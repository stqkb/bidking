import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8000",
    },
  },
  optimizeDeps: {
    include: ["echarts", "react", "react-dom"],
  },
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 1200,
  },
});
