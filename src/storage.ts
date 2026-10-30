import seedModel from "../examples/metamodel.json";
import coffee from "../examples/maps/coffee-shop.json";
import future from "../examples/maps/platform-future.json";
import practices from "../examples/maps/working-practices.json";
import type { Metamodel, WardleyMap, Workspace } from "./types.ts";
import { validateMap, validateMetamodel } from "./model.ts";

export const native = !!window.__TAURI__;
const key = "wardley-studio-preview-v1";
const invoke = <T>(command: string, args?: Record<string, unknown>) =>
  window.__TAURI__!.core.invoke<T>(command, args);
const seed = () =>
  structuredClone({
    path: "Browser preview · export JSON to keep files",
    metamodel: seedModel,
    maps: [coffee, future, practices],
    warnings: [],
  }) as Workspace;

export class Storage {
  workspace!: Workspace;
  private revisions: Record<string, string> = {};
  private modelRevision = "";
  async load(): Promise<Workspace> {
    if (native) {
      const result = await invoke<
        Workspace & {
          revisions: Record<string, string>;
          metamodelRevision: string;
        }
      >("load_workspace");
      this.revisions = result.revisions;
      this.modelRevision = result.metamodelRevision;
      this.workspace = result;
    } else {
      const raw = localStorage.getItem(key);
      this.workspace = raw ? JSON.parse(raw) : seed();
    }
    if (!native) {
      let migrated = false;
      for (const type of this.workspace.metamodel.componentTypes) {
        if (
          ["user", "need", "activity"].includes(type.id) &&
          JSON.stringify(type.stageLabels) ===
            JSON.stringify(["Genesis", "Custom built", "Product", "Commodity"])
        ) {
          type.stageLabels = [
            "Genesis",
            "Custom built",
            "Product (+ rental)",
            "Commodity (+ utility)",
          ];
          migrated = true;
        }
      }
      if (migrated) this.persistPreview();
    }
    validateMetamodel(this.workspace.metamodel);
    this.workspace.maps.forEach((m) =>
      validateMap(m, this.workspace.metamodel),
    );
    return this.workspace;
  }
  private persistPreview() {
    localStorage.setItem(key, JSON.stringify(this.workspace));
  }
  async saveMap(map: WardleyMap) {
    validateMap(map, this.workspace.metamodel);
    if (native)
      this.revisions[map.id] = await invoke<string>("save_map", {
        map,
        expectedRevision: this.revisions[map.id] ?? null,
      });
    else this.persistPreview();
  }
  async deleteMap(id: string) {
    if (native)
      await invoke("delete_map", {
        id,
        expectedRevision: this.revisions[id] ?? null,
      });
    this.workspace.maps = this.workspace.maps.filter((m) => m.id !== id);
    delete this.revisions[id];
    if (!native) this.persistPreview();
  }
  async saveMetamodel(metamodel: Metamodel) {
    validateMetamodel(metamodel);
    this.workspace.maps.forEach((m) => validateMap(m, metamodel));
    if (native)
      this.modelRevision = await invoke<string>("save_metamodel", {
        metamodel,
        expectedRevision: this.modelRevision,
      });
    this.workspace.metamodel = metamodel;
    if (!native) this.persistPreview();
  }
  async apiInfo() {
    return invoke<{
      url: string;
      token: string;
      discoveryFile: string;
      pid: number;
    }>("api_info");
  }
  async setWorkspace(path: string) {
    await invoke("set_workspace", { path });
  }
  async chooseWorkspace(): Promise<boolean> {
    return native && (await invoke<boolean>("choose_workspace"));
  }
  async importMap(): Promise<WardleyMap | null> {
    let value: unknown;
    if (native) value = await invoke<unknown>("import_map");
    else
      value = await new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json,application/json";
        input.addEventListener("change", async () => {
          try {
            resolve(
              input.files?.[0] ? JSON.parse(await input.files[0].text()) : null,
            );
          } catch {
            resolve({ error: "Invalid JSON file." });
          }
        });
        input.addEventListener("cancel", () => resolve(null));
        input.click();
      });
    if (value === null) return null;
    validateMap(value, this.workspace.metamodel);
    return value;
  }
  async exportMap(map: WardleyMap) {
    if (native) return invoke<boolean>("export_map", { map });
    download(
      `${map.title.replace(/[^a-z0-9 -]/gi, "").trim() || "map"}.json`,
      JSON.stringify(map, null, 2),
      "application/json",
    );
    return true;
  }
}
export function download(filename: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
