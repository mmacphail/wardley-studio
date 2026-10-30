# Wardley Studio

A native Tauri 2 app for drawing Wardley maps. A Rust backend reads and writes ordinary JSON files; a TypeScript/SVG editor provides the canvas. Map editing works offline without an account. Optional chat, web search, and visual layout assistance require an internet connection and a supported ChatGPT subscription through Codex.

## Run

From a clone or downloaded copy of this repository:

```sh
cd wardley-studio
npm ci
npm run desktop
```

Requires Node 24+ (`.nvmrc` selects 24), a current stable Rust toolchain (minimum 1.90), and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/). On Linux, GTK 3 and WebKitGTK 4.1 are required. Python 3.10+ is needed for the API client and native integration tests. Linux is the verified desktop target; macOS and Windows builds need separate validation.

For a browser preview, run `npm run dev` and visit `http://127.0.0.1:1435`. The browser preview uses localStorage. **Direct JSON file persistence and native folder/file dialogs are provided by the desktop app.** The preview can import and download JSON.

## Map editing

The canvas fills the window, with evolution stages along the bottom. Open the **Maps (M)**, **Components (A)** or **Properties (I)** drawer as needed. Drawers overlay the canvas without changing map position or zoom. Escape closes a drawer while keeping the selection. **Focus mode (F)** hides the header, tools and drawers; press F again or use Exit focus to return. Clicking a component opens its properties; dragging it leaves closed drawers closed.

- **Map library:** create, rename, describe, duplicate, import or delete maps. Click the title to edit map details.
- **Map types:** landscape, future state, practices, data landscape and knowledge. Changing the type changes the evolution-axis vocabulary, preserving component positions and connections.
- **Component palette:** users, user needs, activities, practices, data and knowledge. Click or drag a palette item onto the canvas. Double-click blank canvas space to add a component of the map's axis type.
- **Move:** drag a component or select it and use arrow keys; Shift+arrow makes a larger move. Visibility and evolution are normalized coordinates from 0 to 1.
- **Connect:** select the connection tool (`C`), click the source, then the dependency. Connections follow components as they move. Duplicate connections and self-links are rejected.
- **Auto-connect:** when enabled, adding a component connects the selected component to the new one. Drag the `+` port below a component to an existing component, or onto empty space to create a connected dependency.
- **Inspector:** rename, change type/stage, adjust visibility and evolution, add notes, show future evolution, or mark inertia. Select a connection to change its label or relationship.
- **Navigation:** scroll to zoom, `H` or Space+drag to pan, `0` to fit. `V` selects the move tool. Escape closes an open drawer first; otherwise it clears selection and cancels a connection.
- **History:** Ctrl/⌘ Z to undo; Ctrl/⌘ Shift Z or Ctrl/⌘ Y to redo. History is per map and lasts for the current session.
- **Export:** editable JSON or standalone SVG with vector text, shapes and arrows. Export the metamodel separately from the Metamodel dialog when sharing maps with custom types.
- **Save:** edits autosave after a short delay; Ctrl/⌘ S saves immediately, including the focused component text field. Closing the desktop window waits for pending edits to save. A save failure keeps the window open and displays the error.

## Chat assistant

Click **Chat** in the top bar to open a collapsible, resizable sidebar. It uses the installed **Codex CLI** and its **Sign in with ChatGPT** session for subscription access. No OpenAI API key is needed. If Codex is not signed in, choose **Sign in with ChatGPT**, open the verification page and enter the displayed code. This sign-in is shared with the local Codex CLI. Models are loaded from the account's available model catalog; choose one in the sidebar.

**Allow map edits** is enabled by default. The model receives the current map and metamodel as context and can inspect and control the app through `get_current_map`, `get_map_snapshot`, `list_app_routes`, and `control_app`. Map snapshots deliver an actual PNG to the model for visual inspection. The assistant is instructed to inspect before and after layout changes, check overlap and spacing, and refine placement while preserving stages and map meaning. Existing conversations can request the same image through `control_app` using `GET /api/v1/current-map/snapshot`. Tool calls appear in the conversation. Changes update the canvas, use normal validation and JSON saves, and can be undone with the existing Undo button. Turn off Allow map edits for discussion without changes. **Stop** interrupts the reply and prevents queued tool actions from applying; already completed edits remain undoable. **New conversation** starts a fresh thread. Enter sends a message; Shift+Enter adds a line.

