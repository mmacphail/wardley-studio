import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  addNode,
  connect,
  createMap,
  removeNode,
  stageIndex,
  validateMap,
  validateMetamodel,
} from "../src/model.ts";
import type { Metamodel, WardleyMap } from "../src/types.ts";
const model: Metamodel = JSON.parse(
  readFileSync(new URL("../examples/metamodel.json", import.meta.url), "utf8"),
);
const sample = (): WardleyMap =>
  JSON.parse(
    readFileSync(
      new URL("../examples/maps/coffee-shop.json", import.meta.url),
      "utf8",
    ),
  );
test("stage boundaries handle endpoints and exact quarter transitions", () => {
  assert.deepEqual(
    [0, 0.249, 0.25, 0.5, 0.75, 1].map(stageIndex),
    [0, 0, 1, 2, 3, 3],
  );
});
test("all supplied map kinds and component types validate", () => {
  validateMetamodel(model);
  validateMap(sample(), model);
  for (const name of ["platform-future", "working-practices"])
    validateMap(
      JSON.parse(
        readFileSync(
          new URL(`../examples/maps/${name}.json`, import.meta.url),
          "utf8",
        ),
      ),
      model,
    );
});
test("adding a dependency connects it and clamps canvas coordinates", () => {
  const map = createMap("Test", "landscape");
  const user = addNode(map, "user", "Customer", 0.5, 0.9);
  const child = addNode(map, "activity", "Delivery", 2, -1, user.id);
  assert.equal(child.evolution, 1);
  assert.equal(child.visibility, 0);
  assert.equal(map.edges[0].source, user.id);
  assert.equal(map.edges[0].target, child.id);
  validateMap(map, model);
});
test("connections reject duplicates, self-links and missing nodes", () => {
  const map = sample(),
    { source, target } = map.edges[0],
    count = map.edges.length;
  assert.equal(connect(map, source, target), false);
  assert.equal(connect(map, source, source), false);
  assert.equal(connect(map, source, "absent"), false);
  assert.equal(map.edges.length, count);
  assert.equal(connect(map, source, target, "evolution"), true);
});
test("removing a component also removes all of its connections", () => {
  const map = sample();
  removeNode(map, "coffee");
  assert.equal(
    map.nodes.some((n) => n.id === "coffee"),
    false,
  );
  assert.equal(
    map.edges.some((e) => e.source === "coffee" || e.target === "coffee"),
    false,
  );
  validateMap(map, model);
});
test("imports reject invalid coordinates, dangling edges and unsafe map IDs", () => {
  for (const mutate of [
    (m: WardleyMap) => {
      m.nodes[0].visibility = NaN;
    },
    (m: WardleyMap) => {
      m.nodes[0].type = "unknown";
    },
    (m: WardleyMap) => {
      m.edges[0].target = "missing";
    },
    (m: WardleyMap) => {
      m.id = "../escape";
    },
    (m: WardleyMap) => {
      m.edges.push({ ...m.edges[0], id: "duplicate" });
    },
    (m: WardleyMap) => {
      m.nodes[0].targetEvolution = 0.1;
    },
  ]) {
    const map = sample();
    mutate(map);
    assert.throws(() => validateMap(map, model));
  }
});
test("metamodel rejects unsupported shapes, invalid colors and wrong stage counts", () => {
  for (const mutate of [
    (m: Metamodel) => {
      m.componentTypes[0].stageLabels.pop();
    },
    (m: Metamodel) => {
      m.componentTypes[0].color = "red";
    },
    (m: Metamodel) => {
      m.mapKinds[0].axisType = "absent";
    },
    (m: Metamodel) => {
      m.componentTypes[0].id = m.componentTypes[1].id;
    },
  ]) {
    const next = structuredClone(model);
    mutate(next);
    assert.throws(() => validateMetamodel(next));
  }
});
test("a custom component type and map kind work without application changes", () => {
  const custom = structuredClone(model);
  custom.componentTypes.push({
    id: "capability",
    label: "Capability",
    description: "A custom capability",
    color: "#123456",
    shape: "hexagon",
    stageLabels: ["One", "Two", "Three", "Four"],
  });
  custom.mapKinds.push({
    id: "custom-map",
    label: "Custom",
    description: "Custom map",
    axisType: "capability",
  });
  const map = createMap("Custom", "custom-map");
  addNode(map, "capability", "Test", 0.2, 0.3);
  validateMetamodel(custom);
  validateMap(map, custom);
});
