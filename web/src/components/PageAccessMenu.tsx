"use client";

import { useId, useRef, useState } from "react";
import { useReducer, useSpacetimeDB, useTable } from "spacetimedb/react";
import { tables, reducers } from "@/src/module_bindings";
import { useAiUserProfiles } from "@/src/hooks/useAiUsers";
import {
  pageAccessScope,
  effectivePagePermission,
  type PagePermission,
} from "@/src/lib/pageAccess";
import { FloatingPopup } from "./FloatingPopup";

export function PageAccessMenu({ pageId }: { pageId: bigint }) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const dialogId = useId();
  function close() {
    setOpen(false);
    anchorRef.current?.focus();
  }
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen(!open)}
        title="Page access and sharing"
        aria-label="Page access and sharing"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? dialogId : undefined}
        className={`shrink-0 rounded p-1.5 transition-colors ${open ? "bg-neutral-200 text-neutral-900 dark:bg-neutral-700 dark:text-white" : "text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"}`}
      >
        <svg
          aria-hidden="true"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
          <circle cx="9" cy="7" r="4" />
        </svg>
      </button>
      {open && (
        <FloatingPopup
          anchorRef={anchorRef}
          onClose={close}
          className="max-h-[calc(100dvh-16px)] w-96 max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl border border-neutral-200 bg-white p-4 text-neutral-900 shadow-xl dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
        >
          <PageAccessPanel
            key={String(pageId)}
            pageId={pageId}
            dialogId={dialogId}
            onClose={close}
          />
        </FloatingPopup>
      )}
    </>
  );
}

