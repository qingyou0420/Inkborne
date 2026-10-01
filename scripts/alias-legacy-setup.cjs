/**
 * 发版辅助：把主安装包 Lightbound-Setup-<ver>.exe 与 .sha256
 * 复制为 Inkborne-Setup、FantaWriter-Setup、Fantasy-Writer-Setup。
 * 2.6.x 客户端认 Inkborne-Setup；2.0.x 认 FantaWriter-Setup；1.4.0 认 Fantasy-Writer-Setup。
 * latest Release 必须同时挂四套文件名。
 * legacy 仍指向 FantaWriter-Setup（按文件名查找，不是 aliases[0]）。
 */
const fs = require("fs");
const path = require("path");

const CURRENT_SETUP_PREFIX = "Lightbound-Setup";
const LEGACY_SETUP_PREFIXES = ["Inkborne-Setup", "FantaWriter-Setup", "Fantasy-Writer-Setup"];
// 原导出是最旧前缀。别名数组前插入 Inkborne-Setup 后不能再按下标取。
const LEGACY_SETUP_PREFIX = "Fantasy-Writer-Setup";

function fantaWriterAlias(names) {
  const found = names.find((name) => path.basename(String(name)).startsWith("FantaWriter-Setup-"));
  if (!found) throw new Error("缺少 FantaWriter-Setup 别名");
  return found;
}

function setupNamesForVersion(version) {
  const v = String(version || "").replace(/^v/i, "");
  if (!v) throw new Error("缺少 version");
  const aliases = LEGACY_SETUP_PREFIXES.map((prefix) => `${prefix}-${v}.exe`);
  return {
    version: v,
    primary: `${CURRENT_SETUP_PREFIX}-${v}.exe`,
    aliases,
    legacy: fantaWriterAlias(aliases),
  };
}

function hashFromSha256Sidecar(text) {
  const hash = String(text || "").trim().split(/\s+/)[0] || "";
  if (!/^[a-f0-9]{64}$/i.test(hash)) {
    throw new Error("sha256 文件格式无效");
  }
  return hash.toLowerCase();
}

function writeSha256Sidecar(filePath, hash, listedName) {
  const name = listedName || path.basename(filePath);
  fs.writeFileSync(`${filePath}.sha256`, `${hash}  ${name}\n`);
}

/**
 * @param {{ distDir: string, version: string }} opts
 * @returns {{ primary: string, aliases: string[], legacy: string, sha256: string }}
 */
function aliasLegacySetup(opts) {
  const distDir = path.resolve(opts.distDir);
  const names = setupNamesForVersion(opts.version);
  const primary = path.join(distDir, names.primary);
  if (!fs.existsSync(primary)) {
    throw new Error(`找不到安装包 ${primary}`);
  }
  const shaSrc = `${primary}.sha256`;
  if (!fs.existsSync(shaSrc)) {
    throw new Error(`找不到校验文件 ${shaSrc}`);
  }
  const sha256 = hashFromSha256Sidecar(fs.readFileSync(shaSrc, "utf8"));
  const aliases = names.aliases.map((name) => {
    const dest = path.join(distDir, name);
    fs.copyFileSync(primary, dest);
    writeSha256Sidecar(dest, sha256, name);
    return dest;
  });
  return { primary, aliases, legacy: fantaWriterAlias(aliases), sha256 };
}

function main() {
  const version = process.argv[2];
  const distDir = path.resolve(process.argv[3] || "dist-installer");
  const result = aliasLegacySetup({ distDir, version });
  console.log(`[alias-legacy-setup] ${result.primary}`);
  for (const alias of result.aliases) {
    console.log(`[alias-legacy-setup] → ${alias}`);
  }
  console.log(`[alias-legacy-setup] sha256 ${result.sha256}`);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`[alias-legacy-setup] ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}

module.exports = {
  CURRENT_SETUP_PREFIX,
  LEGACY_SETUP_PREFIXES,
  LEGACY_SETUP_PREFIX,
  setupNamesForVersion,
  hashFromSha256Sidecar,
  writeSha256Sidecar,
  aliasLegacySetup,
};
