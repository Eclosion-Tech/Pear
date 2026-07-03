/**
 * Public entry for the platform-agnostic custom API endpoint library.
 *
 * Imported by:
 *   - The default Next.js handler at `pear/web/app/api/e/[slug]/...`.
 *   - External gateways such as the Pear-Cloud Cloudflare Worker.
 *
 * Anything not re-exported here is considered internal and may change.
 */

export {
  dispatchApiEndpointRequest,
  type DispatchArgs,
} from "./dispatcher";
export {
  encodePropertyValue,
  decodePropertyValue,
  encodeHttpMethod,
  encodeOption,
  // Generic /sql wire-shape decoders, consumed by the sibling `../mcp` lib.
  decodeEnumVariant,
  decodeOptionSome,
  isOptionNone,
  unwrapScalar,
  normaliseTs,
} from "./codec";
export { buildOpenApiSpec } from "./openapi";
export { EndpointConfigCache } from "./cache";
export type { EndpointConfigCacheOptions } from "./cache";
export { HttpStdbTransport } from "./http-transport";
export type { HttpTransportOptions } from "./http-transport";
export {
  resolveEndpointUrl,
  isCustomTemplate,
  DEFAULT_API_URL_TEMPLATE,
  type ResolveEndpointUrlArgs,
} from "./url-template";
export {
  ApiEndpointError,
  type ApiEndpointRow,
  type ApiFieldMappingRow,
  type AuthResult,
  type EndpointConfig,
  type ErrorBody,
  type HttpMethodName,
  type ListBody,
  type PropertyDefinitionRow,
  type PropertyTypeName,
  type RowBody,
  type SatsHttpMethod,
  type SatsPropertyValue,
  type StdbTransport,
} from "./types";
