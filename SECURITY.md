# Security

Report suspected vulnerabilities privately through the repository's **Security → Report a vulnerability** option if available. If private reporting is not enabled, open an issue asking the maintainer for a private contact channel without including exploit details or sensitive data. Do not post credentials, API tokens, chat transcripts, or personal maps in public issues.

The native API binds to loopback and requires a per-launch bearer token. Anyone holding that token can read and modify the open workspace through the app's API. Keep its discovery file private; do not forward the API port to an untrusted network.

Chat is optional. Using it sends prompts and map context to OpenAI through the installed Codex CLI. Requested map snapshots are also sent to the model. Web search can send queries to the search service. The model may edit and delete map content when **Allow map edits** is enabled; normal validation, saving and undo apply. Inspect changes and keep backups of important workspaces.

Codex manages authentication and its own conversation/tool history outside the repository. The application stores its chat history in its native app data directory. Git ignore rules are a convenience, not a guarantee against accidental disclosure: review exports, logs, screenshots and staged files before sharing them.

This is an early release. Linux is the currently verified desktop target; macOS and Windows packaging and signing have not been verified. There is no security-response SLA or automatic-update mechanism.

## Remote workspaces

Every hosted API route except the minimal `/health` response requires a bearer token, including discovery, map reads, edits, imports, backups, and snapshots. HTTPS is enforced by the Fly deployment. Token comparisons use a timing-safe comparison, browser Origin requests are denied, and request sizes are bounded. The deployment token is random, is configured as a Fly secret, and is never embedded in the public source or container image.

The desktop stores remote tokens in the operating system keyring and stores only the URL in its connection settings. It sends requests from Rust, validates TLS certificates, refuses redirects, and does not return credentials in API responses. The assistant cannot access connection or credential controls. The desktop API remains loopback-only with a separate per-launch bearer token and Host/Origin validation. A local API token grants control of the currently open workspace, including remote data, so protect its discovery file as well.

Possession of a server token grants full access to that deployment. There are no per-user roles, token scopes, or multi-tenant accounts yet. Rotate a leaked token using Fly secrets and reconnect trusted clients. A public URL or a copy of the source code alone does not grant access. Authentication does not prevent all denial-of-service traffic to a public endpoint.

Fly volumes are encrypted at rest, but maps are not end-to-end encrypted: the server process and administrators with access to the Fly account/volume can read them. Chat still sends the selected map context to the configured AI service. Local backup/export files also contain readable map data; keep them private.
