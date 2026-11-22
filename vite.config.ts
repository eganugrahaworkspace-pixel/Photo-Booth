import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL("./index.html", import.meta.url)),
        p: fileURLToPath(new URL("./p.html", import.meta.url)),
      },
    },
  },
});
