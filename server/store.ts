import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  lstat,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { validateMap, validateMetamodel } from "../src/model.ts";
import type { Metamodel, WardleyMap } from "../src/types.ts";

export const MAX_BYTES = 8 * 1024 * 1024;
export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export function fail(status: number, code: string, message: string): never {
  throw new HttpError(status, code, message);
}
export const etag = (raw: string | Buffer) =>
  `"${createHash("sha256").update(raw).digest("hex")}"`;

/** One process owns one workspace. HTTP mutations are serialized by the server. */
export class JsonStore {
  root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  mapPath(id: string) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id))
      fail(422, "invalid_id", "Invalid map ID.");
    return join(this.root, "maps", `${id}.json`);
  }
  async init() {
    for (const path of [
      this.root,
      join(this.root, "maps"),
      join(this.root, ".trash"),
    ]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("Workspace directories must not be symlinks.");
    }
    try {
      await this.model();
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
      const seed = JSON.parse(
        await readFile(
          new URL("../examples/metamodel.json", import.meta.url),
          "utf8",
        ),
      );
      await this.write(join(this.root, "metamodel.json"), seed);
    }
    await this.list(); // Fail startup rather than silently omit corrupt data.
  }
  async read(path: string) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES)
      throw new Error("Invalid workspace file.");
    const raw = await readFile(path, "utf8");
    return { value: JSON.parse(raw), revision: etag(raw) };
  }
  async write(path: string, value: unknown) {
    const raw = JSON.stringify(value, null, 2) + "\n";
    if (Buffer.byteLength(raw) > MAX_BYTES)
      fail(413, "too_large", "JSON exceeds 8 MiB.");
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temp, "wx", 0o600);
      try {
        await file.writeFile(raw);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temp, path);
      const directory = await open(resolve(path, ".."), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      return etag(raw);
    } finally {
      await unlink(temp).catch(() => {});
    }
  }
  async model(): Promise<{ value: Metamodel; revision: string }> {
    const result = await this.read(join(this.root, "metamodel.json"));
    validateMetamodel(result.value);
    return result;
  }
  async map(id: string): Promise<{ value: WardleyMap; revision: string }> {
    try {
      const result = await this.read(this.mapPath(id));
      validateMap(result.value, (await this.model()).value);
      if (result.value.id !== id)
        throw new Error("Map filename and ID disagree.");
      return result;
    } catch (error: any) {
      if (error.code === "ENOENT") fail(404, "map_not_found", "Map not found.");
      throw error;
    }
  }
  async list() {
    const maps = [];
    for (const name of (await readdir(join(this.root, "maps"))).sort()) {
      if (name.endsWith(".json"))
        maps.push((await this.map(name.slice(0, -5))).value);
    }
    return maps;
  }
  checkRevision(expected: string | undefined, current: string) {
    if (!expected)
      fail(
        428,
        "precondition_required",
        "Send If-Match with the ETag from the latest map or metamodel read.",
      );
    if (expected !== current)
      fail(
        412,
        "revision_conflict",
        "Data changed. Read it again before retrying.",
      );
  }
  async saveMap(value: WardleyMap) {
    validateMap(value, (await this.model()).value);
    return this.write(this.mapPath(value.id), value);
  }
  async insert(value: WardleyMap) {
    try {
      await lstat(this.mapPath(value.id));
      fail(409, "duplicate_id", "A map with this ID already exists.");
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
    return this.saveMap(value);
  }
  async saveModel(value: Metamodel) {
    validateMetamodel(value);
    for (const map of await this.list()) validateMap(map, value);
    return this.write(join(this.root, "metamodel.json"), value);
  }
  async remove(id: string) {
    await rename(
      this.mapPath(id),
      join(this.root, ".trash", `${id}-${randomUUID()}.json`),
    );
  }
}
