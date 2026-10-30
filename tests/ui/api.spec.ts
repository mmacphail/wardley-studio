import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
async function request(
  page: Page,
  method: string,
  path: string,
  body: unknown = {},
) {
  return page.evaluate(
    async ({ method, path, body }) =>
      window.wardleyApi!.request(method, `/api/v1${path}`, body),
    { method, path, body },
  );
}
async function ok(
  page: Page,
  method: string,
  path: string,
  body: unknown = {},
): Promise<any> {
  const result = await request(page, method, path, body);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body;
}
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => !!window.wardleyApi);
});

test("API creates, connects, edits, exports and imports maps with disk-equivalent persistence", async ({
  page,
}) => {
  const model = await ok(page, "GET", "/metamodel");
  expect(
    model.componentTypes.find((t: any) => t.id === "activity").stageLabels,
  ).toEqual([
    "Genesis",
    "Custom built",
    "Product (+ rental)",
    "Commodity (+ utility)",
  ]);
  const map = await ok(page, "POST", "/actions/new", {
    title: "API map",
    anchor: false,
  });
  await expect(page.locator("h1")).toHaveText("API map");
  const node = await ok(page, "POST", `/maps/${map.id}/components`, {
    type: "activity",
    label: "API capability",
    stage: 2,
    visibility: 0.8,
  });
  expect(node.evolution).toBe(0.625);
  const dependency = await ok(page, "POST", `/maps/${map.id}/components`, {
    type: "data",
    label: "Records",
    parentId: node.id,
  });
  let edges = await ok(page, "GET", `/maps/${map.id}/connections`);
  expect(edges).toHaveLength(1);
  expect(edges[0].source).toBe(node.id);
  await ok(page, "PATCH", `/maps/${map.id}/components/${node.id}`, {
    evolution: 0.7,
    visibility: 0.9,
    notes: "API notes",
    inertia: true,
    targetEvolution: 0.95,
  });
  await ok(page, "PATCH", `/maps/${map.id}/connections/${edges[0].id}`, {
    label: "uses",
  });
  await ok(
    page,
    "POST",
    `/maps/${map.id}/components/${dependency.id}/duplicate`,
    { label: "Records copy" },
  );
  await ok(page, "DELETE", `/maps/${map.id}/components/${node.id}`);
  expect(await ok(page, "GET", `/maps/${map.id}/connections`)).toHaveLength(0);
  await ok(page, "POST", `/maps/${map.id}/undo`);
  expect(await ok(page, "GET", `/maps/${map.id}/connections`)).toHaveLength(1);
  await ok(page, "POST", `/maps/${map.id}/redo`);
  await ok(page, "POST", "/actions/undo");
  const svg = await request(page, "GET", `/maps/${map.id}/export/svg`);
  expect(svg.contentType).toBe("image/svg+xml");
  expect(svg.body).toContain("Product (+ rental)");
  expect(svg.body).toContain("API capability");
  const exported = await ok(page, "POST", "/actions/export-json");
  const imported = await ok(page, "POST", "/actions/import", exported);
  expect(imported.id).not.toBe(map.id);
  expect(imported.nodes).toEqual(exported.nodes);
  await ok(page, "DELETE", `/maps/${imported.id}`);
  await page.reload();
  await page.waitForFunction(() => !!window.wardleyApi);
  expect((await ok(page, "GET", `/maps/${map.id}`)).nodes).toEqual(
    exported.nodes,
  );
  expect((await request(page, "GET", `/maps/${imported.id}`)).status).toBe(404);
});

