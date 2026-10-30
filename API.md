# Wardley Studio API

The native app starts a local HTTP API. It controls the **running editor**, including its selection, drawers, view, undo history and JSON files. The app must be open. Programmatic edits appear immediately in the UI and finish saving before a successful response. No file picker or confirmation dialog is needed for data routes.

Open **Maps → API** for the URL and connection file. On Linux, the default file is `~/.config/studio.wardley.desktop/api.json` (`$XDG_CONFIG_HOME` is respected). It contains `url`, `token`, `pid` and `discoveryFile`. The token changes each launch; the file is owner-readable/writable on Unix. The default listener is `127.0.0.1:14280`, falling back to a free port if occupied. Set `WARDLEY_API_PORT` to an explicit port (`0` selects a free port), or `WARDLEY_API_INFO` to a different absolute connection-file path.

Every request requires `Authorization: Bearer <token>`. Requests with bodies also require `Content-Type: application/json`. Use the exact loopback URL from the connection file. Browser origins are rejected; no CORS access is granted. Requests and responses are local. The HTTP body limit is 8 MiB.

## Quick start

The bundled Python client reads the connection file and adds authentication:

```sh
python scripts/wardley-api.py GET /state
python scripts/wardley-api.py GET /routes
python scripts/wardley-api.py POST /maps '{"title":"Strategy","kind":"landscape","anchor":false}'
```

Use the returned map `id`:

```sh
python scripts/wardley-api.py POST /maps/MAP_ID/components \
  '{"type":"activity","label":"Payments","stage":2,"visibility":0.7,"autoConnect":false}'
python scripts/wardley-api.py POST /maps/MAP_ID/components \
  '{"type":"data","label":"Transactions","evolution":0.8,"visibility":0.4,"parentId":"COMPONENT_ID"}'
python scripts/wardley-api.py PATCH /maps/MAP_ID/components/COMPONENT_ID \
  '{"notes":"Review options","inertia":true,"targetEvolution":0.9}'
python scripts/wardley-api.py POST /maps/MAP_ID/undo
python scripts/wardley-api.py GET /maps/MAP_ID/export/svg -o map.svg
python scripts/wardley-api.py GET /maps/MAP_ID/export/json -o map.json
python scripts/wardley-api.py POST /maps/import @map.json
python scripts/wardley-api.py GET /openapi.json -o wardley-openapi.json
```

`--info /path/api.json` selects another instance. `-` reads request JSON from stdin. The client exits nonzero on HTTP errors. It works with Python's standard library; no packages are needed.

For curl:

```sh
WARDLEY_INFO="$HOME/.config/studio.wardley.desktop/api.json"
WARDLEY_URL=$(jq -r .url "$WARDLEY_INFO")
WARDLEY_TOKEN=$(jq -r .token "$WARDLEY_INFO")
curl --noproxy '*' -H "Authorization: Bearer $WARDLEY_TOKEN" \
  "$WARDLEY_URL/api/v1/maps"
curl --noproxy '*' -X PATCH -H "Authorization: Bearer $WARDLEY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"focusMode":true}' "$WARDLEY_URL/api/v1/ui"
```

## Routes

All paths below begin with `/api/v1`. `GET /routes` lists every concrete route with descriptions and input examples. `GET /openapi.json` returns an OpenAPI 3.1 document. The native API dialog also exports this document.

