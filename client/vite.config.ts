/** Enables React compilation and Tailwind's Vite-native CSS processing. */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The API process during local development. Production never uses this because
// the built frontend is served by the API itself, from a single origin.
const DEV_API_TARGET =
  process.env.VITE_DEV_API_TARGET ?? "http://localhost:3000";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],

  server: {
    // Proxying keeps development same-origin, which matches production and
    // means session cookies behave identically in both places.
    proxy: {
      "/api": {
        target: DEV_API_TARGET,
        changeOrigin: false,
      },
      "/health": {
        target: DEV_API_TARGET,
        changeOrigin: false,
      },
    },
  },
});