test("every menu action has an explicit discoverable route and UI controls stay synchronized", async ({
  page,
}) => {
  const routes = await ok(page, "GET", "/routes");
  const source = readFileSync(
    new URL("../../src/main.ts", import.meta.url),
    "utf8",
  );
  const actions = new Set([
    ...[...source.matchAll(/data-(?:modal-)?action="([a-z-]+)"/g)].map(
      (m) => m[1],
    ),
    ...[...source.matchAll(/button\("([a-z-]+)",/g)].map((m) => m[1]),
    "drawer-maps",
    "drawer-components",
    "drawer-inspector",
  ]);
  for (const action of actions)
    expect(
      routes.some(
        (r: any) =>
          r.method === "POST" && r.path === `/api/v1/actions/${action}`,
      ),
      action,
    ).toBe(true);
  const spec = await ok(page, "GET", "/openapi.json");
  expect(spec.openapi).toBe("3.1.0");
  expect(spec.paths["/api/v1/maps/{id}/components/{node}"].patch).toBeDefined();
  for (const action of [
    "select",
    "connect",
    "pan",
    "zoom-in",
    "zoom-out",
    "fit",
    "drawer-maps",
    "drawer-components",
    "drawer-inspector",
    "close-drawer",
    "focus",
    "focus",
    "save",
  ])
    await ok(page, "POST", `/actions/${action}`);
  await ok(page, "PATCH", "/ui", {
    selectedId: "experience",
    drawer: "inspector",
    tool: "select",
    autoConnect: false,
  });
  await expect(page.locator("#node-label")).toHaveValue("In-store experience");
  await expect(page.locator("#auto-connect")).not.toBeChecked();
  await page.locator("#node-label").fill("Committed from API");
  await ok(page, "POST", "/actions/save");
  expect(
    (await ok(page, "GET", "/maps/coffee-shop/components/experience")).label,
  ).toBe("Committed from API");
  await ok(page, "POST", "/actions/clone-node");
  expect(await ok(page, "GET", "/maps/coffee-shop/components")).toHaveLength(
    11,
  );
  await ok(page, "POST", "/actions/delete-selection");
  await ok(page, "POST", "/actions/undo");
  await ok(page, "PUT", "/ui/view", { x: 50, y: 30, width: 900 });
  await expect(page.locator("#map-canvas")).toHaveAttribute(
    "viewBox",
    /50 30 900/,
  );
  await ok(page, "POST", "/actions/details", { title: "Renamed by API" });
  await expect(page.locator("h1")).toHaveText("Renamed by API");
  const duplicate = await ok(page, "POST", "/actions/duplicate");
  await ok(page, "POST", "/actions/delete-map");
  expect((await request(page, "GET", `/maps/${duplicate.id}`)).status).toBe(
    404,
  );
});

test("API rejects invalid changes atomically and protects open dialog drafts", async ({
  page,
}) => {
  const before = await ok(page, "GET", "/maps/coffee-shop");
  expect((await request(page, "PATCH", "/ui", { labels: null })).status).toBe(
    422,
  );
  for (const body of [
    { stage: 9 },
    { visibility: 3 },
    { label: "" },
    { stage: 1, evolution: 0.6 },
    { inertia: "yes" },
    { targetEvolution: 0.01 },
    { typo: true },
  ]) {
    expect(
      (
        await request(
          page,
          "PATCH",
          "/maps/coffee-shop/components/experience",
          body,
        )
      ).status,
    ).toBe(422);
  }
  expect(await ok(page, "GET", "/maps/coffee-shop")).toEqual(before);
  expect(
    (
      await request(page, "POST", "/maps/coffee-shop/connections", {
        source: "experience",
        target: "experience",
      })
    ).status,
  ).toBe(422);
  expect(
    (await request(page, "DELETE", "/maps/coffee-shop/components/missing"))
      .status,
  ).toBe(404);
  expect(
    (await request(page, "POST", "/maps/import", { schemaVersion: 1 })).status,
  ).toBe(422);
  expect((await request(page, "PUT", "/state")).status).toBe(405);
  expect((await request(page, "GET", "/missing")).status).toBe(404);
  await ok(page, "POST", "/ui/dialog/new");
  await page.locator('input[name="title"]').fill("Unfinished draft");
  expect(
    (await request(page, "POST", "/actions/new", { title: "API" })).status,
  ).toBe(409);
  await expect(page.locator('input[name="title"]')).toHaveValue(
    "Unfinished draft",
  );
  expect((await ok(page, "POST", "/actions/export-json")).id).toBe(
    "coffee-shop",
  );
  await ok(page, "POST", "/actions/close-dialog");
  await expect(page.locator("dialog")).toHaveCount(0);
  await ok(page, "PATCH", "/ui", { labels: false, focusMode: true });
  await expect(page.locator(".node-label")).toHaveCount(0);
  await expect(page.locator(".app-header")).toBeHidden();
});

test("API validates metamodel edits and serializes concurrent component additions", async ({
  page,
}) => {
  const model = await ok(page, "GET", "/metamodel");
  const invalid = structuredClone(model);
  invalid.componentTypes = invalid.componentTypes.filter(
    (t: any) => t.id !== "activity",
  );
  expect((await request(page, "PUT", "/metamodel", invalid)).status).toBe(422);
  expect(await ok(page, "GET", "/metamodel")).toEqual(model);
  model.componentTypes.push({
    id: "team",
    label: "Team",
    description: "Team",
    shape: "hexagon",
    color: "#123456",
    stageLabels: ["New", "Forming", "Established", "Standard"],
  });
  await ok(page, "POST", "/metamodel/validate", model);
  await ok(page, "POST", "/actions/save-metamodel", model);
  await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      ok(page, "POST", "/maps/coffee-shop/components", {
        type: "team",
        label: `Team ${i}`,
        autoConnect: false,
      }),
    ),
  );
  const nodes = await ok(page, "GET", "/maps/coffee-shop/components");
  expect(nodes.filter((n: any) => n.type === "team")).toHaveLength(5);
  await ok(page, "POST", "/actions/reload");
  expect(await ok(page, "GET", "/maps/coffee-shop/components")).toEqual(nodes);
  await ok(page, "POST", "/actions/drawer-components");
  await expect(page.locator('[data-type="team"]')).toBeVisible();
});

