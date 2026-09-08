/** Live regression suite; creates/removes its own localhost-only database.
 * Build the release WASM first; run pnpm exec tsx scripts/access-control-e2e.ts.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { HttpStdbTransport } from '../src/lib/api-endpoint/http-transport';
async function main() {
    const base = process.argv[2] ?? 'http://127.0.0.1:3098';
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname));
    const name = `pear-access-e2e-${Date.now()}`, db = `${base}/v1/database/${name}`;
    const none = { none: [] }, some = (x: unknown) => ({ some: x }), ident = (x: string) => [`0x${x}`];
    let passes = 0;
    function check(label: string, ok: unknown) { assert(ok, label); console.log(`PASS ${++passes}: ${label}`); }
    async function request(url: string, token?: string, body?: any, method = 'POST') {
        const r = await fetch(url, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(url.includes('/call/') ? { 'Content-Type': 'application/json' } : {}) }, body });
        const text = await r.text();
        if (!r.ok)
            throw Error(`${r.status}: ${text}`);
        return text ? JSON.parse(text) : undefined;
    }
    type Actor = {
        identity: string;
        token: string;
        transport: HttpStdbTransport;
        socket?: WebSocket;
    };
    const sockets: WebSocket[] = [];
    async function actor(connect = true): Promise<Actor> {
        const a = await request(`${base}/v1/identity`) as Actor;
        a.transport = new HttpStdbTransport({ baseUrl: base, dbName: name, token: a.token });
        if (connect) {
            const ws = a.socket = new WebSocket(`${db.replace(/^http/, 'ws')}/subscribe?token=${encodeURIComponent(a.token)}`, 'v1.json.spacetimedb');
            sockets.push(ws);
            await new Promise<void>((ok, fail) => { const timer = setTimeout(() => fail(Error('Connection timeout')), 8000); ws.addEventListener('message', e => { if (JSON.parse(String(e.data)).IdentityToken) {
                clearTimeout(timer);
                ok();
            } }); ws.addEventListener('error', () => { clearTimeout(timer); fail(Error('Connection failed')); }); });
        }
        return a;
    }
    const owner = await actor(false);
    const call = (a: Actor, n: string, args: unknown[]) => a.transport.call(n, args);
    const rows = (a: Actor, t: string) => a.transport.sql<Record<string, any>>(`SELECT * FROM ${t}`);
    async function denied(label: string, a: Actor, n: string, args: unknown[]) { await assert.rejects(call(a, n, args)); check(label, true); }
    async function page(a: Actor, title: string, parent: number | null = null) { await call(a, 'create_page', [parent === null ? none : some(parent), { doc: [] }, title]); return Number((await rows(owner, 'page')).find(p => p.title === title)!.id); }
    async function waitFor(fn: () => boolean, label: string) { const until = Date.now() + 6000; while (Date.now() < until) {
        if (fn())
            return;
        await new Promise(r => setTimeout(r, 20));
    } throw Error(`Timed out: ${label}`); }
    try {
        const wasm = await readFile(new URL('../../server/spacetimedb/target/wasm32-unknown-unknown/release/server.wasm', import.meta.url));
        await request(db, owner.token, wasm, 'PUT');
        const admin = await actor();
        await call(admin, 'register', ['admin@example.test', 'Admin', 'fixture-password']);
        const alice = await actor(), bob = await actor(), anonymous = await actor(), ai = await actor(), otherAI = await actor();
        for (const [a, n] of [[alice, 'alice'], [bob, 'bob']] as const) {
            await call(admin, 'create_local_user', [`${n}@example.test`, n, 'fixture-password']);
            await call(a, 'login', [`${n}@example.test`, 'fixture-password']);
        }
        for (const [a, n] of [[ai, 'Agent'], [otherAI, 'Other Agent']] as const)
            await call(owner, 'create_ai_user', [ident(a.identity), ident(admin.identity), n, { anthropic: [] }, 'fixture', none, none, none, none, none]);
        const open = await page(admin, 'Open page'), root = await page(admin, 'Private root');
        await call(admin, 'set_page_access_rule', [root, ident(ai.identity), { write: [] }]);
        const child = await page(admin, 'Inherited child', root);
        const component = (await rows(owner, 'component_node')).find(n => Number(n.surface_id) === child && n.component_type === 'RichText')!;
        await call(owner, 'save_component_yjs_state', [Number(component.id), [1, 2, 3]]);
        await call(owner, 'take_snapshot', [child, { manual: [] }]);
        await call(owner, 'create_database_schema', [child, 'Private schema']);
        const schema = Number((await rows(owner, 'database_schema'))[0].id);
        await call(owner, 'add_property', [schema, 'Secret', { text: [] }, '{}']);
        const property = Number((await rows(owner, 'property_definition'))[0].id);
        await call(owner, 'set_property_value', [child, property, { text: 'private cell' }]);
        await call(owner, 'create_view', [child, 'Private view', { grid: [] }, none]);
        for (const table of ['database_schema', 'property_definition', 'page_property_value', 'page_property_value_history', 'database_view']) {
            check(`other agent cannot read ${table}`, (await rows(otherAI, table)).length === 0);
            check(`owning agent can read ${table}`, (await rows(ai, table)).length === 1);
        }
        check('anonymous cannot read pages', (await rows(anonymous, 'page')).length === 0);
        check('anonymous cannot read component rows', (await rows(anonymous, 'component_node')).length === 0);
        check('member reads unrestricted page', (await rows(alice, 'page')).some(p => Number(p.id) === open));
        check('member cannot read restricted subtree', (await rows(alice, 'page')).every(p => ![root, child].includes(Number(p.id))));
        check('owning AI reads inherited child', (await rows(ai, 'page')).some(p => Number(p.id) === child));
        check('other AI cannot read private subtree', (await rows(otherAI, 'page')).every(p => ![root, child].includes(Number(p.id))));
        check('other AI cannot read component bytes', (await rows(otherAI, 'component_yjs_state')).length === 0);
        check('other AI cannot read snapshots', (await rows(otherAI, 'page_snapshot')).length === 0);
        check('owning AI can read component bytes', (await rows(ai, 'component_yjs_state')).length === 1);
        check('admin page override preserved', (await rows(admin, 'page')).some(p => Number(p.id) === child));
        await denied('anonymous page overwrite denied', anonymous, 'update_page_title', [open, 'corrupt']);
        await denied('anonymous root creation denied', anonymous, 'create_page', [none, { doc: [] }, 'injected']);
        await denied('anonymous ACL mutation denied', anonymous, 'set_page_access_rule', [open, ident(anonymous.identity), { write: [] }]);
        await denied('anonymous saved view write denied', anonymous, 'create_view', [open, 'Injected', { grid: [] }, none]);
        await denied('anonymous snapshot denied', anonymous, 'take_snapshot', [open, { manual: [] }]);
        await denied('anonymous AI provisioning denied', anonymous, 'create_ai_user', [ident(anonymous.identity), ident(anonymous.identity), 'Forged', { anthropic: [] }, 'fixture', none, none, none, none, none]);
        await denied('registration cannot bypass membership', anonymous, 'register', ['intruder@example.test', 'Intruder', 'fixture-password']);
        await call(admin, 'set_page_access_rule', [root, ident(alice.identity), { read: [] }]);
        check('HTTP read grant works', (await rows(alice, 'page')).some(p => Number(p.id) === child));
        await denied('read-only parent forbids child writes', alice, 'update_page_title', [child, 'corrupt']);
        await call(admin, 'clear_page_access_rule', [root, ident(alice.identity)]);
        const raw = await request(db + '/sql', alice.token, 'SELECT * FROM page');
        check('raw HTTP cannot reuse revoked view access', raw[0].rows.every((r: any[]) => Number(r[0]) !== child));
        await call(alice, 'create_conversation', [some(open), [ident(ai.identity)], none]);
        const conv = Number((await rows(owner, 'conversation'))[0].id);
        await call(alice, 'send_user_message', [conv, 'private conversation', []]);
        check('private conversation visible to participant', (await rows(ai, 'conversation')).some(c => Number(c.id) === conv));
        check('private conversation hidden from nonparticipant', (await rows(bob, 'conversation')).length === 0);
        check('private messages hidden from nonparticipant', (await rows(bob, 'conversation_message')).length === 0);
        check('admin cannot read private conversations', (await rows(admin, 'conversation')).length === 0);
        await denied('admin cannot self-add to private chat', admin, 'add_conversation_participant', [conv, ident(admin.identity)]);
        await denied('admin cannot expose private chat', admin, 'set_conversation_visibility', [conv, { pageInheriting: [] }]);
        await denied('page writer cannot close private sidebar', bob, 'close_conversation', [conv]);
        await denied('page writer cannot inject private messages', bob, 'send_user_message', [conv, 'injected', []]);
        await denied('anonymous detached conversation denied', anonymous, 'create_conversation', [none, [], none]);
        const visible = new Map<string, Set<number>>();
        let initial = false, error = '';
        alice.socket!.addEventListener('message', e => {
            const m = JSON.parse(String(e.data));
            if (m.TransactionUpdate?.status?.Failed)
                error = m.TransactionUpdate.status.Failed;
            const update = m.InitialSubscription?.database_update ?? m.TransactionUpdate?.status?.Committed ?? m.TransactionUpdateLight?.update;
            for (const t of update?.tables ?? []) {
                const set = visible.get(t.table_name) ?? new Set<number>();
                visible.set(t.table_name, set);
                for (const u of t.updates ?? []) {
                    for (const r of u.deletes ?? []) {
                        const row = typeof r === 'string' ? JSON.parse(r) : r;
                        set.delete(Number(row.id ?? row.component_node_id));
                    }
                    for (const r of u.inserts ?? []) {
                        const row = typeof r === 'string' ? JSON.parse(r) : r;
                        set.add(Number(row.id ?? row.component_node_id));
                    }
                }
            }
            if (m.InitialSubscription)
                initial = true;
        });
        alice.socket!.send(JSON.stringify({ Subscribe: { query_strings: ['page', 'page_content', 'page_yjs_state', 'attachment', 'page_snapshot', 'page_access_rule', 'block_access_rule', 'page_property_value', 'page_property_value_history', 'database_schema', 'database_view', 'component_node', 'ai_user_memory', 'component_yjs_state', 'property_definition', 'conversation', 'conversation_message', 'conversation_participant', 'conversation_attachment', 'page_access_request', 'database_row_marker', 'ai_evaluation'].map(t => `SELECT * FROM ${t}`), request_id: 1 } }));
        await waitFor(() => initial || Boolean(error), 'initial subscription');
        assert.equal(error, '');
        check('protected live subscriptions accepted', initial);
        await call(admin, 'set_page_access_rule', [root, ident(alice.identity), { read: [] }]);
        await waitFor(() => visible.get('page')?.has(child) === true && visible.get('component_yjs_state')?.has(Number(component.id)) === true, 'live grant');
        check('live grant delivers page and bytes', true);
        await call(admin, 'clear_page_access_rule', [root, ident(alice.identity)]);
        await waitFor(() => visible.get('page')?.has(child) === false && visible.get('component_yjs_state')?.has(Number(component.id)) === false, 'live revocation');
        check('live revocation removes page and bytes', true);
        await call(alice, 'add_conversation_participant', [conv, ident(bob.identity)]);
        check('added participant reads history', (await rows(bob, 'conversation_message')).length === 1);
        await call(alice, 'remove_conversation_participant', [conv, ident(bob.identity)]);
        check('removed participant loses history', (await rows(bob, 'conversation_message')).length === 0);
        await denied('removed participant cannot send', bob, 'send_user_message', [conv, 'injected', []]);
        await call(alice, 'set_conversation_visibility', [conv, { pageInheriting: [] }]);
        check('page-inheriting conversation follows page rights', (await rows(bob, 'conversation_message')).length === 1);
        await call(alice, 'logout', []);
        await waitFor(() => visible.get('page')?.size === 0, 'logout');
        check('logout revokes live reads', true);
        console.log(`\n${passes} live access-control checks passed.`);
    }
    finally {
        for (const s of sockets)
            s.close();
        await request(db, owner.token, undefined, 'DELETE').catch(() => { });
    }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
