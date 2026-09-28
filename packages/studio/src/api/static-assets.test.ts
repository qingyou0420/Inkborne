// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { mountStudioStaticFiles } from "./static-assets.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("production Studio static assets", () => {
  it("serves module/font/image bytes with browser MIME types and keeps misses out of the SPA fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkborne-static-")); roots.push(root);
    await mkdir(join(root, "assets/vendor"), { recursive: true });
    await mkdir(join(root, "fonts"));
    await writeFile(join(root, "index.html"), "<main>Studio</main>");
    await writeFile(join(root, "assets/vendor/diagram.mjs"), "export default 1;");
    await writeFile(join(root, "fonts/body.ttf"), Buffer.from([0, 1, 2, 3]));
    await writeFile(join(root, "studio-light.png"), Buffer.from([137, 80, 78, 71]));
    await writeFile(join(root, "inkborne-mark.png"), Buffer.from([137, 80, 78, 71]));
    await writeFile(join(root, "paper-grain.svg"), "<svg />");
    const app = new Hono(); await mountStudioStaticFiles(app, root);
    const module = await app.request("/assets/vendor/diagram.mjs");
    expect(module.status).toBe(200); expect(module.headers.get("content-type")).toBe("application/javascript");
    expect(await module.text()).toBe("export default 1;");
    const font = await app.request("/fonts/body.ttf");
    expect(font.headers.get("content-type")).toBe("font/ttf");
    expect(new Uint8Array(await font.arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 3]));
    const image = await app.request("/studio-light.png");
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.status).toBe(200);
    expect((await app.request("/inkborne-mark.png")).headers.get("content-type")).toBe("image/png");
    expect((await app.request("/paper-grain.svg")).headers.get("content-type")).toBe("image/svg+xml");
    expect((await app.request("/fonts/missing.woff2")).status).toBe(404);
    expect((await app.request("/assets/missing.mjs")).status).toBe(404);
    expect((await app.request("/api/v1/missing")).status).toBe(404);
    expect(await (await app.request("/book/example/write")).text()).toBe("<main>Studio</main>");
  });
});
