import { defineConfig } from "@playwright/test";
import base from "./playwright.config.ts";

export default defineConfig({
  ...base,
  testMatch: "features.spec.ts",
  metadata: { chatExpected: false },
  use: { ...base.use, baseURL: "http://127.0.0.1:1436" },
  webServer: {
    command: "npm run dev -- --port 1436",
    url: "http://127.0.0.1:1436",
    reuseExistingServer: false,
    env: { VITE_CHAT_ENABLED: "0" },
  },
});
