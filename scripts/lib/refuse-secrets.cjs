/**
 * Refuse env/secrets files in a packed engine or installer tree.
 * Keys stay in the desktop user-data secrets.json (or a project file before migration), never in git or NSIS.
 */
const fs = require("fs");
const path = require("path");

const SECRET_BASENAMES = new Set([
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.development.local",
  ".env.production.local",
  "secrets.json",
]);

const ALLOWED_BASENAMES = new Set([".env.example"]);

function normalizeRel(rel) {
  return String(rel || "").replace(/\\/g, "/");
}

function isSecretRelPath(rel) {
  const posix = normalizeRel(rel);
  const base = path.posix.basename(posix);
  if (ALLOWED_BASENAMES.has(base)) return false;
  if (SECRET_BASENAMES.has(base)) return true;
  if (/(^|\/)\.inkos\/secrets\.json$/.test(posix)) return true;
  if (/^\.env(\.|$)/.test(base) && base !== ".env.example") return true;
  return false;
}

function walkFiles(root, acc = [], relBase = "") {
  if (!root || !fs.existsSync(root)) return acc;
  const st = fs.statSync(root);
  if (st.isFile()) {
    acc.push(relBase || path.basename(root));
    return acc;
  }
  if (!st.isDirectory()) return acc;
  let names;
  try {
    names = fs.readdirSync(root);
  } catch {
    return acc;
  }
  for (const name of names) {
    if (name === "node_modules" || name === ".git") {
      const child = path.join(root, name);
      if (fs.existsSync(child) && fs.statSync(child).isDirectory()) {
        walkFiles(child, acc, relBase ? `${relBase}/${name}` : name);
      }
      continue;
    }
    const child = path.join(root, name);
    const rel = relBase ? `${relBase}/${name}` : name;
    try {
      const cst = fs.statSync(child);
      if (cst.isDirectory()) walkFiles(child, acc, rel);
      else acc.push(rel);
    } catch {
      /* ignore */
    }
  }
  return acc;
}

function findSecretFiles(root) {
  return walkFiles(root).filter((rel) => isSecretRelPath(rel));
}

function assertNoSecrets(root, label = root) {
  const hits = findSecretFiles(root);
  if (hits.length) {
    throw new Error(
      `密钥文件不得打进安装包（${label}）:\n${hits.slice(0, 20).join("\n")}`,
    );
  }
  return hits;
}

function main(argv) {
  const targets = argv.length ? argv : ["dist-engine"];
  for (const target of targets) {
    const abs = path.resolve(target);
    if (!fs.existsSync(abs)) {
      console.error(`[refuse-secrets] 缺少目录: ${abs}`);
      process.exit(1);
    }
    assertNoSecrets(abs, abs);
    console.log(`[refuse-secrets] ok ${abs}`);
  }
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`[refuse-secrets] ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

module.exports = {
  SECRET_BASENAMES,
  isSecretRelPath,
  findSecretFiles,
  assertNoSecrets,
};
