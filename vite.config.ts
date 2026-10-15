/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  // Prevent vite from obscuring Rust errors
  clearScreen: false,
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Don't watch Rust sources — Tauri handles that
      ignored: ["**/src-tauri/**"],
    },
  },
}));