| Method                     | Path                                   | Body / result                                                                                |
| -------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------- |
| GET                        | `/health`                              | Readiness and API version                                                                    |
| GET                        | `/routes`, `/openapi.json`             | Route catalog / OpenAPI                                                                      |
| GET                        | `/state`                               | Active map, selection, tool, drawers, focus, view, save status, history counts, dialog title |
| GET                        | `/api`                                 | URL, discovery-file path and PID; no token in HTTP responses                                 |
| GET                        | `/help`                                | Shortcuts and editing instructions                                                           |
| GET                        | `/workspace`                           | Workspace path, complete maps, metamodel and warnings                                        |
| PUT                        | `/workspace`                           | `{"path":"/absolute/folder"}`; open or initialize a JSON workspace                           |
| POST                       | `/workspace/save`                      | Save all edits, including the focused component text field                                   |
| POST                       | `/workspace/reload`                    | `{"discard":false}`; save then reload, or discard unsaved edits when true                    |
| GET / PUT                  | `/metamodel`                           | Read / validate and replace the complete metamodel JSON                                      |
| POST                       | `/metamodel/validate`                  | Complete metamodel JSON; validate without saving                                             |
| GET                        | `/metamodel/export`                    | Complete metamodel JSON                                                                      |
| GET / POST                 | `/maps`                                | List / create maps                                                                           |
| POST                       | `/maps/import`                         | Complete map JSON; import under a fresh ID                                                   |
| GET / PATCH / PUT / DELETE | `/maps/:id`                            | Read / edit metadata / replace complete map / delete                                         |
| POST                       | `/maps/:id/activate`                   | Switch the visible map                                                                       |
| POST                       | `/maps/:id/duplicate`                  | Optional `{"title":"Copy"}`; returns the new map                                             |
| POST                       | `/maps/:id/undo`, `/maps/:id/redo`     | Switch to the map and undo / redo one edit                                                   |
| GET                        | `/maps/:id/export/json`                | Complete map JSON                                                                            |
| GET                        | `/maps/:id/export/svg`                 | Standalone SVG, `image/svg+xml`                                                              |
| GET / POST                 | `/maps/:id/components`                 | List / add components                                                                        |
| GET / PATCH / DELETE       | `/maps/:id/components/:node`           | Read / edit / delete a component and its attached connections                                |
| POST                       | `/maps/:id/components/:node/duplicate` | Optional `{"label":"Copy"}`                                                                  |
| GET / POST                 | `/maps/:id/connections`                | List / create connections                                                                    |
| GET / PATCH / DELETE       | `/maps/:id/connections/:edge`          | Read / edit / delete a connection                                                            |
| PATCH                      | `/ui`                                  | Set editor controls; see fields below                                                        |
| PUT                        | `/ui/view`                             | `{"x":0,"y":0,"width":1100}`; pan and zoom                                                   |
| POST                       | `/ui/dialog/:name`                     | Open `new`, `details`, `export`, `workspace`, `metamodel`, `help` or `api`                   |
| POST                       | `/ui/dialog/close`                     | Close a dialog, discarding its unapplied draft                                               |

Creation accepts `title` (required), `kind` (defaults to the first map kind), `description` (defaults to empty) and `anchor` (defaults to true, adds connected user/need components). Map PATCH accepts `title`, `description`, `kind`. PUT requires a valid complete map whose ID matches the URL. Imports and duplicates get new map IDs and timestamps; imported component/connection IDs are preserved within the new map. Native map deletion moves the file into `.trash`.

Component POST/PATCH accepts `label`, `type`, `evolution`, `visibility`, `notes`, `inertia`, `targetEvolution`, and `stage`. POST defaults type to the map axis type, label to its component type, and position near the parent/selection. `evolution` and `visibility` are numbers from 0 to 1. `stage` is an integer **0–3** and places the component at that stage's midpoint; do not send stage and evolution together. `targetEvolution` must be between the current evolution and 1; send null to remove the future arrow. Moving an existing component past its current target moves the target along with it unless a target is explicitly supplied.

Component POST additionally accepts `parentId` and `autoConnect`. An explicit parent creates a dependency from that parent to the new component. Without a parent, auto-connect uses the selected component only when editing the active map. It defaults to the UI's Auto-connect setting; use false for deterministic independent additions.

Connection POST requires `source` and `target`; `kind` defaults to `dependency` (or use `evolution`) and `label` defaults to empty. PATCH accepts all four fields. Self-links, dangling endpoints and duplicate source/target/kind combinations are rejected. Moving a component updates connected lines automatically.

`PATCH /ui` accepts any combination of:

- `selectedId`: component/connection ID in the active map, or null to clear.
- `tool`: `select`, `connect`, `pan`.
- `autoConnect`, `labels`, `focusMode`: booleans.
- `drawer`: `maps`, `components`, `inspector`, or null.
- `search`: map-library search text.

View width ranges from 300 to 2200 logical units; height follows the map ratio. The initial view is `{x:0,y:0,width:1100}`. Component positions remain normalized regardless of zoom. Full map replacements and API component/connection changes are undoable. Metamodel edits and map creation/deletion use the same history boundaries as the UI.

## Read the current graph model

`GET /current-map` returns the visible map's complete editable JSON (`nodes`, `edges` and metadata). `GET /current-map/components` and `GET /current-map/connections` return just those arrays.

`GET /current-map/model` returns a resolved snapshot:

- `map`: complete map JSON, including metadata, nodes and edges.
- `components`: all component fields, plus `typeDefinition`, `stage: {index, label}`, `incomingLinkIds`, and `outgoingLinkIds`.
- `links`: connections with `id`, `source`, `target`, `kind` and `label`.
- `metamodel`: complete component types, stage labels and map kinds.
- `kind`: the map-kind definition; `axes`: coordinate ranges and evolution-axis stage labels.
- `active` and `hasUnsavedChanges`: whether this map is currently visible and has pending edits.

`GET /maps/:id/model` returns the same snapshot for any map without switching the visible map. Stage indices are 0–3 and are resolved from each component's evolution coordinate using its own type's labels. Link endpoints reference component IDs. A current-map request returns 404 if no map exists.

