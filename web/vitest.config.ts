import { defineConfig } from "vitest/config";

// Scoped to the shared platform-agnostic libs for now — the app itself is
// exercised by Next's own tooling. (`src/hooks/useSyncChildPageLinks.test.ts`
// predates this config and needs a jsdom environment + fixture work before
// it can join the include list.)
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/lib/**/*.test.ts"],
  },
});
