import { componentActionInput, componentSourceCreate, componentSourceWrite, readAuthoredComponent, createAuthoredComponent, commitAuthoredComponent, observeComponentCommit, componentCatalog, authorizeComponentWrite, type AuthoredComponent, type ComponentCommit, type ComponentCommand, canonicalJson, sha256, TrellisError, describePatchContract, createRetainedInterface, interfaceCreationFingerprint, commitRetainedInterface, observeInterfaceCommit, interfaceDefinition, interfaceCatalog, type RetainedInterface, type InterfaceCreate, type InterfaceCommand, type JsonObject, type InterfaceRegistry } from "@eclosion-tech/trellis";
import {
  PAGE_PANEL_TYPE,
  PAGE_PANEL_TEMPLATE,
  readPagePanel,
  panelId,
  panelRequestId,
  panelChanges,
  commitObservedPagePanel,
  PanelCommitError,
  type PagePanel,
  INTERFACE_REGISTRY,
  isAuthoredPageComponent, readPageComponent, isRetainedPageInterface,
  readPageInterface,
} from "@pear/trellis-ui";
import type { McpContext, McpToolEntry, StdbTransport } from "./types.js";
import { isOptionNone } from "../api-endpoint/codec.js";
import { reducerErrorMessage } from "./errors.js";
import { panelRegistry, workspaceTemplateFamilies, workspaceTemplate } from "./component-repository-store";

