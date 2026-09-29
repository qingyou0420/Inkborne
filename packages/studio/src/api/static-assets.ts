// SPDX-License-Identifier: AGPL-3.0-only
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { Hono } from "hono";

const contentTypes: Record<string, string> = {
  js: "application/javascript", mjs: "application/javascript", css: "text/css",
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  webp: "image/webp", ico: "image/x-icon", json: "application/json",
  ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2",
  txt: "text/plain; charset=utf-8", md: "text/plain; charset=utf-8",
};

/** Serve the bundled browser assets from the explicit engine distribution only. */
export async function mountStudioStaticFiles(app: Hono, staticDir: string): Promise<void> {
  const root = resolve(staticDir);
  app.on("GET", ["/assets/*", "/fonts/*", "/studio-light.png", "/inkborne-mark.png", "/inkborne-mark.svg", "/paper-grain.svg", "/favicon.ico"], async (c) => {
    let pathname: string;
    try { pathname = decodeURIComponent(c.req.path); } catch { return c.notFound(); }
    const file = resolve(root, `.${pathname}`);
    const child = relative(root, file);
    if (child.startsWith("..") || isAbsolute(child)) return c.notFound();
    try {
      const content = await readFile(file);
      const ext = file.split(".").pop()?.toLowerCase() ?? "";
      return new Response(content, { headers: { "Content-Type": contentTypes[ext] ?? "application/octet-stream" } });
    } catch { return c.notFound(); }
  });
  let index: string;
  try { index = await readFile(resolve(root, "index.html"), "utf8"); } catch { return; }
  app.get("*", (c) => c.req.path.startsWith("/api/") ? c.notFound() : c.html(index));
}
