import { defineConfig } from "vitest/config";

/** Test configuration for the shared simulator package. */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"]
  }
});
