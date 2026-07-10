/** Format Pear Date-column values as timezone-neutral calendar dates. */
export function formatDateOnly(
  timestampMs: number,
  locales?: Intl.LocalesArgument,
): string {
  if (!Number.isFinite(timestampMs)) return "";
  return new Intl.DateTimeFormat(locales, { timeZone: "UTC" }).format(
    new Date(timestampMs),
  );
}

/** Canonical YYYY-MM-DD key for Date-column comparisons and date inputs. */
export function dateOnlyKey(timestampMs: number): string {
  if (!Number.isFinite(timestampMs)) return "";
  return new Date(timestampMs).toISOString().slice(0, 10);
}
