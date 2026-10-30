import type { MapNode, Metamodel, WardleyMap } from "./types.ts";

export const clamp = (n: number, min = 0, max = 1) =>
  Math.max(min, Math.min(max, n));
export const uid = () => crypto.randomUUID();
export const stageIndex = (evolution: number) =>
  Math.min(3, Math.floor(clamp(evolution) * 4));
export function connect(
  map: WardleyMap,
  source: string,
  target: string,
  kind: "dependency" | "evolution" = "dependency",
): boolean {
  if (
    source === target ||
    !map.nodes.some((n) => n.id === source) ||
    !map.nodes.some((n) => n.id === target)
  )
    return false;
  if (
    map.edges.some(
      (e) => e.source === source && e.target === target && e.kind === kind,
    )
  )
    return false;
  map.edges.push({ id: uid(), source, target, kind, label: "" });
  return true;
}
export function removeNode(map: WardleyMap, id: string) {
  map.nodes = map.nodes.filter((n) => n.id !== id);
  map.edges = map.edges.filter((e) => e.source !== id && e.target !== id);
}
export function createMap(title: string, kind: string): WardleyMap {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: uid(),
    title,
    kind,
    description: "",
    createdAt: now,
    updatedAt: now,
    nodes: [],
    edges: [],
  };
}
export function addNode(
  map: WardleyMap,
  type: string,
  label: string,
  evolution: number,
  visibility: number,
  parent?: string,
): MapNode {
  const node = {
    id: uid(),
    label,
    type,
    evolution: clamp(evolution),
    visibility: clamp(visibility),
    notes: "",
  };
  map.nodes.push(node);
  if (parent) connect(map, parent, node.id);
  return node;
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
export function validateMetamodel(value: unknown): asserts value is Metamodel {
  assert(isObject(value), "Metamodel must be an object.");
  assert(
    value.schemaVersion === 1 &&
      typeof value.name === "string" &&
      value.name.trim(),
    "Metamodel needs schemaVersion 1 and a name.",
  );
  assert(
    Array.isArray(value.componentTypes) && value.componentTypes.length > 0,
    "Add at least one component type.",
  );
  const ids = new Set<string>();
  for (const t of value.componentTypes) {
    assert(
      isObject(t) && typeof t.id === "string" && /^[a-z][a-z0-9-]*$/.test(t.id),
      "Component type IDs must be lowercase slugs.",
    );
    assert(!ids.has(t.id), `Duplicate component type: ${t.id}`);
    ids.add(t.id);
    assert(
      typeof t.label === "string" &&
        t.label.trim() &&
        typeof t.description === "string",
      "Every type needs a label and description.",
    );
    assert(
      typeof t.color === "string" && /^#[0-9a-f]{6}$/i.test(t.color),
      "Colors must be six-digit hex values.",
    );
    assert(
      ["circle", "diamond", "square", "hexagon", "person"].includes(
        String(t.shape),
      ),
      `Invalid shape for ${t.id}.`,
    );
    assert(
      Array.isArray(t.stageLabels) &&
        t.stageLabels.length === 4 &&
        t.stageLabels.every((s) => typeof s === "string" && s.trim()),
      "Each type needs exactly four stage labels.",
    );
  }
  assert(
    Array.isArray(value.mapKinds) && value.mapKinds.length > 0,
    "Add at least one map kind.",
  );
  const kinds = new Set<string>();
  for (const k of value.mapKinds) {
    assert(
      isObject(k) &&
        typeof k.id === "string" &&
        /^[a-z][a-z0-9-]*$/.test(k.id) &&
        !kinds.has(k.id),
      "Map kind IDs must be unique lowercase slugs.",
    );
    kinds.add(k.id);
    assert(
      typeof k.label === "string" &&
        k.label.trim() &&
        typeof k.description === "string" &&
        typeof k.axisType === "string" &&
        ids.has(k.axisType),
      `Invalid map kind: ${k.id}`,
    );
  }
}
export function validateMap(
  value: unknown,
  model: Metamodel,
): asserts value is WardleyMap {
  assert(isObject(value), "Map must be an object.");
  assert(
    value.schemaVersion === 1,
    "Unsupported map schemaVersion (expected 1).",
  );
  assert(
    typeof value.id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value.id),
    "Map ID must contain only letters, numbers, underscores or hyphens.",
  );
  assert(
    typeof value.title === "string" && value.title.trim(),
    "Map title cannot be empty.",
  );
  assert(
    typeof value.description === "string",
    "Map description must be text.",
  );
  assert(
    typeof value.createdAt === "string" &&
      Number.isFinite(Date.parse(value.createdAt)) &&
      typeof value.updatedAt === "string" &&
      Number.isFinite(Date.parse(value.updatedAt)),
    "Map timestamps must be valid dates.",
  );
  assert(
    model.mapKinds.some((k) => k.id === value.kind),
    `Unknown map kind: ${value.kind}`,
  );
  assert(
    Array.isArray(value.nodes) && Array.isArray(value.edges),
    "Map needs nodes and edges arrays.",
  );
  const ids = new Set<string>();
  for (const n of value.nodes) {
    assert(
      isObject(n) &&
        typeof n.id === "string" &&
        n.id.length > 0 &&
        !ids.has(n.id),
      "Node IDs must be nonempty and unique.",
    );
    ids.add(n.id);
    assert(
      typeof n.label === "string" &&
        n.label.trim() &&
        typeof n.notes === "string",
      "Every node needs a label and notes text.",
    );
    assert(
      model.componentTypes.some((t) => t.id === n.type),
      `Unknown component type: ${n.type}`,
    );
    for (const key of ["evolution", "visibility"])
      assert(
        typeof n[key] === "number" &&
          Number.isFinite(n[key]) &&
          n[key] >= 0 &&
          n[key] <= 1,
        `${key} must be between 0 and 1.`,
      );
    assert(
      n.targetEvolution === undefined ||
        (typeof n.targetEvolution === "number" &&
          Number.isFinite(n.targetEvolution) &&
          n.targetEvolution >= (n.evolution as number) &&
          n.targetEvolution <= 1),
      "Target evolution must be between current evolution and 1.",
    );
    assert(
      n.inertia === undefined || typeof n.inertia === "boolean",
      "Inertia must be boolean.",
    );
  }
  const edgeIds = new Set<string>();
  const links = new Set<string>();
  for (const e of value.edges) {
    assert(
      isObject(e) &&
        typeof e.id === "string" &&
        e.id.length > 0 &&
        !edgeIds.has(e.id),
      "Edge IDs must be nonempty and unique.",
    );
    edgeIds.add(e.id);
    assert(
      typeof e.source === "string" &&
        typeof e.target === "string" &&
        ids.has(e.source) &&
        ids.has(e.target) &&
        e.source !== e.target,
      "Every edge must connect two existing, different nodes.",
    );
    assert(
      ["dependency", "evolution"].includes(String(e.kind)) &&
        typeof e.label === "string",
      "Invalid edge kind or label.",
    );
    const key = JSON.stringify([e.source, e.target, e.kind]);
    assert(!links.has(key), "Duplicate connection.");
    links.add(key);
  }
}
