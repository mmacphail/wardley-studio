import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createApi } from "../../server/api.ts";

const token = "test-only-".repeat(6);
test("cloud API authenticates, validates, serializes edits, renders, and persists", async () => {
  const root = await mkdtemp(join(tmpdir(), "wardley-api-"));
  let api = await createApi(root, token);
  const start = async () => {
    api.server.listen(0, "127.0.0.1");
    await once(api.server, "listening");
    return `http://127.0.0.1:${(api.server.address() as any).port}`;
  };
  const stop = () =>
    new Promise<void>((resolve, reject) =>
      api.server.close((error) => (error ? reject(error) : resolve())),
    );
  let base = await start();
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    revision?: string,
    extra: Record<string, string> = {},
  ) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(revision ? { "If-Match": revision } : {}),
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = response.headers.get("content-type")?.includes("json")
      ? await response.json()
      : Buffer.from(await response.arrayBuffer());
    return {
      status: response.status,
      body: value,
      revision: response.headers.get("etag")!,
    };
  };
  try {
    assert.equal((await fetch(base + "/health")).status, 200);
    assert.equal((await fetch(base + "/api/v1/maps")).status, 401);
    assert.equal(
      (
        await call("GET", "/api/v1/maps", undefined, undefined, {
          Origin: "https://evil.example",
        })
      ).status,
      403,
    );
    assert.equal(
      (await call("POST", "/api/v1/maps", { title: "" })).status,
      422,
    );
    const created = await call("POST", "/api/v1/maps", { title: "Cloud test" });
    assert.equal(created.status, 201);
    const path = `/api/v1/maps/${created.body.id}`;
    assert.equal(
      (await call("PATCH", path, { title: "No revision" })).status,
      428,
    );
    const contenders = await Promise.all(
      ["First", "Second"].map((title) =>
        call("PATCH", path, { title }, created.revision),
      ),
    );
    assert.deepEqual(contenders.map((r) => r.status).sort(), [200, 412]);
    let current = await call("GET", path);
    const type = (await call("GET", "/api/v1/metamodel")).body.componentTypes[0]
      .id;
    const first = await call(
      "POST",
      path + "/components",
      { type, label: "User", stage: 1, visibility: 0.9 },
      current.revision,
    );
    assert.equal(first.status, 201);
    assert.equal(first.body.evolution, 0.375);
    const second = await call(
      "POST",
      path + "/components",
      { type, label: "Need", evolution: 0.6, parent: first.body.id },
      first.revision,
    );
    assert.equal(second.status, 201);
    const model = await call("GET", path + "/model");
    assert.equal(model.body.components.length, 2);
    assert.equal(model.body.links.length, 1);
    assert.equal(model.body.components[0].stage.index, 1);
    assert.equal(
      (
        await call(
          "PATCH",
          path + `/components/${first.body.id}`,
          { evolution: 2 },
          second.revision,
        )
      ).status,
      422,
    );
    assert.equal(
      (
        await call(
          "POST",
          path + "/links",
          { source: first.body.id, target: second.body.id },
          second.revision,
        )
      ).status,
      422,
    );
    const snapshot = await call("GET", path + "/snapshot");
    assert.equal(snapshot.body.components.length, 2);
    assert.ok(snapshot.body.dataUrl.startsWith("data:image/png;base64,"));
    const png = await call("GET", path + "/snapshot.png");
    assert.equal(png.body.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(png.body.readUInt32BE(16), 1650);
    const relabeled = await call(
      "PATCH",
      path + `/components/${first.body.id}`,
      { label: "Visible label regression check" },
      png.revision,
    );
    assert.equal(relabeled.status, 200);
    const relabeledPng = await call("GET", path + "/snapshot.png");
    assert.notDeepEqual(
      relabeledPng.body,
      png.body,
      "Changing only a label must change rendered pixels",
    );
    assert.equal((await call("GET", path + "/export/svg")).status, 200);
    const meta = await call("GET", "/api/v1/metamodel");
    const badMeta = structuredClone(meta.body);
    badMeta.componentTypes = badMeta.componentTypes.filter(
      (t: any) => t.id !== type,
    );
    assert.equal(
      (await call("PUT", "/api/v1/metamodel", badMeta, meta.revision)).status,
      422,
    );
    assert.equal(
      (await call("GET", "/api/v1/workspace/export")).body.maps.length,
      1,
    );
    const duplicate = await call("POST", path + "/duplicate", {});
    assert.equal(duplicate.status, 201);
    assert.notEqual(duplicate.body.id, created.body.id);
    const imported = await call("POST", "/api/v1/maps/import", duplicate.body);
    assert.equal(imported.status, 201);
    assert.notEqual(imported.body.id, duplicate.body.id);
    assert.equal((await call("GET", "/api/v1/maps/a%2Fb")).status, 422);
    await stop();
    api = await createApi(root, token);
    base = await start();
    current = await call("GET", path);
    assert.equal(current.body.nodes.length, 2);
    assert.equal(current.body.edges.length, 1);
    const deletedNode = await call(
      "DELETE",
      path + `/components/${first.body.id}`,
      undefined,
      current.revision,
    );
    assert.equal(deletedNode.status, 200);
    assert.equal((await call("GET", path)).body.edges.length, 0);
    assert.equal(
      (await call("DELETE", path, undefined, deletedNode.revision)).status,
      200,
    );
    assert.equal((await call("GET", path)).status, 404);
    const trash = await readdir(join(root, ".trash"));
    assert.equal(trash.length, 1);
    assert.equal(
      JSON.parse(await readFile(join(root, ".trash", trash[0]), "utf8")).id,
      created.body.id,
    );
  } finally {
    await stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses to start without a strong token", async () => {
  await assert.rejects(createApi("/unused", "short"), /at least 32/);
});
