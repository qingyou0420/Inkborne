import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");
const {
  compareSetupCandidates,
  versionFromSetupName,
} = require("../lib/setup-artifact.cjs") as {
  compareSetupCandidates: (
    a: { version: string; path: string; mtime: number },
    b: { version: string; path: string; mtime: number },
    compareVersionsFn: (left: string, right: string) => number,
  ) => number;
  versionFromSetupName: (name: string) => string | null;
};

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const mainSource = fs.readFileSync(join(desktopDir, "main.cjs"), "utf8");

function part(from: string, to: string) {
  const start = mainSource.indexOf(from);
  const end = mainSource.indexOf(to, start);
  if (start < 0 || end <= start) throw new Error(`Cannot find ${from}`);
  return mainSource.slice(start, end);
}

type Candidate = { path: string; version: string; mtime: number; source?: string };

const searchDirs = { current: [] as string[] };
const finderContext: Record<string, unknown> = {
  fs,
  path,
  versionFromSetupName,
  compareSetupCandidates,
  getUpdateSearchDirs: () => searchDirs.current,
};
vm.createContext(finderContext);
vm.runInContext(
  part("function parseSemver(", "function getGithubUpdateToken(")
    + part("async function scanInstallersInDir(", "function isAllowedOpenPath("),
  finderContext,
);
const findLatestInstaller = finderContext.findLatestInstaller as (
  currentVersion: string,
  kind?: string,
) => Promise<{ candidates: Candidate[] }>;

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeDir(prefix: string) {
  const dir = fs.mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function writeAt(dir: string, name: string, unixSec: number) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, name);
  const when = new Date(unixSec * 1000);
  fs.utimesSync(file, when, when);
  return file;
}

/** 按数组顺序把 mtime 拉开：越靠后越新。 */
function writeRanked(dir: string, names: readonly string[]) {
  names.forEach((name, index) => writeAt(dir, name, 1_700_000_000 + index * 120));
}

function compareVersions(a: string, b: string) {
  const parse = (value: string) => value.split(".").map((partNo) => Number(partNo));
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

function sortedNames(dir: string) {
  return fs
    .readdirSync(dir)
    .filter((name) => versionFromSetupName(name))
    .map((name) => {
      const file = path.join(dir, name);
      return { version: versionFromSetupName(name) as string, path: file, mtime: fs.statSync(file).mtimeMs };
    })
    .sort((a, b) => compareSetupCandidates(a, b, compareVersions))
    .map((item) => path.basename(item.path));
}

async function pickedNames(dir: string, currentVersion: string) {
  searchDirs.current = [dir];
  const { candidates } = await findLatestInstaller(currentVersion);
  return candidates.map((item) => path.basename(item.path));
}

const SAME_VERSION = [
  "Lightbound-Setup-3.0.0.exe",
  "Inkborne-Setup-3.0.0.exe",
  "FantaWriter-Setup-3.0.0.exe",
  "Fantasy-Writer-Setup-3.0.0.exe",
] as const;

describe("local installer pick", () => {
  it("picks Lightbound when the older names are newer on disk", async () => {
    // 同版本先比 preferSetupRank：故意让 Fantasy-Writer 最新、Lightbound 最旧，仍选 Lightbound
    const dir = makeDir("fw-pick-rank-");
    writeRanked(dir, SAME_VERSION);
    const lightbound = fs.statSync(path.join(dir, "Lightbound-Setup-3.0.0.exe")).mtimeMs;
    const fantasy = fs.statSync(path.join(dir, "Fantasy-Writer-Setup-3.0.0.exe")).mtimeMs;
    expect(fantasy).toBeGreaterThan(lightbound);
    expect(sortedNames(dir)[0]).toBe("Lightbound-Setup-3.0.0.exe");
    const picked = await pickedNames(dir, "1.0.0");
    expect(picked[0]).toBe("Lightbound-Setup-3.0.0.exe");
    expect(picked).toEqual([...SAME_VERSION]);
  });

  it("ranks a higher Fantasy-Writer build ahead of an older Lightbound build", async () => {
    // 3.0.1 的 Fantasy-Writer 即使 mtime 更旧，也排在 3.0.0 的 Lightbound 前面
    const dir = makeDir("fw-pick-ver-");
    const lightbound = writeAt(dir, "Lightbound-Setup-3.0.0.exe", 1_800_000_000);
    const fantasy = writeAt(dir, "Fantasy-Writer-Setup-3.0.1.exe", 1_600_000_000);
    expect(fs.statSync(lightbound).mtimeMs).toBeGreaterThan(fs.statSync(fantasy).mtimeMs);
    expect(sortedNames(dir)[0]).toBe("Fantasy-Writer-Setup-3.0.1.exe");
    const picked = await pickedNames(dir, "1.0.0");
    expect(picked[0]).toBe("Fantasy-Writer-Setup-3.0.1.exe");
    expect(picked.indexOf("Fantasy-Writer-Setup-3.0.1.exe")).toBeLessThan(
      picked.indexOf("Lightbound-Setup-3.0.0.exe"),
    );
  });

  it("picks Inkborne when Lightbound is absent", async () => {
    // 没有 Lightbound 时，同版本取 Inkborne，即使旧名更新
    const dir = makeDir("fw-pick-ink-");
    const names = [
      "Inkborne-Setup-3.0.0.exe",
      "FantaWriter-Setup-3.0.0.exe",
      "Fantasy-Writer-Setup-3.0.0.exe",
    ];
    writeRanked(dir, names);
    expect(fs.statSync(path.join(dir, names[2])).mtimeMs).toBeGreaterThan(
      fs.statSync(path.join(dir, names[0])).mtimeMs,
    );
    expect(sortedNames(dir)[0]).toBe("Inkborne-Setup-3.0.0.exe");
    expect((await pickedNames(dir, "1.0.0"))[0]).toBe("Inkborne-Setup-3.0.0.exe");
  });

  it("breaks a rank tie by newer mtime", async () => {
    // rank 相同再按 mtime 降序：两个 Lightbound 里较新的在前
    const olderDir = makeDir("fw-pick-old-");
    const newerDir = makeDir("fw-pick-new-");
    const older = writeAt(olderDir, "Lightbound-Setup-3.0.0.exe", 1_700_000_000);
    const newer = writeAt(newerDir, "Lightbound-Setup-3.0.0.exe", 1_700_008_000);
    expect(fs.statSync(newer).mtimeMs).toBeGreaterThan(fs.statSync(older).mtimeMs);
    searchDirs.current = [olderDir, newerDir];
    const { candidates } = await findLatestInstaller("1.0.0");
    expect(candidates[0].path).toBe(newer);
  });

  it("findLatestInstaller calls compareSetupCandidates", () => {
    // main.cjs 的选包排序走 lib 里的纯函数
    expect(mainSource).toMatch(
      /async function findLatestInstaller[\s\S]*?compareSetupCandidates\(\s*a\s*,\s*b\s*,\s*compareVersions\s*\)/,
    );
  });
});
