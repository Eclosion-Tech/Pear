import { describe, expect, it } from "vitest";
import { canReadBlob } from "./blob-access";
import type { StdbTransport } from "./types";

describe("immutable blob ownership", () => {
  it("uses the stored context and rechecks access after revocation", async () => {
    let allowed = true;
    const queries: string[] = [];
    const transport = { sql: async (query: string) => { queries.push(query); return allowed ? [{ id: 42 }] : []; } } as unknown as StdbTransport;
    const binding = { created_by: "uploader", resource_kind: "page" as const, resource_id: "42" };
    expect(await canReadBlob(binding, transport, "uploader")).toBe(true);
    allowed = false;
    expect(await canReadBlob(binding, transport, "uploader")).toBe(false);
    expect(queries).toEqual(["SELECT id FROM page WHERE id = 42", "SELECT id FROM page WHERE id = 42"]);
  });
  it("denies unknown/unscoped blobs except to their uploader, without trusting references", async () => {
    const transport = { sql: async () => { throw Error("must not infer permissions from references"); } } as unknown as StdbTransport;
    const old = { created_by: "alice", resource_kind: null, resource_id: null };
    expect(await canReadBlob(null, transport, "alice")).toBe(false);
    expect(await canReadBlob(old, transport, "bob")).toBe(false);
    expect(await canReadBlob(old, transport)).toBe(false);
    expect(await canReadBlob(old, transport, "alice")).toBe(true);
    expect(await canReadBlob({ ...old, resource_kind: "page", resource_id: "1 OR 1=1" }, transport)).toBe(false);
  });
});
