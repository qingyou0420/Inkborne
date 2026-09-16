/**
 * Temporary patch: electron-builder extractArchive rename fails on Windows
 * when antivirus locks freshly extracted electron.exe (EPERM).
 * Adds retries + copy fallback.
 */
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Resolve the exact dependency used by the desktop builder, including pnpm's
// isolated node_modules layout instead of assuming root-level hoisting.
const desktopRequire = createRequire(path.join(root, "packages/desktop/package.json"));
const builderRequire = createRequire(
  desktopRequire.resolve("electron-builder/package.json")
);
const target = builderRequire.resolve("app-builder-lib/out/util/electronGet.js");

let s = fs.readFileSync(target, "utf8");

const old = `        await fs.rm(dir, { recursive: true, force: true });
        await fs.rename(tmpDir, dir);`;

const neu = `        await fs.rm(dir, { recursive: true, force: true });
        // Windows antivirus often locks freshly extracted electron.exe; retry rename / fallback copy
        let renamed = false;
        for (let attempt = 0; attempt < 12; attempt++) {
            try {
                await fs.rename(tmpDir, dir);
                renamed = true;
                break;
            }
            catch (e) {
                const code = e && e.code;
                if (!["EPERM", "EACCES", "EBUSY", "EAGAIN"].includes(code)) throw e;
                builder_util_1.log.warn({ attempt: attempt + 1, code, tmpDir, dir }, "rename locked, retrying");
                await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
                await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
            }
        }
        if (!renamed) {
            builder_util_1.log.warn({ tmpDir, dir }, "rename failed after retries; copying");
            await fs.cp(tmpDir, dir, { recursive: true, force: true });
            await fs.rm(tmpDir, { recursive: true, force: true });
        }`;

if (s.includes("rename locked, retrying")) {
  console.log("Already patched:", target);
  process.exit(0);
}

if (!s.includes(old)) {
  console.error("Pattern not found in", target);
  process.exit(1);
}

fs.writeFileSync(target, s.replace(old, neu));
console.log("Patched:", target);
