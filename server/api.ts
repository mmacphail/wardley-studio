import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual } from "node:crypto";
import { Resvg } from "@resvg/resvg-js";
import {
  addNode,
  connect,
  createMap,
  removeNode,
  uid,
  validateMap,
  validateMetamodel,
} from "../src/model.ts";
import { describeMap } from "../src/map-model.ts";
import { exportSvg, graphContent, point, PLOT } from "../src/canvas.ts";
import type { MapNode } from "../src/types.ts";
import { JsonStore, HttpError, fail, MAX_BYTES } from "./store.ts";

export const routes = [
  ["GET", "/api/v1/routes"],
  ["GET", "/api/v1/features"],
  ["GET", "/api/v1/workspace/export"],
  ["GET", "/api/v1/metamodel"],
  ["PUT", "/api/v1/metamodel"],
  ["POST", "/api/v1/metamodel/validate"],
  ["GET", "/api/v1/maps"],
  ["POST", "/api/v1/maps"],
  ["POST", "/api/v1/maps/import"],
  ["GET", "/api/v1/maps/:id"],
  ["PATCH", "/api/v1/maps/:id"],
  ["PUT", "/api/v1/maps/:id"],
  ["DELETE", "/api/v1/maps/:id"],
  ["POST", "/api/v1/maps/:id/duplicate"],
  ["GET", "/api/v1/maps/:id/model"],
  ["GET", "/api/v1/maps/:id/export/json"],
  ["GET", "/api/v1/maps/:id/export/svg"],
  ["GET", "/api/v1/maps/:id/snapshot"],
  ["GET", "/api/v1/maps/:id/snapshot.png"],
  ...["components", "links"].flatMap((name) => [
    ["GET", `/api/v1/maps/:id/${name}`],
    ["POST", `/api/v1/maps/:id/${name}`],
    ["GET", `/api/v1/maps/:id/${name}/:itemId`],
    ["PATCH", `/api/v1/maps/:id/${name}/:itemId`],
    ["DELETE", `/api/v1/maps/:id/${name}/:itemId`],
  ]),
];
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(422, "invalid_body", "Expected a JSON object.");
  return value as Record<string, any>;
}
function validate(action: () => void) {
  try {
    action();
  } catch (error) {
    fail(422, "invalid_data", (error as Error).message);
  }
}
function patchNode(node: MapNode, body: Record<string, any>) {
  for (const key of [
    "label",
    "type",
    "evolution",
    "visibility",
    "notes",
    "targetEvolution",
    "inertia",
  ] as const) {
    if (key in body) (node as any)[key] = body[key];
  }
  if (body.targetEvolution === null) delete node.targetEvolution;
  if ("stage" in body) {
    if (
      "evolution" in body ||
      !Number.isInteger(body.stage) ||
      body.stage < 0 ||
      body.stage > 3
    )
      fail(422, "invalid_stage", "Use stage 0–3 or evolution 0–1, not both.");
    node.evolution = (body.stage + 0.5) / 4;
  }
  if (node.targetEvolution !== undefined && !("targetEvolution" in body))
    node.targetEvolution = Math.max(node.evolution, node.targetEvolution);
}
async function bodyOf(req: IncomingMessage) {
  if (!/^[a-z]+\/json(?:;|$)/i.test(req.headers["content-type"] ?? ""))
    fail(415, "content_type", "Use Content-Type: application/json.");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BYTES) fail(413, "too_large", "JSON exceeds 8 MiB.");
    chunks.push(chunk);
  }
  try {
    return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fail(400, "invalid_json", "Invalid JSON.");
  }
}
function send(
  res: ServerResponse,
  status: number,
  value: unknown,
  revision?: string,
  mime = "application/json",
) {
  res.writeHead(status, {
    "Content-Type": mime,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...(revision ? { ETag: revision } : {}),
  });
  res.end(mime === "application/json" ? JSON.stringify(value) : value);
}
export async function createApi(root: string, token: string) {
  if (token.length < 32)
    throw new Error("WARDLEY_API_TOKEN must contain at least 32 characters.");
  const store = new JsonStore(root);
  await store.init();
  let queue: Promise<unknown> = Promise.resolve();
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        send(res, 200, { ok: true });
        return;
      }
      const supplied = Buffer.from(req.headers.authorization ?? "");
      const expected = Buffer.from(`Bearer ${token}`);
      if (
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      ) {
        res.setHeader("WWW-Authenticate", "Bearer");
        fail(401, "unauthorized", "A bearer token is required.");
      }
      if (req.headers.origin)
        fail(
          403,
          "origin_denied",
          "Browser origins are not enabled for this API.",
        );
      const method = req.method!;
      let path: string[];
      try {
        path = new URL(req.url!, "http://localhost").pathname
          .split("/")
          .filter(Boolean)
          .map(decodeURIComponent);
      } catch {
        fail(400, "invalid_path", "Invalid URL.");
      }
      if (path[0] !== "api" || path[1] !== "v1")
        fail(404, "not_found", "Route not found.");
      const p = path.slice(2);
      const matched = routes.some(
        ([verb, route]) =>
          verb === method &&
          route.split("/").filter(Boolean).length === path.length &&
          route
            .split("/")
            .filter(Boolean)
            .every((part, i) => part.startsWith(":") || part === path[i]),
      );
      if (!matched)
        fail(
          404,
          "not_found",
          "Route not found. GET /api/v1/routes lists available endpoints.",
        );
      const b = ["POST", "PATCH", "PUT"].includes(method)
        ? await bodyOf(req)
        : {};
      // Serialize reads and writes together: revision checks and mutations form one transaction.
      const operation = queue.then(async () => {
        if (p[0] === "routes")
          return send(
            res,
            200,
            routes.map(([method, path]) => ({ method, path })),
          );
        if (p[0] === "features")
          return send(res, 200, {
            chat: false,
            chatCompiled: false,
            headless: true,
            snapshots: true,
            optimisticConcurrency: true,
          });
        const model = await store.model();
        if (p[0] === "workspace")
          return send(res, 200, {
            schemaVersion: 1,
            exportedAt: new Date().toISOString(),
            metamodel: model.value,
            maps: await store.list(),
          });
        if (p[0] === "metamodel") {
          if (method === "GET")
            return send(res, 200, model.value, model.revision);
          validate(() => validateMetamodel(b));
          for (const map of await store.list())
            validate(() => validateMap(map, b as any));
          if (p[1] === "validate") return send(res, 200, { valid: true });
          store.checkRevision(req.headers["if-match"], model.revision);
          return send(res, 200, b, await store.saveModel(b as any));
        }
        if (p.length === 1 && method === "GET")
          return send(res, 200, await store.list());
        if ((p.length === 1 || p[1] === "import") && method === "POST") {
          let map;
          if (p[1] === "import") {
            validate(() => validateMap(b, model.value));
            map = {
              ...b,
              id: uid(),
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            } as any;
          } else {
            map = createMap(b.title, b.kind ?? model.value.mapKinds[0].id);
            map.description = b.description ?? "";
          }
          validate(() => validateMap(map, model.value));
          return send(res, 201, map, await store.insert(map));
        }
        const existing = await store.map(p[1]);
        let map = existing.value;
        const section = p[2];
        if (method === "GET") {
          if (!section || (section === "export" && p[3] === "json"))
            return send(res, 200, map, existing.revision);
          if (section === "model")
            return send(
              res,
              200,
              describeMap(map, model.value),
              existing.revision,
            );
          if (section === "export")
            return send(
              res,
              200,
              exportSvg(map, model.value, true),
              existing.revision,
              "image/svg+xml",
            );
          if (section === "snapshot" || section === "snapshot.png") {
            const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1650" height="1140" viewBox="0 0 1100 760">${graphContent(map, model.value, null, null, true)}</svg>`;
            const png = new Resvg(svg, {
              background: "#fdfcf9",
              font: {
                defaultFontFamily: "DejaVu Sans",
                sansSerifFamily: "DejaVu Sans",
              },
            })
              .render()
              .asPng();
            if (section === "snapshot.png")
              return send(res, 200, png, existing.revision, "image/png");
            return send(
              res,
              200,
              {
                mapId: map.id,
                title: map.title,
                updatedAt: map.updatedAt,
                capturedAt: new Date().toISOString(),
                mimeType: "image/png",
                width: 1650,
                height: 1140,
                scope: "full-map",
                labels: true,
                viewBox: { x: 0, y: 0, width: 1100, height: 760 },
                plot: {
                  x: PLOT.x * 1.5,
                  y: PLOT.y * 1.5,
                  width: PLOT.w * 1.5,
                  height: PLOT.h * 1.5,
                },
                components: map.nodes.map((n) => {
                  const pt = point(n.evolution, n.visibility);
                  return {
                    id: n.id,
                    label: n.label,
                    x: pt.x * 1.5,
                    y: pt.y * 1.5,
                  };
                }),
                dataUrl: `data:image/png;base64,${png.toString("base64")}`,
              },
              existing.revision,
            );
          }
          const items =
            section === "components"
              ? describeMap(map, model.value).components
              : map.edges;
          const result = p[3] ? items.find((item) => item.id === p[3]) : items;
          if (!result)
            fail(404, "item_not_found", "Component or link not found.");
          return send(res, 200, result, existing.revision);
        }
        if (section === "duplicate") {
          map.id = uid();
          map.title = b.title ?? `${map.title} (copy)`;
          map.createdAt = map.updatedAt = new Date().toISOString();
          validate(() => validateMap(map, model.value));
          return send(res, 201, map, await store.insert(map));
        }
        store.checkRevision(req.headers["if-match"], existing.revision);
        if (!section && method === "DELETE") {
          await store.remove(map.id);
          return send(res, 200, { deleted: map.id });
        }
        let result: unknown;
        if (!section) {
          if (method === "PUT") {
            if (b.id !== map.id)
              fail(422, "invalid_id", "The map ID cannot change.");
            map = { ...b, createdAt: map.createdAt } as any;
          } else
            for (const key of ["title", "description", "kind"] as const)
              if (key in b) map[key] = b[key];
          result = map;
        } else if (section === "components") {
          if (method === "POST") {
            if (
              b.parent !== undefined &&
              !map.nodes.some((n) => n.id === b.parent)
            )
              fail(422, "invalid_parent", "Parent component not found.");
            const node = addNode(map, b.type, b.label, 0.5, 0.5, b.parent);
            patchNode(node, b);
            result = node;
          } else {
            const node = map.nodes.find((n) => n.id === p[3]);
            if (!node) fail(404, "item_not_found", "Component not found.");
            if (method === "DELETE") {
              removeNode(map, node.id);
              result = { deleted: node.id };
            } else {
              patchNode(node, b);
              result = node;
            }
          }
        } else {
          if (method === "POST") {
            if (!connect(map, b.source, b.target, b.kind ?? "dependency"))
              fail(422, "invalid_link", "Invalid or duplicate link.");
            const edge = map.edges.at(-1)!;
            edge.label = b.label ?? "";
            result = edge;
          } else {
            const edge = map.edges.find((e) => e.id === p[3]);
            if (!edge) fail(404, "item_not_found", "Link not found.");
            if (method === "DELETE") {
              map.edges = map.edges.filter((e) => e.id !== edge.id);
              result = { deleted: edge.id };
            } else {
              for (const key of ["source", "target", "kind", "label"] as const)
                if (key in b) edge[key] = b[key];
              result = edge;
            }
          }
        }
        map.updatedAt = new Date().toISOString();
        validate(() => validateMap(map, model.value));
        send(
          res,
          method === "POST" ? 201 : 200,
          result,
          await store.saveMap(map),
        );
      });
      queue = operation.catch(() => {});
      await operation;
    } catch (error) {
      const known = error instanceof HttpError;
      if (!known)
        console.error("API operation failed:", (error as Error).message);
      if (!res.headersSent)
        send(res, known ? error.status : 500, {
          error: {
            code: known ? error.code : "internal_error",
            message: known ? error.message : "Internal server error.",
          },
        });
      else res.end();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.timeout = 30_000;
  return { server, store };
}
