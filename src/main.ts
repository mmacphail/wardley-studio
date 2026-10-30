import "./style.css";
import { installApi } from "./api.ts";
import type { ChatPanel } from "./chat.ts";
import { loadFeatures, type AppFeatures } from "./features.ts";
import type { MapNode, Metamodel, WardleyMap, Workspace } from "./types.ts";
import {
  addNode,
  clamp,
  connect,
  createMap,
  removeNode,
  stageIndex,
  uid,
  validateMap,
  validateMetamodel,
} from "./model.ts";
import { escape as e, icon } from "./icons.ts";
import { exportSvg, graphContent, PLOT, point, typeIcon } from "./canvas.ts";
import { download, native, Storage } from "./storage.ts";

const $ = <T extends Element = HTMLElement>(
  selector: string,
  root: ParentNode = document,
) => root.querySelector<T>(selector)!;
const button = (action: string, name: string, label: string, extra = "") =>
  `<button type="button" data-action="${action}" class="icon-button ${extra}" title="${label}" aria-label="${label}">${icon(name)}</button>`;
const clone = <T>(value: T): T => structuredClone(value);
type View = { x: number; y: number; w: number; h: number };
type Drag =
  | {
      kind: "node";
      id: string;
      start: { x: number; y: number };
      original: MapNode;
      before: WardleyMap;
      moved: boolean;
    }
  | { kind: "choose"; id: string | null; connecting: boolean }
  | { kind: "pan"; start: { x: number; y: number }; view: View }
  | { kind: "connect"; source: string; moved: boolean };

export class Studio {
  apiBusy = false;
  chat: ChatPanel | null = null;
  features: AppFeatures = { chat: false, chatCompiled: false };
  storage = new Storage();
  ws!: Workspace;
  activeId = "";
  selected: string | null = null;
  tool: "select" | "connect" | "pan" = "select";
  connectFrom: string | null = null;
  autoConnect = true;
  labels = true;
  search = "";
  drawer: "maps" | "components" | "inspector" | null = null;
  focusMode = false;
  view: View = { x: 0, y: 0, w: 1100, h: 760 };
  drag: Drag | null = null;
  space = false;
  timer?: ReturnType<typeof setTimeout>;
  toastTimer?: ReturnType<typeof setTimeout>;
  past = new Map<string, WardleyMap[]>();
  future = new Map<string, WardleyMap[]>();
  dirty = new Set<string>();
  versions = new Map<string, number>();
  queue: Promise<void> = Promise.resolve();
  saveState: "saved" | "saving" | "dirty" | "error" = "saved";
  get map() {
    return this.ws.maps.find((m) => m.id === this.activeId)!;
  }
  get model() {
    return this.ws.metamodel;
  }
  get node() {
    return this.map?.nodes.find((n) => n.id === this.selected);
  }

