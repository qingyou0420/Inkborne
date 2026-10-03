import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveChapterFile } from "../authoring/chapter-index.js";
import {
  commitAtomicFileSet,
  recoverAtomicFileSetsIn,
  recoverAtomicTransactionDir,
} from "../utils/atomic-file-set.js";

const here = dirname(fileURLToPath(import.meta.url));
const tsxCli = join(here, "../../../studio/node_modules/tsx/dist/cli.mjs");
const crashChild = join(here, "helpers", "crash-atomic-child.ts");

async function waitForFile(path: string, timeoutMs = 12_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function killChildAfterMarker(configPath: string, marker: string): Promise<void> {
  const child = spawn(process.execPath, [tsxCli, crashChild, configPath], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const err: Buffer[] = [];
  child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
  try {
    await waitForFile(marker);
  } catch (error) {
    child.kill("SIGKILL");
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${Buffer.concat(err).toString("utf-8")}`);
  }
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 3000);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

describe("commitAtomicFileSet", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function createBookFixture(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "inkos-file-set-"));
    roots.push(root);
    await Promise.all([
      mkdir(join(root, "chapters"), { recursive: true }),
      mkdir(join(root, "story"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(root, "chapters", "0001_old.md"), "old chapter", "utf-8"),
      writeFile(join(root, "story", "current_state.md"), "old state", "utf-8"),
      writeFile(join(root, "story", "pending_hooks.md"), "old hooks", "utf-8"),
    ]);
    return root;
  }

  it("commits the complete file set and removes superseded files", async () => {
    const root = await createBookFixture();

    await commitAtomicFileSet({
      rootDir: root,
      writes: [
        { relativePath: "chapters/0001_new.md", content: "new chapter" },
        { relativePath: "story/current_state.md", content: "new state" },
        { relativePath: "story/pending_hooks.md", content: "new hooks" },
      ],
      deletes: ["chapters/0001_old.md"],
    });

    await expect(readFile(join(root, "chapters", "0001_new.md"), "utf-8")).resolves.toBe("new chapter");
    await expect(readFile(join(root, "story", "current_state.md"), "utf-8")).resolves.toBe("new state");
    await expect(readFile(join(root, "story", "pending_hooks.md"), "utf-8")).resolves.toBe("new hooks");
    await expect(readdir(join(root, "chapters"))).resolves.toEqual(["0001_new.md"]);
  });

  it("restores every original file when commit fails after the first replacement", async () => {
    const root = await createBookFixture();
    let stagedRenameCount = 0;

    await expect(commitAtomicFileSet({
      rootDir: root,
      writes: [
        { relativePath: "chapters/0001_new.md", content: "new chapter" },
        { relativePath: "story/current_state.md", content: "new state" },
        { relativePath: "story/pending_hooks.md", content: "new hooks" },
      ],
      deletes: ["chapters/0001_old.md"],
      renameFile: async (from, to) => {
        if (from.includes(`${sep}staged${sep}`)) {
          stagedRenameCount += 1;
          if (stagedRenameCount === 2) {
            throw new Error("injected commit failure");
          }
        }
        await rename(from, to);
      },
    })).rejects.toThrow("injected commit failure");

    await expect(readFile(join(root, "chapters", "0001_old.md"), "utf-8")).resolves.toBe("old chapter");
    await expect(readFile(join(root, "story", "current_state.md"), "utf-8")).resolves.toBe("old state");
    await expect(readFile(join(root, "story", "pending_hooks.md"), "utf-8")).resolves.toBe("old hooks");
    await expect(readdir(join(root, "chapters"))).resolves.toEqual(["0001_old.md"]);
  });

  it("keeps the old file in place until a single-file replacement lands", async () => {
    const root = await createBookFixture();
    const seen: string[] = [];
    await commitAtomicFileSet({
      rootDir: join(root, "story"),
      writes: [{ relativePath: "current_state.md", content: "new state" }],
      renameFile: async (from, to) => {
        if (from.includes("staged")) {
          seen.push(await readFile(join(root, "story", "current_state.md"), "utf-8"));
        }
        await rename(from, to);
      },
    });
    expect(seen[0]).toBe("old state");
    await expect(readFile(join(root, "story", "current_state.md"), "utf-8")).resolves.toBe("new state");
  });

  it("recovers a complete old tree after a crash mid-install", async () => {
    const { recoverAtomicFileSetsIn } = await import("../utils/atomic-file-set.js");
    const root = await createBookFixture();
    await expect(commitAtomicFileSet({
      rootDir: root,
      writes: [
        { relativePath: "story/current_state.md", content: "new state" },
        { relativePath: "story/pending_hooks.md", content: "new hooks" },
      ],
      renameFile: async (from, to) => {
        if (from.includes("staged") && to.endsWith("pending_hooks.md")) {
          throw Object.assign(new Error("killed"), { code: "SIGKILL" });
        }
        await rename(from, to);
      },
    })).rejects.toThrow(/killed/);
    await expect(readFile(join(root, "story", "current_state.md"), "utf-8")).resolves.toBe("old state");
    await expect(readFile(join(root, "story", "pending_hooks.md"), "utf-8")).resolves.toBe("old hooks");
    const recovered = await recoverAtomicFileSetsIn(root);
    expect(recovered.every((item) => item.outcome !== "kept-for-manual-recovery")).toBe(true);
  });

  it("keeps backups when rollback also fails", async () => {
    const root = await createBookFixture();
    await expect(commitAtomicFileSet({
      rootDir: root,
      writes: [
        { relativePath: "story/current_state.md", content: "new state" },
        { relativePath: "story/pending_hooks.md", content: "new hooks" },
      ],
      renameFile: async (from, to) => {
        if (from.includes("staged")) {
          throw Object.assign(new Error("install EPERM"), { code: "EPERM" });
        }
        throw Object.assign(new Error("rollback EPERM"), { code: "EPERM" });
      },
    })).rejects.toThrow(/回滚也不完整|EPERM|备份仍在/);
    const leftovers = (await readdir(root)).filter((name) => name.startsWith(".inkos-file-txn-"));
    expect(leftovers.length).toBeGreaterThan(0);
    const backup = join(root, leftovers[0]!, "backup", "story", "current_state.md");
    await expect(readFile(backup, "utf-8")).resolves.toBe("old state");
  });

  it("withdraws files created this round when recovering the old tree", async () => {
    const root = await createBookFixture();
    const transactionDir = join(root, ".inkos-file-txn-created");
    await mkdir(join(transactionDir, "backup", "story"), { recursive: true });
    await writeFile(join(root, "chapters", "0001_new.md"), "new chapter", "utf-8");
    await writeFile(join(root, "story", "current_state.md"), "new state", "utf-8");
    await writeFile(join(transactionDir, "backup", "story", "current_state.md"), "old state", "utf-8");
    await writeFile(join(transactionDir, "journal.json"), `${JSON.stringify({
      version: 1,
      phase: "committing",
      writes: ["chapters/0001_new.md", "story/current_state.md"],
      deletes: ["chapters/0001_old.md"],
      backups: [{ relativePath: "story/current_state.md", backupRelative: ".inkos-file-txn-created/backup/story/current_state.md" }],
      installed: ["chapters/0001_new.md"],
      created: ["chapters/0001_new.md"],
    }, null, 2)}\n`);

    const recovered = await recoverAtomicTransactionDir(transactionDir);
    expect(recovered.outcome).toBe("restored-old");
    await expect(readFile(join(root, "chapters", "0001_old.md"), "utf-8")).resolves.toBe("old chapter");
    await expect(readFile(join(root, "story", "current_state.md"), "utf-8")).resolves.toBe("old state");
    await expect(readdir(join(root, "chapters"))).resolves.toEqual(["0001_old.md"]);
    await expect(readdir(root)).resolves.not.toContain(".inkos-file-txn-created");
    const second = await recoverAtomicFileSetsIn(root);
    expect(second).toEqual([]);
  });

  it("finishes the new tree when every write is already installed", async () => {
    const root = await createBookFixture();
    const transactionDir = join(root, ".inkos-file-txn-done");
    await mkdir(transactionDir, { recursive: true });
    await writeFile(join(root, "chapters", "0001_new.md"), "new chapter", "utf-8");
    await writeFile(join(root, "story", "current_state.md"), "new state", "utf-8");
    await writeFile(join(transactionDir, "journal.json"), `${JSON.stringify({
      version: 1,
      phase: "committing",
      writes: ["chapters/0001_new.md", "story/current_state.md"],
      deletes: ["chapters/0001_old.md"],
      backups: [],
      installed: ["chapters/0001_new.md", "story/current_state.md"],
      created: ["chapters/0001_new.md"],
    }, null, 2)}\n`);

    const recovered = await recoverAtomicTransactionDir(transactionDir);
    expect(recovered.outcome).toBe("completed-new");
    await expect(readFile(join(root, "chapters", "0001_new.md"), "utf-8")).resolves.toBe("new chapter");
    await expect(readFile(join(root, "story", "current_state.md"), "utf-8")).resolves.toBe("new state");
    await expect(readdir(join(root, "chapters"))).resolves.toEqual(["0001_new.md"]);
  });

  it("recovers a complete old tree after a real process kill mid-install", async () => {
    const root = await createBookFixture();
    const marker = join(root, "installed.marker");
    const configPath = join(root, "crash-config.json");
    await writeFile(configPath, JSON.stringify({
      kind: "file-set",
      rootDir: root,
      hangAfter: "0001_new.md",
      marker,
      writes: [
        { relativePath: "chapters/0001_new.md", content: "new chapter" },
        { relativePath: "story/current_state.md", content: "new state" },
        { relativePath: "story/pending_hooks.md", content: "new hooks" },
      ],
      deletes: ["chapters/0001_old.md"],
    }), "utf-8");

    await killChildAfterMarker(configPath, marker);
    const recovered = await recoverAtomicFileSetsIn(root);
    expect(recovered.some((item) => item.outcome === "restored-old")).toBe(true);
    await expect(readFile(join(root, "chapters", "0001_old.md"), "utf-8")).resolves.toBe("old chapter");
    await expect(readFile(join(root, "story", "current_state.md"), "utf-8")).resolves.toBe("old state");
    await expect(readFile(join(root, "story", "pending_hooks.md"), "utf-8")).resolves.toBe("old hooks");
    await expect(readdir(join(root, "chapters"))).resolves.toEqual(["0001_old.md"]);
    expect(await recoverAtomicFileSetsIn(root)).toEqual([]);
  });

  it("recovers first-chapter adopt after a real process kill on the new chapter file", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-file-set-adopt-"));
    roots.push(root);
    await mkdir(join(root, "chapters"), { recursive: true });
    await writeFile(join(root, "chapters", "index.json"), "[]\n", "utf-8");
    const marker = join(root, "installed.marker");
    const configPath = join(root, "crash-config.json");
    await writeFile(configPath, JSON.stringify({
      kind: "adopt",
      rootDir: root,
      bookDir: root,
      hangAfter: "chapters/0001_",
      marker,
      chapterNumber: 1,
      title: "新章",
      body: "# 第1章 新章\n新正文\n",
    }), "utf-8");

    await killChildAfterMarker(configPath, marker);
    const recovered = await recoverAtomicFileSetsIn(root);
    expect(recovered.some((item) => item.outcome === "restored-old" || item.outcome === "cleaned")).toBe(true);
    expect(JSON.parse(await readFile(join(root, "chapters", "index.json"), "utf-8"))).toEqual([]);
    expect(await resolveChapterFile(root, 1)).toBeUndefined();
    const chapterFiles = (await readdir(join(root, "chapters"))).filter((name) => name.endsWith(".md"));
    expect(chapterFiles).toEqual([]);
  });
});
