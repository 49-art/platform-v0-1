import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
      // .dev.vars is for `wrangler dev`; these two must stay at their test values whatever it says.
      miniflare: { bindings: { TEST_MIGRATIONS: migrations, APP_ORIGIN: "https://app.test", ENVIRONMENT: "test" } } })],
    test: { include: ["tests/**/*.test.ts"], setupFiles: ["./tests/setup.ts"], testTimeout: 30_000 },
  };
});
