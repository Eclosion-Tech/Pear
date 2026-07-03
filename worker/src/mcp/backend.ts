/**
 * PearMcpBackend — owns a SpacetimeDB connection authenticated as one AI user
 * (via its worker token) on behalf of an external MCP client.
 *
 * Mirrors AiUserWorker's connect/reconnect shape, but instead of driving chat
 * turns it just holds the connection + subscription so MCP tool calls can run
 * through `executeTool`. The AI user's identity is resolved from its own
 * `ai_user_config` row, which is the only one RLS makes visible on this
 * connection — so a token that isn't an AI-user worker token fails fast.
 */

import type { Identity } from "spacetimedb";
import { DbConnection, type EventContext } from "../module_bindings/index.js";
import { subscribeToAvailableTables } from "../subscriptions.js";
import {
  toolContextFromAiUserConfigRow,
  type ConnLike,
  type ToolCallContext,
} from "../tools.js";

const RECONNECT_CAP_MS = 30_000;
const RECONNECT_BASE_MS = 1_500;
const READY_TIMEOUT_MS = 20_000;

export interface PearMcpBackendOptions {
  /** SpacetimeDB WebSocket URI, e.g. ws://localhost:3000. */
  uri: string;
  /** Database name (workspace). */
  dbName: string;
  /** The AI user's worker token (SpacetimeDB JWT). */
  token: string;
  /** Label for log lines. */
  label?: string;
}

type AiUserConfigRow = {
  id: bigint;
  identity: Identity;
  toolSecretsJson?: unknown;
};

export class PearMcpBackend {
  private conn: DbConnection | null = null;
  private identity: Identity | null = null;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private subscriptionApplied = false;

  private readyPromise: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (err: Error) => void;
  private settled = false;

  private aiUserId: bigint | null = null;
  private aiIdentityHex: string | null = null;

  readonly uri: string;
  readonly dbName: string;
  private readonly token: string;
  private readonly logTag: string;

  /** Millis timestamp of the last tool call, for idle eviction in HTTP mode. */
  lastUsedAt = 0;

  constructor(opts: PearMcpBackendOptions) {
    this.uri = opts.uri;
    this.dbName = opts.dbName;
    this.token = opts.token;
    this.logTag = `[mcp:${opts.dbName}/${opts.label ?? "backend"}]`;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
  }

  /**
   * Resolves once connected, subscribed, and the AI user identity is resolved.
   * Rejects on auth failure or when the token isn't an AI-user worker token.
   */
  ready(): Promise<void> {
    return this.readyPromise;
  }

  start(): void {
    if (this.stopped) return;
    this.beginConnection();
    // Fail ready() rather than hanging forever on a bad URI/token.
    setTimeout(() => {
      if (!this.settled) {
        this.fail(new Error(
          `Timed out connecting to ${this.uri}/${this.dbName} — check SPACETIMEDB_URI and the worker token.`,
        ));
      }
    }, READY_TIMEOUT_MS).unref?.();
  }

  /** Connection for the tool executor; throws if not currently connected. */
  getConn(): ConnLike {
    if (!this.conn) {
      throw new Error("Pear backend is not connected (reconnecting?). Retry shortly.");
    }
    return this.conn as unknown as ConnLike;
  }

  /** Tool context carrying the AI user attribution + per-user secrets. */
  getToolContext(): ToolCallContext {
    if (this.aiUserId === null || this.aiIdentityHex === null) {
      throw new Error("Pear backend has not resolved its AI user yet.");
    }
    const row = this.findOwnConfigRow();
    return {
      ...toolContextFromAiUserConfigRow(row),
      aiUserId: this.aiUserId,
      aiIdentityHex: this.aiIdentityHex,
    };
  }

  get resolvedAiUserId(): bigint | null {
    return this.aiUserId;
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (!this.settled) this.fail(new Error("Backend closed before ready."));
    try {
      this.conn?.disconnect();
    } catch (err) {
      console.warn(`${this.logTag} disconnect failed:`, err);
    }
    this.conn = null;
    this.identity = null;
  }

  private fail(err: Error): void {
    if (this.settled) return;
    this.settled = true;
    this.readyReject(err);
  }

  private succeed(): void {
    if (this.settled) return;
    this.settled = true;
    this.readyResolve();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    const exp = Math.min(
      RECONNECT_CAP_MS,
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt),
    );
    const delay = exp + Math.floor(Math.random() * 400);
    this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, 12);
    console.log(`${this.logTag} will reconnect in ${delay}ms (attempt ${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.beginConnection();
    }, delay);
  }

  private beginConnection(): void {
    if (this.stopped) return;
    console.log(`${this.logTag} connecting to ${this.uri} / ${this.dbName}`);

    DbConnection.builder()
      .withUri(this.uri)
      .withDatabaseName(this.dbName)
      .withToken(this.token)
      .onConnect((conn, identity) => {
        this.reconnectAttempt = 0;
        this.conn = conn;
        this.identity = identity;
        this.subscriptionApplied = false;
        console.log(
          `${this.logTag} connected — identity: ${identity.toHexString().slice(0, 12)}…`,
        );
        subscribeToAvailableTables(conn, this.logTag, () => {
          this.subscriptionApplied = true;
          this.resolveAiUser();
        });
      })
      .onDisconnect(() => {
        console.log(`${this.logTag} disconnected`);
        this.conn = null;
        this.identity = null;
        if (!this.stopped) this.scheduleReconnect();
      })
      .onConnectError((_ctx: EventContext, err: Error) => {
        console.error(`${this.logTag} connection error:`, err?.message ?? err);
        // Before first ready: an auth failure is terminal for this token.
        if (!this.settled) {
          this.fail(new Error(
            `Failed to connect to ${this.uri}/${this.dbName}: ${err?.message ?? err}`,
          ));
          return;
        }
        if (!this.stopped) this.scheduleReconnect();
      })
      .build();
  }

  private findOwnConfigRow(): AiUserConfigRow | undefined {
    if (!this.conn || !this.identity) return undefined;
    const myHex = this.identity.toHexString();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const table = (this.conn as unknown as ConnLike).db.ai_user_config as
      | { iter: () => Iterable<AiUserConfigRow> }
      | undefined;
    if (!table?.iter) return undefined;
    for (const row of table.iter()) {
      if (row.identity.toHexString() === myHex) return row;
    }
    return undefined;
  }

  private resolveAiUser(): void {
    if (!this.subscriptionApplied) return;
    const row = this.findOwnConfigRow();
    if (!row) {
      this.fail(new Error(
        "Connected, but this token does not belong to a Pear AI user — no ai_user_config row " +
        "is visible on this connection. Provision one with `pnpm mcp:provision` and use the " +
        "printed worker token.",
      ));
      return;
    }
    this.aiUserId = BigInt(row.id);
    this.aiIdentityHex = this.identity!.toHexString();
    console.log(`${this.logTag} acting as AI user id=${this.aiUserId}`);
    this.succeed();
  }
}