function PageAccessPanel({
  pageId,
  dialogId,
  onClose,
}: {
  pageId: bigint;
  dialogId: string;
  onClose: () => void;
}) {
  const { identity } = useSpacetimeDB();
  const [pages, pagesReady] = useTable(tables.page);
  const [rules, rulesReady] = useTable(tables.page_access_rule);
  // Permissions belong to identities; email-deduplicated rows can hide grants
  // held by another session belonging to the same person.
  const [users, usersReady] = useTable(tables.user);
  const [install, installReady] = useTable(tables.module_install_meta);
  const { profiles, isReady: profilesReady } = useAiUserProfiles();
  const setRule = useReducer(reducers.setPageAccessRule);
  const clearRule = useReducer(reducers.clearPageAccessRule);
  const [selected, setSelected] = useState("");
  const [permission, setPermission] = useState<PagePermission>("Read");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{
    message: string;
    action: () => Promise<unknown>;
  } | null>(null);
  const scope = pageAccessScope(pageId, pages, rules);
  const me = identity?.toHexString();
  const publisher = install[0]?.publisherIdentity;
  const isPrivileged = (hex: string) =>
    hex === publisher?.toHexString() ||
    users.some(
      (user) =>
        user.identity.toHexString() === hex &&
        user.isAuthenticated &&
        user.isAdmin,
    );
  const ready =
    pagesReady && rulesReady && usersReady && profilesReady && installReady;
  const members = new Map(
    users
      .filter((user) => user.isAuthenticated)
      .map((user) => [
        user.identity.toHexString(),
        {
          identity: user.identity,
          name:
            user.name || user.email || user.identity.toHexString().slice(0, 8),
          detail: user.email,
          ai: false,
        },
      ]),
  );
  for (const profile of profiles)
    members.set(profile.identity.toHexString(), {
      identity: profile.identity,
      name: profile.displayName,
      detail: "AI member",
      ai: true,
    });
  if (publisher && !members.has(publisher.toHexString()))
    members.set(publisher.toHexString(), {
      identity: publisher,
      name: "Workspace service",
      detail: "Module publisher",
      ai: false,
    });
  for (const rule of scope.rules) {
    const principal = rule.principal.value;
    if (!members.has(principal.toHexString()))
      members.set(principal.toHexString(), {
        identity: principal,
        name: principal.toHexString().slice(0, 12),
        detail: "Identity with a grant; membership unverified",
        ai: false,
      });
  }
  const hasMembership = (hex: string) =>
    hex === publisher?.toHexString() ||
    users.some(
      (user) => user.identity.toHexString() === hex && user.isAuthenticated,
    ) ||
    profiles.some((profile) => profile.identity.toHexString() === hex);
  const canManage =
    ready &&
    scope.complete &&
    !!me &&
    hasMembership(me) &&
    effectivePagePermission(scope, me, isPrivileged(me)) === "Write";
  const candidates = [...members.entries()].filter(
    ([hex]) =>
      hasMembership(hex) &&
      !isPrivileged(hex) &&
      !scope.rules.some(
        (rule) =>
          rule.pageId === pageId && rule.principal.value.toHexString() === hex,
      ),
  );
  const visible = [...members.entries()].filter(
    ([hex]) =>
      scope.open ||
      isPrivileged(hex) ||
      scope.rules.some((rule) => rule.principal.value.toHexString() === hex),
  );
  const pageTitle =
    pages.find((page) => page.id === pageId)?.title || "Untitled";
  const controlClass =
    "rounded border border-neutral-300 bg-white px-2 py-1.5 text-xs disabled:opacity-50 dark:border-neutral-600 dark:bg-neutral-800";

  async function mutate(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setConfirm(null);
      setNotice("Access updated.");
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Could not update access. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section role="dialog" aria-labelledby={`${dialogId}-title`} id={dialogId}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id={`${dialogId}-title`} className="text-sm font-semibold">
            Page access
          </h2>
          <p className="truncate text-xs text-neutral-500" title={pageTitle}>
            {pageTitle}
          </p>
        </div>
        <button
          autoFocus
          type="button"
          onClick={onClose}
          aria-label="Close page access"
          className="rounded px-1 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
        >
          ×
        </button>
      </div>
      {!ready ? (
        <p className="py-4 text-sm text-neutral-500">Loading access…</p>
      ) : (
        <>
          <div className="my-3 rounded-lg bg-neutral-50 p-3 text-xs dark:bg-neutral-800">
            <p className="font-medium">
              {scope.open
                ? "Everyone in this workspace can edit"
                : "Restricted access"}
            </p>
            <p className="mt-1 text-neutral-500 dark:text-neutral-400">
              {scope.open
                ? "Includes people and AI members. Restrict access to choose who can view or edit this page and its children."
                : "Grants apply to this page and its children. Parent-page grants still apply. Workspace admins always have access."}
            </p>
          </div>
          {!scope.complete && (
            <p
              role="status"
              className="mb-2 text-xs text-amber-700 dark:text-amber-300"
            >
              Some parent-page details are unavailable. The access list may be
              incomplete.
            </p>
          )}
          <ul
            className="max-h-64 space-y-3 overflow-y-auto"
            aria-label="People and AI members with access"
          >
            {visible.map(([hex, member]) => {
              const direct = scope.rules.find(
                (rule) =>
                  rule.pageId === pageId &&
                  rule.principal.value.toHexString() === hex,
              );
              const inherited = scope.rules.filter(
                (rule) =>
                  rule.pageId !== pageId &&
                  rule.principal.value.toHexString() === hex,
              );
              const effective = effectivePagePermission(
                scope,
                hex,
                isPrivileged(hex),
              );
              const label = !hasMembership(hex)
                ? "Unverified member"
                : isPrivileged(hex)
                  ? "Full access"
                  : effective === "Write"
                    ? "Can edit"
                    : "Can view";
              const duplicates =
                [...members.values()].filter(
                  (other) => other.name === member.name,
                ).length > 1;
              return (
                <li key={hex} className="flex items-start gap-2 text-xs">
                  <span
                    aria-hidden="true"
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${member.ai ? "bg-violet-100 text-violet-700 dark:bg-violet-900 dark:text-violet-200" : "bg-neutral-100 text-neutral-600 dark:bg-neutral-700 dark:text-neutral-200"}`}
                  >
                    {member.name[0]?.toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium" title={member.detail}>
                      {member.name}
                      {hex === me ? " (you)" : ""}
                      {member.ai ? " · AI" : ""}
                    </p>
                    {duplicates && (
                      <p className="text-neutral-500">
                        Identity {hex.slice(0, 8)}
                      </p>
                    )}
                    <p className="text-neutral-500">
                      {label}
                      {scope.open
                        ? " · Workspace"
                        : isPrivileged(hex)
                          ? " · Admin / service"
                          : direct
                            ? " · Direct grant"
                            : ""}
                    </p>
                    {inherited.map((rule) => (
                      <p key={String(rule.pageId)} className="text-neutral-500">
                        {rule.permission.tag === "Write" ? "Edit" : "View"}{" "}
                        inherited from{" "}
                        {pages.find((page) => page.id === rule.pageId)?.title ||
                          `page ${rule.pageId}`}
                      </p>
                    ))}
                  </div>
                  {canManage && direct && !isPrivileged(hex) && (
                    <select
                      aria-label={`Direct access for ${member.name}`}
                      disabled={busy}
                      value={direct.permission.tag}
                      className={controlClass}
                      onChange={(event) => {
                        const value = event.target.value;
                        const action = () =>
                          value === "remove"
                            ? clearRule({ pageId, principal: member.identity })
                            : setRule({
                                pageId,
                                principal: member.identity,
                                permission: { tag: value as PagePermission },
                              });
                        if (value === "remove" && scope.rules.length === 1)
                          setConfirm({
                            message:
                              "Removing the last grant opens this page to everyone in the workspace. Child pages inherit this unless they have their own restrictions. Continue?",
                            action,
                          });
                        else if (
                          hex === me &&
                          !inherited.some(
                            (rule) => rule.permission.tag === "Write",
                          ) &&
                          value !== "Write"
                        )
                          setConfirm({
                            message:
                              "You will lose the ability to edit this page and manage its access. Continue?",
                            action,
                          });
                        else void mutate(action);
                      }}
                    >
                      <option value="Read">Can view</option>
                      <option value="Write">Can edit</option>
                      <option value="remove">Remove grant</option>
                    </select>
                  )}
                </li>
              );
            })}
          </ul>
          {canManage && scope.open && identity && (
            <button
              type="button"
              disabled={busy}
              className={`${controlClass} mt-4 w-full`}
              onClick={() =>
                setConfirm({
                  message:
                    "Only you, workspace admins and the workspace service will retain access to this page and its children, alongside any grants on child pages. You can then add people or AI members.",
                  action: () =>
                    setRule({
                      pageId,
                      principal: identity,
                      permission: { tag: "Write" },
                    }),
                })
              }
            >
              Restrict access…
            </button>
          )}
          {canManage && !scope.open && (
            <form
              className="mt-4 border-t border-neutral-200 pt-3 dark:border-neutral-700"
              onSubmit={(event) => {
                event.preventDefault();
                const member = members.get(selected);
                if (member)
                  void mutate(async () => {
                    await setRule({
                      pageId,
                      principal: member.identity,
                      permission: { tag: permission },
                    });
                    setSelected("");
                  });
              }}
            >
              <label
                htmlFor={`${dialogId}-member`}
                className="mb-1 block text-xs font-medium"
              >
                Share with a workspace member
              </label>
              <select
                id={`${dialogId}-member`}
                value={selected}
                onChange={(event) => setSelected(event.target.value)}
                disabled={busy}
                className={`${controlClass} w-full`}
              >
                <option value="">Choose a person or AI…</option>
                {candidates.map(([hex, member]) => (
                  <option key={hex} value={hex}>
                    {member.name}
                    {member.ai ? " (AI)" : ""} · {hex.slice(0, 8)}
                  </option>
                ))}
              </select>
              <div className="mt-2 flex gap-2">
                <select
                  aria-label="Access to grant"
                  value={permission}
                  onChange={(event) =>
                    setPermission(event.target.value as PagePermission)
                  }
                  disabled={busy}
                  className={`${controlClass} flex-1`}
                >
                  <option value="Read">Can view</option>
                  <option value="Write">Can edit</option>
                </select>
                <button
                  type="submit"
                  disabled={busy || !selected}
                  className="rounded bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-700 disabled:opacity-50"
                >
                  {busy ? "Saving…" : "Share"}
                </button>
              </div>
            </form>
          )}
          {!canManage && scope.complete && (
            <p className="mt-3 text-xs text-neutral-500">
              Only members with edit access or workspace admins can change
              sharing.
            </p>
          )}
        </>
      )}
      {confirm && (
        <div className="mt-3 rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <p>{confirm.message}</p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className={controlClass}
              disabled={busy}
              onClick={() => void mutate(confirm.action)}
            >
              Confirm change
            </button>
            <button
              type="button"
              className={controlClass}
              disabled={busy}
              onClick={() => setConfirm(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {notice && (
        <p
          role="status"
          className="mt-2 text-xs text-emerald-700 dark:text-emerald-300"
        >
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-300">
          {error}
        </p>
      )}
    </section>
  );
}