test("current model exposes components, stages, links and metamodel without switching maps", async ({
  page,
}) => {
  const current = await ok(page, "GET", "/current-map");
  expect(current.id).toBe("coffee-shop");
  const model = await ok(page, "GET", "/current-map/model");
  expect(model.components).toHaveLength(current.nodes.length);
  expect(model.links).toEqual(current.edges);
  expect(model.metamodel.componentTypes).toHaveLength(6);
  const component = model.components.find(
    (node: any) => node.id === "experience",
  );
  expect(component.typeDefinition.id).toBe("activity");
  expect(component.stage.index).toBe(Math.floor(component.evolution * 4));
  expect(component.stage.label).toBe(
    component.typeDefinition.stageLabels[component.stage.index],
  );
  for (const id of component.outgoingLinkIds)
    expect(model.links.find((link: any) => link.id === id).source).toBe(
      component.id,
    );
  const other = await ok(page, "GET", "/maps/working-practices/model");
  expect(other.active).toBe(false);
  expect(other.axes.evolution.stages).toEqual([
    "Novel",
    "Emerging",
    "Good",
    "Best",
  ]);
  expect((await ok(page, "GET", "/current-map")).id).toBe("coffee-shop");
  await ok(page, "PATCH", "/maps/coffee-shop/components/experience", {
    stage: 2,
  });
  const updated = await ok(page, "GET", "/current-map/model");
  expect(
    updated.components.find((node: any) => node.id === "experience").stage
      .label,
  ).toBe("Product (+ rental)");
  expect(await ok(page, "GET", "/current-map/components")).toEqual(
    updated.map.nodes,
  );
  expect(await ok(page, "GET", "/current-map/connections")).toEqual(
    updated.links,
  );
});

test("API deletion and new maps clear unfinished connection sources", async ({
  page,
}) => {
  await ok(page, "PATCH", "/ui", { selectedId: "experience" });
  await ok(page, "POST", "/actions/connect-selected");
  await ok(page, "DELETE", "/maps/coffee-shop/components/experience");
  expect((await ok(page, "GET", "/state")).connectFrom).toBeNull();
  await ok(page, "PATCH", "/ui", { selectedId: "payment" });
  await ok(page, "POST", "/actions/connect-selected");
  await ok(page, "POST", "/maps", { title: "New graph", anchor: false });
  expect((await ok(page, "GET", "/state")).connectFrom).toBeNull();
});

test("map snapshots contain rendered pixels and live positions without changing the editor", async ({
  page,
}) => {
  await ok(page, "PUT", "/ui/view", { x: 200, y: 100, width: 700 });
  await ok(page, "PATCH", "/ui", { labels: false, selectedId: "experience" });
  const state = await ok(page, "GET", "/state");
  const map = await ok(page, "GET", "/current-map");
  const snapshot = await ok(page, "GET", "/current-map/snapshot");
  expect(snapshot).toMatchObject({
    mapId: "coffee-shop",
    mimeType: "image/png",
    width: 1650,
    height: 1140,
    scope: "full-map",
    labels: true,
  });
  expect(snapshot.dataUrl).toMatch(/^data:image\/png;base64,iVBOR/);
  const pixels = await page.evaluate(async (url) => {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, image.width, image.height).data;
    let ink = 0;
    for (let i = 0; i < data.length; i += 4)
      if (
        data[i] < 150 &&
        data[i + 1] < 150 &&
        data[i + 2] < 150 &&
        data[i + 3] > 0
      )
        ink++;
    return { width: image.width, height: image.height, ink };
  }, snapshot.dataUrl);
  expect(pixels).toMatchObject({ width: 1650, height: 1140 });
  expect(pixels.ink).toBeGreaterThan(1000);
  const node = map.nodes.find((n: any) => n.id === "experience");
  const pixel = snapshot.components.find((n: any) => n.id === "experience");
  expect(pixel.x).toBeCloseTo(135 + node.evolution * 1380);
  expect(pixel.y).toBeCloseTo(60 + (1 - node.visibility) * 915);
  expect(await ok(page, "GET", "/state")).toEqual(state);
  expect(await ok(page, "GET", "/current-map")).toEqual(map);
  const other = await ok(page, "GET", "/maps/working-practices/snapshot");
  expect(other.mapId).toBe("working-practices");
  expect(other.dataUrl).not.toBe(snapshot.dataUrl);
  expect((await ok(page, "GET", "/state")).activeMapId).toBe("coffee-shop");
  expect((await request(page, "GET", "/maps/missing/snapshot")).status).toBe(
    404,
  );
  await ok(page, "PATCH", "/maps/coffee-shop/components/experience", {
    visibility: 0.9,
  });
  const updated = await ok(page, "GET", "/current-map/snapshot");
  expect(updated.dataUrl).not.toBe(snapshot.dataUrl);
  expect(
    updated.components.find((n: any) => n.id === "experience").y,
  ).toBeCloseTo(151.5);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    "test-results/map-snapshot.png",
    Buffer.from(snapshot.dataUrl.split(",")[1], "base64"),
  );
  const spec = await ok(page, "GET", "/openapi.json");
  expect(spec.paths["/api/v1/current-map/snapshot"].get).toBeDefined();
  await page.evaluate(() => {
    HTMLCanvasElement.prototype.getContext = (() => null) as any;
  });
  const failed = await request(page, "GET", "/current-map/snapshot");
  expect(failed.status).toBe(422);
  expect(failed.body).toMatchObject({
    error: { message: "Map image capture is unavailable." },
  });
});
