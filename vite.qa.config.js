// The quality-check library (src/lib/qualityChecks.js over the costing
// library) built as ONE self-contained IIFE that defines window.GradconQA,
// into dist/assets/gradcon-qa.js with a fixed name: the AI Engine loads it
// from location.origin + "/assets/gradcon-qa.js" the first time the Quality
// checks tab runs. Same contract as vite.3d.config.js.
import { defineConfig } from "vite";
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false,
    lib: { entry: "src/qa-entry.js", name: "GradconQA", formats: ["iife"], fileName: () => "assets/gradcon-qa.js" },
    rollupOptions: { output: { inlineDynamicImports: true } },
    minify: true,
    sourcemap: false,
  },
});
