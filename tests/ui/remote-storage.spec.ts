import { test, expect } from "@playwright/test";

test("remote storage sends revisions, preserves IDs, and blocks unsafe connection changes", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForFunction(() => !!window.wardleyApi);
  const result = await page.evaluate(async () => {
    const initial: any = (
      await window.wardleyApi!.request("GET", "/api/v1/workspace")
    ).body;
    let url = "https://maps.example";
    let conflict = false;
    let unavailable = false;
    const calls: any[] = [];
    window.__TAURI__ = {
      core: {
        invoke: async (command, args): Promise<any> => {
          calls.push({ command, args });
          if (command === "connection_info")
            return { mode: "remote", url, credentialStorage: "system-keyring" };
          if (command === "connection_set") {
            url = args!.url as string;
            return;
          }
          if (command !== "remote_request")
            throw new Error("Unexpected local storage call");
          if (unavailable) throw new Error("Offline");
          if (args!.method === "GET")
            return {
              status: 200,
              body: {
                ...initial,
                metamodelRevision: '"model-1"',
                revisions: Object.fromEntries(
                  initial.maps.map((m: any) => [m.id, '"map-1"']),
                ),
              },
            };
          if (conflict)
            return { status: 412, body: { error: { message: "Conflict" } } };
          return { status: 200, body: args!.body, revision: '"map-2"' };
        },
      },
    };
    const modulePath = "/src/storage.ts?remote-test";
    const { Storage } = await import(modulePath);
    const storage = new Storage();
    await storage.load();
    const map = structuredClone(storage.workspace.maps[0]);
    map.title = "Remote edit";
    await storage.saveMap(map);
    const save = calls.at(-1);
    conflict = true;
    let conflictMessage = "";
    try {
      await storage.saveMap(map);
    } catch (error) {
      conflictMessage = String(error);
    }
    conflict = false;
    const newMap = { ...map, id: "new-map" };
    await storage.saveMap(newMap);
    const create = calls.at(-1);
    await storage.deleteMap(newMap.id);
    const remove = calls.at(-1);
    await storage.connect("remote", "https://other.example", "test-token");
    unavailable = true;
    try {
      await storage.load();
    } catch {
      /* Keep the original in-memory workspace. */
    }
    const count = calls.length;
    let connectionMessage = "";
    try {
      await storage.saveMap(map);
    } catch (error) {
      connectionMessage = String(error);
    }
    return {
      save,
      create,
      remove,
      conflictMessage,
      connectionMessage,
      noWriteAfterFailedReload: calls.length === count,
    };
  });
  expect(result.save.args.method).toBe("PUT");
  expect(result.save.args.revision).toBe('"map-1"');
  expect(result.save.args).not.toHaveProperty("token");
  expect(result.create.args.path).toBe("/api/v1/maps/import");
  expect(result.create.args.body).toMatchObject({
    preserveId: true,
    map: { id: "new-map" },
  });
  expect(result.remove.args.revision).toBe('"map-2"');
  expect(result.conflictMessage).toContain("changed on the server");
  expect(result.connectionMessage).toContain("connection changed");
  expect(result.noWriteAfterFailedReload).toBe(true);
});
