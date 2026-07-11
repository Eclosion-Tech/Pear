import { describe, expect, test } from "vitest";

import { EndpointConfigCache } from "./cache";
import { dispatchApiEndpointRequest } from "./dispatcher";
import type { AuthResult, StdbTransport } from "./types";

class EndpointConfigTransport implements StdbTransport {
  endpointReads = 0;

  constructor(
    private readonly config: {
      endpointId: number;
      databasePageId: number;
      displayName: string;
      requireAuth: boolean;
      fieldName: string;
    },
  ) {}

  async sql<Row = unknown>(query: string): Promise<Row[]> {
    if (query.includes("FROM api_endpoint")) {
      this.endpointReads += 1;
      return [
        {
          id: this.config.endpointId,
          database_page_id: this.config.databasePageId,
          slug: "records",
          display_name: this.config.displayName,
          description: "",
          allowed_methods: [[0, []]],
          require_auth: this.config.requireAuth,
        },
      ] as Row[];
    }
    if (query.includes("FROM api_field_mapping")) {
      return [
        {
          id: this.config.endpointId * 10,
          endpoint_id: this.config.endpointId,
          property_definition_id: this.config.endpointId * 100,
          field_name: this.config.fieldName,
          required_on_create: false,
          default_value: null,
          read_only: false,
          field_order: 0,
        },
      ] as Row[];
    }
    if (query.includes("FROM property_definition")) {
      return [
        {
          id: this.config.endpointId * 100,
          schema_id: this.config.databasePageId,
          name: this.config.fieldName,
          property_type: "Text",
          config: "{}",
          order: 0,
        },
      ] as Row[];
    }
    throw new Error(`Unexpected SQL in test transport: ${query}`);
  }

  async call(): Promise<void> {
    // The dispatcher records API-call telemetry after producing a response.
  }
}

function dispatchSchema(args: {
  transport: StdbTransport;
  cache: EndpointConfigCache;
  cacheNamespace?: string;
  auth?: AuthResult;
}): Promise<Response> {
  return dispatchApiEndpointRequest({
    url: new URL("https://workspace.api.pear.pro/records/_schema"),
    method: "GET",
    body: undefined,
    endpointSlug: "records",
    trailing: "_schema",
    transport: args.transport,
    auth: args.auth ?? { kind: "open" },
    cache: args.cache,
    cacheNamespace: args.cacheNamespace,
    baseUrl: "https://workspace.api.pear.pro/records",
  });
}

describe("endpoint config cache isolation", () => {
  test("isolates identical endpoint slugs by workspace namespace", async () => {
    const cache = new EndpointConfigCache();
    const publicWorkspace = new EndpointConfigTransport({
      endpointId: 1,
      databasePageId: 101,
      displayName: "Public records",
      requireAuth: false,
      fieldName: "public_field",
    });
    const privateWorkspace = new EndpointConfigTransport({
      endpointId: 2,
      databasePageId: 202,
      displayName: "Private records",
      requireAuth: true,
      fieldName: "private_field",
    });

    const publicResponse = await dispatchSchema({
      transport: publicWorkspace,
      cache,
      cacheNamespace: "workspace-public",
    });
    expect(publicResponse.status).toBe(200);
    const publicSpec = (await publicResponse.json()) as {
      info: { title: string };
      components: {
        schemas: {
          Row: {
            properties: {
              fields: { properties: Record<string, unknown> };
            };
          };
        };
      };
    };
    expect(publicSpec.info.title).toBe("Public records");
    const publicFields =
      publicSpec.components.schemas.Row.properties.fields.properties;
    expect(publicFields).toHaveProperty("public_field");
    expect(publicFields).not.toHaveProperty("private_field");

    const unauthenticatedPrivateResponse = await dispatchSchema({
      transport: privateWorkspace,
      cache,
      cacheNamespace: "workspace-private",
    });
    expect(unauthenticatedPrivateResponse.status).toBe(401);
    expect(await unauthenticatedPrivateResponse.json()).toMatchObject({
      error: { code: "auth_required" },
    });

    const authenticatedPrivateResponse = await dispatchSchema({
      transport: privateWorkspace,
      cache,
      cacheNamespace: "workspace-private",
      auth: { kind: "session", identityHex: "01" },
    });
    expect(authenticatedPrivateResponse.status).toBe(200);
    const privateSpec = (await authenticatedPrivateResponse.json()) as
      typeof publicSpec;
    expect(privateSpec.info.title).toBe("Private records");
    const privateFields =
      privateSpec.components.schemas.Row.properties.fields.properties;
    expect(privateFields).toHaveProperty("private_field");
    expect(privateFields).not.toHaveProperty("public_field");
    expect(publicWorkspace.endpointReads).toBe(1);
    expect(privateWorkspace.endpointReads).toBe(1);
  });

  test("bypasses a supplied cache when no safe namespace is available", async () => {
    const cache = new EndpointConfigCache();
    const firstWorkspace = new EndpointConfigTransport({
      endpointId: 1,
      databasePageId: 101,
      displayName: "First records",
      requireAuth: false,
      fieldName: "first_field",
    });
    const secondWorkspace = new EndpointConfigTransport({
      endpointId: 2,
      databasePageId: 202,
      displayName: "Second records",
      requireAuth: true,
      fieldName: "second_field",
    });

    expect(
      (await dispatchSchema({ transport: firstWorkspace, cache })).status,
    ).toBe(200);
    expect(
      (await dispatchSchema({ transport: firstWorkspace, cache })).status,
    ).toBe(200);

    const secondResponse = await dispatchSchema({
      transport: secondWorkspace,
      cache,
    });
    expect(secondResponse.status).toBe(401);
    expect(firstWorkspace.endpointReads).toBe(2);
    expect(secondWorkspace.endpointReads).toBe(1);
  });

  test("reuses cached config within one explicit workspace namespace", async () => {
    const cache = new EndpointConfigCache();
    const transport = new EndpointConfigTransport({
      endpointId: 1,
      databasePageId: 101,
      displayName: "Cached records",
      requireAuth: false,
      fieldName: "cached_field",
    });

    await dispatchSchema({ transport, cache, cacheNamespace: "workspace-1" });
    await dispatchSchema({ transport, cache, cacheNamespace: "workspace-1" });

    expect(transport.endpointReads).toBe(1);
  });
});
