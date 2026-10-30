import { defineConfig, loadEnv } from "vite";
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const value = env.VITE_CHAT_ENABLED;
  const chat =
    value === undefined ||
    ["1", "true", "on"].includes(value.trim().toLowerCase());
  return {
    define: { __CHAT_ENABLED__: JSON.stringify(chat) },
    server: {
      port: 1435,
      strictPort: true,
      watch: { ignored: ["**/src-tauri/**", "**/workspace/**"] },
    },
    clearScreen: false,
    envPrefix: ["VITE_", "TAURI_ENV_*"],
    build: { target: "es2022" },
  };
});
