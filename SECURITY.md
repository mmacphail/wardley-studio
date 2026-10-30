# Security

Report suspected vulnerabilities privately through the repository's **Security → Report a vulnerability** option if available. If private reporting is not enabled, open an issue asking the maintainer for a private contact channel without including exploit details or sensitive data. Do not post credentials, API tokens, chat transcripts, or personal maps in public issues.

The native API binds to loopback and requires a per-launch bearer token. Anyone holding that token can read and modify the open workspace through the app's API. Keep its discovery file private; do not forward the API port to an untrusted network.

Chat is optional. Using it sends prompts and map context to OpenAI through the installed Codex CLI. Requested map snapshots are also sent to the model. Web search can send queries to the search service. The model may edit and delete map content when **Allow map edits** is enabled; normal validation, saving and undo apply. Inspect changes and keep backups of important workspaces.

Codex manages authentication and its own conversation/tool history outside the repository. The application stores its chat history in its native app data directory. Git ignore rules are a convenience, not a guarantee against accidental disclosure: review exports, logs, screenshots and staged files before sharing them.

This is an early release. Linux is the currently verified desktop target; macOS and Windows packaging and signing have not been verified. There is no security-response SLA or automatic-update mechanism.