**Web search** is enabled by default. The assistant can search the live web and open sources when researching a map. Search queries and page visits appear in chat; cited source links open in your browser. Turn off Web search while idle to disable it for subsequent replies, including in existing conversations. This setting is saved with the chat history and is independent of Allow map edits. Search uses the same subscription connection and is subject to the selected model and account policy.

Chat stays mounted while the editor redraws, preserving the composer draft. Its history and selected model are stored in the native app data directory as `chat.json`; Codex manages its own conversation history and authentication. Map context and prompts are sent to OpenAI when a message is sent; map images are sent when the assistant requests a snapshot. Snapshots show the full map with labels, independently of zoom or hidden-label settings, without changing the editor. PNGs are generated on demand and are not stored in map JSON or the app’s chat history; Codex manages its own tool history. Authentication tokens are managed by Codex and are not copied into map files or exposed as model tools. Shell, external app and multi-agent features are disabled for this integration; the model controls Wardley Studio through its application API and can research through built-in web search.

Install a current [Codex CLI](https://learn.chatgpt.com/docs/cli) if needed (tested with 0.166.0). The executable must be on PATH, or set `WARDLEY_CODEX_BIN=/absolute/path/to/codex`. The app-server dynamic-tool protocol is experimental. The browser preview displays the sidebar, but real subscription chat runs in the native app.

After a native build, `python scripts/test-native-chat.py` runs a live integration test using one model turn on the signed-in account, against temporary maps. `--dev` uses the debug binary and starts Vite. `--web-search` tests a real search and source link without changing a map. `--layout` tests before/after image inspection and improved placement on a temporary map. Normal browser tests use a deterministic fake model and do not consume subscription usage.

The integration follows the official [Codex App Server](https://learn.chatgpt.com/docs/app-server) and [ChatGPT authentication](https://learn.chatgpt.com/docs/auth) documentation.

### Disabling chat

Chat is enabled by default. For ordinary deployments, disable it at startup without rebuilding:

```sh
WARDLEY_CHAT_ENABLED=0 ./src-tauri/target/release/wardley-studio
# During development:
WARDLEY_CHAT_ENABLED=0 npm run desktop
```

The runtime flag is read when the native app starts, so restart to change it. Unset means enabled; `1`, `true`, and `on` enable it. `0`, `false`, `off`, and unrecognized values disable it (case-insensitive). With chat disabled there is no Chat button or sidebar, chat HTTP routes are absent, native chat commands reject requests, and the app does not read/write chat history or start Codex. Existing history is preserved for a later enabled session. Map editing, the map API and map snapshots continue to work. This is an application capability flag, separate from **Allow map edits** or **Web search**.

To distribute a build that cannot enable chat at runtime:

```sh
npm run desktop:build:core
```

This build script sets `VITE_CHAT_ENABLED=0` and passes Cargo `--no-default-features`, excluding the chat frontend module and native backend. The native Cargo feature is named `chat` and belongs to the default feature set. Setting `WARDLEY_CHAT_ENABLED=1` cannot restore chat in this build. For a browser-only preview without chat, use `VITE_CHAT_ENABLED=0 npm run dev`; the Vite flag is a build/server-start setting, not a production runtime switch.

`GET /api/v1/features` returns `{ "chat": true, "chatCompiled": true }` for the standard enabled build, `{ "chat": false, "chatCompiled": true }` when disabled at runtime, and both `false` for a core build. The same object appears in `/api/v1/state`. There is no API route to enable chat, so assistant or API calls cannot override the startup/build policy.

## Programmatic API

The native app serves an authenticated localhost API while open. **Maps → API** shows the URL and local connection file. Every menu action has a route, alongside map/component/connection CRUD, metamodel/workspace operations, exports and UI controls. API edits use the live editor's validation, undo history and JSON saves.

See [API.md](API.md) for routes, request fields, curl examples, concurrency behavior and the bundled Python client:

```sh
python scripts/wardley-api.py GET /state
python scripts/wardley-api.py POST /maps '{"title":"Strategy","anchor":false}'
python scripts/wardley-api.py GET /openapi.json -o wardley-openapi.json
```

## JSON workspace

Development uses the git-ignored `workspace/` directory by default. Personal maps are not part of the repository; `examples/` contains the starter maps. An installed release initially uses `Documents/Wardley Studio/`. Use **Workspace folder → Open a workspace folder** to choose another location. The selected location is remembered in the app's configuration directory. A `WARDLEY_WORKSPACE` environment variable overrides the startup location:

```sh
WARDLEY_WORKSPACE=/path/to/my-maps npm run desktop
```

An empty workspace is initialized with the metamodel and three example maps from `examples/`:

```text
workspace/
  metamodel.json
  maps/
    coffee-shop.json
    platform-future.json
    working-practices.json
    <map-id>.json
  .trash/
    <deleted-map-id>-<timestamp>.json
```

Every map has `schemaVersion`, `id`, `title`, `kind`, `description`, timestamps, `nodes` and `edges`. Node positions use `evolution` (left = 0, right = 1) and `visibility` (bottom = 0, top = 1). A node's stage is derived from its horizontal quarter: `[0, .25)`, `[.25, .5)`, `[.5, .75)`, `[.75, 1]`. Its type supplies that stage's label. This avoids storing a stage that could disagree with the position. Connections store node IDs rather than line coordinates.

Optional node properties are `targetEvolution` (a future position at or to the right of the current position) and `inertia` (boolean). Edge kinds are `dependency` and `evolution`.

The metamodel defines component types (`id`, `label`, `description`, `shape`, `color`, four `stageLabels`) and map kinds (`id`, `label`, `description`, `axisType`). Supported shapes are circle, diamond, square, hexagon and person. Shape/color conventions are configurable Studio notation.

| Component type | I          | II           | III                | IV                    |
| -------------- | ---------- | ------------ | ------------------ | --------------------- |
| Activity       | Genesis    | Custom built | Product (+ rental) | Commodity (+ utility) |
| Practice       | Novel      | Emerging     | Good               | Best                  |
| Data           | Unmodelled | Divergent    | Convergent         | Modelled              |
| Knowledge      | Concept    | Hypothesis   | Theory             | Accepted              |

Use **Metamodel** to edit and validate its JSON. New component types and map kinds appear in the editor immediately. Changes that invalidate existing maps are rejected. You can also edit files with your own tools and use **Workspace folder → Reload from disk**.

Saves use a temporary file followed by atomic replacement. Content revisions prevent an open editor from overwriting external file changes. If there is a conflict, export the unsaved map, then reload the workspace (or explicitly discard and reload). Invalid map files are skipped with a visible warning and left untouched. Files are limited to 8 MiB; symlinks are rejected for workspace data files. Deleted maps are moved to `.trash`; restore a deleted map by importing its JSON file.

## Build and verify

```sh
npm run check
npx playwright install chromium
npm run test:e2e
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
npm run format:check
npm run desktop:build
```

After building, `python scripts/test-native-api.py` verifies the actual HTTP server and disk saves in temporary workspaces.

UI tests use a Playwright-installed Chromium in CI and on other platforms. Local Linux runs detect `/usr/bin/chromium`; set `CHROMIUM_PATH` to override browser selection. Tests cover templates, component dragging, attached edges, undo/redo, reload persistence, auto-connect, stage editing, notes, future evolution, metamodel extensions and JSON import/export. Rust tests exercise disk round trips, conflict detection, invalid file preservation, path validation, symlink rejection and recoverable deletion.

The Linux release executable is `src-tauri/target/release/wardley-studio`. Debian and RPM installers are written under `src-tauri/target/release/bundle/`. Build on macOS or Windows for those platforms and select the corresponding bundle targets with the Tauri CLI.

## Contributing and publishing

See [CONTRIBUTING.md](CONTRIBUTING.md) for checks and contribution guidance, [SECURITY.md](SECURITY.md) for security reporting and data handling, and [docs/PUBLISHING.md](docs/PUBLISHING.md) for first-push and release steps. GitHub CI tests the app and produces Linux installers; it does not publish releases automatically.

## Sources

Wardley Mapping is by Simon Wardley, [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). The component families and evolution vocabulary follow [Learn Wardley Mapping's landscape reference](https://learnwardleymapping.com/landscape/). The original example maps, application code and icon in this project are provided under the MIT license. Native IPC and file dialogs follow the official [Tauri commands](https://v2.tauri.app/develop/calling-rust/) and [dialog plugin](https://v2.tauri.app/plugin/dialog/) documentation. The local HTTP transport uses [tiny_http](https://docs.rs/tiny_http/latest/tiny_http/) and [Tauri frontend events](https://v2.tauri.app/develop/calling-frontend/).

## Hosted API

The API can also run independently on Fly.io with token authentication and persistent JSON storage. See [Hosted API](docs/HOSTED_API.md) for deployment, routes, backups, and concurrency requirements. Desktop and hosted workspaces are independent; automatic synchronization is not included.
