/** Explicit local-weights decision client. One attempted call per instance, no fallback. */
import { randomUUID } from "node:crypto";
import { discoverExecutionProfiles } from "./routing-discovery.js";
import type { PreflightConnection } from "./routing-preflight.js";
import type { SystemOneClient, SystemOneRequest } from "./routing.js";

export interface BridgeSystemOneOptions {
  readonly approved: boolean;
  readonly principalId: string;
  readonly aiUserId: bigint;
  readonly deviceId: bigint;
  /** Machine-local literal IPv4 endpoint, explicitly approved; no default. */
  readonly endpoint: string;
  readonly model: string;
  readonly modelDigest: string;
  readonly timeoutMs: number;
}
export function createBridgeSystemOneClient(conn: PreflightConnection, input: BridgeSystemOneOptions): SystemOneClient {
  const o = Object.freeze({ ...input });
  const endpoint = new URL(o.endpoint);
  if (o.approved !== true || !/^[a-f0-9]{64}$/.test(o.principalId) || o.aiUserId <= 0n || o.deviceId <= 0n
    || endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.pathname !== "/v1/systemone"
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.href !== o.endpoint
    || !/^[a-f0-9]{64}$/.test(o.modelDigest) || !/^[a-zA-Z0-9_.:/-]{1,128}$/.test(o.model) || o.model.endsWith(":cloud")
    || !Number.isInteger(o.timeoutMs) || o.timeoutMs < 1 || o.timeoutMs > 30_000) throw new Error("Invalid local decision approval");
  let used = false;
  const profile = () => discoverExecutionProfiles(conn, { principalId:o.principalId, aiUserId:o.aiUserId,
    nowMs:Date.now(), maxObservationAgeMs:30_000 }).profiles.find(p=>p.id===`bridge_${o.deviceId}_ollama`);
  return { async decide(request: SystemOneRequest, signal: AbortSignal): Promise<unknown> {
    if (used) throw new Error("Local decision budget exhausted");
    used = true; // Failed, cancelled and refused attempts consume this allowance too.
    if (signal.aborted) throw new Error("Local decision cancelled");
    const p = profile();
    if (!p || p.grant !== "granted" || p.availability !== "available" || !p.configurationFingerprint)
      throw new Error("Local decision profile unavailable");
    const db = conn.db as Record<string, any>;
    const results = db.bridge_command_result ?? db.bridgeCommandResult;
    if (typeof results?.iter !== "function" || typeof conn.reducers?.enqueueBridgeInference !== "function")
      throw new Error("Local decision transport unavailable");
    const nonce = randomUUID();
    const fingerprint = p.configurationFingerprint;
    // The routing builder already selects safe context fields; copying here
    // prevents later caller mutation, and rejects extra outer request keys.
    if (Object.keys(request).sort().join(",") !== "questions,state") throw new Error("Invalid decision request");
    const payloadJson = JSON.stringify({ operation:"local-system-one-v1", principal_id:o.principalId,
      ai_user_id:String(o.aiUserId), request_nonce:nonce, configuration_fingerprint:fingerprint,
      endpoint:o.endpoint, model:o.model, model_digest:o.modelDigest, request:JSON.parse(JSON.stringify(request)) });
    if (Buffer.byteLength(payloadJson) > 16_384) throw new Error("Decision request too large");
    const started = Date.now(), deadline = started + o.timeoutMs;
    let stopped = false;
    const cancelled = () => stopped || signal.aborted || Date.now() >= deadline;
    const work = async () => {
      await conn.reducers.enqueueBridgeInference({deviceId:o.deviceId,provider:"ollama",model:"",payloadJson,
        conversationId:0n,jobId:undefined,taskId:undefined,nonce});
      while (!cancelled()) {
        for (const row of results.iter()) {
          if (row.requestedBy?.toHexString() !== o.principalId || typeof row.stdout !== "string" || row.stdout.length > 49_152) continue;
          let envelope: any, evidence: any;
          try { envelope=JSON.parse(row.stdout); evidence=JSON.parse(envelope.output); } catch { continue; }
          if (evidence?.request_nonce !== nonce) continue;
          if (envelope.ok !== true) throw new Error("Local decision refused");
          const completed = typeof row.completedAt?.microsSinceUnixEpoch === "bigint"
            ? Number(row.completedAt.microsSinceUnixEpoch)/1000 : NaN;
          if (row.exitCode !== 0 || row.rejectionReason || envelope.provider !== "local-system-one"
            || envelope.usage != null || envelope.tool_calls != null || evidence.schema !== "bridge-local-system-one-v1"
            || evidence.command_id !== String(row.commandId) || evidence.device_id !== String(o.deviceId)
            || typeof evidence.session_id !== "string" || !/^[1-9][0-9]*$/.test(evidence.session_id) || evidence.principal_id !== o.principalId
            || evidence.ai_user_id !== String(o.aiUserId) || evidence.configuration_fingerprint !== fingerprint
            || evidence.endpoint !== o.endpoint || evidence.model_digest !== o.modelDigest
            || evidence.decision?.model !== o.model || !Number.isFinite(completed)
            || completed < started-5000 || completed > Date.now()+5000) throw new Error("Invalid local decision receipt");
          const current = profile();
          if (!current || current.configurationFingerprint !== fingerprint || current.grant !== "granted"
            || current.availability !== "available" || cancelled()) throw new Error("Local decision context changed");
          return evidence.decision; // recommendRoute validates distributions; no opaque receipt export.
        }
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      throw new Error("Local decision stopped");
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (()=>void) | undefined;
    try {
      return await Promise.race([work().catch(()=>{throw new Error("Local decision unavailable");}),
        new Promise<never>((_,reject)=>{
          const stop=()=>{stopped=true;reject(new Error("Local decision stopped"));};
          timer=setTimeout(stop,Math.max(0,deadline-Date.now()));abort=stop;
          signal.addEventListener("abort",stop,{once:true});if(signal.aborted) stop();
        })]);
    } finally {stopped=true;if(timer) clearTimeout(timer);if(abort) signal.removeEventListener("abort",abort);}
  } };
}
