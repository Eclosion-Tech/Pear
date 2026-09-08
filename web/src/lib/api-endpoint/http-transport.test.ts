import { describe, expect, test, vi } from "vitest";
import { HttpStdbTransport } from "./http-transport";
const reply = (name: string, value: unknown) => new Response(JSON.stringify([
    { schema: { elements: [{ name: { some: name } }] }, rows: [[value]] },
]));
const create = (fetchImpl: typeof fetch, token = "actor-a") => new HttpStdbTransport({
    baseUrl: "http://localhost:3098", dbName: "fixture", token, fetchImpl,
});
describe("caller-scoped HTTP reads", () => {
    test("initializes only the required view and returns requested data", async () => {
        const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => String(init?.body).startsWith("SELECT COUNT") ? reply("count", 10) : reply("title", "Allowed"));
        const transport = create(fetchImpl as typeof fetch);
        await expect(transport.sql("SELECT title FROM page WHERE id = ?", [3])).resolves.toEqual([{ title: "Allowed" }]);
        expect(fetchImpl.mock.calls.map(([, init]) => init?.body)).toEqual([
            "SELECT COUNT(*) AS count FROM readable_pages", "SELECT title FROM page WHERE id = 3",
        ]);
        await transport.sql("SELECT title FROM page");
        expect(fetchImpl).toHaveBeenCalledTimes(3);
    });
    test("coalesces initialization per transport, never across identities", async () => {
        const fetchImpl = vi.fn(async () => reply("id", 1));
        const first = create(fetchImpl as typeof fetch);
        await Promise.all([first.sql("SELECT * FROM page"), first.sql("SELECT * FROM page_content")]);
        const second = create(fetchImpl as typeof fetch, "actor-b");
        await second.sql("SELECT * FROM page");
        const preludes = fetchImpl.mock.calls.filter(([, init]: any) => String(init?.body).startsWith("SELECT COUNT"));
        expect(preludes).toHaveLength(2);
        expect(preludes.map(([, init]: any) => init.headers.Authorization)).toEqual(["Bearer actor-a", "Bearer actor-b"]);
    });
    test("fails closed and retries initialization after an error", async () => {
        let fail = true;
        const bodies: string[] = [];
        const transport = create((async (_url, init) => {
            bodies.push(String(init?.body));
            if (fail) {
                fail = false;
                return new Response("view unavailable", { status: 503 });
            }
            return reply("id", 1);
        }) as typeof fetch);
        await expect(transport.sql("SELECT * FROM conversation_message")).rejects.toThrow("view unavailable");
        expect(bodies).toEqual(["SELECT COUNT(*) AS count FROM readable_conversations"]);
        await expect(transport.sql("SELECT * FROM conversation_message")).resolves.toEqual([{ id: 1 }]);
        expect(bodies).toHaveLength(3);
    });
    test("does not change unprotected identity/config reads", async () => {
        const fetchImpl = vi.fn(async () => reply("id", 4));
        await expect(create(fetchImpl as typeof fetch).sql("SELECT id FROM ai_user_config")).resolves.toEqual([{ id: 4 }]);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
});
