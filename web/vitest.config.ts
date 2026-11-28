import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Shared library tests run in Node; pagePanelAccess opts into Happy DOM to
// exercise the real SDK's live React subscriptions.
// `src/hooks/useSyncChildPageLinks.test.ts` only covers that hook's pure
// helpers, so it runs in Node as well.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
    dedupe: ["react", "react-dom"],
  },
  test: {
    environment: "node",
    include: [
      "src/lib/**/*.test.{ts,tsx,js}",
      "src/hooks/useSyncChildPageLinks.test.ts",
    ],
  },
});