```sh
python scripts/wardley-api.py GET /current-map/model -o current-model.json
python scripts/wardley-api.py GET /maps/coffee-shop/model
```

## Menu action routes

Every menu/toolbar action has a **POST `/actions/<name>`** route. These target the active map or selection. Actions that normally show forms or pickers accept their data directly; explicit `/ui/dialog/...` routes are available when opening the dialog itself is wanted.

| Action names                                           | Behavior / body                                                        |
| ------------------------------------------------------ | ---------------------------------------------------------------------- |
| `new`                                                  | Create a map; same body as POST `/maps`                                |
| `details`                                              | Edit active map; same body as map PATCH                                |
| `duplicate`, `delete-map`                              | Duplicate / delete active map                                          |
| `import`                                               | Import complete map JSON                                               |
| `export`, `export-json`, `export-svg`                  | Return JSON / SVG directly, without a save dialog                      |
| `workspace`, `choose-workspace`                        | Read workspace / open `{"path":"/absolute/folder"}`                    |
| `reload`, `reload-discard`, `save`                     | Reload after saving / discard and reload / save all                    |
| `metamodel`, `save-metamodel`, `export-metamodel`      | Read / replace / export metamodel                                      |
| `help`, `api`, `export-openapi`                        | Return help / API metadata / OpenAPI                                   |
| `undo`, `redo`                                         | Active map history                                                     |
| `select`, `connect`, `pan`                             | Choose tool                                                            |
| `connect-selected`                                     | Begin connecting from the selected component                           |
| `clone-node`, `delete-selection`, `deselect`           | Duplicate component / delete component or connection / clear selection |
| `zoom-in`, `zoom-out`, `fit`                           | View navigation                                                        |
| `drawer-maps`, `drawer-components`, `drawer-inspector` | Toggle the corresponding drawer                                        |
| `close-drawer`, `focus`, `close-dialog`                | Close drawer / toggle focus / dismiss dialog                           |

Map-library items use `/maps/:id/activate`. Palette items use POST `/maps/:id/components`. Stage buttons, component settings and connection fields use their PATCH routes. Checkboxes and search use PATCH `/ui`. Metamodel validation and its save/export buttons are covered above. Use data routes to submit dialog values without interacting with forms.

## Chat routes

Subscription chat is exposed programmatically as well. The native app uses the installed Codex CLI and its ChatGPT authentication. A model turn runs asynchronously after `/chat/messages` returns; read `/chat` for streamed messages, tool actions, completion, and errors.

