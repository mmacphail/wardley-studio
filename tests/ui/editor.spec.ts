import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
const sample = JSON.parse(
  readFileSync(
    new URL("../../examples/maps/coffee-shop.json", import.meta.url),
    "utf8",
  ),
);
async function openDrawer(
  page: Page,
  drawer: "maps" | "components" | "inspector",
) {
  const toggle = page.locator(`[data-action="drawer-${drawer}"]`);
  if ((await toggle.getAttribute("aria-expanded")) !== "true")
    await toggle.click();
}
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("h1")).toHaveText("The coffee shop");
});

test("overview and templates render without page errors or overflow", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(page.locator("[data-node]")).toHaveCount(10);
  await expect(page.locator("[data-edge]")).toHaveCount(9);
  await page.screenshot({
    animations: "disabled",
    path: "test-results/overview.png",
  });
  await openDrawer(page, "maps");
  await page.locator('[data-map="working-practices"]').click();
  await expect(page.locator("#map-canvas")).toContainText("Novel");
  await expect(page.locator("#map-canvas")).toContainText("Best");
  await openDrawer(page, "maps");
  await page.locator('[data-map="platform-future"]').click();
  await expect(
    page.locator('#map-canvas [marker-end="url(#evolution-arrow)"]'),
  ).toHaveCount(3);
  expect(errors).toEqual([]);
  await page.setViewportSize({ width: 1050, height: 700 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("dragging changes stage and connected lines follow; undo and redo restore positions", async ({
  page,
}) => {
  const node = page.locator('[data-node="experience"]');
  const original = await node.getAttribute("transform");
  const before = await page
    .locator('[data-edge="coffee-shop-e1"] .edge-line')
    .getAttribute("d");
  const center = await node.evaluate((el) => {
    const p = new DOMPoint(0, 0).matrixTransform(
      (el as SVGGraphicsElement).getScreenCTM()!,
    );
    return { x: p.x, y: p.y };
  });
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x + 170, center.y + 25, { steps: 12 });
  await page.mouse.up();
  expect(
    await page.locator('[data-node="experience"]').getAttribute("transform"),
  ).not.toEqual(original);
  expect(
    await page
      .locator('[data-edge="coffee-shop-e1"] .edge-line')
      .getAttribute("d"),
  ).not.toEqual(before);
  await expect(page.locator("#node-label")).toHaveValue("In-store experience");
  await page
    .getByRole("button", { name: "Undo (Ctrl/⌘ Z)", exact: true })
    .click();
  await expect(page.locator('[data-node="experience"]')).toHaveAttribute(
    "transform",
    original!,
  );
  await page
    .getByRole("button", { name: "Redo (Ctrl/⌘ Shift Z)", exact: true })
    .click();
  expect(
    await page.locator('[data-node="experience"]').getAttribute("transform"),
  ).not.toEqual(original);
  await expect(page.locator("#save-status")).toContainText("Saved in browser");
  const saved = await page
    .locator('[data-node="experience"]')
    .getAttribute("transform");
  await page.reload();
  await expect(page.locator('[data-node="experience"]')).toHaveAttribute(
    "transform",
    saved!,
  );
});

test("new map, auto-connect, stage editing, notes and future evolution persist", async ({
  page,
}) => {
  await openDrawer(page, "maps");
  await page.locator('[data-action="new"]').click();
  await page.locator('input[name="title"]').fill("My strategy");
  await page.getByRole("button", { name: "Create map", exact: true }).click();
  await expect(page.locator("h1")).toHaveText("My strategy");
  await expect(page.locator("[data-node]")).toHaveCount(2);
  await page.locator("[data-node]").last().click();
  await openDrawer(page, "components");
  await page.locator('[data-type="practice"]').click();
  await expect(page.locator("[data-node]")).toHaveCount(3);
  await expect(page.locator("[data-edge]")).toHaveCount(2);
  await page.locator("#node-label").fill("Continuous discovery");
  await page.locator("#node-label").press("Tab");
  await page.locator('[data-stage="2"]').click();
  await expect(page.locator('[data-stage="2"]')).toHaveClass("chosen");
  await page.locator("#node-target-enabled").check();
  await page.locator("#node-inertia").check();
  await page.locator("#node-notes").fill("Test our assumptions.");
  await page.locator("#node-notes").press("Tab");
  await expect(page.locator("#save-status")).toContainText("Saved in browser");
  await page.reload();
  await openDrawer(page, "maps");
  await page
    .getByRole("button", { name: "My strategy Landscape", exact: true })
    .click();
  await page.locator("[data-node]").last().click();
  await expect(page.locator("#node-notes")).toHaveValue(
    "Test our assumptions.",
  );
  await expect(page.locator("#node-target-enabled")).toBeChecked();
  await expect(page.locator("#node-inertia")).toBeChecked();
});

test("connection tool prevents duplicates and a port creates a connected dependency", async ({
  page,
}) => {
  await page.locator('[data-action="connect"]').click();
  await page.locator('[data-node="experience"]').click();
  await page.locator('[data-node="payment"]').click();
  await expect(page.locator("[data-edge]")).toHaveCount(10);
  await page.locator('[data-node="experience"]').click();
  await page.locator('[data-node="payment"]').click();
  await expect(page.locator("[data-edge]")).toHaveCount(10);
  await page.locator('[data-action="select"]').click();
  await page.locator('[data-node="payment"]').click();
  const port = await page.locator('[data-port="payment"]').evaluate((el) => {
    const p = new DOMPoint(0, 0).matrixTransform(
      (el as SVGGraphicsElement).getScreenCTM()!,
    );
    return { x: p.x, y: p.y };
  });
  const empty = await page.locator("#map-canvas").evaluate((el) => {
    const p = new DOMPoint(200, 400).matrixTransform(
      (el as SVGGraphicsElement).getScreenCTM()!,
    );
    return { x: p.x, y: p.y };
  });
  await page.mouse.move(port.x, port.y);
  await page.mouse.down();
  await page.mouse.move(empty.x, empty.y, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator("[data-node]")).toHaveCount(11);
  await expect(page.locator("[data-edge]")).toHaveCount(11);
});

test("metamodel validates edits and supports new types", async ({ page }) => {
  await openDrawer(page, "maps");
  await page.locator('[data-action="metamodel"]').click();
  const model = JSON.parse(await page.locator("#model-json").inputValue());
  model.componentTypes[0].stageLabels.pop();
  await page.locator("#model-json").fill(JSON.stringify(model));
  await page.getByRole("button", { name: "Validate & save" }).click();
  await expect(page.locator("#modal-error")).toContainText("four stage labels");
  model.componentTypes[0].stageLabels.push("Commodity");
  model.componentTypes.push({
    id: "team",
    label: "Team",
    description: "People working together",
    shape: "hexagon",
    color: "#123456",
    stageLabels: ["Novel", "Forming", "Established", "Standard"],
  });
  await page.locator("#model-json").fill(JSON.stringify(model));
  await page.getByRole("button", { name: "Validate & save" }).click();
  await openDrawer(page, "components");
  await expect(page.locator('[data-type="team"]')).toBeVisible();
  await page.locator('[data-type="team"]').click();
  await expect(page.locator("#node-type")).toHaveValue("team");
});

test("JSON import/export round-trip and invalid imports leave the map intact", async ({
  page,
}) => {
  await openDrawer(page, "maps");
  await page.locator('[data-action="workspace"]').click();
  let chooser = page.waitForEvent("filechooser");
  await page
    .locator("dialog")
    .getByRole("button", { name: "Import JSON map", exact: true })
    .click();
  await (
    await chooser
  ).setFiles({
    name: "invalid.json",
    mimeType: "application/json",
    buffer: Buffer.from("{broken"),
  });
  await expect(page.locator("#toast")).toContainText("schemaVersion");
  await expect(page.locator("[data-node]")).toHaveCount(10);
  await openDrawer(page, "maps");
  await page.locator('[data-action="workspace"]').click();
  chooser = page.waitForEvent("filechooser");
  await page
    .locator("dialog")
    .getByRole("button", { name: "Import JSON map", exact: true })
    .click();
  await (
    await chooser
  ).setFiles({
    name: "sample.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ ...sample, title: "Imported map" })),
  });
  await expect(page.locator("h1")).toHaveText("Imported map");
  await expect(page.locator("[data-node]")).toHaveCount(10);
  await page.locator('[data-action="export"]').click();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Map as JSON", exact: false }).click();
  const file = await downloaded;
  expect(file.suggestedFilename()).toBe("Imported map.json");
  const exported = JSON.parse(readFileSync((await file.path())!, "utf8"));
  expect(exported.nodes).toEqual(sample.nodes);
  expect(exported.edges).toEqual(sample.edges);
  expect(exported.id).not.toEqual(sample.id);
});

test("autosave preserves typing focus and Ctrl S commits a focused text field", async ({
  page,
}) => {
  await openDrawer(page, "components");
  await page.locator('[data-type="activity"]').click();
  await expect(page.locator("#node-label")).toBeFocused();
  await page.locator("#node-label").fill("An unfinished thought");
  await expect(page.locator("#save-status")).toContainText("Saved in browser");
  await expect(page.locator("#node-label")).toBeFocused();
  await page.locator("#node-label").press("Control+s");
  await expect(page.locator("#save-status")).toContainText("Saved in browser");
  await page.reload();
  await expect(page.locator("[data-node]").last()).toHaveAttribute(
    "aria-label",
    /An unfinished thought/,
  );
});

test("drawers preserve canvas space and selection; focus mode expands it", async ({
  page,
}) => {
  const canvas = page.locator("#map-canvas");
  const initial = (await canvas.boundingBox())!;
  expect(initial.width).toBeGreaterThan(1450);
  expect(initial.height).toBeGreaterThan(820);
  await expect(page.locator(".drawer:visible")).toHaveCount(0);
  const stages = await page
    .locator(".stage-name")
    .evaluateAll((elements) =>
      elements.map((el) => Number(el.getAttribute("y"))),
    );
  expect(stages).toHaveLength(4);
  expect(stages.every((y) => y > 650)).toBe(true);
  await page.keyboard.press("m");
  await expect(page.locator("#map-search")).toBeFocused();
  expect(await canvas.boundingBox()).toEqual(initial);
  await page.keyboard.press("Escape");
  await expect(page.locator(".drawer:visible")).toHaveCount(0);
  await page.locator('[data-node="experience"]').click();
  await expect(page.locator("#drawer-inspector")).toBeVisible();
  await page.locator("#node-label").fill("Edited in drawer");
  await page.locator("#node-label").press("Escape");
  await expect(page.locator("#drawer-inspector")).toBeHidden();
  await expect(page.locator('[data-node="experience"]')).toHaveClass(
    /selected/,
  );
  await page.keyboard.press("i");
  await expect(page.locator("#node-label")).toHaveValue("Edited in drawer");
  await page.keyboard.press("Escape");
  await page.keyboard.press("f");
  await expect(page.locator(".app-header")).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Exit focus F" }),
  ).toBeVisible();
  expect((await canvas.boundingBox())!.height).toBeGreaterThan(
    initial.height + 70,
  );
  await page.screenshot({
    animations: "disabled",
    path: "test-results/focus.png",
  });
  await page.keyboard.press("f");
  await expect(page.locator(".app-header")).toBeVisible();
  expect(await canvas.boundingBox()).toEqual(initial);
  await page.setViewportSize({ width: 1050, height: 700 });
  await openDrawer(page, "inspector");
  await expect(page.locator('[data-action="delete-selection"]')).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: "test-results/drawer-compact.png",
  });
});

test("palette dragging adds a component and opens properties", async ({
  page,
}) => {
  await openDrawer(page, "components");
  await page
    .locator('[data-type="knowledge"]')
    .dragTo(page.locator("#map-canvas"));
  await expect(page.locator("[data-node]")).toHaveCount(11);
  await expect(page.locator("#drawer-components")).toBeHidden();
  await expect(page.locator("#drawer-inspector")).toBeVisible();
  await expect(page.locator("#node-type")).toHaveValue("knowledge");
  await expect(page.locator("#node-label")).toBeFocused();
});
