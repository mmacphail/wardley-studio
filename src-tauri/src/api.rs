use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::OpenOptions,
    io::{Read, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    time::Duration,
};
use tauri::{Emitter, Manager, State};
use tiny_http::{Header, Request, Response, Server};
use uuid::Uuid;

const MAX_BODY: usize = 8 * 1024 * 1024;
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiInfo {
    pub url: String,
    pub token: String,
    pub discovery_file: String,
    pub pid: u32,
}
#[derive(Clone, Serialize)]
struct ApiRequest {
    id: String,
    method: String,
    path: String,
    body: Value,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiResponse {
    pub status: u16,
    pub body: Value,
    pub content_type: Option<String>,
}
impl ApiResponse {
    fn error(status: u16, code: &str, message: &str) -> Self {
        Self {
            status,
            body: json!({"error":{"code":code,"message":message}}),
            content_type: None,
        }
    }
}
pub struct ApiState {
    info: ApiInfo,
    ready: AtomicBool,
    pending: Mutex<HashMap<String, mpsc::Sender<ApiResponse>>>,
}
#[tauri::command]
pub fn api_info(state: State<Arc<ApiState>>) -> ApiInfo {
    state.info.clone()
}
#[tauri::command]
pub fn api_ready(state: State<Arc<ApiState>>) {
    state.ready.store(true, Ordering::Release);
}
#[tauri::command]
pub fn api_pending(state: State<Arc<ApiState>>, id: String) -> bool {
    state
        .pending
        .lock()
        .is_ok_and(|pending| pending.contains_key(&id))
}
#[tauri::command]
pub fn api_reply(state: State<Arc<ApiState>>, id: String, response: ApiResponse) {
    if let Ok(mut pending) = state.pending.lock() {
        if let Some(tx) = pending.remove(&id) {
            let _ = tx.send(response);
        }
    }
}
fn header<'a>(request: &'a Request, name: &'static str) -> Option<&'a str> {
    request
        .headers()
        .iter()
        .find(|h| h.field.equiv(name))
        .map(|h| h.value.as_str())
}
fn authorize(request: &Request, info: &ApiInfo) -> Option<ApiResponse> {
    let authority = info.url.trim_start_matches("http://");
    if header(request, "Host") != Some(authority) || header(request, "Origin").is_some() {
        return Some(ApiResponse::error(
            403,
            "forbidden_origin",
            "Use the loopback API URL from api.json without an Origin header.",
        ));
    }
    let expected = format!("Bearer {}", info.token);
    if header(request, "Authorization") != Some(expected.as_str()) {
        return Some(ApiResponse::error(
            401,
            "unauthorized",
            "A valid Bearer token from api.json is required.",
        ));
    }
    None
}
fn respond(request: Request, response: ApiResponse) {
    let content_type = response
        .content_type
        .unwrap_or_else(|| "application/json".into());
    let body = if content_type == "application/json" {
        response.body.to_string()
    } else {
        response.body.as_str().unwrap_or("").to_owned()
    };
    let mut reply = Response::from_string(body).with_status_code(response.status);
    for (name, value) in [
        ("Content-Type", content_type.as_str()),
        ("Cache-Control", "no-store"),
        ("X-Content-Type-Options", "nosniff"),
    ] {
        if let Ok(h) = Header::from_bytes(name, value) {
            reply.add_header(h);
        }
    }
    let _ = request.respond(reply);
}
fn handle(mut request: Request, state: &ApiState, app: &tauri::AppHandle) {
    if let Some(error) = authorize(&request, &state.info) {
        respond(request, error);
        return;
    }
    if !state.ready.load(Ordering::Acquire) {
        respond(
            request,
            ApiResponse::error(503, "editor_not_ready", "The editor is still opening."),
        );
        return;
    }
    if request.body_length().is_some_and(|len| len > MAX_BODY) {
        respond(
            request,
            ApiResponse::error(413, "body_too_large", "Request body exceeds 8 MiB."),
        );
        return;
    }
    let mut raw = Vec::new();
    if request
        .as_reader()
        .take((MAX_BODY + 1) as u64)
        .read_to_end(&mut raw)
        .is_err()
    {
        respond(
            request,
            ApiResponse::error(400, "invalid_body", "Could not read request body."),
        );
        return;
    }
    if raw.len() > MAX_BODY {
        respond(
            request,
            ApiResponse::error(413, "body_too_large", "Request body exceeds 8 MiB."),
        );
        return;
    }
    if !raw.is_empty()
        && header(&request, "Content-Type")
            .is_none_or(|v| v.split(';').next() != Some("application/json"))
    {
        respond(
            request,
            ApiResponse::error(
                415,
                "unsupported_media_type",
                "Use Content-Type: application/json.",
            ),
        );
        return;
    }
    let body = if raw.is_empty() {
        json!({})
    } else {
        match serde_json::from_slice(&raw) {
            Ok(value) => value,
            Err(_) => {
                respond(
                    request,
                    ApiResponse::error(400, "invalid_json", "Request body must be valid JSON."),
                );
                return;
            }
        }
    };
    let id = Uuid::new_v4().to_string();
    let payload = ApiRequest {
        id: id.clone(),
        method: request.method().as_str().into(),
        path: request.url().into(),
        body,
    };
    let (tx, rx) = mpsc::channel();
    if let Ok(mut pending) = state.pending.lock() {
        pending.insert(id.clone(), tx);
    }
    let response = if app.emit_to("main", "api-request", payload).is_err() {
        ApiResponse::error(503, "editor_unavailable", "Could not reach the editor.")
    } else {
        rx.recv_timeout(Duration::from_secs(30)).unwrap_or_else(|_| ApiResponse::error(504, "request_timeout", "The editor did not reply within 30 seconds. Read state before retrying a mutation; it may have completed."))
    };
    if let Ok(mut pending) = state.pending.lock() {
        pending.remove(&id);
    }
    respond(request, response);
}
pub fn start(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let requested = std::env::var("WARDLEY_API_PORT").ok();
    let port = requested.as_deref().unwrap_or("14280").parse::<u16>()?;
    let server = Server::http(("127.0.0.1", port))
        .or_else(|error| {
            if requested.is_none() {
                Server::http(("127.0.0.1", 0))
            } else {
                Err(error)
            }
        })
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    let address = server.server_addr().to_ip().ok_or("No API address")?;
    let path = std::env::var_os("WARDLEY_API_INFO")
        .map(PathBuf::from)
        .unwrap_or(app.path().app_config_dir()?.join("api.json"));
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let info = ApiInfo {
        url: format!("http://{address}"),
        token: format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()),
        discovery_file: path.to_string_lossy().into(),
        pid: std::process::id(),
    };
    // Write a fresh owner-only file and atomically replace stale discovery data.
    let temp = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp)?;
    file.write_all(serde_json::to_string_pretty(&info)?.as_bytes())?;
    file.sync_all()?;
    std::fs::rename(&temp, &path)?;
    let state = Arc::new(ApiState {
        info,
        ready: AtomicBool::new(false),
        pending: Mutex::new(HashMap::new()),
    });
    app.manage(state.clone());
    let app = app.clone();
    std::thread::spawn(move || {
        // One dispatcher serializes HTTP commands with the live editor's command queue.
        for request in server.incoming_requests() {
            handle(request, &state, &app);
        }
    });
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_missing_token_and_browser_origins() {
        let info = ApiInfo {
            url: "http://127.0.0.1:14280".into(),
            token: "secret".into(),
            discovery_file: String::new(),
            pid: 0,
        };
        let make = |headers: Vec<(&str, &str)>| {
            let mut req = tiny_http::TestRequest::new();
            for (k, v) in headers {
                req = req.with_header(Header::from_bytes(k, v).unwrap());
            }
            Request::from(req)
        };
        assert_eq!(
            authorize(&make(vec![("Host", "127.0.0.1:14280")]), &info)
                .unwrap()
                .status,
            401
        );
        assert!(authorize(
            &make(vec![
                ("Host", "127.0.0.1:14280"),
                ("Authorization", "Bearer secret")
            ]),
            &info
        )
        .is_none());
        assert_eq!(
            authorize(
                &make(vec![
                    ("Host", "127.0.0.1:14280"),
                    ("Authorization", "Bearer secret"),
                    ("Origin", "https://example.com")
                ]),
                &info
            )
            .unwrap()
            .status,
            403
        );
        assert_eq!(
            authorize(
                &make(vec![
                    ("Host", "example.com:14280"),
                    ("Authorization", "Bearer secret")
                ]),
                &info
            )
            .unwrap()
            .status,
            403
        );
    }
}
