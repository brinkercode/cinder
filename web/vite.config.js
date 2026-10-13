import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // CI runners are shared; the 5s default times out render tests under load.
  test: { testTimeout: 30000, setupFiles: ["src/test-setup.js"] },
  server: { proxy: { "/api": { target: "http://localhost:8787", ws: true } } },
});