type RawNode = {
  id: unknown;
  surface_id: unknown;
  component_type: string;
  props: string;
  deleted_at: unknown;
};
function fail(code: string, message: string): never {
  throw new PanelCommitError(code, message);
}
function exact(input: Record<string, unknown>, fields: string[]) {
  if (Object.keys(input).some((key) => !fields.includes(key)))
    fail("INVALID_INPUT", "Unexpected page-panel arguments.");
}
function sqlId(raw: unknown): string {
  if (typeof raw === "number" && !Number.isSafeInteger(raw))
    fail("UNSAFE_ID", "The database transport rounded an opaque ID.");
  return panelId(String(raw));
}
function identity(raw: unknown): string {
  if (Array.isArray(raw) && raw.length === 1) return identity(raw[0]);
  if (raw && typeof raw === "object") {
    const row = raw as Record<string, unknown>;
    return identity(row.__identity__ ?? row.identity ?? row.value);
  }
  if (typeof raw !== "string" || !/^(0x)?[a-f0-9]{64}$/i.test(raw))
    fail("AUTHORIZATION_DENIED", "Caller identity is unavailable.");
  return raw.replace(/^0x/i, "").toLowerCase();
}
async function caller(ctx: McpContext): Promise<string> {
  const rows = await ctx.transport.sql<{ identity: unknown }>(
    `SELECT identity FROM ai_user_config WHERE id = ${ctx.aiUserId}`,
  );
  if (rows.length !== 1)
    fail("AUTHORIZATION_DENIED", "Caller AI identity is unavailable.");
  return identity(rows[0].identity);
}
async function rawNode(transport: StdbTransport, id: string): Promise<RawNode> {
  panelId(id);
  const rows = await transport.sql<RawNode>(
    `SELECT id, surface_id, component_type, props, deleted_at FROM component_node WHERE id = ${id}`,
  );
  const row = rows[0];
  if (!row || !isOptionNone(row.deleted_at))
    fail("PANEL_UNAVAILABLE", "The component is unavailable or unreadable.");
  return row;
}
export async function getPagePanel(
  transport: StdbTransport,
  componentId: string,
) {
  const row = await rawNode(transport, componentId);
  if (row.component_type !== PAGE_PANEL_TYPE)
    fail("INVALID_PAGE_PANEL", "This component is not a versioned panel.");
  const raw = isRetainedPageInterface(row.props) ? JSON.parse(row.props) : null;
  const registry = raw ? await panelRegistry(transport, String(raw.document?.template?.id), String(raw.document?.template?.version)) : INTERFACE_REGISTRY;
  return {
    componentId,
    surfaceId: sqlId(row.surface_id),
    state: isAuthoredPageComponent(row.props)?readPageComponent(row.props,sqlId(row.surface_id),componentId):raw ? readPageInterface(row.props, sqlId(row.surface_id), componentId, registry) : readPagePanel(row.props),
    registry,
  };
}
export function pagePanelResult(panel: {
  componentId: string;
  surfaceId: string;
  state: PagePanel | RetainedInterface | AuthoredComponent;
  registry?: InterfaceRegistry;
}) {
  if(panel.state.v==="trellis_component_v1"){
    const saved=panel.state,catalog=componentCatalog(INTERFACE_REGISTRY.catalog,saved.actions);
    return{ok:true,saved:true,component_id:panel.componentId,page_id:panel.surfaceId,revision:saved.document.revision,format:saved.v,
      document:saved.document,configuration:{title:saved.title,actions:saved.actions,sources:saved.sources,bindings:saved.bindings},origin:saved.origin,
      components:catalog.components,patch_contract:describePatchContract(catalog,saved.document,{allowNewActions:true}),allowed_edits:["patch","configuration"],
      authoring_contract:{edit:{kind:"edit",operations:"Flat patch operations from patch_contract; an empty array is allowed when changing configuration",configuration:"Optional COMPLETE title/actions/sources/bindings map, matching the current configuration with your changes"},
        local_action:{kind:"local",input:{type:"object",properties:{value:{type:"string"}},required:["value"]},message:"Saved.",effects:[{kind:"setText",target:{id:"existing-output-node"},input:"value"}]},
        create_action:{kind:"create",source:"your-source-name",input:{type:"object",properties:{value:{type:"string"}},required:["value"]},fields:{name:"value"},clearOnSuccess:true,message:"Entry created."},
        refresh_action:{kind:"refresh",source:"your-source-name",input:{type:"object",properties:{}},message:"Refreshed."},
        action_execution:"Use run_component_action with a saved node ID and its exact declared inputs for workspace creates/updates or local actions. Browser refresh and external source operations stay in the connected adapter. Creating a row requires a saved create action; a writable table alone does not grant creation.",
        attach_action:{op:"setAction",target:{id:"existing-button"},action:{slot:"your-action-name",input:{value:{field:"existing-input-name"}}}},
        workspace_source:{label:"Workspace data",fields:{name:{type:"string",writable:true}},connection:{adapter:"pear.database",schemaId:"positive-schema-id",mapping:{name:"positive-property-id"}}},
        query_source:{label:"Asks",mode:"query",fields:{title:{type:"string"},id:{type:"string"},status:{type:"string"},raised:{type:"date"}},connection:{adapter:"pear.database",schemaId:"positive-schema-id",mapping:{title:"$title",id:"$id",status:"positive-property-id",raised:"positive-property-id"}}},
        native_fields:"A pear.database mapping value may be '$title' (the row's page title) or '$id' (the row's record identity) instead of a property ID. Declare such fields as read-only string fields; they filter and sort like any text field.",
        query_view_table:{op:"insertNode",node:{id:"agent:needs-judgment",parentId:"existing-container",order:0,type:"DataTable",props:{source:"your-query-source",columns:["title","status","raised"],filter:[{field:"status",op:"eq",value:"Open"}],sort:[{field:"raised",direction:"asc"}],limit:50,rowAction:"your-open-action",emptyText:"Nothing needs your judgment."}}},
        query_view_list:{op:"insertNode",node:{id:"agent:needs-judgment-list",parentId:"existing-container",order:1,type:"RecordList",props:{source:"your-query-source",titleField:"title",detailFields:["status","raised"],filter:[{field:"status",op:"eq",value:"Open"}],sort:[{field:"raised",direction:"asc"}],limit:25,rowAction:"your-open-action"}}},
        open_action:{kind:"open",source:"your-query-source",recordId:{row:true},input:{type:"object",properties:{}},message:"Open record"},
        view_rules:"DataTable and RecordList accept saved filter (up to 8 AND predicates: eq, neq, lt, gt, contains, isEmpty), sort (up to 3 keys) and limit (1-200, default 200) props over declared source fields; values must match the field type and dates are YYYY-MM-DD. On a query-mode source the view is read-only and evaluates every readable record before the limit; on a snapshot source the same settings apply to the snapshot rows and table cells stay editable. complete:false in the rendered view means the limit truncated matching records. Set rowAction to an open action on the same source for record navigation. Edit view settings with setProps carrying the complete props.",
        external_source:{label:"Service",fields:{name:{type:"string",writable:false}},connection:{adapter:"external.json",readUrl:"https://service.example/records",recordsPath:"",idField:"id"}},
        binding:{source:"your-source-name",recordId:{first:true},field:"name",property:"value",writeBack:true},
        source_rules:"Only supported operations with current source/record permission are writable. Query-mode sources (mode:'query') are read-only and power filtered tables, lists and calendars. External JSON requires CORS. Updates require write:{url,method:'PUT'|'PATCH'}; record creation separately requires create:{url,method:'POST',idempotency:'key'} and a service honoring Idempotency-Key retries and returning a stable ID. Authentication stays private to the browser session. Missing operations are read-only. Use run_component_action for saved workspace create/update controls and write_component_data for workspace bindings; external operations use the connected browser. Templates disconnect source ports."},
      reference:{v:"pear_page_component_v1",surfaceId:panel.surfaceId,blockId:panel.componentId}};
  }
  if ("document" in panel.state) {
    const registry = panel.registry ?? INTERFACE_REGISTRY;
    const saved = panel.state, origin = saved.document.template!, entry = interfaceDefinition(registry, origin.id, origin.version);
    return {
      ok: true, saved: true, component_id: panel.componentId, page_id: panel.surfaceId, revision: saved.document.revision,
      template_id: origin.id, template_version: origin.version, parameters: origin.parameters,
      editable_parameters: origin.state === "linked" ? entry.template.parameters : null, allowed_edits: origin.state === "linked" ? ["parameters", "patch"] : ["patch"],
      document: saved.document, components: INTERFACE_REGISTRY.catalog.components,
      patch_contract: describePatchContract(interfaceCatalog(registry, entry), saved.document),
      actions: Object.fromEntries(Object.values(entry.bindings).map(binding => [binding.action, { input: binding.input }])),
      reference: { v: "pear_page_component_v1", surfaceId: panel.surfaceId, blockId: panel.componentId },
    };
  }
  return {
    ok: true,
    saved: true,
    component_id: panel.componentId,
    page_id: panel.surfaceId,
    revision: panel.state.revision,
    template_id: panel.state.templateId,
    template_version: panel.state.templateVersion,
    parameters: panel.state.parameters,
    editable_parameters: PAGE_PANEL_TEMPLATE.parameters,
    reference: {
      v: "pear_page_component_v1",
      surfaceId: panel.surfaceId,
      blockId: panel.componentId,
    },
  };
}
const idSchema = {
  type: "string",
  description: "Positive decimal component ID. Keep IDs as strings.",
};
const requestSchema = {
  type: "string",
  description:
    "Stable request ID. Retry uncertain writes with identical arguments and this same ID.",
};
function tool(entry: McpToolEntry): McpToolEntry {
  return {
    ...entry,
    async execute(ctx, input) {
      try {
        return await entry.execute(ctx, input);
      } catch (error) {
        return JSON.stringify({
          ok: false,
          code:
            error instanceof PanelCommitError || error instanceof TrellisError
              ? error.code
              : "INVALID_PAGE_PANEL",
          error: error instanceof Error ? error.message : String(error),
          ...(error instanceof TrellisError ? { path: error.path } : {}),
          ...(error instanceof TrellisError && entry.name === "update_page_panel" && ["INVALID_OPERATION", "UNKNOWN_KEY", "INVALID_TARGET"].includes(error.code)
            ? { hint: "Read get_page_panel.patch_contract for exact operation schemas and examples. Use flat {op, ...} objects. insertNode has only op and node; placement belongs in node.parentId and node.order." } : {}),
        });
      }
    },
  };
}
export const PAGE_PANEL_TOOLS: McpToolEntry[] = [
  tool({
    name: "list_page_panel_templates",
    description:
      "List reusable templates published in this workspace. Start from blank with create_component, or use a discovered exact template version. Bundled legacy note/checklist presets are not offered for new work.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute(ctx, input) {
      exact(input, []);
      const families = await workspaceTemplateFamilies(ctx.transport);
      const workspace = await Promise.all(families.map(async family => {
        const saved = await workspaceTemplate(ctx.transport, family.template_id, family.latest_version);
        if(saved.package.format==="trellis_authored_template_v1")return{id:saved.reference.templateId,version:saved.reference.version,hash:saved.reference.hash,repository_id:"workspace",name:saved.package.name,allowed_edits:["patch","configuration"],create_with:"create_component"};
        const entry = saved.package.definition;
        return { id: entry.template.id, version: entry.template.version, hash: entry.template.hash, repository_id: "workspace", package_hash: saved.reference.hash, name: saved.package.name, parameters: entry.template.parameters, defaults: entry.defaults, allowed_edits: ["parameters", "patch"] };
      }));
      return JSON.stringify({
        ok: true,
        templates: workspace,
      });
    },
  }),
  tool({
    name: "get_page_panel",
    description:
      "Read a saved panel's revision, document, component catalog, granted actions and patch_contract (exact operation schemas and examples using current IDs). After a structural edit or saved action, parameters are template provenance; use the document as current state and patches for further edits. Unsent browser drafts are private. Use get_page_components to discover the component ID.",
    inputSchema: {
      type: "object",
      properties: { component_id: idSchema },
      required: ["component_id"],
      additionalProperties: false,
    },
    async execute(ctx, input) {
      exact(input, ["component_id"]);
      return JSON.stringify(
        pagePanelResult(
          await getPagePanel(ctx.transport, panelId(input.component_id)),
        ),
      );
    },
  }),
  tool({
    name: "create_page_panel",
    description:
      "Instantiate a workspace-published registered template under an existing page container. Discover its exact version and typed parameters with list_page_panel_templates. For a blank component or an authored template use create_component. This endpoint also retains compatibility with previously pinned legacy requests. Read get_page_components for parent_id; retry uncertain writes with identical request_id and arguments.",
    inputSchema: {
      type: "object",
      properties: {
        parent_id: idSchema,
        template_id: { type: "string", description: "Exact workspace template ID from list_page_panel_templates or the component library." },
        template_version: {
          type: "string",
          description: "Exact immutable major.minor.patch version from discovery.",
        },
        parameters: {
          type: "object",
          description: "Parameters matching the selected template's schema from list_page_panel_templates.",
        },
        request_id: requestSchema,
      },
      required: [
        "parent_id",
        "template_id",
        "template_version",
        "parameters",
        "request_id",
      ],
      additionalProperties: false,
    },
    async execute(ctx, input) {
      exact(input, [
        "parent_id",
        "template_id",
        "template_version",
        "parameters",
        "request_id",
      ]);
      const generic = input.template_id !== PAGE_PANEL_TEMPLATE.id;
      const registry = generic ? await panelRegistry(ctx.transport, String(input.template_id), String(input.template_version)) : INTERFACE_REGISTRY;
      if (generic) interfaceDefinition(registry, String(input.template_id), String(input.template_version));
      else if (input.template_version !== PAGE_PANEL_TEMPLATE.version) fail("TEMPLATE_PINNED", "Choose an exact bundled page-panel template.");
      const parentId = panelId(input.parent_id),
        requestId = panelRequestId(input.request_id),
        parameters = generic ? input.parameters as JsonObject : panelChanges(input.parameters);
      const [parent, principal] = await Promise.all([
        rawNode(ctx.transport, parentId),
        caller(ctx),
      ]);
      const surfaceId = sqlId(parent.surface_id);
      const descriptor: InterfaceCreate = { templateId: String(input.template_id), templateVersion: String(input.template_version), parameters };
      if (generic) await createRetainedInterface(descriptor, { registry, principal, parentId, requestId, documentId: "validation", instanceId: "validation" });
      const fingerprint = generic ? await interfaceCreationFingerprint(descriptor) : await sha256({ operation: "create", parameters });
      let acknowledgement: unknown;
      try {
        await ctx.transport.call("create_trellis_panel", [
          parentId,
          requestId,
          canonicalJson(generic ? descriptor : parameters),
        ]);
      } catch (error) {
        const message = reducerErrorMessage(error);
        const code =
          /\b(REQUEST_REUSED|PANEL_DELETED|INVALID_PAGE_PANEL|INVALID_INTERFACE|TEMPLATE_NOT_FOUND|TEMPLATE_ARCHIVED):/.exec(
            message,
          )?.[1];
        if (code) fail(code, message);
        if (
          /lacks .*access|Authentication required|not found|cannot contain/i.test(
            message,
          )
        )
          fail("AUTHORIZATION_DENIED", message);
        acknowledgement = error;
      }
      const deadline = Date.now() + 3000;
      do {
        try {
          const rows = await ctx.transport.sql<RawNode>(
            `SELECT id, surface_id, component_type, props, deleted_at FROM component_node WHERE surface_id = ${surfaceId}`,
          );
          for (const row of rows) {
            if (
              row.component_type !== PAGE_PANEL_TYPE ||
              !isOptionNone(row.deleted_at)
            )
              continue;
            let saved: PagePanel | RetainedInterface;
            try {
              saved = isRetainedPageInterface(row.props) ? readPageInterface(row.props, surfaceId, sqlId(row.id), registry) : readPagePanel(row.props);
            } catch {
              continue;
            }
            if (
              saved.creation.parentId !== parentId ||
              saved.creation.principal !== principal ||
              saved.creation.requestId !== requestId
            )
              continue;
            if (saved.creation.fingerprint !== fingerprint)
              fail(
                "REQUEST_REUSED",
                "This create request has different arguments.",
              );
            return JSON.stringify(
              pagePanelResult({
                componentId: sqlId(row.id),
                surfaceId,
                state: saved,
                registry,
              }),
            );
          }
        } catch (error) {
          if (error instanceof PanelCommitError) throw error;
          acknowledgement ??= error;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      } while (Date.now() < deadline);
      fail(
        "COMMIT_UNCONFIRMED",
        `The created panel was not observed. Retry the identical request.${acknowledgement ? " " + reducerErrorMessage(acknowledgement) : ""}`,
      );
    },
  }),
  tool({
    name: "update_page_panel",
    description:
      "Edit the SAME saved interface. First read get_page_panel and its patch_contract. Supply parameters only while linked, or a batch of flat operations with an op discriminator. insertNode is {op:'insertNode',node:{id,parentId,type,order,props,...}}. moveNode is {op:'moveNode',target:{id:...},parentId,order}; targets may also use {key:...}. Never wrap an operation in its name. Preserve existing IDs and private input nodes. Saved actions and structural edits fork the template; use patches afterward. A stale revision requires a fresh read and proposal; an uncertain commit requires an identical retry with the same request_id.",
    inputSchema: {
      type: "object",
      properties: {
        component_id: idSchema,
        base_revision: { type: "integer", minimum: 0 },
        request_id: requestSchema,
        parameters: {
          type: "object",
          description: "Typed parameter changes allowed by the selected interface definition.",
        },
        operations: { ...describePatchContract(INTERFACE_REGISTRY.catalog).operations_schema, description: "Atomic flat patch operations. Read get_page_panel.patch_contract for scoped actions and examples using current IDs. Host bindings and template provenance remain pinned." },
      },
      required: ["component_id", "base_revision", "request_id"],
      additionalProperties: false,
    },
    async execute(ctx, input) {
      exact(input, [
        "component_id",
        "base_revision",
        "request_id",
        "parameters",
        "operations",
      ]);
      if (Object.hasOwn(input, "parameters") === Object.hasOwn(input, "operations")) fail("INVALID_INPUT", "Supply either parameters or operations.");
      const componentId = panelId(input.component_id),
        requestId = panelRequestId(input.request_id);
      if (
        !Number.isSafeInteger(input.base_revision) ||
        (input.base_revision as number) < 0
      )
        fail("INVALID_INPUT", "Expected a safe base revision.");
      const principal = await caller(ctx);
      const current = await getPagePanel(ctx.transport, componentId);
      if(current.state.v==="trellis_component_v1"){
        if(Object.hasOwn(input,"parameters"))fail("USE_COMPONENT_AUTHORING","Use update_component with configuration for this authored component.");
        return updateAuthored(ctx,componentId,current.state,{baseRevision:input.base_revision as number,requestId,command:{kind:"edit",operations:input.operations as any}});
      }
      if ("document" in current.state) {
        const command = (Object.hasOwn(input, "parameters") ? { kind: "parameters", parameters: input.parameters } : { kind: "patch", operations: input.operations }) as InterfaceCommand;
        const request = { baseRevision: input.base_revision as number, requestId, command };
        await commitRetainedInterface(current.state, request, { registry: current.registry, principal });
        const state = await observeInterfaceCommit(request, {
          registry: current.registry, principal,
          write: async args => {
            try { return await ctx.transport.call("commit_trellis_panel", [componentId, args.baseRevision, args.requestId, canonicalJson(args.command)]); }
            catch (error) {
              const message = reducerErrorMessage(error);
              if (/lacks .*access|Authentication required|not found/i.test(message)) fail("AUTHORIZATION_DENIED", message);
              const code = /\b(STALE_REVISION|STALE_ACTION|REQUEST_REUSED|INVALID_INTERFACE|TEMPLATE_FORKED|TEMPLATE_PINNED|UNKNOWN_ACTION|UNKNOWN_NODE|DUPLICATE_ID):/.exec(message)?.[1];
              if (code) fail(code, message);
              throw error;
            }
          },
          read: async () => {
            const observed = (await getPagePanel(ctx.transport, componentId)).state;
            if (observed.v!=="trellis_instance_v1") fail("INVALID_INTERFACE", "The saved interface changed format.");
            return observed;
          },
        });
        const receipt = state.receipts.find(item => item.principal === principal && item.requestId === requestId)!;
        return JSON.stringify({ ...pagePanelResult({ ...current, state }), committed_revision: receipt.revision, replayed: current.state.receipts.some(item => item.principal === principal && item.requestId === requestId) });
      }
      if (Object.hasOwn(input, "operations")) fail("UNSUPPORTED_OPERATION", "This legacy Note panel supports parameter changes. Create a registered interface for structural edits.");
      const parameters = panelChanges(input.parameters);
      const state = await commitObservedPagePanel(
        {
          componentId,
          baseRevision: input.base_revision as number,
          requestId,
          parameters,
        },
        {
          principal,
          commit: (args) =>
            ctx.transport.call("commit_trellis_panel", [
              args.componentId,
              args.baseRevision,
              args.requestId,
              canonicalJson(args.parameters),
            ]),
          read: async () => {
            const observed = (await getPagePanel(ctx.transport, componentId)).state;
            if ("document" in observed) fail("INVALID_PAGE_PANEL", "The saved panel changed format.");
            return observed;
          },
        },
      );
      const receipt = state.receipts.find(
        (item) => item.principal === principal && item.requestId === requestId,
      )!;
      return JSON.stringify({
        ...pagePanelResult({ ...current, state }),
        committed_revision: receipt.revision,
        replayed: current.state.receipts.some(
          (item) =>
            item.principal === principal && item.requestId === requestId,
        ),
      });
    },
  }),
];

