import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Shared library tests run in Node; pagePanelAccess opts into Happy DOM to
// exercise the real SDK's live React subscriptions. (`src/hooks/useSyncChildPageLinks.test.ts`
// predates this config and needs a jsdom environment + fixture work before
// it can join the include list.)
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
    dedupe: ["react", "react-dom"],
  },
  test: {
    environment: "node",
    include: ["src/lib/**/*.test.{ts,js}", "src/components/ProductOperations*.test.tsx"],
  },
});
