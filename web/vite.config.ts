import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The core serves the built files from the binary, so the base path is "/".
// During development Vite proxies the API to a running router. The deployed
// config listens on 8090, so the dev target uses the same port.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    proxy: {
      "/health": "http://127.0.0.1:8090",
      "/v1": "http://127.0.0.1:8090",
    },
  },
});