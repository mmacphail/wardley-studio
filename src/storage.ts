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

export interface ConnectionInfo {
  mode: "local" | "remote";
  url?: string | null;
  credentialStorage?: string;
}
type RemoteReply = { status: number; body: any; revision?: string };
export class Storage {
  connection: ConnectionInfo = { mode: "local" };
  get remote() {
    return this.connection.mode === "remote";
  }
  async connectionInfo() {
    return (this.connection = native
      ? await invoke<ConnectionInfo>("connection_info")
      : { mode: "local" });
  }
  async connect(mode: "local" | "remote", url?: string, token?: string) {
    if (!native) throw new Error("Remote connections require the desktop app.");
    await invoke("connection_set", {
      mode,
      url: url ?? null,
      token: token ?? null,
    });
    await this.connectionInfo();
  }
  private async remoteCall(
    method: string,
    path: string,
    body?: unknown,
    revision?: string,
  ): Promise<RemoteReply> {
    const response = await invoke<RemoteReply>("remote_request", {
      method,
      path: `/api/v1${path}`,
      body: body ?? null,
      revision: revision ?? null,
    });
    if (response.status >= 400) {
      if (response.status === 412 || response.status === 428)
        throw new Error(
          "This map changed on the server. Export your unsaved edits, then reload before saving again.",
        );
      if (response.status === 401)
        throw new Error(
          "Server authentication failed. Reconnect with a valid token.",
        );
      throw new Error(
        response.body?.error?.message ??
          `Server request failed (${response.status}).`,
      );
    }
    return response;
  }
  private loadedConnection = "";
  private connectionKey() {
    return this.remote ? this.connection.url! : "local";
  }
  private assertWorkspaceConnection() {
    if (this.loadedConnection !== this.connectionKey())
      throw new Error(
        "The connection changed. Reload the workspace before editing.",
      );
  }
  workspace!: Workspace;
  private revisions: Record<string, string> = {};
  private modelRevision = "";
  async load(): Promise<Workspace> {
    await this.connectionInfo();
    if (this.remote) {
      const { body } = await this.remoteCall("GET", "/workspace/export");
      validateMetamodel(body.metamodel);
      body.maps.forEach((map: WardleyMap) => validateMap(map, body.metamodel));
      if (!body.revisions || typeof body.metamodelRevision !== "string")
        throw new Error(
          "Update the remote server to support workspace revisions.",
        );
      this.revisions = body.revisions;
      this.modelRevision = body.metamodelRevision;
      this.workspace = {
        path: this.connection.url!,
        metamodel: body.metamodel,
        maps: body.maps,
        warnings: [],
      };
    } else if (native) {
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
    this.loadedConnection = this.connectionKey();
    return this.workspace;
  }
  private persistPreview() {
    localStorage.setItem(key, JSON.stringify(this.workspace));
  }
  async saveMap(map: WardleyMap) {
    this.assertWorkspaceConnection();
    validateMap(map, this.workspace.metamodel);
    if (this.remote) {
      const revision = this.revisions[map.id];
      const response = revision
        ? await this.remoteCall(
            "PUT",
            `/maps/${encodeURIComponent(map.id)}`,
            map,
            revision,
          )
        : await this.remoteCall("POST", "/maps/import", {
            map,
            preserveId: true,
          });
      if (!response.revision)
        throw new Error("Server did not return a map revision.");
      this.revisions[map.id] = response.revision;
    } else if (native)
      this.revisions[map.id] = await invoke<string>("save_map", {
        map,
        expectedRevision: this.revisions[map.id] ?? null,
      });
    else this.persistPreview();
  }
  async deleteMap(id: string) {
    this.assertWorkspaceConnection();
    if (this.remote)
      await this.remoteCall(
        "DELETE",
        `/maps/${encodeURIComponent(id)}`,
        undefined,
        this.revisions[id],
      );
    else if (native)
      await invoke("delete_map", {
        id,
        expectedRevision: this.revisions[id] ?? null,
      });
    this.workspace.maps = this.workspace.maps.filter((m) => m.id !== id);
    delete this.revisions[id];
    if (!native) this.persistPreview();
  }
  async saveMetamodel(metamodel: Metamodel) {
    this.assertWorkspaceConnection();
    validateMetamodel(metamodel);
    this.workspace.maps.forEach((m) => validateMap(m, metamodel));
    if (this.remote) {
      const response = await this.remoteCall(
        "PUT",
        "/metamodel",
        metamodel,
        this.modelRevision,
      );
      if (!response.revision)
        throw new Error("Server did not return a metamodel revision.");
      this.modelRevision = response.revision;
    } else if (native)
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
    await this.connect("local");
  }
  async chooseWorkspace(): Promise<boolean> {
    const chosen = native && (await invoke<boolean>("choose_workspace"));
    if (chosen) await this.connect("local");
    return chosen;
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
