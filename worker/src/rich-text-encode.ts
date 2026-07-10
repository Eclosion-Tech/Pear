/**
 * Re-export shim. The ComponentTree rich-text encoder moved into pulp
 * (`@eclosion-tech/pulp/rich-text/encode`) so the worker's chat tools, the
 * stateless MCP core (`web/src/lib/mcp`), and the Cloudflare gateway all
 * share one implementation next to `richTextSchema`. Tests moved with it
 * (`packages/pulp/src/rich-text/encode.test.ts`).
 */

export {
  parseInlineMarkdown,
  richTextBlockToYjsBytes,
  markdownToComponentBlocks,
  markdownTablePropsToMarkdown,
  type ComponentBlockSpec,
} from "@eclosion-tech/pulp/rich-text/encode";
