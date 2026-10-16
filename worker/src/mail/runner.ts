import { createHash, randomUUID } from "node:crypto";
import { HttpStdbTransport } from "../../../web/src/lib/api-endpoint/http-transport.js";
import { decodeOptionSome } from "../../../web/src/lib/api-endpoint/codec.js";
import { encodeU64 } from "../../../web/src/lib/mcp/encode.js";
import type { ConnLike } from "../tools.js";
import type { AiUserConfigRow } from "../providers.js";
import { getProviderForAiUser } from "../providers.js";
import { wsUriToHttpBase } from "../bridge-sql.js";
import { createImapClient, MailMonitorError, scanMail, type MailClient } from "./monitor.js";
import { createPearMailSink } from "./pear-sink.js";
import { triageMessage } from "./triage.js";
import type { Cursor, MailConfig } from "./config.js";
import { mailEncryptionKey, decryptMailPassword } from "./credentials.js";

interface Account {
  id: string | number; root_page_id: string | number; host: string; port: number;
  username: string; inbox_folder: string; sent_folder: unknown; ai_user_id: unknown; backfill: number;
}

/** One runner per workspace. Database leases coordinate multiple worker hosts;
 * cursors survive restarts, deployments, and host moves. */
export class MailMonitorRunner {
  private readonly transport: HttpStdbTransport;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private client?: MailClient;
  private encryption?: ReturnType<typeof mailEncryptionKey>;
  constructor(options: { uri: string; dbName: string; token: string },
    private getAiConnection: (id: bigint) => ConnLike | undefined) {
    this.transport = new HttpStdbTransport({
      baseUrl: wsUriToHttpBase(options.uri), dbName: options.dbName, token: options.token, timeoutMs: 20_000,
    });
  }
  start(): void {
    const key = process.env.PEAR_MAIL_PRIVATE_KEY_B64;
    if (!key) return; // Host opt-in. The settings UI explains the missing setup.
    try { this.encryption = mailEncryptionKey(key); }
    catch { console.error("[mail-monitor] Invalid PEAR_MAIL_PRIVATE_KEY_B64; monitor disabled"); return; }
    this.timer = setTimeout(() => void this.tick(), 10_000);
  }
  stop(): void { this.stopped = true; clearTimeout(this.timer); this.client?.close(); }
  private async tick(): Promise<void> {
    try {
      if (!this.encryption) return;
      await this.transport.call("publish_mail_encryption_key", [this.encryption.publicKeyJwk, this.encryption.keyId]);
      const accounts = await this.transport.sql<Account>("SELECT * FROM mail_connection WHERE enabled = true");
      for (const account of accounts) {
        if (this.stopped) break;
        await this.sync(account);
      }
    } catch {
      // Older modules do not have mail tables. No credential/response logging.
    } finally {
      if (!this.stopped) this.timer = setTimeout(() => void this.tick(), 60_000);
    }
  }
  private async sync(account: Account): Promise<void> {
    const id = BigInt(account.id), lease = randomUUID();
    const wireId = encodeU64(id);
    try { await this.transport.call("claim_mail_sync", [wireId, lease]); }
    catch { return; } // Another worker may already hold the lease.
    let status = "Up to date";
    let heartbeatFailed = false;
    let activeClient: MailClient | undefined;
    const heartbeat = setInterval(() => {
      if (this.stopped) return;
      void this.transport.call("renew_mail_sync", [wireId, lease]).catch(() => {
        heartbeatFailed = true; activeClient?.close();
      });
    }, 30_000);
    try {
      const secrets = await this.transport.sql<{ encrypted_password: string }>(
        "SELECT encrypted_password FROM mail_connection_secret WHERE connection_id = ?", [id]);
      if (!secrets[0]?.encrypted_password || !this.encryption) throw new Error("Missing credential");
      const rows = await this.transport.sql<{ folder: string; uid_validity: string; last_uid: number }>(
        "SELECT * FROM mail_sync_cursor WHERE connection_id = ?", [id]);
      const cursors = new Map<string, Cursor>(rows.map((r) => [r.folder, { uidValidity: r.uid_validity, lastUid: r.last_uid }]));
      const rawAi = decodeOptionSome(account.ai_user_id);
      const aiId = rawAi == null ? undefined : BigInt(rawAi as string | number);
      const config: MailConfig = {
        host: account.host, port: account.port, user: account.username, password: decryptMailPassword(secrets[0].encrypted_password, this.encryption),
        inboxFolder: account.inbox_folder, sentFolder: decodeOptionSome(account.sent_folder) as string | undefined,
        backfill: account.backfill, batchSize: 10, maxMessageBytes: 5 * 1024 * 1024,
        accountKey: createHash("sha256").update(JSON.stringify([account.host, account.port, account.username])).digest("hex"),
      };
      const ensureRunning = () => { if (this.stopped || heartbeatFailed) throw new Error("Monitor stopped"); };
      const sink = createPearMailSink(this.transport, id, BigInt(account.root_page_id), lease,
        aiId === undefined ? undefined : async (mail) => {
          ensureRunning();
          const conn = this.getAiConnection(aiId);
          const configs = conn?.db.ai_user_config as { id: { find(id: bigint): AiUserConfigRow | undefined } } | undefined;
          const aiConfig = configs?.id.find(aiId);
          if (!conn || !aiConfig || aiConfig.inferenceBackendJson) {
            throw new MailMonitorError("Assistant unavailable — check its model settings");
          }
          // Recheck permissions, cap, and lease before transmitting mail to the model.
          try { await this.transport.call("authorize_mail_triage", [wireId, lease]); }
          catch { throw new MailMonitorError("Assistant unavailable — check its model settings"); }
          const started = Date.now();
          let result;
          try { result = await triageMessage(mail, getProviderForAiUser(conn as unknown as { db: Record<string, unknown> }, aiId)); }
          catch { throw new MailMonitorError("Assistant unavailable — check its model settings"); }
          await this.transport.call("record_usage_event", [0, "mail_triage", "mail-monitor", { some: encodeU64(aiId) },
            result.response.usage?.inputTokens ?? 0, result.response.usage?.outputTokens ?? 0, Date.now() - started]);
          ensureRunning();
          return result.text;
        });
      activeClient = createImapClient(config, process.env.PEAR_MAIL_ALLOW_PRIVATE_HOSTS === "true");
      this.client = activeClient;
      const result = await scanMail(config, {
        get: (folder) => cursors.get(folder),
        set: async (folder, cursor) => {
          ensureRunning();
          await this.transport.call("checkpoint_mail_sync", [wireId, lease, folder, cursor.uidValidity, cursor.lastUid]);
          cursors.set(folder, cursor);
        },
      }, sink, activeClient);
      if (result.hasMore) status = "Catching up";
    } catch (error) {
      status = error instanceof MailMonitorError ? error.status : "Sync failed — will retry";
    } finally {
      clearInterval(heartbeat);
      activeClient?.close();
      if (this.client === activeClient) this.client = undefined;
      await this.transport.call("finish_mail_sync", [wireId, lease, status]).catch(() => {});
    }
  }
}
