import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPool } from "../src/db.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export async function runMigrations(): Promise<void> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    await getPool().query(sql);
  }
}

// Only run and tear down the pool when invoked directly, not when imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { closePool } = await import("../src/db.js");
  await runMigrations();
  await closePool();
  console.log("Migrations applied");
}
