import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, /api goes to the api service; in Compose and on Mynt, the web server proxies it the same way.
export default defineConfig({
  plugins: [react()],
  server: { port: 8080, proxy: { "/api": "http://localhost:3000" } },
});
