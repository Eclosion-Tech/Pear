"use client";

import type { BlockRendererProps } from "@eclosion-tech/pulp";

type Alignment = "left" | "center" | "right";

function readTableProps(raw: string): {
  headers: string[];
  rows: string[][];
  alignments: Alignment[];
} {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const headers = Array.isArray(value.headers) ? value.headers.map(String) : [];
    const rows = Array.isArray(value.rows)
      ? value.rows.map((row) =>
          Array.isArray(row) ? headers.map((_, index) => String(row[index] ?? "")) : [],
        )
      : [];
    const alignments = headers.map((_, index) => {
      const alignment = Array.isArray(value.alignments) ? value.alignments[index] : undefined;
      return alignment === "center" || alignment === "right" ? alignment : "left";
    });
    return { headers, rows, alignments };
  } catch {
    return { headers: [], rows: [], alignments: [] };
  }
}

/** Read-only static table emitted by the GFM markdown converter. */
export function MarkdownTableRenderer({ node }: BlockRendererProps) {
  const { headers, rows, alignments } = readTableProps(node.props);
  if (headers.length === 0) return null;

  return (
    <div className="my-3 overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            {headers.map((header, index) => (
              <th
                key={`${index}-${header}`}
                className="border border-neutral-200 bg-neutral-50 px-3 py-2 font-medium text-neutral-800 dark:border-neutral-700 dark:bg-neutral-800/70 dark:text-neutral-100"
                style={{ textAlign: alignments[index] }}
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {headers.map((_, columnIndex) => (
                <td
                  key={columnIndex}
                  className="border border-neutral-200 px-3 py-2 text-neutral-700 dark:border-neutral-700 dark:text-neutral-200"
                  style={{ textAlign: alignments[columnIndex] }}
                >
                  {row[columnIndex] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
