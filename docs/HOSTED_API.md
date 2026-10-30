# Hosted API

The standalone Node 24 API runs without Tauri, a browser, or a ChatGPT session. It shares the desktop map schema, validation, model descriptions, and SVG renderer. It renders PNG snapshots with resvg.

The desktop API is documented in [API.md](../API.md). The hosted API operates on explicit map IDs; it has no current selection, undo history, window controls, filesystem picker, or chat service. `GET /api/v1/routes` lists its supported routes. The native desktop connects through **Workspace → Remote server**. Enter the server HTTPS URL and API token, then choose **Connect**. The token is saved in the system keyring; the connection setting contains only the URL. Switching storage does not migrate existing maps automatically.

## Run locally

```sh
npm ci
export WARDLEY_API_TOKEN="$(openssl rand -hex 32)"
export WARDLEY_WORKSPACE="./workspace-server"
npm run server:start
```

The default address is `127.0.0.1:8080`. Set `HOST` and `PORT` to override it. The token must contain at least 32 characters. The workspace is created with the example metamodel and no maps.

## Access

All routes except `GET /health` require `Authorization: Bearer <token>`. Keep the token in a password manager or secret store. It grants full access to this single workspace, so share it only with trusted clients. This release does not have user accounts or per-map permissions. Each self-hosted deployment has its own workspace and secret; installing the open-source app does not grant access to another deployment. Browser origins are rejected; CORS is not enabled.

For the initial deployment, `.env.fly.local` on the deploying computer supplies the API URL and may contain the bootstrap token. This file is ignored by Git and excluded from the Docker context. After connecting the desktop and removing the bootstrap token from that file, Linux clients can read the credential from the keyring without printing it:

```sh
set -a
. ./.env.fly.local
set +a
export WARDLEY_API_TOKEN="$(secret-tool lookup service studio.wardley.desktop.remote username "$WARDLEY_API_URL")"
curl --fail-with-body "$WARDLEY_API_URL/api/v1/maps" \
  -H "Authorization: Bearer $WARDLEY_API_TOKEN"
```

Send `Content-Type: application/json` for POST, PUT, and PATCH, including `{}` for actions with no parameters. Requests and individual JSON files are limited to 8 MiB. Coordinates use evolution 0–1 and visibility 0–1. Component creation or patching also accepts `stage: 0..3` instead of evolution, placing the component at the stage midpoint.

## Routes

| Method                     | Path after `/api/v1`           | Result                                                                                                               |
| -------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| GET                        | `/routes`, `/features`         | Route discovery and capabilities                                                                                     |
| GET                        | `/workspace/export`            | Metamodel, active maps, and revisions as one consistent JSON snapshot                                                |
| GET / PUT                  | `/metamodel`                   | Read or replace the metamodel                                                                                        |
| POST                       | `/metamodel/validate`          | Validate against all existing maps without saving                                                                    |
| GET / POST                 | `/maps`                        | List full maps or create with `{title, kind?, description?}`                                                         |
| POST                       | `/maps/import`                 | Import a full map JSON with a fresh ID; `{map, preserveId: true}` preserves IDs and timestamps, rejecting duplicates |
| GET / PATCH / PUT / DELETE | `/maps/:id`                    | Read, edit metadata, replace, or remove a map                                                                        |
| POST                       | `/maps/:id/duplicate`          | Copy a map with optional `{title}`                                                                                   |
| GET                        | `/maps/:id/model`              | Full map, typed components, stage labels, links, axes, metamodel                                                     |
| GET                        | `/maps/:id/export/json`        | Map JSON compatible with desktop import                                                                              |
| GET                        | `/maps/:id/export/svg`         | SVG image                                                                                                            |
| GET                        | `/maps/:id/snapshot`           | PNG data URL and pixel coordinates for assistant placement checks                                                    |
| GET                        | `/maps/:id/snapshot.png`       | PNG image bytes                                                                                                      |
| GET / POST                 | `/maps/:id/components`         | List or add components                                                                                               |
| GET / PATCH / DELETE       | `/maps/:id/components/:itemId` | Read, edit, or remove a component and its links                                                                      |
| GET / POST                 | `/maps/:id/links`              | List or add links                                                                                                    |
| GET / PATCH / DELETE       | `/maps/:id/links/:itemId`      | Read, edit, or remove a link                                                                                         |

