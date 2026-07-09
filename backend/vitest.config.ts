import { defineConfig } from "vitest/config";

const LOCAL_DB = "postgres://appuser:localdevpassword@localhost:5432/github_users";

export default defineConfig({
  test: {
    env: { DATABASE_URL: process.env.DATABASE_URL ?? LOCAL_DB },
    // db.test.ts truncates a shared table, so files must not run concurrently.
    fileParallelism: false,
  },
});
