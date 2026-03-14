import { defineConfig } from "vitest/config";

/** Test configuration for the runtime backend package. */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"]
  }
});
