import { describe, expect, test } from "vitest";
import { findActiveMentionQuery, insertMention } from "./mentionQuery";

describe("findActiveMentionQuery", () => {
  test("detects a trigger at a word boundary", () => {
    expect(findActiveMentionQuery("Ask @rel", 8)).toEqual({
      start: 4,
      end: 8,
      query: "rel",
    });
  });

  test("returns the query span up to punctuation", () => {
    expect(findActiveMentionQuery("Ask (@release), please", 12)).toEqual({
      start: 5,
      end: 13,
      query: "release",
    });
  });

  test("does not trigger for an at-sign in the middle of a word", () => {
    expect(findActiveMentionQuery("email@example", 13)).toBeNull();
  });

  test("includes the full query when the caret is in its middle", () => {
    expect(findActiveMentionQuery("Ask @Release Manager!", 9)).toEqual({
      start: 4,
      end: 20,
      query: "Release Manager",
    });
  });
});

describe("insertMention", () => {
  test("replaces the active query and places the caret after a trailing space", () => {
    const mention = findActiveMentionQuery("Ask @Rel!", 8);
    expect(mention).not.toBeNull();

    expect(insertMention("Ask @Rel!", mention!, "Release Manager")).toEqual({
      value: "Ask @Release Manager !",
      caretIndex: 21,
    });
  });

  test("replaces the entire query when the caret is in its middle", () => {
    const value = "Ask @Relase Manager!";
    const mention = findActiveMentionQuery(value, 9);
    expect(mention).not.toBeNull();

    expect(insertMention(value, mention!, "Release Manager")).toEqual({
      value: "Ask @Release Manager !",
      caretIndex: 21,
    });
  });
});