  async start() {
    $("#app").innerHTML =
      '<div class="loading"><div class="brand-mark">w<span>•</span></div><p>Opening your workspace…</p></div>';
    try {
      this.features = await loadFeatures();
      if (__CHAT_ENABLED__ && this.features.chat) {
        const { ChatPanel } = await import("./chat.ts");
        this.chat = new ChatPanel(this);
      }
      this.ws = await this.storage.load();
      this.activeId =
        this.ws.maps.find((m) => m.id === "coffee-shop")?.id ??
        this.ws.maps[0]?.id ??
        "";
      this.render();
      if (this.ws.warnings.length) this.showWarnings();
      document.addEventListener("keydown", (ev) => this.keydown(ev));
      document.addEventListener("keyup", (ev) => {
        if (ev.code === "Space") this.space = false;
      });
      window.addEventListener("blur", () => {
        this.space = false;
      });
      window.addEventListener("beforeunload", (ev) => {
        if (this.dirty.size) {
          ev.preventDefault();
          ev.returnValue = "";
        }
      });
      const api = await installApi(this);
      await this.chat?.start(api);
      if (native) {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        await win.onCloseRequested(async (event) => {
          event.preventDefault();
          try {
            await this.flushAll(true);
            if (this.chat?.busy) await this.chat.stop();
            await this.chat?.flush();
            await win.destroy();
          } catch (error) {
            this.toast(`Could not save before closing: ${String(error)}`, true);
          }
        });
      }
    } catch (error) {
      $("#app").innerHTML =
        `<div class="loading"><div class="brand-mark">w<span>•</span></div><h2>Could not open the workspace</h2><p>${e(String(error))}</p><button class="primary" id="retry">Try again</button></div>`;
      $("#retry").addEventListener("click", () => location.reload());
    }
  }
  checkpoint(before = clone(this.map)) {
    const stack = this.past.get(this.activeId) ?? [];
    stack.push(before);
    if (stack.length > 80) stack.shift();
    this.past.set(this.activeId, stack);
    this.future.set(this.activeId, []);
  }
  change(fn: () => void, redraw = true) {
    this.checkpoint();
    fn();
    this.changed();
    if (redraw) this.render();
  }
  changed() {
    this.map.updatedAt = new Date().toISOString();
    this.dirty.add(this.activeId);
    this.versions.set(
      this.activeId,
      (this.versions.get(this.activeId) ?? 0) + 1,
    );
    this.saveState = "dirty";
    this.updateStatus();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flushAll().catch((error) => this.toast(String(error), true));
    }, 550);
  }
  async saveNow(id = this.activeId): Promise<void> {
    clearTimeout(this.timer);
    const map = this.ws.maps.find((map) => map.id === id);
    if (!map || !this.dirty.has(id)) {
      await this.queue;
      return;
    }
    const snapshot = clone(map),
      version = this.versions.get(id);
    const task = this.queue
      .catch(() => {})
      .then(async () => {
        this.saveState = "saving";
        this.updateStatus();
        try {
          await this.storage.saveMap(snapshot);
          if (this.versions.get(id) === version) this.dirty.delete(id);
          this.saveState = this.dirty.size ? "dirty" : "saved";
          this.updateStatus();
        } catch (error) {
          this.saveState = "error";
          this.updateStatus();
          throw error;
        }
      });
    this.queue = task;
    await task;
    if (this.dirty.has(id)) await this.saveNow(id);
  }
  async flushAll(commitFocusedField = false) {
    if (
      commitFocusedField &&
      document.activeElement?.matches("#node-label,#node-notes,#edge-label")
    )
      (document.activeElement as HTMLElement).blur();
    await this.saveNow();
    while (this.dirty.size)
      for (const id of [...this.dirty]) await this.saveNow(id);
    await this.queue;
  }
  updateStatus() {
    const status = $("#save-status");
    if (!status) return;
    const text = {
      saved: native ? "Saved to disk" : "Saved in browser",
      saving: "Saving…",
      dirty: "Unsaved changes",
      error: "Save failed · click to retry",
    }[this.saveState];
    status.innerHTML = `${icon(this.saveState === "saved" ? "check" : "json", 14)}<span>${text}</span>`;
    status.className = `save-status ${this.saveState}`;
  }
  drawerButton(
    drawer: "maps" | "components" | "inspector",
    name: string,
    label: string,
  ) {
    return `<button type="button" class="drawer-toggle ${this.drawer === drawer ? "active" : ""}" data-action="drawer-${drawer}" aria-expanded="${this.drawer === drawer && !this.focusMode}" aria-controls="drawer-${drawer}" aria-label="${label}" title="${label}">${icon(name, 17)}<span>${label.replace(/ \([A-Z]\)$/, "")}</span></button>`;
  }
  render() {
    const map = this.map;
    $("#app").classList.toggle("focus-mode", this.focusMode);
    $("#app").innerHTML = `<main class="main">
      <header class="app-header">
        ${this.drawerButton("maps", "folder", "Maps (M)")}
        ${
          map
            ? `<button class="title-button" data-action="details" title="Edit map details"><h1>${e(map.title)}</h1>${icon("down", 15)}</button>
        <div class="map-type"><select id="map-kind" aria-label="Map type">${this.model.mapKinds.map((k) => `<option value="${e(k.id)}" ${map.kind === k.id ? "selected" : ""}>${e(k.label)}</option>`).join("")}</select></div>
        <div class="heading-actions"><button id="save-status" data-action="save" class="save-status"></button>${button("duplicate", "copy", "Duplicate map")}<button class="quiet" data-action="export">${icon("export", 16)} Export</button></div>`
            : "<h1>Wardley Studio</h1>"
        }
      ${this.chat ? `<button type="button" class="drawer-toggle" data-action="chat" aria-controls="chat-panel" aria-expanded="${this.chat.open}" title="Chat">${icon("chat", 17)}<span>Chat</span></button>` : ""}</header>
      ${
        map
          ? `<section class="editor">
        <div class="canvas-tools" role="toolbar" aria-label="Map tools">
          ${this.drawerButton("components", "plus", "Components (A)")}
          <span class="bar-divider"></span><div class="tool-group">${button("select", "cursor", "Select and move (V)", this.tool === "select" ? "active" : "")}${button("connect", "link", "Connect components (C)", this.tool === "connect" ? "active" : "")}${button("pan", "hand", "Pan the canvas (H)", this.tool === "pan" ? "active" : "")}</div>
          <span class="bar-divider"></span><div class="tool-group">${button("undo", "undo", "Undo (Ctrl/⌘ Z)", (this.past.get(this.activeId)?.length ?? 0) ? "" : "unavailable")}${button("redo", "redo", "Redo (Ctrl/⌘ Shift Z)", (this.future.get(this.activeId)?.length ?? 0) ? "" : "unavailable")}</div>
          <label class="auto-connect"><input id="auto-connect" type="checkbox" ${this.autoConnect ? "checked" : ""}/><span class="switch"></span>Auto-connect</label>
          <div class="toolbar-end">${this.drawerButton("inspector", "settings", "Properties (I)")}${button("focus", "fit", "Focus mode (F)")}</div>
        </div>
        <div class="canvas-surface ${this.tool === "connect" ? "connecting" : this.tool === "pan" ? "panning" : ""}">
          <svg id="map-canvas" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${e(map.title)} Wardley map" viewBox="${this.view.x} ${this.view.y} ${this.view.w} ${this.view.h}"></svg>
          <div class="canvas-bottom"><span class="canvas-hint">${this.connectFrom ? "Choose a component to connect · Esc to cancel" : this.tool === "connect" ? "Click a source, then its dependency" : this.tool === "pan" ? "Drag to pan" : "Double-click to add · Space + drag to pan"}</span><div class="zoom-controls">${button("zoom-out", "minus", "Zoom out")}<span id="zoom-value">${Math.round((1100 / this.view.w) * 100)}%</span>${button("zoom-in", "plus", "Zoom in")}<span class="bar-divider"></span>${button("fit", "fit", "Fit map (0)")}</div></div>
        </div>
        <aside id="drawer-components" class="drawer component-drawer" aria-label="Components" ${this.drawer !== "components" || this.focusMode ? "hidden" : ""}>
          <div class="drawer-heading"><h2>Components</h2>${button("close-drawer", "close", "Close components")}</div>
          <div class="palette-types">${this.model.componentTypes.map((t) => `<button class="palette-type" draggable="true" data-type="${e(t.id)}" title="${e(t.description)}">${typeIcon(t)}<span>${e(t.label)}</span></button>`).join("")}</div>
          <p class="drawer-hint">Click or drag onto the map</p>
        </aside>
        <aside id="drawer-inspector" class="drawer inspector" aria-label="Inspector" ${this.drawer !== "inspector" || this.focusMode ? "hidden" : ""}>${this.inspector()}</aside>
      </section>`
          : `<div class="empty-workspace"><h1>No maps</h1><button class="primary" data-action="new">${icon("plus")} New map</button><button class="quiet" data-action="import">Import a JSON map</button></div>`
      }
      <aside id="drawer-maps" class="drawer sidebar" aria-label="Maps" ${this.drawer !== "maps" || this.focusMode ? "hidden" : ""}>
        <div class="drawer-heading"><h2>Maps</h2>${button("close-drawer", "close", "Close maps")}</div>
        <button class="new-map" data-action="new">${icon("plus", 17)} New map <kbd>Ctrl/⌘ N</kbd></button>
        <label class="search">${icon("search", 15)}<input id="map-search" value="${e(this.search)}" placeholder="Find a map…" aria-label="Find a map"/></label>
        <nav class="map-list" aria-label="Map library">${this.library()}</nav>
        <div class="sidebar-bottom">
          <button class="sidebar-action" data-action="import">${icon("import", 17)}<span>Import JSON map</span></button>
          <button class="sidebar-action" data-action="workspace" title="${e(this.ws.path)}">${icon("folder", 17)}<span>Workspace folder</span></button>
          <button class="sidebar-action" data-action="metamodel">${icon("settings", 17)}<span>Metamodel</span></button>
          <button class="sidebar-action" data-action="api">${icon("json", 17)}<span>API</span></button>
        <button class="sidebar-action" data-action="help">${icon("help", 17)}<span>Help</span></button>
        </div>
      </aside>
      ${this.focusMode ? `<button class="focus-exit quiet" data-action="focus">${icon("fit", 16)} Exit focus <kbd>F</kbd></button>` : ""}
    </main><div id="toast" role="status" aria-live="polite"></div><div id="modal-root"></div>`;
    this.bind();
    if (map) {
      this.renderCanvas();
      this.updateStatus();
    }
  }
  syncChatButton() {
    const button = document.querySelector<HTMLElement>('[data-action="chat"]');
    button?.setAttribute("aria-expanded", String(this.chat?.open ?? false));
    button?.classList.toggle("active", this.chat?.open ?? false);
  }
  library() {
    const maps = this.ws.maps.filter((m) =>
      `${m.title} ${m.description}`
        .toLowerCase()
        .includes(this.search.toLowerCase()),
    );
    return (
      maps
        .map(
          (m) =>
            `<button class="map-item ${m.id === this.activeId ? "current" : ""}" data-map="${e(m.id)}">${icon("map", 17)}<span>${e(m.title)}<small>${e(this.model.mapKinds.find((k) => k.id === m.kind)?.label ?? m.kind)}</small></span>${m.id === this.activeId ? '<span class="current-dot"></span>' : ""}</button>`,
        )
        .join("") || '<p class="no-results">No maps found.</p>'
    );
  }
  inspector() {
    const n = this.node;
    if (n) {
      const t = this.model.componentTypes.find((t) => t.id === n.type)!;
      const connections = this.map.edges.filter(
        (edge) => edge.source === n.id || edge.target === n.id,
      );
      return `<div class="inspector-heading"><span class="section-label">COMPONENT</span>${button("close-drawer", "close", "Close inspector")}</div>
        <div class="selected-type">${typeIcon(t, 27)}<span>${e(t.label)}</span></div>
        <label class="field">Name<input id="node-label" value="${e(n.label)}" maxlength="160"/></label>
        <label class="field">Component type<select id="node-type">${this.model.componentTypes.map((type) => `<option value="${e(type.id)}" ${n.type === type.id ? "selected" : ""}>${e(type.label)}</option>`).join("")}</select></label>
        <div class="inspector-divider"></div><div class="field"><span>Stage of evolution</span><div class="stage-picker">${t.stageLabels.map((s, i) => `<button data-stage="${i}" class="${stageIndex(n.evolution) === i ? "chosen" : ""}" title="${e(s)}"><small>${["I", "II", "III", "IV"][i]}</small><span>${e(s)}</span></button>`).join("")}</div></div>
        <label class="field range-field">Evolution <output>${Math.round(n.evolution * 100)}%</output><input id="node-evolution" type="range" min="0" max="100" value="${Math.round(n.evolution * 100)}"/></label>
        <label class="field range-field">Visibility <output>${Math.round(n.visibility * 100)}%</output><input id="node-visibility" type="range" min="0" max="100" value="${Math.round(n.visibility * 100)}"/></label>
        <div class="inspector-divider"></div><label class="check-field"><input id="node-target-enabled" type="checkbox" ${n.targetEvolution !== undefined ? "checked" : ""}/> Show future evolution</label>
        ${n.targetEvolution !== undefined ? `<label class="field range-field">Target evolution <output>${Math.round(n.targetEvolution * 100)}%</output><input id="node-target" type="range" min="${Math.ceil(n.evolution * 100)}" max="100" value="${Math.round(n.targetEvolution * 100)}"/></label>` : ""}
        <label class="check-field"><input id="node-inertia" type="checkbox" ${n.inertia ? "checked" : ""}/> Mark inertia</label>
        <label class="field">Notes<textarea id="node-notes" rows="3" placeholder="Optional notes">${e(n.notes)}</textarea></label>
        <div class="connection-heading"><span class="section-label">CONNECTIONS</span><span>${connections.length}</span></div>
        <div class="connections-list">${connections.map((edge) => `<button data-edge-select="${e(edge.id)}">${icon("arrow", 13)}<span>${e(this.map.nodes.find((other) => other.id === (edge.source === n.id ? edge.target : edge.source))!.label)}</span><small>${edge.source === n.id ? "depends on" : "needed by"}</small></button>`).join("") || "<p>No connections yet.</p>"}</div>
        <button class="connect-button" data-action="connect-selected">${icon("link", 15)} Add connection</button><div class="inspector-bottom">${button("clone-node", "copy", "Duplicate component")}<button class="danger-text" data-action="delete-selection">${icon("trash", 15)} Delete component</button></div>`;
    }
    const edge = this.map.edges.find((edge) => edge.id === this.selected);
    if (edge)
      return `<div class="inspector-heading"><span class="section-label">CONNECTION</span>${button("close-drawer", "close", "Close inspector")}</div><div class="edge-summary">${e(this.map.nodes.find((n) => n.id === edge.source)!.label)}<span>${icon("arrow")}</span>${e(this.map.nodes.find((n) => n.id === edge.target)!.label)}</div><label class="field">Relationship<select id="edge-kind"><option value="dependency" ${edge.kind === "dependency" ? "selected" : ""}>Depends on</option><option value="evolution" ${edge.kind === "evolution" ? "selected" : ""}>Evolves toward</option></select></label><label class="field">Label<input id="edge-label" value="${e(edge.label)}" maxlength="100" placeholder="Optional label"/></label><button class="danger-text" data-action="delete-selection">${icon("trash", 15)} Delete connection</button>`;
    const counts = this.model.componentTypes
      .map((t) => ({
        t,
        count: this.map.nodes.filter((n) => n.type === t.id).length,
      }))
      .filter((x) => x.count);
    return `<div class="inspector-heading"><span class="section-label">MAP OVERVIEW</span>${button("close-drawer", "close", "Close inspector")}</div><div class="overview-stats"><div><strong>${this.map.nodes.length}</strong><span>Components</span></div><div><strong>${this.map.edges.length}</strong><span>Connections</span></div></div><div class="inspector-divider"></div><div class="section-label">ON THIS MAP</div><div class="type-legend">${counts.map(({ t, count }) => `<div>${typeIcon(t, 19)}<span>${e(t.label)}</span><small>${count}</small></div>`).join("") || "<p>No components.</p>"}</div><label class="check-field labels-toggle"><input id="show-labels" type="checkbox" ${this.labels ? "checked" : ""}/> Show labels</label>`;
  }
  bind() {
    document
      .querySelectorAll<HTMLButtonElement>("[data-action]")
      .forEach((el) =>
        el.addEventListener("click", () => {
          void this.action(el.dataset.action!).catch((err) =>
            this.toast(String(err), true),
          );
        }),
      );
    $(".map-list").addEventListener("click", (ev) => {
      const target = (ev.target as Element).closest<HTMLElement>("[data-map]");
      if (target)
        void this.switchMap(target.dataset.map!).catch((err) =>
          this.toast(String(err), true),
        );
    });
    $("#map-search").addEventListener("input", (ev) => {
      this.search = (ev.target as HTMLInputElement).value;
      $(".map-list").innerHTML = this.library();
    });
    if (!this.map) return;
    $("#map-kind").addEventListener("change", (ev) =>
      this.change(() => {
        this.map.kind = (ev.target as HTMLSelectElement).value;
      }),
    );
    $("#auto-connect").addEventListener("change", (ev) => {
      this.autoConnect = (ev.target as HTMLInputElement).checked;
    });
    const svg = $<SVGSVGElement>("#map-canvas");
    svg.addEventListener("pointerdown", (ev) => this.pointerDown(ev));
    svg.addEventListener("pointermove", (ev) => this.pointerMove(ev));
    svg.addEventListener("pointerup", (ev) => this.pointerUp(ev));
    svg.addEventListener("pointercancel", () => this.cancelDrag());
    svg.addEventListener("dblclick", (ev) => {
      if (
        (ev.target as Element).closest("[data-node],[data-edge]") ||
        this.tool !== "select"
      )
        return;
      const p = this.svgPoint(ev);
      if (this.inPlot(p))
        this.addComponent(
          this.defaultType(),
          (p.x - PLOT.x) / PLOT.w,
          1 - (p.y - PLOT.y) / PLOT.h,
        );
    });
    svg.addEventListener(
      "wheel",
      (ev) => {
        ev.preventDefault();
        const p = this.svgPoint(ev);
        this.zoom(ev.deltaY > 0 ? 1.12 : 1 / 1.12, p);
      },
      { passive: false },
    );
    svg.addEventListener("dragover", (ev) => {
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
    });
    svg.addEventListener("drop", (ev) => {
      ev.preventDefault();
      const type = ev.dataTransfer?.getData("application/wardley-type");
      if (type && this.model.componentTypes.some((t) => t.id === type)) {
        const p = this.svgPoint(ev);
        this.addComponent(
          type,
          (p.x - PLOT.x) / PLOT.w,
          1 - (p.y - PLOT.y) / PLOT.h,
        );
      }
    });
    document.querySelectorAll<HTMLElement>("[data-type]").forEach((el) => {
      el.addEventListener("click", () => this.addComponent(el.dataset.type!));
      el.addEventListener("dragstart", (ev) => {
        (ev as DragEvent).dataTransfer?.setData(
          "application/wardley-type",
          el.dataset.type!,
        );
      });
    });
    document.querySelectorAll<HTMLElement>("[data-edge-select]").forEach((el) =>
      el.addEventListener("click", () => {
        this.selected = el.dataset.edgeSelect!;
        this.render();
      }),
    );
    $("#show-labels")?.addEventListener("change", (ev) => {
      this.labels = (ev.target as HTMLInputElement).checked;
      this.renderCanvas();
    });
    if (this.node) this.bindNode();
    const edge = this.map.edges.find((edge) => edge.id === this.selected);
    if (edge) {
      $("#edge-label").addEventListener("change", (ev) =>
        this.change(() => {
          edge.label = (ev.target as HTMLInputElement).value;
        }),
      );
      $("#edge-kind").addEventListener("change", (ev) => {
        const kind = (ev.target as HTMLSelectElement).value as
          "dependency" | "evolution";
        if (
          this.map.edges.some(
            (other) =>
              other.id !== edge.id &&
              other.source === edge.source &&
              other.target === edge.target &&
              other.kind === kind,
          )
        ) {
          this.toast("That connection already exists.");
          this.render();
          return;
        }
        this.change(() => {
          edge.kind = kind;
        });
      });
    }
  }
  bindNode() {
    const n = this.node!;
    $("#node-label").addEventListener("change", (ev) => {
      const value = (ev.target as HTMLInputElement).value.trim();
      if (value)
        this.change(() => {
          n.label = value;
        });
      else this.render();
    });
    $("#node-type").addEventListener("change", (ev) =>
      this.change(() => {
        n.type = (ev.target as HTMLSelectElement).value;
      }),
    );
    document.querySelectorAll<HTMLElement>("[data-stage]").forEach((el) =>
      el.addEventListener("click", () =>
        this.change(() => {
          n.evolution = (Number(el.dataset.stage) + 0.5) / 4;
          if (n.targetEvolution !== undefined)
            n.targetEvolution = Math.max(n.evolution, n.targetEvolution);
        }),
      ),
    );
    for (const [id, property] of [
      ["node-evolution", "evolution"],
      ["node-visibility", "visibility"],
      ["node-target", "targetEvolution"],
    ] as const) {
      const input = $<HTMLInputElement>(`#${id}`);
      if (!input) continue;
      input.addEventListener("input", () => {
        input.parentElement!.querySelector("output")!.value = `${input.value}%`;
      });
      input.addEventListener("change", () =>
        this.change(() => {
          n[property] = Number(input.value) / 100;
          if (n.targetEvolution !== undefined)
            n.targetEvolution = Math.max(n.evolution, n.targetEvolution);
        }),
      );
    }
    $("#node-target-enabled").addEventListener("change", (ev) =>
      this.change(() => {
        if ((ev.target as HTMLInputElement).checked)
          n.targetEvolution = clamp(n.evolution + 0.22);
        else delete n.targetEvolution;
      }),
    );
    $("#node-inertia").addEventListener("change", (ev) =>
      this.change(() => {
        n.inertia = (ev.target as HTMLInputElement).checked;
      }),
    );
    $("#node-notes").addEventListener("change", (ev) =>
      this.change(() => {
        n.notes = (ev.target as HTMLTextAreaElement).value;
      }),
    );
  }
  defaultType() {
    const axis = this.model.mapKinds.find(
      (k) => k.id === this.map.kind,
    )!.axisType;
    return this.model.componentTypes.some((t) => t.id === axis)
      ? axis
      : this.model.componentTypes[0].id;
  }
  addComponent(
    type: string,
    evolution?: number,
    visibility?: number,
    parentOverride?: string,
  ) {
    const parent =
      parentOverride ?? (this.autoConnect ? this.node?.id : undefined);
    const anchor = this.map.nodes.find((n) => n.id === parent);
    const t = this.model.componentTypes.find((t) => t.id === type)!;
    let label = t.label;
    let i = 2;
    while (this.map.nodes.some((n) => n.label === label))
      label = `${t.label} ${i++}`;
    this.drawer = "inspector";
    this.focusMode = false;
    this.change(() => {
      const n = addNode(
        this.map,
        type,
        label,
        evolution ?? clamp((anchor?.evolution ?? 0.4) + 0.08),
        visibility ?? clamp((anchor?.visibility ?? 0.7) - 0.16, 0.04, 0.96),
        parent,
      );
      this.selected = n.id;
      this.connectFrom = null;
    });
    const input = $<HTMLInputElement>("#node-label");
    input?.focus();
    input?.select();
  }
  renderCanvas() {
    const svg = $<SVGSVGElement>("#map-canvas");
    if (!svg) return;
    svg.setAttribute(
      "viewBox",
      `${this.view.x} ${this.view.y} ${this.view.w} ${this.view.h}`,
    );
    svg.innerHTML = graphContent(
      this.map,
      this.model,
      this.selected,
      this.connectFrom,
      this.labels,
    );
    const zoom = $("#zoom-value");
    if (zoom) zoom.textContent = `${Math.round((1100 / this.view.w) * 100)}%`;
  }
  svgPoint(ev: { clientX: number; clientY: number }) {
    const svg = $<SVGSVGElement>("#map-canvas"),
      matrix = svg.getScreenCTM();
    return new DOMPoint(ev.clientX, ev.clientY).matrixTransform(
      matrix?.inverse(),
    );
  }
  inPlot(p: { x: number; y: number }) {
    return (
      p.x >= PLOT.x &&
      p.x <= PLOT.x + PLOT.w &&
      p.y >= PLOT.y &&
      p.y <= PLOT.y + PLOT.h
    );
  }
  pointerDown(ev: PointerEvent) {
    if (ev.button !== 0 && ev.button !== 1) return;
    const target = ev.target as Element,
      p = this.svgPoint(ev);
    const svg = $<SVGSVGElement>("#map-canvas");
    if (this.tool === "pan" || this.space || ev.button === 1) {
      ev.preventDefault();
      this.drag = {
        kind: "pan",
        start: { x: ev.clientX, y: ev.clientY },
        view: { ...this.view },
      };
      svg.setPointerCapture(ev.pointerId);
      return;
    }
    const port = target.closest<HTMLElement>("[data-port]");
    if (port) {
      ev.preventDefault();
      this.drag = { kind: "connect", source: port.dataset.port!, moved: false };
      svg.setPointerCapture(ev.pointerId);
      return;
    }
    const nodeElement = target.closest<HTMLElement>("[data-node]");
    if (nodeElement) {
      ev.preventDefault();
      const id = nodeElement.dataset.node!;
      if (this.tool === "connect" || this.connectFrom) {
        this.drag = { kind: "choose", id, connecting: true };
        svg.setPointerCapture(ev.pointerId);
        return;
      }
      this.selected = id;
      const n = this.node!;
      this.drag = {
        kind: "node",
        id,
        start: p,
        original: clone(n),
        before: clone(this.map),
        moved: false,
      };
      svg.setPointerCapture(ev.pointerId);
      return;
    }
    const edge = target.closest<HTMLElement>("[data-edge]");
    this.drag = {
      kind: "choose",
      id: edge?.dataset.edge ?? null,
      connecting: false,
    };
    svg.setPointerCapture(ev.pointerId);
  }
  pointerMove(ev: PointerEvent) {
    if (!this.drag) return;
    const p = this.svgPoint(ev);
    if (this.drag.kind === "node") {
      const dx = p.x - this.drag.start.x,
        dy = p.y - this.drag.start.y;
      if (!this.drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
      this.drag.moved = true;
      const id = this.drag.id;
      const n = this.map.nodes.find((n) => n.id === id)!;
      n.evolution = clamp(
        this.drag.original.evolution + dx / PLOT.w,
        0.012,
        0.988,
      );
      n.visibility = clamp(
        this.drag.original.visibility - dy / PLOT.h,
        0.02,
        0.98,
      );
      if (n.targetEvolution !== undefined)
        n.targetEvolution = Math.max(n.evolution, n.targetEvolution);
      this.renderCanvas();
    } else if (this.drag.kind === "pan") {
      const svg = $<SVGSVGElement>("#map-canvas"),
        rect = svg.getBoundingClientRect();
      const scale = Math.max(
        this.drag.view.w / rect.width,
        this.drag.view.h / rect.height,
      );
      this.view.x = this.drag.view.x - (ev.clientX - this.drag.start.x) * scale;
      this.view.y = this.drag.view.y - (ev.clientY - this.drag.start.y) * scale;
      svg.setAttribute(
        "viewBox",
        `${this.view.x} ${this.view.y} ${this.view.w} ${this.view.h}`,
      );
    } else if (this.drag.kind === "connect") {
      this.drag.moved = true;
      const id = this.drag.source;
      const n = this.map.nodes.find((n) => n.id === id)!;
      const source = point(n.evolution, n.visibility);
      $("#draft-link").setAttribute(
        "d",
        `M${source.x},${source.y}L${p.x},${p.y}`,
      );
    }
  }
  pointerUp(ev: PointerEvent) {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    const svg = $<SVGSVGElement>("#map-canvas");
    if (svg.hasPointerCapture(ev.pointerId))
      svg.releasePointerCapture(ev.pointerId);
    if (drag.kind === "node" && drag.moved) {
      this.checkpoint(drag.before);
      this.changed();
    }
    if (drag.kind === "choose") {
      if (drag.connecting && drag.id) {
        if (this.connectFrom && this.connectFrom !== drag.id) {
          const source = this.connectFrom,
            target = drag.id;
          if (
            this.map.edges.some(
              (edge) =>
                edge.source === source &&
                edge.target === target &&
                edge.kind === "dependency",
            )
          )
            this.toast("Those components are already connected.");
          else
            this.change(() => {
              connect(this.map, source, target);
              this.selected = target;
              this.connectFrom = null;
            });
        } else {
          this.connectFrom = drag.id;
          this.selected = drag.id;
        }
      } else {
        this.selected = drag.id;
        this.connectFrom = null;
      }
    }
    if (drag.kind === "connect") {
      const target = document
        .elementFromPoint(ev.clientX, ev.clientY)
        ?.closest<HTMLElement>("[data-node]")?.dataset.node;
      if (target && target !== drag.source) {
        if (
          this.map.edges.some(
            (edge) =>
              edge.source === drag.source &&
              edge.target === target &&
              edge.kind === "dependency",
          )
        )
          this.toast("Those components are already connected.");
        else
          this.change(() => {
            connect(this.map, drag.source, target);
            this.selected = target;
          });
      } else if (drag.moved && this.inPlot(this.svgPoint(ev)) && !target) {
        const p = this.svgPoint(ev);
        this.addComponent(
          this.defaultType(),
          (p.x - PLOT.x) / PLOT.w,
          1 - (p.y - PLOT.y) / PLOT.h,
          drag.source,
        );
        return;
      } else {
        this.selected = drag.source;
        this.connectFrom = drag.source;
      }
    }
    if (!this.focusMode) {
      if (
        (drag.kind === "node" && !drag.moved) ||
        (drag.kind === "choose" && drag.id && !drag.connecting)
      )
        this.drawer = "inspector";
      else if (drag.kind === "choose" && !drag.id) this.drawer = null;
    }
    this.render();
  }
  cancelDrag() {
    if (this.drag?.kind === "node") {
      const index = this.ws.maps.findIndex((m) => m.id === this.activeId);
      this.ws.maps[index] = this.drag.before;
    }
    this.drag = null;
    this.render();
  }
  zoom(
    factor: number,
    center = {
      x: this.view.x + this.view.w / 2,
      y: this.view.y + this.view.h / 2,
    },
  ) {
    const width = clamp(this.view.w * factor, 300, 2200),
      ratio = width / this.view.w;
    this.view = {
      x: center.x - (center.x - this.view.x) * ratio,
      y: center.y - (center.y - this.view.y) * ratio,
      w: width,
      h: (width * 760) / 1100,
    };
    this.renderCanvas();
  }
  async switchMap(id: string) {
    if (id === this.activeId) return;
    await this.flushAll();
    this.activeId = id;
    this.drawer = null;
    this.selected = null;
    this.connectFrom = null;
    this.view = { x: 0, y: 0, w: 1100, h: 760 };
    this.render();
  }
  undo(redo = false) {
    const from = redo ? this.future : this.past,
      to = redo ? this.past : this.future;
    const stack = from.get(this.activeId) ?? [],
      previous = stack.pop();
    if (!previous) return;
    const other = to.get(this.activeId) ?? [];
    other.push(clone(this.map));
    to.set(this.activeId, other);
    this.ws.maps[this.ws.maps.findIndex((m) => m.id === this.activeId)] =
      previous;
    this.selected = null;
    this.connectFrom = null;
    this.changed();
    this.render();
  }
  async action(action: string) {
    if (action.startsWith("drawer-")) {
      const drawer = action.slice(7) as NonNullable<typeof this.drawer>;
      this.drawer = this.drawer === drawer ? null : drawer;
      this.focusMode = false;
      this.render();
      if (this.drawer === "maps") $("#map-search").focus();
      else if (this.drawer)
        $<HTMLElement>(
          `#drawer-${drawer} button, #drawer-${drawer} input`,
        )?.focus();
      else $<HTMLElement>(`[data-action="${action}"]`)?.focus();
      return;
    }
    if (action === "close-drawer") {
      const drawer = this.drawer;
      this.drawer = null;
      this.render();
      $<HTMLElement>(`[data-action="drawer-${drawer}"]`)?.focus();
      return;
    }
    if (action === "focus") {
      this.focusMode = !this.focusMode;
      this.drawer = null;
      this.render();
      $<HTMLElement>(
        '[data-action="focus"]:not(.canvas-tools button)',
      )?.focus();
      return;
    }
    if (["select", "connect", "pan"].includes(action)) {
      this.tool = action as typeof this.tool;
      this.connectFrom = null;
      this.render();
      return;
    }
    switch (action) {
      case "chat":
        this.chat?.toggle();
        break;
      case "new":
        this.mapDialog();
        break;
      case "details":
        this.mapDialog(true);
        break;
      case "save":
        await this.saveNow();
        break;
      case "undo":
        this.undo();
        break;
      case "redo":
        this.undo(true);
        break;
      case "zoom-in":
        this.zoom(1 / 1.2);
        break;
      case "zoom-out":
        this.zoom(1.2);
        break;
      case "fit":
        this.view = { x: 0, y: 0, w: 1100, h: 760 };
        this.renderCanvas();
        break;
      case "deselect":
        this.selected = null;
        this.connectFrom = null;
        this.render();
        break;
      case "connect-selected":
        this.drawer = null;
        this.connectFrom = this.node!.id;
        this.tool = "connect";
        this.render();
        break;
      case "delete-selection":
        if (this.selected)
          this.change(() => {
            if (this.node) removeNode(this.map, this.selected!);
            else
              this.map.edges = this.map.edges.filter(
                (edge) => edge.id !== this.selected,
              );
            this.selected = null;
            this.connectFrom = null;
          });
        break;
      case "clone-node": {
        const original = clone(this.node!);
        this.change(() => {
          const n = {
            ...original,
            id: uid(),
            label: `${original.label} copy`,
            evolution: clamp(original.evolution + 0.04),
            visibility: clamp(original.visibility - 0.06),
          };
          if (n.targetEvolution !== undefined)
            n.targetEvolution = Math.max(n.targetEvolution, n.evolution);
          this.map.nodes.push(n);
          this.selected = n.id;
        });
        break;
      }
      case "duplicate": {
        await this.saveNow();
        const map = clone(this.map);
        map.id = uid();
        map.title += " · copy";
        map.createdAt = map.updatedAt = new Date().toISOString();
        this.ws.maps.push(map);
        this.activeId = map.id;
        this.selected = null;
        this.changed();
        this.render();
        await this.saveNow();
        this.toast("Map duplicated.");
        break;
      }
      case "delete-map":
        this.confirmDelete();
        break;
      case "export":
        this.exportDialog();
        break;
      case "export-json":
        if (await this.storage.exportMap(this.map))
          this.toast("Map exported as JSON.");
        break;
      case "export-svg":
        download(
          `${this.map.id}.svg`,
          exportSvg(this.map, this.model, this.labels),
          "image/svg+xml",
        );
        this.toast("Map exported as SVG.");
        break;
      case "import": {
        const map = await this.storage.importMap();
        if (!map) break;
        await this.saveNow();
        map.id = uid();
        map.createdAt = map.updatedAt = new Date().toISOString();
        validateMap(map, this.model);
        this.ws.maps.push(map);
        this.activeId = map.id;
        this.selected = null;
        this.changed();
        this.render();
        await this.saveNow();
        this.toast("JSON map imported.");
        break;
      }
      case "workspace":
        this.workspaceDialog();
        break;
      case "choose-workspace":
        await this.flushAll();
        if (await this.storage.chooseWorkspace()) {
          this.ws = await this.storage.load();
          this.activeId = this.ws.maps[0]?.id ?? "";
          this.selected = null;
          this.past.clear();
          this.future.clear();
          this.render();
          if (this.ws.warnings.length) this.showWarnings();
        }
        break;
      case "reload":
        await this.flushAll();
        await this.reload();
        break;
      case "reload-discard":
        await this.reload();
        break;
      case "metamodel":
        this.metamodelDialog();
        break;
      case "api":
        await this.apiDialog();
        break;
      case "help":
        this.helpDialog();
        break;
    }
  }
  async reload() {
    clearTimeout(this.timer);
    await this.queue.catch(() => {});
    this.queue = Promise.resolve();
    this.ws = await this.storage.load();
    this.activeId = this.ws.maps.some((m) => m.id === this.activeId)
      ? this.activeId
      : (this.ws.maps[0]?.id ?? "");
    this.dirty.clear();
    this.past.clear();
    this.future.clear();
    this.selected = null;
    this.connectFrom = null;
    this.saveState = "saved";
    this.render();
    if (this.ws.warnings.length) this.showWarnings();
  }
  keydown(ev: KeyboardEvent) {
    if (this.apiBusy) {
      ev.preventDefault();
      return;
    }
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "s") {
      ev.preventDefault();
      void this.flushAll(true).catch((err) => this.toast(String(err), true));
      return;
    }
    if (ev.key === "Escape" && this.drawer && !$("dialog[open]")) {
      (document.activeElement as HTMLElement)?.blur();
      ev.preventDefault();
      void this.action("close-drawer");
      return;
    }
    if (
      (ev.target as Element).closest("input,textarea,select,[contenteditable]")
    )
      return;
    if ($("dialog[open]")) {
      if (ev.key === "Escape") this.closeModal();
      return;
    }
    const command = ev.metaKey || ev.ctrlKey;
    if (command && ev.key.toLowerCase() === "n") {
      ev.preventDefault();
      this.mapDialog();
      return;
    }
    if (!this.map) return;
    if (command && ev.key.toLowerCase() === "z") {
      ev.preventDefault();
      this.undo(ev.shiftKey);
      return;
    }
    if (command && ev.key.toLowerCase() === "y") {
      ev.preventDefault();
      this.undo(true);
      return;
    }
    if (command && ev.key.toLowerCase() === "s") {
      ev.preventDefault();
      void this.saveNow().catch((err) => this.toast(String(err), true));
      return;
    }
    if (command) return;
    if (ev.code === "Space") {
      ev.preventDefault();
      this.space = true;
    }
    if (ev.key === "Escape") {
      if (this.drag) this.cancelDrag();
      this.selected = null;
      this.connectFrom = null;
      this.tool = "select";
      this.drawer = null;
      this.focusMode = false;
      this.render();
    }
    if (ev.key === "Delete" || ev.key === "Backspace") {
      ev.preventDefault();
      void this.action("delete-selection");
    }
    const drawerKeys: Record<string, string> = {
      m: "drawer-maps",
      a: "drawer-components",
      i: "drawer-inspector",
      f: "focus",
    };
    if (drawerKeys[ev.key.toLowerCase()]) {
      ev.preventDefault();
      void this.action(drawerKeys[ev.key.toLowerCase()]);
    }
    if (ev.key.toLowerCase() === "v") void this.action("select");
    if (ev.key.toLowerCase() === "c") void this.action("connect");
    if (ev.key.toLowerCase() === "h") void this.action("pan");
    if (ev.key === "0") void this.action("fit");
    if (ev.key === "?") this.helpDialog();
    if (
      (ev.key === "Enter" || ev.key === " ") &&
      (ev.target as Element).closest("[data-node],[data-edge]")
    ) {
      ev.preventDefault();
      const target = (ev.target as Element).closest<HTMLElement>(
        "[data-node],[data-edge]",
      )!;
      this.selected = target.dataset.node ?? target.dataset.edge!;
      if (!this.focusMode) this.drawer = "inspector";
      this.render();
    }
    if (
      this.node &&
      ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(ev.key)
    ) {
      ev.preventDefault();
      const n = this.node;
      const amount = ev.shiftKey ? 0.05 : 0.01;
      this.change(() => {
        n.evolution = clamp(
          n.evolution +
            (ev.key === "ArrowRight"
              ? amount
              : ev.key === "ArrowLeft"
                ? -amount
                : 0),
        );
        n.visibility = clamp(
          n.visibility +
            (ev.key === "ArrowUp"
              ? amount
              : ev.key === "ArrowDown"
                ? -amount
                : 0),
        );
        if (n.targetEvolution !== undefined)
          n.targetEvolution = Math.max(n.evolution, n.targetEvolution);
      });
    }
  }
  modal(title: string, subtitle: string, body: string, wide = false) {
    $("#modal-root").innerHTML =
      `<dialog class="modal ${wide ? "wide" : ""}"><div class="modal-heading"><div><h2>${e(title)}</h2></div><button class="icon-button" id="modal-close" aria-label="Close dialog">${icon("close")}</button></div>${subtitle ? `<p class="modal-subtitle">${e(subtitle)}</p>` : ""}${body}<p class="modal-error" id="modal-error" role="alert"></p></dialog>`;
    const dialog = $<HTMLDialogElement>("dialog");
    dialog.showModal();
    $("#modal-close").addEventListener("click", () => this.closeModal());
    dialog.addEventListener("click", (ev) => {
      if (ev.target === dialog) {
        const rect = dialog.getBoundingClientRect();
        if (
          ev.clientX < rect.left ||
          ev.clientX > rect.right ||
          ev.clientY < rect.top ||
          ev.clientY > rect.bottom
        )
          this.closeModal();
      }
    });
    dialog.querySelectorAll<HTMLElement>("[data-modal-action]").forEach((el) =>
      el.addEventListener("click", () => {
        const action = el.dataset.modalAction!;
        this.closeModal();
        void this.action(action).catch((err) => this.toast(String(err), true));
      }),
    );
  }
  closeModal() {
    $<HTMLDialogElement>("dialog")?.close();
    $("#modal-root").innerHTML = "";
  }
  mapDialog(edit = false) {
    this.modal(
      edit ? "Edit map" : "New map",
      "",
      `<form id="map-form"><label class="field">Map name<input name="title" required maxlength="160" value="${edit ? e(this.map.title) : ""}"  autofocus/></label><label class="field">Map type<select name="kind">${this.model.mapKinds.map((k) => `<option value="${e(k.id)}" ${edit && this.map.kind === k.id ? "selected" : ""}>${e(k.label)}</option>`).join("")}</select></label><label class="field">Description<textarea name="description" rows="3" placeholder="Optional description">${edit ? e(this.map.description) : ""}</textarea></label>${edit ? "" : '<label class="check-field"><input name="anchor" type="checkbox" checked/> Add user and need</label>'}<div class="modal-actions">${edit ? '<button type="button" class="danger-text" id="delete-map">Delete map</button>' : '<button type="button" class="quiet" data-modal-action="import">Import JSON</button>'}<button class="primary" type="submit">${edit ? "Save details" : "Create map"} ${icon("arrow", 15)}</button></div></form>`,
    );
    $("#delete-map")?.addEventListener("click", () => this.confirmDelete());
    $("#map-form").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const data = new FormData(ev.target as HTMLFormElement),
        title = String(data.get("title")).trim();
      if (!title) return;
      try {
        if (edit)
          this.change(() => {
            this.map.title = title;
            this.map.kind = String(data.get("kind"));
            this.map.description = String(data.get("description"));
          });
        else {
          await this.saveNow();
          const map = createMap(title, String(data.get("kind")));
          map.description = String(data.get("description"));
          if (
            data.get("anchor") &&
            this.model.componentTypes.some((t) => t.id === "user") &&
            this.model.componentTypes.some((t) => t.id === "need")
          ) {
            const user = addNode(map, "user", "User", 0.45, 0.94);
            addNode(map, "need", "User need", 0.45, 0.75, user.id);
          }
          this.ws.maps.push(map);
          this.activeId = map.id;
          this.drawer = null;
          this.selected = null;
          this.connectFrom = null;
          this.view = { x: 0, y: 0, w: 1100, h: 760 };
          this.changed();
          this.render();
        }
        await this.saveNow();
        this.closeModal();
      } catch (err) {
        if ($("#modal-error")) $("#modal-error").textContent = String(err);
        else this.toast(String(err), true);
      }
    });
  }
  confirmDelete() {
    const id = this.activeId;
    this.modal(
      "Delete this map?",
      `“${this.map.title}” will be removed from the library. ${native ? "The JSON file will be moved to the workspace’s .trash folder for recovery." : "Export a JSON copy first if you want to keep it."}`,
      '<div class="modal-actions"><button class="quiet" id="cancel-delete">Keep map</button><button class="danger-button" id="confirm-delete">Delete map</button></div>',
    );
    $("#cancel-delete").addEventListener("click", () => this.closeModal());
    $("#confirm-delete").addEventListener("click", async () => {
      try {
        await this.saveNow();
        await this.storage.deleteMap(id);
        this.ws = this.storage.workspace;
        this.activeId = this.ws.maps[0]?.id ?? "";
        this.selected = null;
        this.dirty.delete(id);
        this.past.delete(id);
        this.future.delete(id);
        this.render();
        this.toast("Map removed from the library.");
      } catch (err) {
        $("#modal-error").textContent = String(err);
      }
    });
  }
  exportDialog() {
    this.modal(
      "Export map",
      "",
      `<div class="export-options"><button data-modal-action="export-json">${icon("json", 25)}<span><strong>Map as JSON</strong><small>Editable map data</small></span>${icon("arrow")}</button><button data-modal-action="export-svg">${icon("map", 25)}<span><strong>Map as SVG</strong><small>Vector image</small></span>${icon("arrow")}</button></div>`,
    );
  }
  workspaceDialog() {
    this.modal(
      "Workspace",
      "",
      `<div class="path-box">${icon("folder")}<code>${e(this.ws.path)}</code></div><div class="file-tree"><div>${icon("json", 15)} metamodel.json <small>Types, shapes, stages & map kinds</small></div><div>${icon("folder", 15)} maps/ <small>One JSON file per map</small></div><div>${icon("folder", 15)} .trash/ <small>Recoverable deleted maps</small></div></div>${this.dirty.size ? '<p class="conflict-note">There are unsaved changes. Export the current map before discarding them.</p>' : ""}<div class="workspace-actions">${native ? '<button class="primary" data-modal-action="choose-workspace">Open a workspace folder</button>' : '<p class="inspector-tip">Browser storage. Export to save JSON files.</p>'}<button class="quiet" data-modal-action="import">Import JSON map</button><button class="quiet" data-modal-action="reload">Reload from ${native ? "disk" : "browser storage"}</button>${this.dirty.size ? '<button class="danger-text" id="discard-reload">Discard unsaved changes and reload</button>' : ""}</div>`,
    );
    $("#discard-reload")?.addEventListener("click", () => {
      this.modal(
        "Discard unsaved changes?",
        "Changes since the last successful save will be lost. Export your current map first if you want to keep them.",
        '<div class="modal-actions"><button class="quiet" data-modal-action="workspace">Keep editing</button><button class="danger-button" data-modal-action="reload-discard">Discard and reload</button></div>',
      );
    });
  }
  metamodelDialog() {
    this.modal(
      "Metamodel",
      "Edit component types, their four stage labels, colours, shapes and map kinds. Existing maps must remain valid.",
      `<form id="model-form"><label class="field">metamodel.json<textarea id="model-json" class="code-editor" spellcheck="false" rows="22">${e(JSON.stringify(this.model, null, 2))}</textarea></label><div class="model-hint">Shapes: circle, square, diamond, hexagon, person. Type and map kind IDs must be unique lowercase slugs. Each type has exactly four stages.</div><div class="modal-actions"><button type="button" class="quiet" id="download-model">${icon("export", 15)} Export metamodel</button><button class="primary" type="submit">Validate & save</button></div></form>`,
      true,
    );
    $("#download-model").addEventListener("click", () =>
      download(
        "metamodel.json",
        $<HTMLTextAreaElement>("#model-json").value,
        "application/json",
      ),
    );
    $("#model-form").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      try {
        const model: unknown = JSON.parse(
          $<HTMLTextAreaElement>("#model-json").value,
        );
        validateMetamodel(model);
        this.ws.maps.forEach((map) => validateMap(map, model));
        await this.flushAll();
        await this.storage.saveMetamodel(model as Metamodel);
        this.render();
        this.toast("Metamodel validated and saved.");
      } catch (err) {
        $("#modal-error").textContent = String(err);
      }
    });
  }
  showWarnings() {
    this.modal(
      "Invalid map files",
      "These files were skipped and left unchanged.",
      `<ul class="warning-list">${this.ws.warnings.map((w) => `<li>${e(w)}</li>`).join("")}</ul>`,
    );
  }
  async apiDialog() {
    const info = native ? await this.storage.apiInfo() : null;
    this.modal(
      "API",
      "",
      `${info ? `<label class="field">URL<input readonly value="${e(info.url)}"/></label><label class="field">Bearer token<input type="password" readonly value="${e(info.token)}"/></label><label class="field">Connection file<input readonly value="${e(info.discoveryFile)}"/></label>` : '<p class="model-hint">HTTP is available in the native app. Browser preview: window.wardleyApi.request(method, path, body).</p>'}<div class="file-tree"><code>GET /api/v1/routes</code><code>GET /api/v1/openapi.json</code></div><button id="download-api" class="quiet">${icon("export", 15)} Export OpenAPI</button>`,
    );
    $("#download-api").addEventListener("click", async () => {
      const result = await window.wardleyApi!.request(
        "GET",
        "/api/v1/openapi.json",
      );
      download(
        "wardley-openapi.json",
        JSON.stringify(result.body, null, 2),
        "application/json",
      );
    });
  }
  helpDialog() {
    this.modal(
      "Help",
      "",
      `<div class="guide-steps"><div><b>01</b><span><strong>Visibility</strong><p>Place the user and their needs near the top. Put less visible dependencies lower down the value chain.</p></span></div><div><b>02</b><span><strong>Evolution</strong><p>Drag components left to right as they evolve. Activities, practices, data and knowledge each have their own four stage labels.</p></span></div><div><b>03</b><span><strong>Connections</strong><p>Use Connect (C), or drag the small + beneath a component to another component. Drop the + on empty space to create a connected dependency.</p></span></div><div><b>04</b><span><strong>Component settings</strong><p>Select a component to edit its type, stage, future evolution, inertia or notes.</p></span></div></div><div class="guide-note">Auto-connect links a newly added component to the selected component. Existing connections always follow when you move things.</div><div class="shortcut-grid"><span><kbd>M</kbd> Maps drawer</span><span><kbd>A</kbd> Components drawer</span><span><kbd>I</kbd> Properties drawer</span><span><kbd>F</kbd> Focus mode</span><span><kbd>Esc</kbd> Close drawer</span><span><kbd>V</kbd> Select</span><span><kbd>C</kbd> Connect</span><span><kbd>H</kbd> Pan</span><span><kbd>Space + drag</kbd> Pan</span><span><kbd>Ctrl/⌘ Z</kbd> Undo</span><span><kbd>0</kbd> Fit map</span><span><kbd>Scroll</kbd> Zoom</span><span><kbd>Arrows</kbd> Move selected</span></div><div class="guide-credit">Wardley Mapping by Simon Wardley, CC BY-SA 4.0. <a href="https://learnwardleymapping.com/landscape/" target="_blank" rel="noopener">Mapping reference ↗</a></div>`,
      true,
    );
  }
  toast(message: string, error = false) {
    const toast = $("#toast");
    toast.innerHTML = `${icon(error ? "help" : "check", 17)}<span>${e(message)}</span>`;
    toast.className = `visible ${error ? "error" : ""}`;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(
      () => {
        toast.className = "";
      },
      error ? 11000 : 3500,
    );
  }
}

void new Studio().start();