A component accepts `label`, `type`, `evolution` (or `stage`), `visibility`, `notes`, `targetEvolution`, and `inertia`. Creation defaults to evolution and visibility 0.5 and accepts `parent` to connect an existing parent automatically. Set `targetEvolution` to null to remove it. A link accepts `source`, `target`, `kind` (`dependency` or `evolution`), and `label`. IDs in path segments must be URL encoded.

### Concurrent editing

Reads of a map, its model, components, links, and exports return the same parent-map `ETag`. Every edit or deletion of an existing map, component, or link requires that value in `If-Match`. Metamodel replacement similarly requires its own ETag. Missing revisions return 428; stale revisions return 412. Successful mutations return the new ETag. Creating/importing/duplicating a map does not require one.

After 412, read the latest map and reconcile the intended changes before retrying. Do not blindly retry an old full-map replacement. For assistant workflows: read `/model`, edit using its ETag, inspect `/snapshot`, and repeat with the updated revision.

```sh
curl --fail-with-body "$WARDLEY_API_URL/api/v1/maps" \
  -H "Authorization: Bearer $WARDLEY_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Service map"}'
```

Use the returned ID and ETag in subsequent requests. `GET /api/v1/routes` is the authoritative list of available operations.

## Fly deployment

`fly.toml` configures one 512 MiB shared CPU machine in Paris and a `wardley_data` volume mounted at `/data`. The machine stops when idle and starts on requests. The first request after stopping may take longer. HTTPS is enforced. Only the health endpoint is public. The process runs as the unprivileged `node` user.

To deploy to a different account/name, change `app` in `fly.toml` first:

```sh
fly apps create YOUR_APP --org YOUR_ORG
fly volumes create wardley_data --app YOUR_APP --region cdg --size 1 --snapshot-retention 7
# Import from a protected file containing WARDLEY_API_TOKEN=... (never commit it).
fly secrets import --app YOUR_APP < /path/to/api-token.env
fly deploy --app YOUR_APP --ha=false --remote-only
```

Do not scale this app to multiple machines: each Fly Volume is local to one machine, and API operations are serialized within one process. Horizontal scaling requires shared storage and cross-process transactions. Files are written using fsync and atomic rename. Deleted maps move to `/data/.trash` for manual recovery; they are omitted from list and export responses. Monitor volume usage, especially if frequently deleting maps.

Fly daily volume snapshots are configured with seven-day retention. They are not a substitute for an independent backup. Periodically save `/api/v1/workspace/export` somewhere outside Fly. To restore an export into a fresh workspace, PUT its metamodel with the current metamodel ETag, then POST each map to `/maps/import` (map IDs are regenerated). Keep this single-machine limitation in mind for availability and data durability. See [Fly Volume documentation](https://docs.fly.io/volumes/overview).

Rotate access by replacing the `WARDLEY_API_TOKEN` Fly secret and updating trusted clients. Do not copy desktop subscription credentials into the image or volume.

## Verification

`npm run check` includes HTTP integration tests for authentication, origin rejection, revision conflicts, component/link validation, PNG rendering, imports, restart persistence, and recoverable deletion. CI runs these tests alongside the desktop checks.

## Desktop connection behavior

The native backend sends HTTPS requests with the saved token. It refuses redirects and validates TLS certificates. The token is never returned to the webview, local API responses, model context, or exported maps. Linux requires an unlocked Secret Service keyring (for example GNOME Keyring); macOS uses Keychain and Windows uses Credential Manager. There is no plaintext fallback if the keyring is unavailable. HTTPS is required for self-hosted servers too.

Remote mode autosaves to the server. Existing maps use ETags; new maps use the ID-preserving import route. The assistant edits through the same storage layer, with no credential or connection-control tools. A lost connection leaves edits visibly unsaved. A revision conflict requires exporting any unsaved work and reloading before reconciling it. **Reload** fetches changes made by other clients; live multi-user collaboration and offline queues are not implemented.

Choose **Local folder → Connect** to return to the previously selected local workspace, or **Open local folder** to choose another one. Existing local files remain untouched by remote saves. Connection settings persist across app restarts. If the remote server cannot be opened at startup, **Open local workspace** provides recovery.
