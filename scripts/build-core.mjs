import { spawnSync } from "node:child_process";

// Set both flags so the package omits the chat frontend and native commands.
const result = spawnSync(
  process.execPath,
  [
    process.env.npm_execpath,
    "run",
    "desktop:build",
    "--",
    ...process.argv.slice(2),
    "--",
    "--no-default-features",
    "--locked",
  ],
  { stdio: "inherit", env: { ...process.env, VITE_CHAT_ENABLED: "0" } },
);
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
