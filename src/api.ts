import type { Studio } from "./main.ts";
import type { MapNode, WardleyMap } from "./types.ts";
import {
  addNode,
  clamp,
  connect,
  createMap,
  removeNode,
  uid,
  validateMap,
  validateMetamodel,
} from "./model.ts";
import { exportSvg } from "./canvas.ts";
import { native } from "./storage.ts";
import { captureMap } from "./snapshot.ts";
import { describeMap } from "./map-model.ts";

export interface ApiResponse {
  status: number;
  body: unknown;
  contentType?: string;
}
type Body = Record<string, unknown>;
type Params = Record<string, string>;
type Handler = (params: Params, body: Body) => unknown | Promise<unknown>;
interface Route {
  method: string;
  path: string;
  summary: string;
  input?: Body;
  run: Handler;
}
class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
class Raw {
  text: string;
  type: string;
  constructor(text: string, type: string) {
    this.text = text;
    this.type = type;
  }
}
const fail = (status: number, code: string, message: string): never => {
  throw new ApiError(status, code, message);
};
const copy = <T>(v: T): T => structuredClone(v);
function fields(body: Body, allowed: string[]) {
  const extra = Object.keys(body).find((key) => !allowed.includes(key));
  if (extra) fail(422, "invalid_input", `Unknown field: ${extra}`);
}
function text(body: Body, key: string, fallback?: string): string {
  const v = body[key] === undefined ? fallback : body[key];
  if (typeof v !== "string" || !v.trim())
    fail(422, "invalid_input", `${key} must be nonempty text.`);
  return v as string;
}
function number(
  body: Body,
  key: string,
  fallback: number,
  min = 0,
  max = 1,
): number {
  const v = body[key] === undefined ? fallback : body[key];
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max)
    fail(422, "invalid_input", `${key} must be between ${min} and ${max}.`);
  return v as number;
}
function bool(body: Body, key: string, fallback: boolean): boolean {
  const v = body[key] === undefined ? fallback : body[key];
  if (typeof v !== "boolean")
    fail(422, "invalid_input", `${key} must be boolean.`);
  return v as boolean;
}
function object(v: unknown): Body {
  if (!v || typeof v !== "object" || Array.isArray(v))
    fail(422, "invalid_input", "Request body must be a JSON object.");
  return v as Body;
}
const nodeFields = [
  "label",
  "type",
  "evolution",
  "visibility",
  "notes",
  "targetEvolution",
  "inertia",
  "stage",
];

export class EditorApi {
  studio: Studio;
  routes: Route[] = [];
  queue: Promise<unknown> = Promise.resolve();
  constructor(studio: Studio) {
    this.studio = studio;
    this.register();
  }
  add(
    method: string,
    path: string,
    summary: string,
    run: Handler,
    input?: Body,
  ) {
    this.routes.push({ method, path: `/api/v1${path}`, summary, run, input });
  }
  map(id = this.studio.activeId) {
    return (
      this.studio.ws.maps.find((m) => m.id === id) ??
      fail(404, "map_not_found", `Map not found: ${id}`)
    );
  }
  modelSnapshot(id = this.studio.activeId) {
    const map = this.map(id);
    const metamodel = this.studio.model;
    return {
      ...describeMap(map, metamodel),
      active: id === this.studio.activeId,
      hasUnsavedChanges: this.studio.dirty.has(id),
    };
  }

