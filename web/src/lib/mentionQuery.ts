export type MentionQuery = {
  /** Index of the triggering `@`. */
  start: number;
  /** Exclusive end of the query text around the caret. */
  end: number;
  /** Text between `@` and `end`. */
  query: string;
};

const WORD_CHARACTER = /[\p{L}\p{N}_]/u;
const QUERY_TERMINATOR = /[\r\n\t@,!?;:()[\]{}<>"]/u;

/**
 * Find the mention being edited at `caretIndex`.
 *
 * Spaces are deliberately allowed so AI display names such as "Release
 * Manager" can be completed. Punctuation/newlines end the active span, and an
 * `@` immediately following a word character is not a mention trigger.
 */
export function findActiveMentionQuery(
  value: string,
  caretIndex: number,
): MentionQuery | null {
  const caret = Math.max(0, Math.min(caretIndex, value.length));
  const start = value.lastIndexOf("@", caret - 1);
  if (start < 0) return null;

  const preceding = value[start - 1];
  if (preceding && WORD_CHARACTER.test(preceding)) return null;

  for (let i = start + 1; i < caret; i += 1) {
    if (QUERY_TERMINATOR.test(value[i])) return null;
  }

  let end = caret;
  while (end < value.length && !QUERY_TERMINATOR.test(value[end])) {
    end += 1;
  }

  return {
    start,
    end,
    query: value.slice(start + 1, end),
  };
}

/** Replace an active query with the server-resolvable plain-text mention. */
export function insertMention(
  value: string,
  mention: Pick<MentionQuery, "start" | "end">,
  displayName: string,
): { value: string; caretIndex: number } {
  const replacement = `@${displayName} `;
  return {
    value: value.slice(0, mention.start) + replacement + value.slice(mention.end),
    caretIndex: mention.start + replacement.length,
  };
}
