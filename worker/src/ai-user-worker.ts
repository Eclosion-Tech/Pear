/**
 * AiUserWorker — owns a SpacetimeDB connection authenticated as a single
 * AI user. This is the connection that:
 *
 *   - Reads the AI user's row from `ai_user_config` (visible only to its
 *     owning identity via `client_visibility_filter`).
 *   - Calls `send_message` / `update_message` so messages are recorded
 *     with `MessageSender::User(<this AI user's identity>)`.
 *
 * One `AiUserWorker` per AI user per workspace. The host (pear-cloud's
 * worker manager, or a self-hosted bootstrap) is responsible for
 * discovering tokens and spawning workers; this class only knows how
 * to wire up a connection + conversation handlers and tear down cleanly.
 */

import type { Identity } from "spacetimedb";
import {
  DbConnection,
  type EventContext,
} from "./module_bindings/index.js";
import {
  processRecentConversationMessages,
  registerConversationHandlers,
} from "./conversation.js";
import {
  clearProviderCache,
  invalidateProviderCache,
} from "./providers.js";
import { subscribeToAvailableTables } from "./subscriptions.js";
import type { ConnLike } from "./tools.js";
import {
  createBridgeSqlClient,
  registerBridgeSql,
  unregisterBridgeSql,
} from "./bridge-sql.js";

const RECONNECT_CAP_MS = 30_000;
const RECONNECT_BASE_MS = 1_500;

export interface AiUserWorkerOptions {
  /** SpacetimeDB WebSocket URI. */
  uri: string;
  /** Database name (workspace slug in pear-cloud). */
  dbName: string;
  /**
   * Auth token issued by SpacetimeDB for this AI user's identity.
   * Required — the whole point of this worker is to connect AS the AI user.
   */
  token: string;
  /** Optional human label used in log lines (e.g. "eclosion/Kira"). */
  label?: string;
}

export class AiUserWorker {
  private conn: DbConnection | null = null;
  private stopped = false;
  private aiUserIdentity: Identity | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;

  readonly uri: string;
  readonly dbName: string;
  readonly label: string;
  private token: string;
  private logTag: string;

  constructor(opts: AiUserWorkerOptions) {
    this.uri = opts.uri;
    this.dbName = opts.dbName;
    this.token = opts.token;
    this.label = opts.label ?? "ai-user";
    this.logTag = `[ai:${opts.dbName}/${this.label}]`;
  }

  /** Currently-connected SpacetimeDB Identity, or null before onConnect fires. */
  get identity(): Identity | null {
    return this.aiUserIdentity;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.clearReconnectTimer();
    const exp = Math.min(
      RECONNECT_CAP_MS,
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt),
    );
    const jitter = Math.floor(Math.random() * 400);
    const delay = exp + jitter;
    this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, 12);
    console.log(
      `${this.logTag} will reconnect in ${delay}ms (attempt ${this.reconnectAttempt})`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.beginConnection();
    }, delay);
  }

  start(): void {
    if (this.stopped) return;
    this.reconnectAttempt = 0;
    this.beginConnection();
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
        this.aiUserIdentity = identity;
        console.log(
          `${this.logTag} connected — identity: ${identity.toHexString().slice(0, 12)}…`,
        );
        // Register an HTTP `/sql` reader for this AI user so `tool_bash` can read
        // its own bridge_command / bridge_command_result rows directly. The
        // AI-user subscription does not reliably deliver bridge_command
        // incrementals (3-filter RLS table); this committed-state read sidesteps
        // that. Uses THIS connection's token, so RLS stays scoped to the AI user.
        registerBridgeSql(
          identity.toHexString(),
          createBridgeSqlClient({ uri: this.uri, dbName: this.dbName, token: this.token }),
        );
        this.registerHandlers(conn, identity);
      })
      .onDisconnect(() => {
        console.log(`${this.logTag} disconnected`);
        if (this.aiUserIdentity) unregisterBridgeSql(this.aiUserIdentity.toHexString());
        this.conn = null;
        this.aiUserIdentity = null;
        // Drop the cached provider for this AI user so the next connect
        // re-reads the (potentially-rotated) API key from ai_user_config.
        clearProviderCache();
        if (!this.stopped) {
          this.scheduleReconnect();
        }
      })
      .onConnectError((_ctx: EventContext, err: Error) => {
        console.error(
          `${this.logTag} connection error:`,
          err?.message ?? err,
        );
        if (!this.stopped) {
          this.scheduleReconnect();
        }
      })
      .build();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearReconnectTimer();
    clearProviderCache();
    if (this.aiUserIdentity) unregisterBridgeSql(this.aiUserIdentity.toHexString());
    this.conn = null;
    this.aiUserIdentity = null;
    console.log(`${this.logTag} stopped`);
  }

  private registerHandlers(conn: DbConnection, identity: Identity): void {
    const connLike = conn as unknown as ConnLike;

    // Invalidate provider cache when our own ai_user_config row changes
    // (covers API key rotations, model changes, etc.).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const configTable = (connLike.db as any).ai_user_config;
    if (configTable) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      configTable.onUpdate?.((_ctx: any, _old: any, row: any) => {
        invalidateProviderCache(BigInt(row.id));
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      configTable.onDelete?.((_ctx: any, row: any) => {
        invalidateProviderCache(BigInt(row.id));
      });
    }

    registerConversationHandlers(connLike, identity, this.logTag);

    subscribeToAvailableTables(conn, this.logTag, () => {
      console.log(`${this.logTag} subscription ready`);
      void processRecentConversationMessages(connLike, identity, this.logTag).catch(
        (err: unknown) => {
          console.error(
            `${this.logTag} recent message check failed:`,
            err instanceof Error ? err.message : err,
          );
        },
      );
    });
  }
}
