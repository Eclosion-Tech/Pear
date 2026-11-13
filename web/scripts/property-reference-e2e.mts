/** Disposable localhost test: registry, independent placement, persistence, and source permissions. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { HttpStdbTransport } from "../src/lib/api-endpoint/http-transport";
import { createPropertyReference, readPageInterface } from "@pear/trellis-ui";
import { readPropertyReferenceValue } from "../src/lib/mcp/property-references";
import { getPageComponents } from "../src/lib/mcp/authoring";
import { readComponentTreeDoc } from "../src/lib/mcp/component-tree";

async function main() {
  const base = process.argv[2] ?? "http://127.0.0.1:3117";
  assert(["localhost", "127.0.0.1"].includes(new URL(base).hostname), "Localhost only");
  const name = `pear-property-e2e-${Date.now()}`;
  const url = `${base}/v1/database/${name}`;
  const sockets: WebSocket[] = [];
  const none = { none: [] };
  const identity = async () => await (await fetch(`${base}/v1/identity`, { method: "POST" })).json() as { identity: string; token: string };
  const publisher = await identity();
  const admin = new HttpStdbTransport({ baseUrl: base, dbName: name, token: publisher.token });
  async function actor() {
    const account = await identity();
    const socket = new WebSocket(`${url.replace("http:", "ws:")}/subscribe?token=${encodeURIComponent(account.token)}`, "v1.json.spacetimedb");
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Connect timeout")), 10000);
      socket.addEventListener("message", (event) => {
        if (JSON.parse(String(event.data)).IdentityToken) { clearTimeout(timer); resolve(); }
      });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(Error("Connection failed")); });
    });
    return { ...account, db: new HttpStdbTransport({ baseUrl: base, dbName: name, token: account.token }) };
  }
  try {
    const wasm = await readFile(new URL("../../server/spacetimedb/target/wasm32-unknown-unknown/release/server.wasm", import.meta.url));
    const publish = await fetch(url, { method: "PUT", headers: { Authorization: `Bearer ${publisher.token}` }, body: wasm });
    assert(publish.ok, await publish.text());
    await admin.call("run_pending_migrations", []);
    await admin.call("run_pending_migrations", []);
    const owner = await actor(), reader = await actor();
    await owner.db.call("register", ["owner@example.test", "Owner", "property-test-password"]);
    await owner.db.call("create_local_user", ["reader@example.test", "Reader", "property-test-password"]);
    await reader.db.call("login", ["reader@example.test", "property-test-password"]);
    const pages = () => admin.sql<{id:number;title:string}>("SELECT id,title FROM page");
    const findPage = async (title:string) => (await pages()).find(p=>p.title===title)!.id;
    await owner.db.call("create_page", [none,{database:[]},"Records"]);
    const database = await findPage("Records");
    await owner.db.call("create_database_schema",[database,"Records"]);
    const schema = (await admin.sql<{id:number}>("SELECT id FROM database_schema"))[0].id;
    await owner.db.call("add_property",[schema,"Summary",{text:[]},"{}"]);
    const property = (await admin.sql<{id:number}>("SELECT id FROM property_definition"))[0].id;
    await owner.db.call("create_component_tree_page",[{some:database},{doc:[]},"Template"]);
    await owner.db.call("create_component_tree_page",[{some:database},{doc:[]},"Chosen source"]);
    await owner.db.call("create_component_tree_page",[none,{doc:[]},"Destination"]);
    const template = await findPage("Template"), chosen = await findPage("Chosen source"), destination = await findPage("Destination");
    const nodes = (page:number) => admin.sql<{id:number;component_type:string;props:string;parent_id:[number,unknown]}>(`SELECT * FROM component_node WHERE surface_id = ${page}`);
    const root = async(page:number) => (await nodes(page)).find(n=>n.parent_id[0]===1)!.id;
    const self = createPropertyReference(String(schema),String(property));
    const explicit = createPropertyReference(String(schema),String(property),String(chosen));
    await owner.db.call("insert_component",[await root(template),"TrellisPanel",JSON.stringify({templateId:"trellis.note-form",templateVersion:"1.0.0",parameters:{}}),none]);
    for(const ref of [self,explicit]) await owner.db.call("insert_component",[await root(template),"PropertyReference",JSON.stringify(ref),none]);
    await owner.db.call("set_property_value",[chosen,property,{text:"Chosen\n\nComplete value <b>literal</b>"}]);
    for(const title of ["First record","Second record"]) await owner.db.call("create_page_from_template",[template,{some:database},title]);
    const first=await findPage("First record"), second=await findPage("Second record");
    for(const [record,text] of [[first,"First\n\nSummary"],[second,"Second\n\nSummary"]] as const) {
      await owner.db.call("set_property_value",[record,property,{text}]);
      const refs=(await nodes(record)).filter(n=>n.component_type==="PropertyReference").map(n=>JSON.parse(n.props));
      const component=(await nodes(record)).find(n=>n.component_type==="TrellisPanel")!;
      assert.equal(readPageInterface(component.props,String(record),String(component.id)).document.documentId,`pear-page:${record}:component:${component.id}`);
      assert.equal(refs.length,2);assert(refs.some(r=>JSON.stringify(r)===JSON.stringify(self)));assert(refs.some(r=>JSON.stringify(r)===JSON.stringify(explicit)));
      assert.equal((await readPropertyReferenceValue(owner.db,self,String(record)) as any).value,text);
      assert.equal((await readPropertyReferenceValue(owner.db,explicit,String(record)) as any).value,"Chosen\n\nComplete value <b>literal</b>");
    }
    await owner.db.call("create_page_from_template",[first,{some:database},"Duplicate"]);
    assert.equal((await readPropertyReferenceValue(owner.db,explicit,String(await findPage("Duplicate"))) as any).source.page_id,String(chosen));
    await owner.db.call("set_page_access_rule",[database,[`0x${owner.identity}`],{write:[]}]);
    await owner.db.call("set_page_access_rule",[database,[`0x${reader.identity}`],{read:[]}]);
    await reader.db.call("insert_component",[await root(destination),"PropertyReference",JSON.stringify(explicit),none]);
    assert.equal((await readPropertyReferenceValue(reader.db,explicit,String(destination))).status,"ready");
    await assert.rejects(reader.db.call("set_property_value",[chosen,property,{text:"forbidden"}]));
    await assert.rejects(reader.db.call("create_page_from_template",[template,{some:database},"Forbidden clone"]));
    await owner.db.call("clear_page_access_rule",[database,[`0x${reader.identity}`]]);
    assert.deepEqual(await readPropertyReferenceValue(reader.db,explicit,String(destination)),{status:"unavailable"});
    const denied=await getPageComponents(reader.db,destination);assert(!JSON.stringify(denied).includes("Chosen source"));assert(!JSON.stringify(denied).includes("Complete value"));
    await owner.db.call("set_page_access_rule",[database,[`0x${reader.identity}`],{read:[]}]);
    assert.equal((await readPropertyReferenceValue(reader.db,explicit,String(destination))).status,"ready");
    await owner.db.call("rename_property",[property,"Renamed summary"]);
    await owner.db.call("set_property_value",[chosen,property,{text:"Live update"}]);
    const live=await readPropertyReferenceValue(reader.db,explicit,String(destination));assert.equal((live as any).value,"Live update");assert.equal((live as any).property_name,"Renamed summary");
    const content=await readComponentTreeDoc(reader.db,destination);assert(content?.includes("Live update"));
    await owner.db.call("set_property_value",[chosen,property,{text:""}]);assert.equal((await readPropertyReferenceValue(reader.db,explicit,String(destination)) as any).value,"");
    await assert.rejects(owner.db.call("insert_component",[await root(destination),"PropertyReference",JSON.stringify({...explicit,value:"cached secret"}),none]));
    await owner.db.call("delete_property",[property]);
    await owner.db.call("add_property",[schema,"Renamed summary",{text:[]},"{}"]);
    assert.deepEqual(await readPropertyReferenceValue(reader.db,explicit,String(destination)),{status:"unsupported"});
    console.log("PASS: local persisted self/explicit references, two template records, duplication, live agent readback, rename/delete, empty values, source ACL denial/revocation/restoration and malformed-reference rejection");
  } finally {
    sockets.forEach((socket) => socket.close());
    await fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${publisher.token}` } });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
