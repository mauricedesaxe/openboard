import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    cloudflare(
      mode === "e2e"
        ? {
            configPath: "./wrangler.e2e.jsonc",
            persistState: { path: ".wrangler/e2e-final" },
          }
        : {},
    ),
  ],
}));
