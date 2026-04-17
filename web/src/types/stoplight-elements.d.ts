// Stoplight ships .d.ts files but its package.json `exports` map blocks
// TypeScript from resolving them. We only consume `API` (and friends) and
// always render via `next/dynamic` + a runtime cast in
// `ApiEndpointsDocsPanel.tsx`, so a permissive ambient declaration is
// sufficient and avoids drift against upstream.
declare module "@stoplight/elements" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const API: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const _default: any;
  export default _default;
}

declare module "@stoplight/elements/styles.min.css";
