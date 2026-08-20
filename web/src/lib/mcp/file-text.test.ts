import { describe, expect, test } from "vitest";
import {
  capText,
  decodeUtf8,
  describeMediaNode,
  extensionOf,
  extractorFor,
  isTextLikeType,
  looksLikeUtf8Text,
} from "./file-text";

describe("file-text", () => {
  test("extractorFor prefers MIME type, falls back to extension", () => {
    expect(extractorFor("application/pdf")).toBe("pdf");
    expect(extractorFor("application/octet-stream", "deck.PDF")).toBe("pdf");
    expect(extractorFor("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("docx");
    expect(extractorFor("application/octet-stream", "notes.docx")).toBe("docx");
    expect(extractorFor("text/csv")).toBe("utf8");
    expect(extractorFor("application/json")).toBe("utf8");
    expect(extractorFor("application/vnd.api+json")).toBe("utf8");
    expect(extractorFor("application/octet-stream", "script.py")).toBe("utf8");
    expect(extractorFor("application/zip", "bundle.zip")).toBe("none");
    expect(extractorFor(undefined, "photo.jpg")).toBe("none");
  });

  test("isTextLikeType handles parameters and case", () => {
    expect(isTextLikeType("text/plain; charset=utf-8")).toBe(true);
    expect(isTextLikeType("Application/JSON")).toBe(true);
    expect(isTextLikeType("image/png")).toBe(false);
    expect(isTextLikeType(undefined, "README.md")).toBe(true);
    expect(extensionOf("archive.tar.gz")).toBe("gz");
    expect(extensionOf(undefined)).toBe("");
  });

  test("looksLikeUtf8Text rejects NUL bytes and invalid sequences", () => {
    expect(looksLikeUtf8Text(new TextEncoder().encode("plain text\nline 2"))).toBe(true);
    expect(looksLikeUtf8Text(new TextEncoder().encode("héllo wörld ✓"))).toBe(true);
    expect(looksLikeUtf8Text(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]))).toBe(false);
    expect(looksLikeUtf8Text(new Uint8Array([0xff, 0xfe, 0xfd, 0x41]))).toBe(false);
  });

  test("decodeUtf8 strips a BOM; capText reports truncation", () => {
    expect(decodeUtf8(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]))).toBe("hi");
    expect(capText("abcdef", 3)).toEqual({ text: "abc", truncated: true });
    expect(capText("abc", 3)).toEqual({ text: "abc", truncated: false });
  });

  test("describeMediaNode renders handles and ignores non-media types", () => {
    expect(
      describeMediaNode({
        componentType: "FileBlock",
        props: JSON.stringify({ storageKey: "k1", filename: "a.csv", contentType: "text/csv", sizeBytes: 2048 }),
      }),
    ).toBe('[File: "a.csv" (2 KB, text/csv) storage_key=k1]');
    expect(describeMediaNode({ componentType: "ImageBlock", props: JSON.stringify({ storageKey: "k2" }) })).toBe(
      "[Image: storage_key=k2]",
    );
    expect(describeMediaNode({ componentType: "Audio", props: "{}" })).toBe("[Audio:]");
    expect(describeMediaNode({ componentType: "Image", props: JSON.stringify({ attachmentId: 5 }) })).toBe(
      "[Image attachment_id=5]",
    );
    expect(describeMediaNode({ componentType: "FileBlock", props: "not json" })).toBe("[File:]");
    expect(describeMediaNode({ componentType: "RichText", props: "{}" })).toBeUndefined();
  });
});
