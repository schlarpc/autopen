import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  root: "demo",
  base: "./",
  build: {
    outDir: "../demo-dist",
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      // Import library source directly during dev (live reload)
      autopen: resolve(__dirname, "src/index.ts"),
    },
  },
});
