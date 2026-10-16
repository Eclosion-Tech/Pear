"use client";

import { useState } from "react";
import Link from "next/link";
import { useReducer, useTable } from "spacetimedb/react";
import { reducers, tables } from "@/src/module_bindings";
import { useWorkspace } from "@/src/providers/WorkspaceProvider";
import { useAiUserProfiles } from "@/src/hooks/useAiUsers";
import { encryptMailPassword } from "@/src/lib/mail/credentials";

const inputClass = "mt-1 w-full rounded border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-white";
const buttonClass = "rounded border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-neutral-700";

export function MailSettings({ pageBasePath = "/workspace" }: { pageBasePath?: string }) {
  const { activeId } = useWorkspace();
  // Clear credentials and form state on a workspace switch.
  return <MailSettingsContent key={activeId} pageBasePath={pageBasePath} />;
}

function MailSettingsContent({ pageBasePath }: { pageBasePath: string }) {
  const { activeWorkspace } = useWorkspace();
  const [accounts, ready] = useTable(tables.mail_connection);
  const [keys] = useTable(tables.mail_encryption_key);
  const key = keys[0];
  const { profiles } = useAiUserProfiles();
  const create = useReducer(reducers.createMailConnection);
  const setEnabled = useReducer(reducers.setMailConnectionEnabled);
  const remove = useReducer(reducers.deleteMailConnection);
  const rotate = useReducer(reducers.updateMailConnectionPassword);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [password, setPassword] = useState("");
  const [rotation, setRotation] = useState<bigint>();
  const [confirmDelete, setConfirmDelete] = useState<bigint>();

  async function act(operation: () => Promise<unknown>) {
    setError(undefined); setBusy(true);
    try { await operation(); }
    catch { setError("Could not save the mail connection. Check the fields, your access, and the workspace connection."); }
    finally { setBusy(false); }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const ai = String(data.get("assistant") || "");
    await act(async () => {
      if (!key) throw new Error("Mail worker not configured");
      await create({
        label: String(data.get("label")).trim(), host: String(data.get("host")).trim(),
        port: Number(data.get("port")), username: String(data.get("username")).trim(),
        encryptedPassword: await encryptMailPassword(password, key.publicKeyJwk, key.keyId),
        inboxFolder: String(data.get("inbox")).trim() || "INBOX",
        sentFolder: String(data.get("sent")).trim() || undefined,
        aiUserId: ai ? BigInt(ai) : undefined, backfill: Number(data.get("backfill")),
      });
      setPassword(""); setOpen(false);
    });
  }

  return <section className="mb-10" aria-labelledby="mail-settings-heading">
    <h2 id="mail-settings-heading" className="text-lg font-semibold text-neutral-900 dark:text-white">Mail</h2>
    <p className="mt-1 mb-4 text-sm text-neutral-500 dark:text-neutral-400">
      Connect a mailbox to {activeWorkspace?.name || "this workspace"}. Pear checks Inbox and Sent and saves messages in a private page shared with your selected assistant.
    </p>
    {error && <p role="alert" className="mb-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
    {!ready ? <p className="text-sm text-neutral-500">Loading mail connections…</p> :
      <div className="space-y-3">{accounts.map((account) => <div key={String(account.id)} className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <div className="font-medium text-neutral-900 dark:text-white">{account.label}</div>
        <p className="break-all text-sm text-neutral-500">{account.username} · {account.host}:{account.port}</p>
        <p className="mt-2 text-sm" role="status">{account.status}</p>
        <p className="mt-1 text-xs text-neutral-500">
          {String(account.importedCount)} messages imported
          {account.lastSyncAt && ` · Last checked ${new Date(Number(account.lastSyncAt.microsSinceUnixEpoch / 1000n)).toLocaleString()}`}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Link href={`${pageBasePath}/${account.rootPageId}`} className="text-sm text-blue-600 hover:underline dark:text-blue-400">Open mail page</Link>
          <button className={buttonClass} disabled={busy} onClick={() => void act(() => setEnabled({ connectionId: account.id, enabled: !account.enabled }))}>{account.enabled ? "Pause" : "Resume"}</button>
          <button className={buttonClass} disabled={busy || !key} onClick={() => { setOpen(false); setRotation(account.id); setPassword(""); }}>Update password</button>
          <button className={buttonClass} disabled={busy} onClick={() => setConfirmDelete(account.id)}>Disconnect</button>
        </div>
        {rotation === account.id && <form className="mt-3 flex items-end gap-2" onSubmit={(event) => {
          event.preventDefault(); void act(async () => {
            if (!key) throw new Error("Mail worker not configured");
            await rotate({ connectionId: account.id, encryptedPassword: await encryptMailPassword(password, key.publicKeyJwk, key.keyId) });
            setPassword(""); setRotation(undefined);
          });
        }}>
          <label className="flex-1 text-sm">New app password<input className={inputClass} type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          <button className={buttonClass} disabled={busy}>Save</button>
          <button type="button" className={buttonClass} onClick={() => { setRotation(undefined); setPassword(""); }}>Cancel</button>
        </form>}
        {confirmDelete === account.id && <div className="mt-3 text-sm">
          <p>Disconnect this mailbox? Imported pages stay in Pear.</p>
          <div className="mt-2 flex gap-2">
            <button className={buttonClass} disabled={busy} onClick={() => void act(async () => { await remove({ connectionId: account.id }); setConfirmDelete(undefined); })}>Disconnect mailbox</button>
            <button className={buttonClass} onClick={() => setConfirmDelete(undefined)}>Keep connected</button>
          </div>
        </div>}
      </div>)}</div>}
    {!key && <p className="mt-3 text-sm text-neutral-500">Mail connections are not enabled on this workspace’s host yet.</p>}
    {!open ? <button className={`${buttonClass} mt-4`} disabled={!key} onClick={() => { setRotation(undefined); setPassword(""); setOpen(true); }}>Connect mailbox</button> :
      <form onSubmit={submit} className="mt-4 space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <label className="block text-sm">Name<input className={inputClass} name="label" placeholder="Work email" maxLength={100} required /></label>
        <div className="grid grid-cols-[1fr_6rem] gap-3">
          <label className="block text-sm">IMAP server<input className={inputClass} name="host" placeholder="mail.example.com" maxLength={253} required autoCapitalize="none" spellCheck={false} /></label>
          <label className="block text-sm">TLS port<input className={inputClass} name="port" type="number" min={1} max={65535} defaultValue={993} required /></label>
        </div>
        <label className="block text-sm">Mailbox username<input className={inputClass} name="username" autoComplete="username" autoCapitalize="none" maxLength={320} required /></label>
        <label className="block text-sm">App password<input className={inputClass} type="password" autoComplete="new-password" required maxLength={4096} value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm">Inbox folder<input className={inputClass} name="inbox" defaultValue="INBOX" maxLength={512} required /></label>
          <label className="block text-sm">Sent folder<input className={inputClass} name="sent" placeholder="Detect automatically" maxLength={512} /></label>
        </div>
        <label className="block text-sm">AI assistant<select className={inputClass} name="assistant" defaultValue="">
          <option value="">Import only</option>
          {profiles.map((p) => <option key={String(p.aiUserId)} value={String(p.aiUserId)}>{p.displayName}</option>)}
        </select></label>
        <p className="text-xs text-neutral-500">Selecting an assistant sends imported message text to its configured model for priority, reply, and commitment suggestions. Messages remain unread in your email app.</p>
        <label className="block text-sm">Recent messages per folder<select className={inputClass} name="backfill" defaultValue="50">
          <option value="0">New messages only</option><option value="50">Last 50</option><option value="100">Last 100</option><option value="500">Last 500</option>
        </select></label>
        <div className="flex gap-2">
          <button className={buttonClass} disabled={busy}>{busy ? "Connecting…" : "Connect mailbox"}</button>
          <button type="button" className={buttonClass} disabled={busy} onClick={() => { setPassword(""); setOpen(false); }}>Cancel</button>
        </div>
      </form>}
  </section>;
}