| Method | Path                 | Behavior                                                                                                                        |
| ------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/chat`              | Read sidebar state, available models, selected model, account summary, conversation, turn IDs and error                         |
| POST   | `/chat/connect`      | Start/connect to Codex and read the subscription account and model catalog                                                      |
| POST   | `/chat/login`        | Start a ChatGPT device-code sign-in; the sidebar displays its code                                                              |
| POST   | `/chat/login/open`   | Open the pending verification URL in the browser                                                                                |
| POST   | `/chat/login/cancel` | Cancel pending sign-in                                                                                                          |
| POST   | `/chat/messages`     | `{"text":"Add an activity for payments and connect it to the user need"}`                                                       |
| POST   | `/chat/stop`         | Interrupt generation and cancel queued model tool actions                                                                       |
| POST   | `/chat/reset`        | Start a new conversation while idle                                                                                             |
| PATCH  | `/chat`              | Set `open` (boolean), `allowEdits` (boolean), `webSearch` (boolean, while idle), or `model` (an available model ID, while idle) |
| POST   | `/actions/chat`      | Toggle the sidebar                                                                                                              |

`webSearch` defaults to `true` and is persisted in chat history. Changes apply on the next reply, resuming the existing conversation with the updated configuration. Changing it during a reply returns HTTP 409. Web search activity appears in `/chat` messages with `role: "tool"`, `kind: "webSearch"`, and `status: "running"`, `"done"`, or `"interrupted"`. Assistant replies contain Markdown source links.

The assistant's tools share the serialized app command queue and validation. Model tools cannot call chat, account, or sign-in routes or open dialogs. Turning off Allow map edits blocks mutating tool calls. Chat controls remain usable while a map tool is running, so Stop is accessible. Reads through `/current-map/model` remain the source of live component/link/metamodel information.

```sh
python scripts/wardley-api.py POST /chat/connect
python scripts/wardley-api.py PATCH /chat '{"open":true,"allowEdits":true}'
python scripts/wardley-api.py POST /chat/messages '{"text":"Add a payment activity and connect it to the user need."}'
python scripts/wardley-api.py GET /chat
python scripts/wardley-api.py POST /chat/stop
```

## Responses and concurrency

Success is HTTP 200 with the requested object, array, UI state or deletion acknowledgment. SVG exports return text with `image/svg+xml`. Errors use:

```json
{
  "error": {
    "code": "invalid_input",
    "message": "stage must be an integer from 0 to 3."
  }
}
```

Common statuses: 400 malformed JSON, 401 missing/invalid token, 403 browser Origin or wrong Host, 404 missing route/resource, 405 unsupported method, 409 open dialog/drag, empty history or disk revision conflict, 413 body too large, 415 wrong content type, 422 invalid data, 501 native-only operation in preview, 503 editor not ready, 504 reply timeout.

Commands are serialized. Data mutations validate proposed maps before changing live state, save through the same repository as the UI, and preserve disk revision checks. Mutation requests commit a focused component/connection text field first. Reads return the current committed editor state, including unsaved changes; export routes remain available after save conflicts. A save failure leaves pending edits available for recovery: export the map, then reload or discard/reload. A 504 may occur after a command started; read the resulting state before retrying a non-idempotent command.

The API returns `editor_busy` while a drag or dialog draft is active. Reads, exports and dialog-close routes remain available. Close the dialog explicitly before sending data edits. A successful API edit updates the visible map; editing a map by ID also activates it. Workspace switching first saves current changes. Separate processes must use separate discovery files when each needs its own stable connection metadata.

## Browser preview and tests

The preview exposes the same routes as an in-page JavaScript API:

```js
await window.wardleyApi.request("POST", "/api/v1/maps", {
  title: "From JavaScript",
  anchor: false,
});
```

It returns `{status, body, contentType?}`. Preview data uses localStorage; native folder operations require the desktop app. There is no preview HTTP server for this API.

Run `npm run test:e2e` for UI and API integration tests. Run `python scripts/test-native-api.py` after `npm run desktop:build` to exercise actual HTTP authentication, the Tauri bridge and disk saves using temporary workspaces. The native integration test launches a separate temporary app window and closes that process when done.

## Map images

- `GET /api/v1/current-map/snapshot`: capture the current map.
- `GET /api/v1/maps/:id/snapshot`: capture another map without activating it.

Both return JSON with `mimeType: "image/png"`, a base64 `dataUrl`, `width` (1650), `height` (1140), `mapId`, `title`, `updatedAt`, `capturedAt`, `scope: "full-map"`, `labels: true`, and coordinate metadata. `components` contains each component's `id`, `label`, and pixel `x`/`y`. `plot` gives the pixel bounds of the evolution/visibility area; `viewBox` gives SVG coordinates. Pixel origin is top left. Evolution increases rightward and visibility increases upward.

The image uses the same renderer as the canvas, includes labels and axes, and always covers the full map regardless of pan/zoom. Capturing does not change selection, zoom, label visibility, map data, or undo history. It includes live in-memory changes. Rendering failure returns an error, never a placeholder image. Existing API authentication applies.

```sh
python scripts/wardley-api.py GET /current-map/snapshot --output /tmp/map-snapshot.json
python - <<'PY'
import base64, json
from pathlib import Path
snapshot = json.loads(Path("/tmp/map-snapshot.json").read_text())
Path("/tmp/map.png").write_bytes(base64.b64decode(snapshot["dataUrl"].split(",", 1)[1]))
PY
```

The assistant's `get_map_snapshot` tool returns the PNG as image content plus text metadata. Calling either snapshot route through `control_app` also returns image content, including in older conversations. Snapshot reads remain available with Allow map edits disabled.

## Feature flags

`GET /api/v1/features` reports `chat` (available in this session) and `chatCompiled` (included in the effective frontend/native build). `/api/v1/state` includes the same `features` object. Flags are read-only through the API.

With `WARDLEY_CHAT_ENABLED=0`, chat is disabled at native startup. With `npm run desktop:build:core`, chat is excluded at build time and cannot be enabled by runtime configuration. Disabled chat routes, including `/chat`, its subroutes and `/actions/chat`, return 404 and are omitted from `/routes` and `/openapi.json`. Other editor routes, including PNG snapshots, remain available. See the README for flag values and build commands.

## Workspace connections

`GET /api/v1/connection` returns `{mode, url, credentialStorage}` without credentials. `PUT /api/v1/connection` accepts `{mode: "remote", url: "https://your-server.example", token: "..."}` or `{mode: "local"}`. Send the token in the JSON body, never in a URL. Remote settings require the native app and a working system keyring. Omitting the token reuses the saved credential for that server. Pending edits must save before switching. The assistant cannot call connection routes.

The editor API keeps its existing routes in remote mode. Reads describe the loaded editor state; successful changes autosave to the selected server. `POST /api/v1/workspace/reload` refreshes remote state. Hosted server routes and concurrency rules are described in [Hosted API](docs/HOSTED_API.md).