  state() {
    const s = this.studio;
    return {
      features: copy(s.features),
      activeMapId: s.activeId || null,
      selectedId: s.selected,
      tool: s.tool,
      connectFrom: s.connectFrom,
      autoConnect: s.autoConnect,
      labels: s.labels,
      drawer: s.drawer,
      focusMode: s.focusMode,
      search: s.search,
      view: s.view,
      saveState: s.saveState,
      dirtyMapIds: [...s.dirty],
      undoCount: s.past.get(s.activeId)?.length ?? 0,
      redoCount: s.future.get(s.activeId)?.length ?? 0,
      dialog: document.querySelector("dialog[open] h2")?.textContent ?? null,
    };
  }
  async commit(map: WardleyMap, selected?: string | null) {
    validateMap(map, this.studio.model);
    await this.studio.switchMap(map.id);
    this.studio.change(() => {
      this.studio.ws.maps[
        this.studio.ws.maps.findIndex((m) => m.id === map.id)
      ] = map;
      if (selected !== undefined) this.studio.selected = selected;
      if (!map.nodes.some((n) => n.id === this.studio.connectFrom))
        this.studio.connectFrom = null;
      if (
        !map.nodes.some((n) => n.id === this.studio.selected) &&
        !map.edges.some((e) => e.id === this.studio.selected)
      )
        this.studio.selected = null;
    });
    await this.studio.flushAll();
    return copy(this.map(map.id));
  }
  async insert(map: WardleyMap) {
    validateMap(map, this.studio.model);
    if (this.studio.ws.maps.some((m) => m.id === map.id))
      fail(409, "duplicate_id", "A map with this ID already exists.");
    this.studio.ws.maps.push(map);
    this.studio.activeId = map.id;
    this.studio.selected = null;
    this.studio.connectFrom = null;
    this.studio.drawer = null;
    this.studio.view = { x: 0, y: 0, w: 1100, h: 760 };
    this.studio.changed();
    this.studio.render();
    await this.studio.flushAll();
    return copy(map);
  }
  patchNode(n: MapNode, b: Body) {
    for (const key of nodeFields.filter((k) => k !== "stage")) {
      if (key in b) {
        if (key === "targetEvolution" && b[key] === null)
          delete n.targetEvolution;
        else Object.assign(n, { [key]: b[key] });
      }
    }
    if ("stage" in b) {
      if ("evolution" in b)
        fail(422, "invalid_input", "Use stage or evolution, not both.");
      const stage = number(b, "stage", 0, 0, 3);
      if (!Number.isInteger(stage))
        fail(422, "invalid_input", "stage must be an integer from 0 to 3.");
      n.evolution = (stage + 0.5) / 4;
    }
    if (n.targetEvolution !== undefined && !("targetEvolution" in b))
      n.targetEvolution = Math.max(n.evolution, n.targetEvolution);
  }
  async menu(action: string) {
    const s = this.studio;
    if (
      [
        "undo",
        "redo",
        "zoom-in",
        "zoom-out",
        "fit",
        "deselect",
        "connect-selected",
        "delete-selection",
        "clone-node",
      ].includes(action)
    )
      this.map();
    if (["connect-selected", "clone-node"].includes(action) && !s.node)
      fail(409, "selection_required", "Select a component first.");
    if (action === "delete-selection" && !s.selected)
      fail(
        409,
        "selection_required",
        "Select a component or connection first.",
      );
    await s.action(action);
    await s.flushAll();
    return this.state();
  }
  register() {
    const s = this.studio;
    this.add("GET", "/health", "Editor readiness", () => ({
      status: "ready",
      version: "1",
    }));
    this.add("GET", "/routes", "Discover all routes and menu actions", () =>
      this.routes.map(({ run: _, ...route }) => route),
    );
    this.add("GET", "/openapi.json", "OpenAPI 3.1 specification", () =>
      this.openapi(),
    );
    this.add(
      "GET",
      "/state",
      "Current UI state, selection, view and history",
      () => this.state(),
    );
    this.add(
      "GET",
      "/connection",
      "Workspace connection (never returns credentials)",
      () => s.storage.connectionInfo(),
    );
    this.add(
      "PUT",
      "/connection",
      "Connect to local storage or an HTTPS server",
      async (_, b) => {
        fields(b, ["mode", "url", "token"]);
        const mode = text(b, "mode");
        if (mode !== "local" && mode !== "remote")
          fail(422, "invalid_mode", "Choose local or remote.");
        await s.flushAll(true);
        if (s.chat?.busy)
          fail(
            409,
            "chat_busy",
            "Wait for the assistant to finish before changing connections.",
          );
        await s.storage.connect(
          mode as "local" | "remote",
          typeof b.url === "string" ? b.url : undefined,
          typeof b.token === "string" ? b.token : undefined,
        );
        s.activeId = "";
        await s.reload();
        return s.storage.connectionInfo();
      },
      {
        mode: "remote",
        url: "https://your-server.example",
        token: "YOUR_API_TOKEN",
      },
    );
    this.add(
      "GET",
      "/workspace",
      "Workspace path, metamodel, maps and warnings",
      () => s.ws,
    );
    this.add(
      "PUT",
      "/workspace",
      "Open or initialize a workspace folder",
      async (_, b) => {
        fields(b, ["path"]);
        if (!native)
          fail(
            501,
            "native_required",
            "Folder access requires the native app.",
          );
        await s.storage.setWorkspace(text(b, "path"));
        s.activeId = "";
        await s.reload();
        return s.ws;
      },
      { path: "/absolute/path/to/workspace" },
    );
    this.add(
      "POST",
      "/workspace/reload",
      "Reload workspace; optionally discard unsaved changes",
      async (_, b) => {
        fields(b, ["discard"]);
        if (!bool(b, "discard", false)) await s.flushAll(true);
        await s.reload();
        return s.ws;
      },
      { discard: false },
    );
    this.add(
      "POST",
      "/workspace/save",
      "Commit focused fields and save all pending maps",
      async () => {
        await s.flushAll(true);
        return this.state();
      },
    );
    this.add(
      "GET",
      "/metamodel",
      "Read component types, stage labels and map kinds",
      () => s.model,
    );
    this.add(
      "PUT",
      "/metamodel",
      "Validate and save the complete metamodel",
      async (_, b) => {
        validateMetamodel(b);
        s.ws.maps.forEach((m) => validateMap(m, b));
        await s.storage.saveMetamodel(b);
        s.render();
        return s.model;
      },
    );
    this.add(
      "POST",
      "/metamodel/validate",
      "Validate a metamodel against all loaded maps without saving",
      (_, b) => {
        validateMetamodel(b);
        s.ws.maps.forEach((m) => validateMap(m, b));
        return { valid: true };
      },
    );
    this.add(
      "GET",
      "/metamodel/export",
      "Export the metamodel JSON",
      () => s.model,
    );
    this.add("GET", "/maps", "List complete maps", () => s.ws.maps);
    this.add(
      "POST",
      "/maps",
      "Create a map; optional user and need anchors",
      async (_, b) => {
        fields(b, ["title", "kind", "description", "anchor"]);
        const map = createMap(
          text(b, "title"),
          text(b, "kind", s.model.mapKinds[0].id),
        );
        if ("description" in b) map.description = b.description as string;
        if (bool(b, "anchor", true)) {
          if (
            !s.model.componentTypes.some((t) => t.id === "user") ||
            !s.model.componentTypes.some((t) => t.id === "need")
          )
            fail(
              422,
              "invalid_input",
              "This metamodel has no user/need types. Set anchor to false.",
            );
          const user = addNode(map, "user", "User", 0.45, 0.94);
          addNode(map, "need", "User need", 0.45, 0.75, user.id);
        }
        return this.insert(map);
      },
      { title: "My map", kind: "landscape", anchor: true },
    );
    this.add(
      "POST",
      "/maps/import",
      "Import complete map JSON with a fresh ID",
      (_, b) => {
        validateMap(b, s.model);
        const map = copy(b);
        map.id = uid();
        map.createdAt = map.updatedAt = new Date().toISOString();
        return this.insert(map);
      },
    );
    this.add(
      "GET",
      "/current-map",
      "Read the active map's complete JSON, including nodes and edges",
      () => this.map(),
    );
    this.add(
      "GET",
      "/current-map/model",
      "Active graph snapshot: components, links, resolved types/stages, axes and metamodel",
      () => this.modelSnapshot(),
    );
    this.add(
      "GET",
      "/current-map/components",
      "List components of the active map",
      () => this.map().nodes,
    );
    this.add(
      "GET",
      "/current-map/connections",
      "List connections of the active map",
      () => this.map().edges,
    );
    this.add(
      "GET",
      "/maps/:id/model",
      "Graph snapshot of any map, without changing the active map",
      (p) => this.modelSnapshot(p.id),
    );
    this.add("GET", "/maps/:id", "Read a map", (p) => this.map(p.id));
    this.add(
      "PATCH",
      "/maps/:id",
      "Edit map title, description and kind",
      (p, b) => {
        fields(b, ["title", "description", "kind"]);
        return this.commit({ ...copy(this.map(p.id)), ...b });
      },
      { title: "Updated map", kind: "future" },
    );
    this.add(
      "PUT",
      "/maps/:id",
      "Replace a complete map, as one undoable edit",
      (p, b) => {
        this.map(p.id);
        validateMap(b, s.model);
        if (b.id !== p.id)
          fail(422, "invalid_input", "Body ID must match the URL.");
        return this.commit(copy(b));
      },
    );
    this.add(
      "DELETE",
      "/maps/:id",
      "Delete a map (native files move to .trash)",
      async (p) => {
        this.map(p.id);
        await s.storage.deleteMap(p.id);
        s.ws = s.storage.workspace;
        s.dirty.delete(p.id);
        s.past.delete(p.id);
        s.future.delete(p.id);
        if (s.activeId === p.id) {
          s.activeId = s.ws.maps[0]?.id ?? "";
          s.selected = null;
          s.connectFrom = null;
        }
        s.render();
        return { deleted: p.id };
      },
    );
    this.add(
      "POST",
      "/maps/:id/activate",
      "Switch the active map",
      async (p) => {
        this.map(p.id);
        await s.switchMap(p.id);
        return this.state();
      },
    );
    this.add(
      "POST",
      "/maps/:id/duplicate",
      "Duplicate a map with a fresh ID",
      (p, b) => {
        fields(b, ["title"]);
        const map = copy(this.map(p.id));
        map.id = uid();
        map.title = text(b, "title", `${map.title} · copy`);
        map.createdAt = map.updatedAt = new Date().toISOString();
        return this.insert(map);
      },
      { title: "Map copy" },
    );
    this.add(
      "GET",
      "/maps/:id/export/json",
      "Export a complete map as JSON",
      (p) => this.map(p.id),
    );
    this.add(
      "GET",
      "/maps/:id/export/svg",
      "Export standalone SVG using the current label visibility",
      (p) =>
        new Raw(exportSvg(this.map(p.id), s.model, s.labels), "image/svg+xml"),
    );
    this.add(
      "GET",
      "/current-map/snapshot",
      "Capture the full current map as a PNG data URL with pixel coordinates; labels included, no UI changes",
      () => captureMap(this.map(), s.model),
    );
    this.add(
      "GET",
      "/maps/:id/snapshot",
      "Capture a map as a PNG data URL with pixel coordinates, without activating it",
      (p) => captureMap(this.map(p.id), s.model),
    );
    for (const action of ["undo", "redo"] as const)
      this.add(
        "POST",
        `/maps/:id/${action}`,
        `${action} a map edit`,
        async (p) => {
          this.map(p.id);
          await s.switchMap(p.id);
          const history = action === "undo" ? s.past : s.future;
          if (!history.get(p.id)?.length)
            fail(409, "history_empty", `Nothing to ${action}.`);
          s.undo(action === "redo");
          await s.flushAll();
          return this.map(p.id);
        },
      );
    this.add(
      "GET",
      "/maps/:id/components",
      "List map components",
      (p) => this.map(p.id).nodes,
    );
    this.add(
      "POST",
      "/maps/:id/components",
      "Add a component, optionally connected to parentId or selection",
      async (p, b) => {
        fields(b, [...nodeFields, "parentId", "autoConnect"]);
        const map = copy(this.map(p.id));
        const type = text(
          b,
          "type",
          s.model.mapKinds.find((k) => k.id === map.kind)!.axisType,
        );
        const definition =
          s.model.componentTypes.find((t) => t.id === type) ??
          fail(422, "invalid_input", "Unknown component type.");
        const auto = bool(b, "autoConnect", s.autoConnect);
        const parent =
          b.parentId === undefined
            ? auto && s.activeId === p.id
              ? s.node?.id
              : undefined
            : text(b, "parentId");
        const anchor = map.nodes.find((n) => n.id === parent);
        if (parent && !anchor)
          fail(
            404,
            "component_not_found",
            "parentId is not a component in this map.",
          );
        const node = addNode(
          map,
          type,
          text(b, "label", definition.label),
          number(b, "evolution", clamp((anchor?.evolution ?? 0.4) + 0.08)),
          number(
            b,
            "visibility",
            clamp((anchor?.visibility ?? 0.7) - 0.16, 0.04, 0.96),
          ),
          parent,
        );
        this.patchNode(node, b);
        await this.commit(map, node.id);
        return node;
      },
      {
        type: "activity",
        label: "Payment",
        evolution: 0.65,
        visibility: 0.5,
        autoConnect: false,
      },
    );
    this.add(
      "GET",
      "/maps/:id/components/:node",
      "Read a component",
      (p) =>
        this.map(p.id).nodes.find((n) => n.id === p.node) ??
        fail(404, "component_not_found", "Component not found."),
    );
    this.add(
      "PATCH",
      "/maps/:id/components/:node",
      "Move or edit a component; stage is 0–3; null targetEvolution removes its arrow",
      async (p, b) => {
        fields(b, nodeFields);
        const map = copy(this.map(p.id));
        const node =
          map.nodes.find((n) => n.id === p.node) ??
          fail(404, "component_not_found", "Component not found.");
        this.patchNode(node, b);
        await this.commit(map, node.id);
        return node;
      },
      {
        stage: 2,
        visibility: 0.6,
        notes: "Review",
        inertia: true,
        targetEvolution: 0.9,
      },
    );
    this.add(
      "DELETE",
      "/maps/:id/components/:node",
      "Remove a component and its connections",
      async (p) => {
        const map = copy(this.map(p.id));
        if (!map.nodes.some((n) => n.id === p.node))
          fail(404, "component_not_found", "Component not found.");
        removeNode(map, p.node);
        await this.commit(map);
        return { deleted: p.node };
      },
    );
    this.add(
      "POST",
      "/maps/:id/components/:node/duplicate",
      "Duplicate a component",
      async (p, b) => {
        fields(b, ["label"]);
        const map = copy(this.map(p.id));
        const original =
          map.nodes.find((n) => n.id === p.node) ??
          fail(404, "component_not_found", "Component not found.");
        const node = {
          ...original,
          id: uid(),
          label: text(b, "label", `${original.label} copy`),
          evolution: clamp(original.evolution + 0.04),
          visibility: clamp(original.visibility - 0.06),
        };
        if (node.targetEvolution !== undefined)
          node.targetEvolution = Math.max(node.evolution, node.targetEvolution);
        map.nodes.push(node);
        await this.commit(map, node.id);
        return node;
      },
    );
    this.add(
      "GET",
      "/maps/:id/connections",
      "List connections",
      (p) => this.map(p.id).edges,
    );
    this.add(
      "POST",
      "/maps/:id/connections",
      "Connect two components",
      async (p, b) => {
        fields(b, ["source", "target", "kind", "label"]);
        const map = copy(this.map(p.id));
        const kind = text(b, "kind", "dependency");
        if (kind !== "dependency" && kind !== "evolution")
          fail(422, "invalid_input", "kind must be dependency or evolution.");
        if (
          !connect(
            map,
            text(b, "source"),
            text(b, "target"),
            kind as "dependency" | "evolution",
          )
        )
          fail(
            422,
            "invalid_connection",
            "Connection is duplicate, self-referencing, or has missing components.",
          );
        const edge = map.edges.at(-1)!;
        if ("label" in b) edge.label = b.label as string;
        await this.commit(map, edge.id);
        return edge;
      },
      {
        source: "component-id",
        target: "dependency-id",
        kind: "dependency",
        label: "depends on",
      },
    );
    this.add(
      "GET",
      "/maps/:id/connections/:edge",
      "Read a connection",
      (p) =>
        this.map(p.id).edges.find((e) => e.id === p.edge) ??
        fail(404, "connection_not_found", "Connection not found."),
    );
    this.add(
      "PATCH",
      "/maps/:id/connections/:edge",
      "Change connection endpoints, kind or label",
      async (p, b) => {
        fields(b, ["source", "target", "kind", "label"]);
        const map = copy(this.map(p.id));
        const edge =
          map.edges.find((e) => e.id === p.edge) ??
          fail(404, "connection_not_found", "Connection not found.");
        Object.assign(edge, b);
        await this.commit(map, edge.id);
        return edge;
      },
      { label: "requires", kind: "dependency" },
    );
    this.add(
      "DELETE",
      "/maps/:id/connections/:edge",
      "Remove a connection",
      async (p) => {
        const map = copy(this.map(p.id));
        if (!map.edges.some((e) => e.id === p.edge))
          fail(404, "connection_not_found", "Connection not found.");
        map.edges = map.edges.filter((e) => e.id !== p.edge);
        await this.commit(map);
        return { deleted: p.edge };
      },
    );
    this.add(
      "PATCH",
      "/ui",
      "Set tool, selection, toggles, drawer, focus mode or library search",
      (_, b) => {
        fields(b, [
          "tool",
          "selectedId",
          "autoConnect",
          "labels",
          "drawer",
          "focusMode",
          "search",
        ]);
        if (
          "tool" in b &&
          !["select", "connect", "pan"].includes(String(b.tool))
        )
          fail(422, "invalid_input", "Unknown tool.");
        if (
          "drawer" in b &&
          ![null, "maps", "components", "inspector"].includes(
            b.drawer as string | null,
          )
        )
          fail(422, "invalid_input", "Unknown drawer.");
        if (
          "selectedId" in b &&
          b.selectedId !== null &&
          !this.map().nodes.some((n) => n.id === b.selectedId) &&
          !this.map().edges.some((e) => e.id === b.selectedId)
        )
          fail(
            404,
            "selection_not_found",
            "Selection must belong to the active map.",
          );
        for (const key of ["autoConnect", "labels", "focusMode"] as const)
          if (key in b) bool(b, key, false);
        if ("search" in b && typeof b.search !== "string")
          fail(422, "invalid_input", "search must be text.");
        if ("tool" in b) {
          s.tool = b.tool as typeof s.tool;
          s.connectFrom = null;
        }
        if ("selectedId" in b) {
          s.selected = b.selectedId as string | null;
          s.connectFrom = null;
        }
        if ("drawer" in b) s.drawer = b.drawer as typeof s.drawer;
        for (const key of ["autoConnect", "labels", "focusMode"] as const)
          if (key in b) s[key] = b[key] as boolean;
        if ("search" in b) s.search = b.search as string;
        s.render();
        return this.state();
      },
      {
        selectedId: null,
        drawer: "components",
        tool: "select",
        autoConnect: true,
        labels: true,
        focusMode: false,
      },
    );
    this.add(
      "PUT",
      "/ui/view",
      "Set viewBox origin and width; height maintains the map ratio",
      (_, b) => {
        fields(b, ["x", "y", "width"]);
        const w = number(b, "width", s.view.w, 300, 2200);
        s.view = {
          x: number(b, "x", s.view.x, -1e6, 1e6),
          y: number(b, "y", s.view.y, -1e6, 1e6),
          w,
          h: (w * 760) / 1100,
        };
        s.renderCanvas();
        return this.state();
      },
      { x: 0, y: 0, width: 1100 },
    );
    this.add(
      "POST",
      "/ui/dialog/close",
      "Dismiss an open dialog without applying its draft",
      () => {
        s.closeModal();
        return this.state();
      },
    );
    this.add("GET", "/help", "Read shortcuts and editing instructions", () => ({
      shortcuts: {
        M: "Maps",
        A: "Components",
        I: "Properties",
        F: "Focus",
        V: "Select",
        C: "Connect",
        H: "Pan",
        "0": "Fit",
        "Ctrl/⌘ Z": "Undo",
        "Ctrl/⌘ Shift Z": "Redo",
        "Ctrl/⌘ S": "Save",
        Escape: "Close drawer or clear selection",
      },
      editing:
        "Drag components to move them. Double-click blank space to add. Drag a component's + port to connect or create a dependency. Evolution stages run left to right along the bottom.",
      reference: "https://learnwardleymapping.com/landscape/",
    }));
    this.add(
      "GET",
      "/api",
      "API connection metadata (token is available only in the native UI/discovery file)",
      async () => {
        if (!native)
          return { transport: "javascript", routes: "/api/v1/routes" };
        const { token: _, ...info } = await s.storage.apiInfo();
        return info;
      },
    );

    this.add("GET", "/features", "Read enabled application features", () =>
      copy(s.features),
    );
    const chat = s.chat;
    if (__CHAT_ENABLED__ && chat) {
      this.add("GET", "/chat", "Read chat status and conversation", () =>
        chat.state(),
      );
      this.add(
        "POST",
        "/chat/connect",
        "Connect using the local Codex ChatGPT subscription session",
        () => chat.connect(),
      );
      this.add("POST", "/chat/login", "Start ChatGPT device sign-in", () =>
        chat.action("login"),
      );
      this.add(
        "POST",
        "/chat/login/open",
        "Open the ChatGPT verification URL",
        () => chat.action("open-login"),
      );
      this.add("POST", "/chat/login/cancel", "Cancel pending sign-in", () =>
        chat.action("cancel-login"),
      );
      this.add(
        "POST",
        "/chat/messages",
        "Send a message; tool actions and replies stream into the sidebar",
        (_, b) => {
          fields(b, ["text"]);
          return chat.send(text(b, "text"));
        },
        { text: "Add a payment component and connect it to the user need" },
      );
      this.add(
        "POST",
        "/chat/stop",
        "Stop the active model turn and cancel queued tool actions",
        () => chat.stop(),
      );
      this.add("POST", "/chat/reset", "Start a new conversation", () =>
        chat.reset(),
      );
      this.add(
        "PATCH",
        "/chat",
        "Set sidebar visibility, model, web search and permission to edit maps",
        (_, b) => {
          fields(b, ["open", "model", "allowEdits", "webSearch"]);
          if ("webSearch" in b) {
            bool(b, "webSearch", true);
            if (chat.busy)
              fail(
                409,
                "chat_busy",
                "Stop the current reply before changing web search.",
              );
          }
          if ("open" in b) bool(b, "open", false);
          if ("allowEdits" in b) bool(b, "allowEdits", true);
          if (
            "model" in b &&
            (!chat.models.some((m) => m.model === b.model) || chat.busy)
          )
            fail(
              422,
              "invalid_input",
              "Choose an available model while the chat is idle.",
            );
          if ("webSearch" in b) chat.setWebSearch(b.webSearch as boolean);
          if ("model" in b) chat.model = b.model as string;
          if ("open" in b) chat.open = b.open as boolean;
          if ("allowEdits" in b) chat.allowEdits = b.allowEdits as boolean;
          chat.render();
          chat.persist();
          s.syncChatButton();
          return chat.state();
        },
        { open: true, allowEdits: true, webSearch: true },
      );
      this.add("POST", "/actions/chat", "Toggle the chat sidebar", () => {
        chat.toggle();
        return chat.state();
      });
    }
    // Every menu action has an explicit endpoint. Data actions take JSON instead of opening pickers.
    const aliases: Record<string, [string, string]> = {
      new: ["POST", "/maps"],
      details: ["PATCH", "/maps/:id"],
      duplicate: ["POST", "/maps/:id/duplicate"],
      "delete-map": ["DELETE", "/maps/:id"],
      import: ["POST", "/maps/import"],
      export: ["GET", "/maps/:id/export/json"],
      "export-json": ["GET", "/maps/:id/export/json"],
      "export-svg": ["GET", "/maps/:id/export/svg"],
      workspace: ["GET", "/workspace"],
      "choose-workspace": ["PUT", "/workspace"],
      reload: ["POST", "/workspace/reload"],
      save: ["POST", "/workspace/save"],
      metamodel: ["GET", "/metamodel"],
      "save-metamodel": ["PUT", "/metamodel"],
      "export-metamodel": ["GET", "/metamodel/export"],
      help: ["GET", "/help"],
      api: ["GET", "/api"],
      "export-openapi": ["GET", "/openapi.json"],
      undo: ["POST", "/maps/:id/undo"],
      redo: ["POST", "/maps/:id/redo"],
    };
    for (const [action, [method, path]] of Object.entries(aliases)) {
      const route = this.routes.find(
        (r) => r.method === method && r.path === `/api/v1${path}`,
      )!;
      this.add(
        "POST",
        `/actions/${action}`,
        `Menu: ${action}. ${route.summary}`,
        (_, b) => route.run({ id: s.activeId }, b),
        route.input,
      );
    }
    for (const action of [
      "select",
      "connect",
      "pan",
      "zoom-in",
      "zoom-out",
      "fit",
      "deselect",
      "connect-selected",
      "delete-selection",
      "clone-node",
      "drawer-maps",
      "drawer-components",
      "drawer-inspector",
      "close-drawer",
      "focus",
    ]) {
      this.add("POST", `/actions/${action}`, `Menu: ${action}`, (_, b) => {
        fields(b, []);
        return this.menu(action);
      });
    }
    this.add(
      "POST",
      "/actions/reload-discard",
      "Discard unsaved changes and reload workspace",
      () => s.reload().then(() => s.ws),
    );
    this.add(
      "POST",
      "/actions/close-dialog",
      "Dismiss dialog without applying its draft",
      () => {
        s.closeModal();
        return this.state();
      },
    );
    this.add(
      "POST",
      "/ui/dialog/:name",
      "Open a menu dialog: new, details, export, workspace, metamodel, help or api",
      async (p) => {
        if (
          ![
            "new",
            "details",
            "export",
            "workspace",
            "metamodel",
            "help",
            "api",
          ].includes(p.name)
        )
          fail(404, "dialog_not_found", "Unknown dialog.");
        if (["details", "export"].includes(p.name)) this.map();
        await s.action(p.name);
        return this.state();
      },
    );
  }
  openapi() {
    const paths: Record<string, unknown> = {};
    for (const r of this.routes) {
      const path = r.path.replace(/:([a-z]+)/g, "{$1}");
      const params = [...r.path.matchAll(/:([a-z]+)/g)].map((m) => ({
        name: m[1],
        in: "path",
        required: true,
        schema: { type: "string" },
      }));
      const spec = {
        summary: r.summary,
        operationId: `${r.method}_${r.path}`.replace(/[^a-zA-Z0-9]/g, "_"),
        parameters: params,
        ...(r.method !== "GET" && r.method !== "DELETE"
          ? {
              requestBody: {
                required: false,
                content: {
                  "application/json": {
                    schema: { type: "object" },
                    ...(r.input ? { example: r.input } : {}),
                  },
                },
              },
            }
          : {}),
        responses: {
          "200": {
            description: "Completed; data edits are saved before replying",
            content: {
              [r.path.endsWith("/svg") || r.path.endsWith("export-svg")
                ? "image/svg+xml"
                : "application/json"]: { schema: {} },
            },
          },
          "401": { description: "Bearer token missing or invalid" },
          "404": { description: "Route or resource missing" },
          "409": { description: "Editor busy, empty history or file conflict" },
          "422": { description: "Invalid input" },
          "503": { description: "Editor is not ready" },
        },
      };
      paths[path] = {
        ...((paths[path] as object) ?? {}),
        [r.method.toLowerCase()]: spec,
      };
    }
    return {
      openapi: "3.1.0",
      info: {
        title: "Wardley Studio API",
        version: "1.0.0",
        description:
          "Local automation of the running desktop editor. Route bodies and examples are also documented in API.md.",
      },
      security: [{ bearerAuth: [] }],
      components: {
        securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      },
      paths,
    };
  }
  request(
    method: string,
    path: string,
    body: unknown = {},
    guard?: () => boolean,
  ): Promise<ApiResponse> {
    const task = this.queue
      .catch(() => {})
      .then(() =>
        guard && !guard()
          ? {
              status: 409,
              body: {
                error: {
                  code: "cancelled",
                  message: "The chat turn was stopped before this action ran.",
                },
              },
            }
          : this.dispatch(method, path, body, guard),
      );
    this.queue = task;
    return task;
  }
  private async dispatch(
    method: string,
    path: string,
    input: unknown,
    guard?: () => boolean,
  ): Promise<ApiResponse> {
    const s = this.studio;
    let busy = false;
    try {
      if (
        typeof method !== "string" ||
        typeof path !== "string" ||
        !path.startsWith("/api/v1/")
      )
        fail(
          404,
          "route_not_found",
          "Use /api/v1/routes to discover endpoints.",
        );
      const b = object(input);
      const pathname = path.split("?")[0].replace(/\/$/, "");
      const matches = this.routes.flatMap((route) => {
        const pattern = route.path
          .split("/")
          .map((part) =>
            part.startsWith(":")
              ? "([^/]+)"
              : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          )
          .join("/");
        const match = pathname.match(new RegExp(`^${pattern}$`));
        if (!match) return [];
        const names = [...route.path.matchAll(/:([a-z]+)/g)].map((m) => m[1]);
        return [
          {
            route,
            params: Object.fromEntries(
              names.map((name, i) => [name, decodeURIComponent(match[i + 1])]),
            ),
          },
        ];
      });
      const match = matches.find(
        ({ route }) => route.method === method.toUpperCase(),
      );
      if (!match)
        fail(
          matches.length ? 405 : 404,
          matches.length ? "method_not_allowed" : "route_not_found",
          "Use /api/v1/routes to discover endpoints.",
        );
      const readActions = [
        "workspace",
        "metamodel",
        "help",
        "api",
        "export",
        "export-json",
        "export-svg",
        "export-metamodel",
        "export-openapi",
      ];
      const isChat =
        pathname.startsWith("/api/v1/chat") ||
        pathname === "/api/v1/actions/chat";
      const isWrite =
        !isChat &&
        method.toUpperCase() !== "GET" &&
        !readActions.some((action) => pathname === `/api/v1/actions/${action}`);
      const closing = [
        "/api/v1/ui/dialog/close",
        "/api/v1/actions/close-dialog",
      ].includes(pathname);
      if (isWrite) {
        if (s.drag || (!closing && document.querySelector("dialog[open]")))
          fail(
            409,
            "editor_busy",
            "Finish dragging or close the open dialog before changing the editor.",
          );
        const discarding =
          pathname === "/api/v1/actions/reload-discard" ||
          (["/api/v1/workspace/reload", "/api/v1/actions/reload"].includes(
            pathname,
          ) &&
            b.discard === true);
        if (!discarding && !closing) await s.flushAll(true);
        s.apiBusy = true;
        busy = true;
        document.querySelector<HTMLElement>("#app")!.inert = true;
      }
      if (guard && !guard())
        fail(409, "cancelled", "The chat action was cancelled before it ran.");
      const result = await match!.route.run(match!.params, b);
      return result instanceof Raw
        ? { status: 200, body: result.text, contentType: result.type }
        : { status: 200, body: copy(result ?? this.state()) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof ApiError)
        return {
          status: err.status,
          body: { error: { code: err.code, message } },
        };
      const conflict = /changed on disk|removed on disk|before saving/i.test(
        message,
      );
      return {
        status: conflict ? 409 : 422,
        body: {
          error: {
            code: conflict ? "file_conflict" : "invalid_input",
            message,
          },
        },
      };
    } finally {
      if (busy) {
        s.apiBusy = false;
        document.querySelector<HTMLElement>("#app")!.inert = false;
      }
    }
  }
}
export async function installApi(studio: Studio) {
  const api = new EditorApi(studio);
  window.wardleyApi = { request: api.request.bind(api) };
  if (native) {
    const { listen } = await import("@tauri-apps/api/event");
    const invoke = window.__TAURI__!.core.invoke;
    await listen<{ id: string; method: string; path: string; body: unknown }>(
      "api-request",
      async ({ payload }) => {
        if (!(await invoke<boolean>("api_pending", { id: payload.id }))) return;
        const response = await api.request(
          payload.method,
          payload.path,
          payload.body,
        );
        await invoke("api_reply", { id: payload.id, response });
      },
    );
    await invoke("api_ready");
  }
  return api;
}
