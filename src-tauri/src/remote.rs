use crate::repository::{atomic_write, Result};
use reqwest::{redirect::Policy, Client, Method, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Mutex, time::Duration};
use tauri::State;

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub url: Option<String>,
}
pub struct Remote {
    config: Mutex<Connection>,
    preference: PathBuf,
    client: Client,
}
#[derive(Serialize)]
pub struct Reply {
    status: u16,
    body: Value,
    revision: Option<String>,
}
fn normalize_url(raw: &str) -> Result<String> {
    let url = Url::parse(raw.trim()).map_err(|_| "Enter a valid server URL.")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !["", "/", "/api/v1", "/api/v1/"].contains(&url.path())
    {
        return Err(
            "Use an HTTPS server URL without credentials, query parameters, or a custom path."
                .into(),
        );
    }
    Ok(url.origin().ascii_serialization())
}
fn entry(url: &str) -> Result<keyring::Entry> {
    keyring::Entry::new("studio.wardley.desktop.remote", url)
        .map_err(|_| "System keyring is unavailable.".into())
}
fn credential(url: &str) -> Result<String> {
    entry(url)?
        .get_password()
        .map_err(|_| "Unlock your system keyring or reconnect with an API token.".into())
}
impl Remote {
    pub fn new(preference: PathBuf) -> Result<Self> {
        let config = match std::fs::read_to_string(&preference) {
            Ok(raw) => serde_json::from_str::<Connection>(&raw)
                .map_err(|_| "Invalid connection settings.")?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Connection::default(),
            Err(_) => return Err("Could not read connection settings.".into()),
        };
        if let Some(url) = &config.url {
            normalize_url(url)?;
        }
        let client = Client::builder()
            .redirect(Policy::none())
            .timeout(Duration::from_secs(45))
            .connect_timeout(Duration::from_secs(15))
            .build()
            .map_err(|_| "Could not initialize HTTPS client.")?;
        Ok(Self {
            config: Mutex::new(config),
            preference,
            client,
        })
    }
    fn current(&self) -> Result<Connection> {
        self.config
            .lock()
            .map(|c| c.clone())
            .map_err(|_| "Connection lock failed.".into())
    }
    async fn request(
        &self,
        url: &str,
        token: &str,
        method: &str,
        path: &str,
        body: Option<Value>,
        revision: Option<String>,
    ) -> Result<Reply> {
        if !["GET", "POST", "PUT", "PATCH", "DELETE"].contains(&method)
            || !path.starts_with("/api/v1/")
            || path.contains(['?', '#', '\\'])
            || path.split('/').any(|s| s == "." || s == "..")
        {
            return Err("Invalid remote API request.".into());
        }
        let target = Url::parse(&format!("{url}{path}")).map_err(|_| "Invalid API path.")?;
        if target.origin().ascii_serialization() != url || !target.path().starts_with("/api/v1/") {
            return Err("Invalid API origin.".into());
        }
        let mut request = self
            .client
            .request(
                Method::from_bytes(method.as_bytes()).map_err(|_| "Invalid method.")?,
                target,
            )
            .bearer_auth(token);
        if let Some(revision) = revision {
            request = request.header("If-Match", revision);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let mut response = request.send().await.map_err(|_| "Cannot reach the remote server securely. Your edits remain unsaved; check your connection and retry.")?;
        let status = response.status().as_u16();
        if (300..400).contains(&status) {
            return Err("Server redirects are refused to protect the API token.".into());
        }
        let revision = response
            .headers()
            .get("etag")
            .and_then(|h| h.to_str().ok())
            .map(String::from);
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Could not read server response.")?
        {
            if bytes.len() + chunk.len() > 64 * 1024 * 1024 {
                return Err("Server response exceeds 64 MiB.".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let body = serde_json::from_slice(&bytes).map_err(|_| "Server returned invalid JSON.")?;
        Ok(Reply {
            status,
            body,
            revision,
        })
    }
}
#[tauri::command]
pub fn connection_info(remote: State<Remote>) -> Result<Value> {
    let config = remote.current()?;
    Ok(
        json!({"mode": if config.url.is_some() {"remote"} else {"local"}, "url": config.url, "credentialStorage":"system-keyring"}),
    )
}
#[tauri::command]
pub async fn connection_set(
    remote: State<'_, Remote>,
    mode: String,
    url: Option<String>,
    token: Option<String>,
) -> Result<()> {
    let config = if mode == "local" {
        Connection::default()
    } else if mode == "remote" {
        let url = normalize_url(url.as_deref().unwrap_or(""))?;
        let token = match token.filter(|s| !s.is_empty()) {
            Some(token) => token,
            None => credential(&url)?,
        };
        if token.len() < 32 || token.contains(['\r', '\n']) {
            return Err("Enter a valid API token (at least 32 characters).".into());
        }
        let response = remote
            .request(&url, &token, "GET", "/api/v1/features", None, None)
            .await?;
        if response.status != 200
            || response.body["headless"] != true
            || response.body["remoteWorkspace"] != true
        {
            return Err("Connection refused. Check your API token and update the server to support remote workspaces.".into());
        }
        let workspace = remote
            .request(&url, &token, "GET", "/api/v1/workspace/export", None, None)
            .await?;
        if workspace.status != 200 {
            return Err("Could not open the remote workspace. Connection was not changed.".into());
        }
        crate::repository::validate_metamodel(&workspace.body["metamodel"])?;
        for map in workspace.body["maps"]
            .as_array()
            .ok_or("Invalid remote workspace.")?
        {
            crate::repository::validate_map(map, &workspace.body["metamodel"])?;
        }
        if !workspace.body["revisions"].is_object()
            || !workspace.body["metamodelRevision"].is_string()
        {
            return Err("Remote workspace is missing revision information.".into());
        }
        entry(&url)?.set_password(&token).map_err(|_| {
            "Could not save the token in the system keyring. Connection was not changed."
        })?;
        Connection { url: Some(url) }
    } else {
        return Err("Choose local or remote storage.".into());
    };
    if let Some(parent) = remote.preference.parent() {
        std::fs::create_dir_all(parent).map_err(|_| "Could not create settings directory.")?;
    }
    atomic_write(
        &remote.preference,
        &serde_json::to_value(&config).map_err(|e| e.to_string())?,
    )?;
    *remote
        .config
        .lock()
        .map_err(|_| "Connection lock failed.")? = config;
    Ok(())
}
#[tauri::command]
pub async fn remote_request(
    remote: State<'_, Remote>,
    method: String,
    path: String,
    body: Option<Value>,
    revision: Option<String>,
) -> Result<Reply> {
    let url = remote
        .current()?
        .url
        .ok_or("No remote workspace is connected.")?;
    let token = credential(&url)?;
    remote
        .request(&url, &token, &method, &path, body, revision)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn remote_urls_require_https_and_cannot_embed_credentials_or_paths() {
        assert_eq!(
            normalize_url("https://example.com/api/v1/").unwrap(),
            "https://example.com"
        );
        for url in [
            "http://example.com",
            "https://user:secret@example.com",
            "https://example.com/other",
            "https://example.com?token=x",
            "file:///tmp/a",
        ] {
            assert!(normalize_url(url).is_err(), "{url}");
        }
    }
}
