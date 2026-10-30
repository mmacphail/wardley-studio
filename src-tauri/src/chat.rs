use crate::repository::{self, Result};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    time::Duration,
};
use tauri::{Emitter, Manager, State};

struct Runtime {
    child: Mutex<Child>,
    writer: Mutex<ChildStdin>,
    pending: Mutex<HashMap<u64, mpsc::Sender<Result<Value>>>>,
    counter: AtomicU64,
}
impl Runtime {
    fn write(&self, message: Value) -> Result<()> {
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| "Chat connection lock failed")?;
        writeln!(writer, "{message}").map_err(|e| e.to_string())?;
        writer.flush().map_err(|e| e.to_string())
    }
    fn request(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.counter.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        self.pending
            .lock()
            .map_err(|_| "Chat request lock failed")?
            .insert(id, tx);
        let result = self
            .write(json!({"id":id,"method":method,"params":params}))
            .and_then(|_| {
                rx.recv_timeout(Duration::from_secs(45))
                    .map_err(|_| "Chat request timed out. Reconnect and try again.".to_string())?
            });
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&id);
        }
        result
    }
    fn stop(&self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
pub struct ChatService {
    enabled: bool,
    runtime: Mutex<Option<Arc<Runtime>>>,
    workdir: PathBuf,
    history: PathBuf,
}
impl ChatService {
    pub fn new(app: &tauri::AppHandle) -> Result<Self> {
        let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
        Ok(Self {
            enabled: app.state::<crate::features::AppFeatures>().chat,
            runtime: Mutex::new(None),
            workdir: base.join("chat-runtime"),
            history: base.join("chat.json"),
        })
    }
    pub fn shutdown(&self) {
        if let Ok(mut runtime) = self.runtime.lock() {
            if let Some(runtime) = runtime.take() {
                runtime.stop();
            }
        }
    }
    fn require_enabled(&self) -> Result<()> {
        if !self.enabled {
            return Err("Chat is disabled for this session.".into());
        }
        Ok(())
    }
    fn connect(&self, app: &tauri::AppHandle) -> Result<Arc<Runtime>> {
        self.require_enabled()?;
        let mut slot = self
            .runtime
            .lock()
            .map_err(|_| "Chat connection lock failed")?;
        if let Some(runtime) = slot.as_ref() {
            if runtime
                .child
                .lock()
                .map_err(|_| "Chat process lock failed")?
                .try_wait()
                .map_err(|e| e.to_string())?
                .is_none()
            {
                return Ok(runtime.clone());
            }
        }
        std::fs::create_dir_all(&self.workdir).map_err(|e| e.to_string())?;
        let binary = std::env::var_os("WARDLEY_CODEX_BIN").unwrap_or_else(|| "codex".into());
        let mut command = Command::new(binary);
        command.args(["app-server", "--listen", "stdio://"]);
        // The model operates the application through dynamic tools, with no environment tools.
        for setting in [
            "model_provider=\"openai\"",
            "forced_login_method=\"chatgpt\"",
            "web_search=\"live\"",
            "features.shell_tool=false",
            "features.unified_exec=false",
            "features.multi_agent=false",
            "features.apps=false",
            "features.plugins=false",
            "features.hooks=false",
            "features.computer_use=false",
            "features.browser_use=false",
            "features.in_app_browser=false",
            "features.image_generation=false",
            "features.view_image=false",
            "features.memories=false",
            "mcp_servers={}",
            "project_doc_max_bytes=0",
            "analytics.enabled=false",
        ] {
            command.args(["-c", setting]);
        }
        let mut child = command.current_dir(&self.workdir).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
            .spawn().map_err(|e| format!("Could not start Codex: {e}. Install Codex CLI or set WARDLEY_CODEX_BIN to its executable."))?;
        let stdin = child.stdin.take().ok_or("Codex stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("Codex stdout unavailable")?;
        let runtime = Arc::new(Runtime {
            child: Mutex::new(child),
            writer: Mutex::new(stdin),
            pending: Mutex::new(HashMap::new()),
            counter: AtomicU64::new(1),
        });
        let reader_runtime = runtime.clone();
        let emitter = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout)
                .lines()
                .map_while(std::result::Result::ok)
            {
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if message.get("method").is_some() {
                    let _ = emitter.emit_to("main", "chat-event", &message);
                } else if let Some(id) = message["id"].as_u64() {
                    if let Ok(mut pending) = reader_runtime.pending.lock() {
                        if let Some(tx) = pending.remove(&id) {
                            let result = if message.get("error").is_some() {
                                Err(message["error"]["message"]
                                    .as_str()
                                    .unwrap_or("Codex request failed")
                                    .to_owned())
                            } else {
                                Ok(message["result"].clone())
                            };
                            let _ = tx.send(result);
                        }
                    }
                }
            }
            if let Ok(mut pending) = reader_runtime.pending.lock() {
                for (_, tx) in pending.drain() {
                    let _ = tx.send(Err("Codex disconnected. Reconnect to continue.".into()));
                }
            }
            let _ = emitter.emit_to(
                "main",
                "chat-event",
                json!({"method":"wardley/disconnected","params":{}}),
            );
        });
        if let Err(error) = runtime.request("initialize", json!({"clientInfo":{"name":"wardley_studio","title":"Wardley Studio","version":"0.1.0"},"capabilities":{"experimentalApi":true}})) {
            runtime.stop(); return Err(error);
        }
        runtime.write(json!({"method":"initialized","params":{}}))?;
        *slot = Some(runtime.clone());
        Ok(runtime)
    }
}
#[tauri::command]
pub async fn chat_rpc(app: tauri::AppHandle, method: String, params: Value) -> Result<Value> {
    let allowed = [
        "account/read",
        "account/login/start",
        "account/login/cancel",
        "account/rateLimits/read",
        "model/list",
        "thread/start",
        "thread/resume",
        "turn/start",
        "turn/interrupt",
    ];
    if !allowed.contains(&method.as_str()) {
        return Err("Unsupported chat operation".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ChatService>();
        let runtime = state.connect(&app)?;
        runtime.request(&method, params)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn chat_reply(state: State<ChatService>, id: Value, result: Value) -> Result<()> {
    state.require_enabled()?;
    let runtime = state
        .runtime
        .lock()
        .map_err(|_| "Chat connection lock failed")?
        .clone()
        .ok_or("Chat is disconnected")?;
    runtime.write(json!({"id":id,"result":result}))
}
#[tauri::command]
pub fn chat_history_load(state: State<ChatService>) -> Result<Value> {
    state.require_enabled()?;
    if !state.history.exists() {
        return Ok(json!({"schemaVersion":1,"messages":[]}));
    }
    repository::read_json(&state.history).map(|(value, _)| value)
}
#[tauri::command]
pub fn chat_history_save(state: State<ChatService>, history: Value) -> Result<()> {
    state.require_enabled()?;
    if history["schemaVersion"] != 1 || !history["messages"].is_array() {
        return Err("Invalid chat history".into());
    }
    if let Some(parent) = state.history.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    repository::atomic_write(&state.history, &history)?;
    Ok(())
}
#[tauri::command]
pub fn chat_open_login(state: State<ChatService>, url: String) -> Result<()> {
    state.require_enabled()?;
    if !url.starts_with("https://auth.openai.com/") {
        return Err("Unexpected sign-in URL".into());
    }
    open_in_browser(&url)
}
#[tauri::command]
pub fn chat_open_link(state: State<ChatService>, url: String) -> Result<()> {
    state.require_enabled()?;
    let parsed = tauri::Url::parse(&url).map_err(|_| "Invalid link")?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("Only web links can be opened".into());
    }
    open_in_browser(parsed.as_str())
}
fn open_in_browser(url: &str) -> Result<()> {
    #[cfg(target_os = "linux")]
    let mut command = Command::new("xdg-open");
    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut c = Command::new("rundll32");
        c.arg("url.dll,FileProtocolHandler");
        c
    };
    command.arg(url).spawn().map_err(|e| e.to_string())?;
    Ok(())
}
