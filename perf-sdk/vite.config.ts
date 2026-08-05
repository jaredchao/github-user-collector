import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      name: "PerfSDK",
      // ESM for bundlers, IIFE for a plain <script> tag on pages that have
      // no build step. The IIFE build is what the homework demo loads.
      formats: ["es", "iife"],
      fileName: (format) => (format === "es" ? "perf-sdk.js" : "perf-sdk.iife.js"),
    },
    // The SDK sits on the critical path of every page that loads it, so the
    // bundle is kept dependency-free and minified.
    minify: "esbuild",
    sourcemap: true,
  },
  test: {
    environment: "jsdom",
    globals: true,
  },
});
