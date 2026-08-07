"use client";

import { useReducer, useTable } from "spacetimedb/react";
import { reducers, tables } from "@/src/module_bindings";

function severityColor(severity: string) {
  switch (severity) {
    case "error":
      return "bg-rose-500";
    case "warn":
      return "bg-amber-500";
    default:
      return "bg-sky-500";
  }
}

export function WorkspaceHealthSettings() {
  const [findings] = useTable(tables.structural_sensor_finding);
  const resolveFinding = useReducer(reducers.resolveStructuralFinding);
  const openFindings = findings
    .filter((finding) => !finding.resolvedAt)
    .sort((a, b) =>
      Number(
        b.lastSeenAt.microsSinceUnixEpoch -
          a.lastSeenAt.microsSinceUnixEpoch,
      ),
    );

  return (
    <section className="mb-10">
      <h2 className="mb-1 text-sm font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
        Workspace health
      </h2>
      <p className="mb-4 text-sm text-neutral-500 dark:text-neutral-400">
        Structural checks surface orphaned records and relational integrity
        issues in this workspace.
      </p>

      {openFindings.length === 0 ? (
        <div className="rounded-lg border border-neutral-200 px-4 py-3 text-sm text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
          No open structural findings.
        </div>
      ) : (
        <div className="divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {openFindings.slice(0, 25).map((finding) => (
            <div
              key={String(finding.id)}
              className="flex items-start gap-3 px-4 py-3"
            >
              <span
                className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${severityColor(finding.severity)}`}
                title={`${finding.sensorKind} · ${finding.severity}`}
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
                  {finding.message}
                </p>
                <p className="mt-0.5 text-xs text-neutral-400 dark:text-neutral-500">
                  {finding.sensorKind} · {finding.code}
                </p>
              </div>
              <button
                type="button"
                onClick={() =>
                  void resolveFinding({ findingId: finding.id })
                }
                className="shrink-0 rounded px-2 py-1 text-xs text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
              >
                Resolve
              </button>
            </div>
          ))}
          {openFindings.length > 25 && (
            <p className="px-4 py-2 text-xs text-neutral-400 dark:text-neutral-500">
              Showing the 25 most recent of {openFindings.length} open findings.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
