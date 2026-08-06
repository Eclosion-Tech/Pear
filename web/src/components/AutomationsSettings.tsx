"use client";

import { useMemo, useState } from "react";
import { useSpacetimeDB, useTable } from "spacetimedb/react";
import { tables } from "@/src/module_bindings";
import {
  useAutomationControlData,
  useDisableAutomation,
  useEnableAutomation,
  useSetAutomationMode,
  useValidateAutomation,
  type AutomationActionRow,
  type AutomationCapabilityRow,
  type AutomationConditionRow,
  type AutomationEventRow,
  type AutomationRuleRow,
  type AutomationRunLogRow,
} from "@/src/hooks/useAutomations";
import { useCurrentUser } from "@/src/hooks/useUser";
import {
  canManageAutomation,
  liveAutomationBlockers,
  prettyAutomationJson,
} from "@/src/lib/automationControl";

type RuleControl = "validate" | "approve" | "dry-run" | "enable" | "disable";

export function AutomationsSettings() {
  const data = useAutomationControlData();
  const { identity } = useSpacetimeDB();
  const { user } = useCurrentUser();
  const [people] = useTable(tables.user);
  const [aiProfiles] = useTable(tables.ai_user_profile);

  const rules = useMemo(
    () =>
      data.rules
        .slice()
        .sort((a, b) =>
          a.updatedAt.microsSinceUnixEpoch < b.updatedAt.microsSinceUnixEpoch
            ? 1
            : -1,
        ),
    [data.rules],
  );

  function principalName(hex: string): string {
    const ai = aiProfiles.find((profile) => profile.identity.toHexString() === hex);
    if (ai) return ai.displayName;
    const person = people.find((candidate) => candidate.identity.toHexString() === hex);
    return person?.name || person?.email || `${hex.slice(0, 8)}…`;
  }

  return (
    <section className="mb-10">
      <h2 className="mb-1 text-lg font-semibold text-neutral-900 dark:text-white">
        Automations
      </h2>
      <p className="mb-4 text-sm text-neutral-500 dark:text-neutral-400">
        Review agent-authored rules before they can make workspace changes. Any graph edit
        returns a Live rule to DryRun and disables it for fresh approval.
      </p>

      {!data.isReady ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Loading automations…
        </p>
      ) : rules.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 px-4 py-5 dark:border-neutral-700">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
            No automation drafts yet
          </p>
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            Ask an AI user to draft one. It will appear here disabled and in DryRun for
            human review.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {rules.map((rule) => {
            const actions = data.actions
              .filter((action) => action.automationId === rule.id)
              .sort((a, b) => a.order - b.order);
            const conditions = data.conditions
              .filter((condition) => condition.automationId === rule.id)
              .sort((a, b) => a.order - b.order);
            const capabilities = data.capabilities.filter(
              (capability) => capability.automationId === rule.id,
            );
            const events = data.events
              .filter((event) => event.automationId === rule.id)
              .sort((a, b) =>
                a.createdAt.microsSinceUnixEpoch < b.createdAt.microsSinceUnixEpoch
                  ? 1
                  : -1,
              );
            const queueIds = new Set(events.map((event) => event.id));
            const logs = data.runLogs
              .filter((log) => queueIds.has(log.queueId))
              .sort((a, b) =>
                a.createdAt.microsSinceUnixEpoch < b.createdAt.microsSinceUnixEpoch
                  ? 1
                  : -1,
              );
            const manageable = canManageAutomation({
              currentIdentityHex: identity?.toHexString(),
              createdByHex: rule.createdBy.toHexString(),
              isAdmin: user?.isAdmin ?? false,
            });

            return (
              <AutomationRuleCard
                key={String(rule.id)}
                rule={rule}
                actions={actions}
                conditions={conditions}
                capabilities={capabilities}
                events={events}
                logs={logs}
                manageable={manageable}
                creatorName={principalName(rule.createdBy.toHexString())}
                runAsName={principalName(rule.runAs.toHexString())}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

function AutomationRuleCard({
  rule,
  actions,
  conditions,
  capabilities,
  events,
  logs,
  manageable,
  creatorName,
  runAsName,
}: {
  rule: AutomationRuleRow;
  actions: AutomationActionRow[];
  conditions: AutomationConditionRow[];
  capabilities: AutomationCapabilityRow[];
  events: AutomationEventRow[];
  logs: AutomationRunLogRow[];
  manageable: boolean;
  creatorName: string;
  runAsName: string;
}) {
  const validateAutomation = useValidateAutomation();
  const setAutomationMode = useSetAutomationMode();
  const enableAutomation = useEnableAutomation();
  const disableAutomation = useDisableAutomation();
  const [expanded, setExpanded] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [busy, setBusy] = useState<RuleControl | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const blockers = liveAutomationBlockers(actions);
  const isLive = rule.mode.tag === "Live";

  async function runControl(control: RuleControl) {
    setBusy(control);
    setError(null);
    setNotice(null);
    try {
      if (control === "validate") {
        await validateAutomation({ automationId: rule.id });
        setNotice("Validation passed.");
        return;
      }

      if (control === "approve") {
        if (blockers.length > 0) {
          throw new Error(
            `${blockers.join(", ")} cannot run Live until the worker executor exists.`,
          );
        }
        const actionSummary = actions
          .map((action) => `• ${action.actionKind.tag}`)
          .join("\n");
        const capabilitySummary = capabilities.length
          ? capabilities
              .map((capability) => `• ${capability.capabilityKind.tag}`)
              .join("\n")
          : "• None recorded";
        const confirmed = window.confirm(
          `Approve “${rule.name}” for Live execution?\n\n${rule.canonicalDescription}` +
            `\n\nActions:\n${actionSummary || "• None"}` +
            `\n\nCapabilities:\n${capabilitySummary}` +
            "\n\nApproval does not enable the rule.",
        );
        if (!confirmed) return;
        // Never turn a running DryRun rule live in place. Stop it first, then
        // require a separate explicit Enable action after approval.
        if (rule.enabled) {
          await disableAutomation({ automationId: rule.id });
        }
        await validateAutomation({ automationId: rule.id });
        await setAutomationMode({
          automationId: rule.id,
          mode: { tag: "Live" },
        });
        setNotice("Approved for Live execution. The rule remains disabled.");
        return;
      }

      if (control === "dry-run") {
        if (rule.enabled) {
          await disableAutomation({ automationId: rule.id });
        }
        await setAutomationMode({
          automationId: rule.id,
          mode: { tag: "DryRun" },
        });
        setNotice("Returned to DryRun. The rule remains disabled.");
        return;
      }

      if (control === "enable") {
        if (isLive) {
          const confirmed = window.confirm(
            `Enable Live automation “${rule.name}”? It can make workspace changes using ${runAsName}’s authority.`,
          );
          if (!confirmed) return;
        }
        await validateAutomation({ automationId: rule.id });
        await enableAutomation({ automationId: rule.id });
        setNotice(isLive ? "Live automation enabled." : "Dry-run automation enabled.");
        return;
      }

      await disableAutomation({ automationId: rule.id });
      setNotice("Automation disabled.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className="overflow-hidden rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950">
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate text-sm font-semibold text-neutral-900 dark:text-white">
                {rule.name}
              </h3>
              <StatusBadge tone={isLive ? "live" : "dry"}>{rule.mode.tag}</StatusBadge>
              <StatusBadge tone={rule.enabled ? "enabled" : "disabled"}>
                {rule.enabled ? "Enabled" : "Disabled"}
              </StatusBadge>
            </div>
            <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
              {rule.canonicalDescription || "No review description supplied."}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="shrink-0 rounded px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          >
            {expanded ? "Hide graph" : "Review graph"}
          </button>
        </div>

        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
          <Metadata label="Trigger" value={rule.triggerKind.tag} />
          <Metadata
            label="Schedule"
            value={
              rule.scheduleKind.tag === "None"
                ? "—"
                : `${rule.scheduleKind.tag} · ${rule.timezone}`
            }
          />
          <Metadata label="Created by" value={creatorName} />
          <Metadata label="Runs as" value={runAsName} />
        </dl>

        {blockers.length > 0 && (
          <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            Live blocked: {blockers.join(", ")} requires the off-module worker executor.
          </p>
        )}

        {expanded && (
          <div className="mt-4 space-y-4 border-t border-neutral-100 pt-4 dark:border-neutral-800">
            <ConfigBlock title="Trigger config" raw={rule.triggerConfig} />
            {rule.scheduleKind.tag !== "None" && (
              <ConfigBlock title="Schedule config" raw={rule.scheduleConfig} />
            )}
            <GraphRows
              title="Actions"
              empty="No actions — validation will fail."
              rows={actions.map((action) => ({
                id: action.id,
                label: action.actionKind.tag,
                raw: action.config,
              }))}
            />
            <GraphRows
              title="Conditions"
              empty="No conditions. Every matching trigger may run this rule."
              rows={conditions.map((condition) => ({
                id: condition.id,
                label: condition.conditionKind.tag,
                raw: condition.config,
              }))}
            />
            <GraphRows
              title="Capabilities"
              empty="No explicit capabilities recorded."
              rows={capabilities.map((capability) => ({
                id: capability.id,
                label: capability.capabilityKind.tag,
                raw: capability.scopeConfig,
              }))}
            />
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-neutral-100 pt-3 dark:border-neutral-800">
          <ControlButton
            label="Validate"
            busy={busy === "validate"}
            disabled={!manageable || busy !== null}
            onClick={() => void runControl("validate")}
          />
          {!isLive ? (
            <ControlButton
              label="Approve Live"
              busy={busy === "approve"}
              disabled={!manageable || busy !== null || blockers.length > 0}
              strong
              onClick={() => void runControl("approve")}
            />
          ) : (
            <ControlButton
              label="Return to DryRun"
              busy={busy === "dry-run"}
              disabled={!manageable || busy !== null}
              onClick={() => void runControl("dry-run")}
            />
          )}
          {rule.enabled ? (
            <ControlButton
              label="Disable"
              busy={busy === "disable"}
              disabled={!manageable || busy !== null}
              onClick={() => void runControl("disable")}
            />
          ) : (
            <ControlButton
              label={isLive ? "Enable Live" : "Enable DryRun"}
              busy={busy === "enable"}
              disabled={!manageable || busy !== null}
              strong={isLive}
              onClick={() => void runControl("enable")}
            />
          )}
          <button
            type="button"
            onClick={() => setHistoryOpen((value) => !value)}
            className="ml-auto rounded px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          >
            {historyOpen ? "Hide history" : `History (${events.length})`}
          </button>
        </div>

        {!manageable && (
          <p className="mt-2 text-xs text-neutral-400 dark:text-neutral-500">
            Only the creator or a workspace admin can manage this automation.
          </p>
        )}
        {notice && (
          <p className="mt-2 text-xs text-green-700 dark:text-green-400" role="status">
            {notice}
          </p>
        )}
        {error && (
          <p className="mt-2 text-xs text-red-700 dark:text-red-400" role="alert">
            {error}
          </p>
        )}
      </div>

      {historyOpen && <AutomationHistory events={events} logs={logs} />}
    </article>
  );
}

function AutomationHistory({
  events,
  logs,
}: {
  events: AutomationEventRow[];
  logs: AutomationRunLogRow[];
}) {
  const logsByQueue = new Map<bigint, AutomationRunLogRow[]>();
  for (const log of logs) {
    const list = logsByQueue.get(log.queueId) ?? [];
    list.push(log);
    logsByQueue.set(log.queueId, list);
  }

  return (
    <div className="border-t border-neutral-200 bg-neutral-50 px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900/40">
      {events.length === 0 ? (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">No runs yet.</p>
      ) : (
        <ol className="space-y-3">
          {events.slice(0, 10).map((event) => (
            <li key={String(event.id)} className="text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge
                  tone={
                    event.status.tag === "Completed"
                      ? "enabled"
                      : event.status.tag === "Failed"
                        ? "error"
                        : "disabled"
                  }
                >
                  {event.status.tag}
                </StatusBadge>
                <span className="font-medium text-neutral-700 dark:text-neutral-300">
                  {event.triggerKind.tag}
                </span>
                <span className="text-neutral-400">
                  {formatTimestamp(event.createdAt.microsSinceUnixEpoch)}
                </span>
                {event.invokedBy && (
                  <span
                    className="text-neutral-400"
                    title={event.invokedBy.toHexString()}
                  >
                    by {event.invokedBy.toHexString().slice(0, 8)}…
                  </span>
                )}
                {event.idempotencyKey && (
                  <span className="text-neutral-400" title={event.idempotencyKey}>
                    retry {event.idempotencyKey.slice(0, 18)}
                    {event.idempotencyKey.length > 18 ? "…" : ""}
                  </span>
                )}
              </div>
              {event.error && (
                <p className="mt-1 text-red-700 dark:text-red-400">{event.error}</p>
              )}
              {(logsByQueue.get(event.id) ?? []).map((log) => (
                <div
                  key={String(log.id)}
                  className="mt-1 border-l-2 border-neutral-200 pl-2 text-neutral-500 dark:border-neutral-700 dark:text-neutral-400"
                >
                  <span className={log.success ? "" : "text-red-700 dark:text-red-400"}>
                    {log.dryRun ? "DryRun · " : "Live · "}
                    {log.message}
                  </span>
                </div>
              ))}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Metadata({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-neutral-400 dark:text-neutral-500">{label}</dt>
      <dd className="truncate font-medium text-neutral-700 dark:text-neutral-300" title={value}>
        {value}
      </dd>
    </div>
  );
}

function ConfigBlock({ title, raw }: { title: string; raw: string }) {
  return (
    <div>
      <h4 className="mb-1 text-xs font-semibold text-neutral-700 dark:text-neutral-300">
        {title}
      </h4>
      <pre className="max-h-40 overflow-auto rounded bg-neutral-100 p-2 text-[11px] text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400">
        {prettyAutomationJson(raw)}
      </pre>
    </div>
  );
}

function GraphRows({
  title,
  empty,
  rows,
}: {
  title: string;
  empty: string;
  rows: Array<{ id: bigint; label: string; raw: string }>;
}) {
  return (
    <div>
      <h4 className="mb-1 text-xs font-semibold text-neutral-700 dark:text-neutral-300">
        {title}
      </h4>
      {rows.length === 0 ? (
        <p className="text-xs text-neutral-400 dark:text-neutral-500">{empty}</p>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
            <div key={String(row.id)} className="rounded bg-neutral-50 p-2 dark:bg-neutral-900/60">
              <p className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
                {row.label}
              </p>
              <pre className="mt-1 overflow-auto text-[11px] text-neutral-500 dark:text-neutral-400">
                {prettyAutomationJson(row.raw)}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ControlButton({
  label,
  busy,
  disabled,
  strong = false,
  onClick,
}: {
  label: string;
  busy: boolean;
  disabled: boolean;
  strong?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        strong
          ? "rounded-md bg-neutral-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-neutral-700 disabled:opacity-40 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          : "rounded-md border border-neutral-200 px-2.5 py-1 text-xs text-neutral-700 hover:bg-neutral-50 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
      }
    >
      {busy ? "Working…" : label}
    </button>
  );
}

function StatusBadge({
  children,
  tone,
}: {
  children: string;
  tone: "live" | "dry" | "enabled" | "disabled" | "error";
}) {
  const colors = {
    live: "bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300",
    dry: "bg-sky-100 text-sky-700 dark:bg-sky-950/50 dark:text-sky-300",
    enabled: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300",
    disabled: "bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400",
    error: "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300",
  } as const;
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${colors[tone]}`}>
      {children}
    </span>
  );
}

function formatTimestamp(micros: bigint): string {
  return new Date(Number(micros / 1000n)).toLocaleString();
}
