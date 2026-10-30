import { createApi } from "./api.ts";
const { server } = await createApi(
  process.env.WARDLEY_WORKSPACE ?? "./workspace-server",
  process.env.WARDLEY_API_TOKEN ?? "",
);
const port = Number(process.env.PORT ?? 8080);
server.listen(port, process.env.HOST ?? "127.0.0.1", () =>
  console.log(`Wardley API listening on port ${port}`),
);
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
