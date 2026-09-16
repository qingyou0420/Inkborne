import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
import { localMermaid } from "./build/local-mermaid.mjs";
import { directLucide } from "./build/lucide-direct.mjs";

export default defineConfig({
  plugins: [react(), tailwindcss(), localMermaid(), directLucide()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      "@actalk/inkos-core/volume-map-tree": resolve(__dirname, "../core/src/volume-map-tree.ts"),
      "@actalk/inkos-core/review-author-copy": resolve(__dirname, "../core/src/review-author-copy.ts"),
    },
  },
  server: {
    port: 4567,
    proxy: {
      "/api/v1/events": {
        target: `http://localhost:${process.env.INKOS_STUDIO_PORT ?? "4569"}`,
        changeOrigin: true,
        // SSE needs unbuffered streaming — bypass http-proxy response handling
        selfHandleResponse: true,
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes, _req, res) => {
            res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
            proxyRes.pipe(res);
          });
        },
      },
      "/api": {
        target: `http://localhost:${process.env.INKOS_STUDIO_PORT ?? "4569"}`,
        changeOrigin: true,
      },
    },
  },
});
