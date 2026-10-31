import { defineConfig } from "vite";

export default defineConfig({
  // The OpenCASCADE glue is a pre-bundled Emscripten module; keep Vite from re-processing it.
  optimizeDeps: { exclude: ["opencascade.js"] },
  worker: { format: "es" },
  build: { target: "es2022", chunkSizeWarningLimit: 4000 },
});