async function updateAuthored(ctx:McpContext,componentId:string,current:AuthoredComponent,request:ComponentCommit){
  const principal=await caller(ctx);
  if(request.command.kind==="source-write")authorizeComponentWrite(current,request.command.write);
  else if(request.command.kind==="source-create"){
    const replay=current.receipts.some(receipt=>receipt.principal===principal&&receipt.requestId===request.requestId);
    if(!replay&&request.baseRevision!==current.document.revision)fail("STALE_REVISION","Read the component before acting.");
    const intent=componentSourceCreate({...current,document:{...current.document,revision:request.command.event.revision}},request.command.event);
    if(current.sources[intent.source].connection?.adapter!=="pear.database")fail("SOURCE_WRITE_REQUIRED","External creation runs through the connected browser adapter.");
  }else await commitAuthoredComponent(current,request,{catalog:INTERFACE_REGISTRY.catalog,principal});
  const state=await observeComponentCommit(request,{catalog:INTERFACE_REGISTRY.catalog,principal,
    write:async args=>{try{return await ctx.transport.call("commit_trellis_panel",[componentId,args.baseRevision,args.requestId,canonicalJson(args.command)]);}catch(error){const message=reducerErrorMessage(error);if(/lacks .*access|Authentication required|not found/i.test(message))fail("AUTHORIZATION_DENIED",message);const code=/\b(STALE_REVISION|STALE_ACTION|REQUEST_REUSED|INVALID_COMPONENT|INVALID_INTERFACE|INVALID_BINDING|UNKNOWN_ACTION|UNKNOWN_NODE|DUPLICATE_ID|READ_ONLY_SOURCE|SOURCE_WRITE_REQUIRED):/.exec(message)?.[1];if(code)fail(code,message);throw error;}},
    read:async()=>{const observed=await getPagePanel(ctx.transport,componentId);if(observed.state.v!=="trellis_component_v1")fail("INVALID_COMPONENT","The component changed format.");return observed.state;}});
  const panel=await getPagePanel(ctx.transport,componentId);
  return JSON.stringify({...pagePanelResult({...panel,state}),...(state.receipts.find(r=>r.principal===principal&&r.requestId===request.requestId)?.recordId?{record_id:state.receipts.find(r=>r.principal===principal&&r.requestId===request.requestId)!.recordId}:{}),committed_revision:state.receipts.find(r=>r.principal===principal&&r.requestId===request.requestId)!.revision,replayed:current.receipts.some(r=>r.principal===principal&&r.requestId===request.requestId)});
}
PAGE_PANEL_TOOLS.push(
 tool({name:"create_component",description:"Create a genuinely blank page-owned component to design with the user, or instantiate an exact authored workspace template. Read get_page_components for a container parent_id. Then get_component returns its configuration, catalog and exact patch contract; update_component saves atomic structure/action/binding edits. Never require a task/note preset. Each template use has fresh identities, empty state and disconnected data ports. Retry uncertain creation with the identical request_id.",
 inputSchema:{type:"object",properties:{parent_id:idSchema,title:{type:"string",maxLength:160},template:{type:"object",properties:{template_id:{type:"string"},version:{type:"string"},hash:{type:"string",pattern:"^[a-f0-9]{64}$"}},required:["template_id","version","hash"],additionalProperties:false},request_id:requestSchema},required:["parent_id","request_id"],additionalProperties:false},
 async execute(ctx,input){exact(input,["parent_id","title","template","request_id"]);const parentId=panelId(input.parent_id),requestId=panelRequestId(input.request_id),principal=await caller(ctx),parent=await rawNode(ctx.transport,parentId),surfaceId=sqlId(parent.surface_id);
 let descriptor:unknown,fingerprint:string;
 if(input.template){if(input.title!==undefined)fail("INVALID_INPUT","Choose blank title or template, not both.");const template=input.template as Record<string,unknown>;exact(template,["template_id","version","hash"]);const value=await workspaceTemplate(ctx.transport,String(template.template_id),String(template.version));if(value.package.format!=="trellis_authored_template_v1"||value.reference.hash!==template.hash)fail("TEMPLATE_PINNED","Choose an exact authored component package.");descriptor={kind:"component-template",templateId:template.template_id,version:template.version,hash:template.hash};fingerprint=await sha256({templateId:template.template_id,version:template.version,hash:template.hash});}
 else{const title=input.title??"Untitled component";if(typeof title!=="string")fail("INVALID_INPUT","Component title must be text.");const saved=await createAuthoredComponent(title,{catalog:INTERFACE_REGISTRY.catalog,principal,parentId,requestId,documentId:"validation",instanceId:"validation"});fingerprint=saved.creation.fingerprint;descriptor={kind:"component",title};}
 try{await ctx.transport.call("create_trellis_panel",[parentId,requestId,canonicalJson(descriptor)]);}catch(error){const message=reducerErrorMessage(error);const code=/\b(REQUEST_REUSED|TEMPLATE_ARCHIVED|TEMPLATE_NOT_FOUND|TEMPLATE_PINNED|INVALID_COMPONENT|PANEL_DELETED):/.exec(message)?.[1];if(code)fail(code,message);if(/lacks .*access|Authentication required|cannot contain/.test(message))fail("AUTHORIZATION_DENIED",message);}
 const deadline=Date.now()+3000;do{const rows=await ctx.transport.sql<RawNode>(`SELECT id, surface_id, component_type, props, deleted_at FROM component_node WHERE surface_id = ${surfaceId}`);for(const row of rows){if(row.component_type!==PAGE_PANEL_TYPE||!isOptionNone(row.deleted_at)||!isAuthoredPageComponent(row.props))continue;const saved=readPageComponent(row.props,surfaceId,sqlId(row.id));if(saved.creation.principal===principal&&saved.creation.parentId===parentId&&saved.creation.requestId===requestId){if(saved.creation.fingerprint!==fingerprint)fail("REQUEST_REUSED","Creation arguments differ.");return JSON.stringify(pagePanelResult({componentId:sqlId(row.id),surfaceId,state:saved}));}}await new Promise(resolve=>setTimeout(resolve,25));}while(Date.now()<deadline);fail("COMMIT_UNCONFIRMED","The created component has not arrived. Retry identical arguments.");}
 }),
 tool({name:"get_component",description:"Read the live component definition shared by humans and AI: revision, full configuration, layout, field/action/binding contract and exact patch examples. No private browser drafts or connection credentials are returned. Use show_page_panel to show the same live instance in chat.",inputSchema:{type:"object",properties:{component_id:idSchema},required:["component_id"],additionalProperties:false},async execute(ctx,input){exact(input,["component_id"]);return JSON.stringify(pagePanelResult(await getPagePanel(ctx.transport,panelId(input.component_id))));}}),
 tool({name:"update_component",description:"Co-edit an authored component with the user. First get_component. Pass command:{kind:'edit',operations:[flat patches],configuration?:COMPLETE configuration}. Actions, source ports and bindings are declarative data, never code. setAction attaches a declared action slot; null removes it. Preserve existing IDs and private-input names. Atomic layout/config changes share the human builder revision. Stale revisions require a fresh read; uncertain results require identical retries.",inputSchema:{type:"object",properties:{component_id:idSchema,base_revision:{type:"integer",minimum:0,maximum:Number.MAX_SAFE_INTEGER},request_id:requestSchema,command:{type:"object",properties:{kind:{type:"string",enum:["edit"]},operations:describePatchContract(componentCatalog(INTERFACE_REGISTRY.catalog),undefined,{allowNewActions:true}).operations_schema,configuration:{type:"object",properties:{title:{type:"string",maxLength:160},actions:{type:"object"},sources:{type:"object"},bindings:{type:"object"}},required:["title","actions","sources","bindings"],additionalProperties:false}},required:["kind","operations"],additionalProperties:false}},required:["component_id","base_revision","request_id","command"],additionalProperties:false},async execute(ctx,input){exact(input,["component_id","base_revision","request_id","command"]);const id=panelId(input.component_id),current=await getPagePanel(ctx.transport,id);if(current.state.v!=="trellis_component_v1")fail("USE_REGISTERED_INTERFACE","Use update_page_panel for registered examples.");if(!Number.isSafeInteger(input.base_revision)||(input.base_revision as number)<0||!input.command||typeof input.command!=="object"||(input.command as any).kind!=="edit")fail("INVALID_INPUT","Pass an edit command and safe current revision.");return updateAuthored(ctx,id,current.state,{baseRevision:input.base_revision as number,requestId:panelRequestId(input.request_id),command:input.command as ComponentCommand});}}),
 tool({name:"write_component_data",description:"Write real Pear workspace records through a component's saved binding/table/source action. Read get_component first. Only declared writable fields and current record permissions are allowed; computed/unsupported fields are read-only. Data and durable receipt commit atomically. This does not write external services; those require the connected browser adapter. Use the same request_id and exact values for an uncertain retry.",inputSchema:{type:"object",properties:{component_id:idSchema,base_revision:{type:"integer",minimum:0,maximum:Number.MAX_SAFE_INTEGER},source:{type:"string"},record_id:idSchema,values:{type:"object"},request_id:requestSchema},required:["component_id","base_revision","source","record_id","values","request_id"],additionalProperties:false},async execute(ctx,input){exact(input,["component_id","base_revision","source","record_id","values","request_id"]);const id=panelId(input.component_id),current=await getPagePanel(ctx.transport,id);if(current.state.v!=="trellis_component_v1")fail("INVALID_COMPONENT","Choose an authored component.");if(!Number.isSafeInteger(input.base_revision)||(input.base_revision as number)<0)fail("INVALID_INPUT","Use the current safe revision.");const requestId=panelRequestId(input.request_id);return updateAuthored(ctx,id,current.state,{baseRevision:input.base_revision as number,requestId,command:{kind:"source-write",write:{source:String(input.source),recordId:panelId(input.record_id),values:input.values as any,requestId}}});}}),
 tool({name:"run_component_action",description:"Run an existing component control using its exact saved action and typed inputs. Supports local actions and real Pear database record creation/update. It cannot grant new actions or bypass field mapping, page/source permissions, required fields or revisions. First get_component. Retry uncertain results with the identical request_id, revision, node_id and inputs. Refresh and external API actions execute in the connected browser.",inputSchema:{type:"object",properties:{component_id:idSchema,base_revision:{type:"integer",minimum:0,maximum:Number.MAX_SAFE_INTEGER},node_id:{type:"string"},input:{type:"object"},record_id:idSchema,request_id:requestSchema},required:["component_id","base_revision","node_id","input","request_id"],additionalProperties:false},async execute(ctx,input){
  exact(input,["component_id","base_revision","node_id","input","record_id","request_id"]);
  const id=panelId(input.component_id),panel=await getPagePanel(ctx.transport,id);if(panel.state.v!=="trellis_component_v1")fail("INVALID_COMPONENT","Choose an authored component.");
  if(!Number.isSafeInteger(input.base_revision)||(input.base_revision as number)<0)fail("INVALID_INPUT","Use the current safe revision.");
  const current=panel.state,node=current.document.nodes.find(node=>node.id===input.node_id);if(!node?.action)fail("UNKNOWN_ACTION","This node has no saved action.");
  const requestId=panelRequestId(input.request_id),event={documentId:current.document.documentId,revision:input.base_revision as number,nodeId:node.id,slot:node.action.slot,invocationId:requestId,input:input.input as any};
  const definition=componentActionInput({...current,document:{...current.document,revision:event.revision}},event);
  if(definition.kind==="refresh")fail("USE_CONNECTED_BROWSER","Refresh uses the component's connected data adapter.");
  let command:ComponentCommand;
  if(definition.kind==="create")command={kind:"source-create",event};
  else if(definition.kind==="source"){if(current.sources[definition.source].connection?.adapter!=="pear.database")fail("SOURCE_WRITE_REQUIRED","External writes use the connected browser adapter.");command={kind:"source-write",write:componentSourceWrite({...current,document:{...current.document,revision:event.revision}},event,input.record_id?panelId(input.record_id):undefined)};}
  else command={kind:"action",event};
  return updateAuthored(ctx,id,current,{baseRevision:event.revision,requestId,command});
 }})

);
