import { resolve } from "node:path";
import { defineConfig } from "vite";
export default defineConfig({
  clearScreen: false,
  server: {
    port: 48317,
    strictPort: true,
    hmr: { port: 53841, clientPort: 53841 },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: { rollupOptions: { input: { main: resolve(__dirname, "index.html"), settings: resolve(__dirname, "settings.html") } } }
});
