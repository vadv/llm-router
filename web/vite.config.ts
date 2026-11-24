import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// The core serves the built files from the binary, so the base path is "/".
// During development Vite proxies the API to a running router: the deployed
// config listens on 8090. LLM_ROUTER_ORIGIN in the environment or a .env
// file points it at another instance, such as a trial build.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const target = env.LLM_ROUTER_ORIGIN || "http://127.0.0.1:8090";
  return {
    plugins: [react()],
    build: { outDir: "dist", emptyOutDir: true },
    server: {
      proxy: {
        "/health": target,
        "/v1": target,
      },
    },
  };
});
