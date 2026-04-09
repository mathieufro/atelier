import { defineConfig } from "vite"
import solidPlugin from "vite-plugin-solid"
import path from "node:path"

export default defineConfig({
  plugins: [solidPlugin()],
  resolve: {
    alias: {
      "@atelier/core": path.resolve(__dirname, "../core/src"),
    },
  },
  build: {
    outDir: path.resolve(__dirname, "../../extension/dist/webview"),
    emptyOutDir: true,
    lib: {
      entry: path.resolve(__dirname, "src/webview.tsx"),
      formats: ["iife"],
      name: "AtelierWebview",
      fileName: () => "webview.js",
    },
    rollupOptions: {
      output: {
        assetFileNames: "webview.[ext]",
      },
    },
    minify: true,
    cssMinify: true,
  },
})
