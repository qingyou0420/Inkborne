/**
 * System Node's `node:sqlite` often has SQLite but not the FTS5 module
 * (`no such module: fts5`). Electron's `ELECTRON_RUN_AS_NODE` does.
 * Probe once so FTS-backed cases can skip without dropping the rest of the file.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

type ProbeDb = { exec(sql: string): void; close(): void };

export function hasNodeSqliteFts5(): boolean {
  try {
    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync: new (path: string) => ProbeDb;
    };
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE VIRTUAL TABLE __inkos_fts5_probe USING fts5(content)");
      return true;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}
