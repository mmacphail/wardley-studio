#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod api;
#[cfg(feature = "chat")]
mod chat;
mod features;
mod remote;
mod repository;
use repository::{Repository, Result, Workspace};
use serde_json::Value;
use std::{path::PathBuf, sync::Mutex};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

struct Store {
    repo: Mutex<Repository>,
    preference: PathBuf,
}
fn locked(store: &Store) -> Result<std::sync::MutexGuard<'_, Repository>> {
    store
        .repo
        .lock()
        .map_err(|_| "Workspace lock failed".into())
}
#[tauri::command]
fn load_workspace(store: State<Store>) -> Result<Workspace> {
    locked(&store)?.load()
}
#[tauri::command]
fn save_map(store: State<Store>, map: Value, expected_revision: Option<String>) -> Result<String> {
    locked(&store)?.save_map(&map, expected_revision.as_deref())
}
#[tauri::command]
fn save_metamodel(
    store: State<Store>,
    metamodel: Value,
    expected_revision: String,
) -> Result<String> {
    locked(&store)?.save_model(&metamodel, &expected_revision)
}
#[tauri::command]
fn delete_map(store: State<Store>, id: String, expected_revision: Option<String>) -> Result<()> {
    locked(&store)?.delete_map(&id, expected_revision.as_deref())
}
#[tauri::command]
async fn choose_workspace(app: tauri::AppHandle, store: State<'_, Store>) -> Result<bool> {
    let Some(folder) = app
        .dialog()
        .file()
        .set_title("Open a Wardley Studio workspace")
        .blocking_pick_folder()
    else {
        return Ok(false);
    };
    let path = folder.into_path().map_err(|e| e.to_string())?;
    let repo = Repository::open(path)?;
    repo.load()?;
    if let Some(parent) = store.preference.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    repository::atomic_write(&store.preference, &serde_json::json!({"path": repo.root}))?;
    *locked(&store)? = repo;
    Ok(true)
}
#[tauri::command]
async fn import_map(app: tauri::AppHandle) -> Result<Option<Value>> {
    let Some(file) = app
        .dialog()
        .file()
        .add_filter("Wardley map", &["json"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let (map, _) = repository::read_json(&file.into_path().map_err(|e| e.to_string())?)?;
    // The frontend validates against the currently selected local or remote metamodel.
    Ok(Some(map))
}
#[tauri::command]
async fn export_map(app: tauri::AppHandle, map: Value) -> Result<bool> {
    // Export must remain available to recover edits even if the disk metamodel is broken.
    if !map.is_object() || map["schemaVersion"] != 1 {
        return Err("Expected a Wardley map JSON object".into());
    }
    let filename = format!("{}.json", map["id"].as_str().unwrap_or("map"));
    let Some(file) = app
        .dialog()
        .file()
        .add_filter("JSON", &["json"])
        .set_file_name(&filename)
        .blocking_save_file()
    else {
        return Ok(false);
    };
    repository::atomic_write(&file.into_path().map_err(|e| e.to_string())?, &map)?;
    Ok(true)
}
#[tauri::command]
fn set_workspace(store: State<Store>, path: String) -> Result<()> {
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err("Workspace path must be absolute".into());
    }
    let repo = Repository::open(path)?;
    repo.load()?;
    if let Some(parent) = store.preference.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    repository::atomic_write(&store.preference, &serde_json::json!({"path": repo.root}))?;
    *locked(&store)? = repo;
    Ok(())
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(features::AppFeatures::from_env());
            app.manage(
                remote::Remote::new(app.path().app_config_dir()?.join("remote-connection.json"))
                    .map_err(std::io::Error::other)?,
            );
            let preference = app.path().app_config_dir()?.join("workspace-location.json");
            let preferred = std::fs::read_to_string(&preference)
                .ok()
                .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
                .and_then(|v| v["path"].as_str().map(PathBuf::from));
            let root = std::env::var_os("WARDLEY_WORKSPACE")
                .map(PathBuf::from)
                .or(preferred)
                .unwrap_or_else(|| {
                    if cfg!(debug_assertions) {
                        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                            .parent()
                            .unwrap()
                            .join("workspace")
                    } else {
                        app.path()
                            .document_dir()
                            .unwrap_or_else(|_| app.path().app_data_dir().unwrap())
                            .join("Wardley Studio")
                    }
                });
            app.manage(Store {
                repo: Mutex::new(Repository::open(root).map_err(std::io::Error::other)?),
                preference,
            });
            api::start(app.handle())?;
            #[cfg(feature = "chat")]
            app.manage(chat::ChatService::new(app.handle()).map_err(std::io::Error::other)?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            features::app_features,
            load_workspace,
            remote::connection_info,
            remote::connection_set,
            remote::remote_request,
            save_map,
            save_metamodel,
            delete_map,
            choose_workspace,
            import_map,
            export_map,
            set_workspace,
            api::api_info,
            api::api_ready,
            api::api_pending,
            api::api_reply,
            #[cfg(feature = "chat")]
            chat::chat_rpc,
            #[cfg(feature = "chat")]
            chat::chat_reply,
            #[cfg(feature = "chat")]
            chat::chat_history_load,
            #[cfg(feature = "chat")]
            chat::chat_history_save,
            #[cfg(feature = "chat")]
            chat::chat_open_login,
            #[cfg(feature = "chat")]
            chat::chat_open_link
        ])
        .build(tauri::generate_context!())
        .expect("Could not start Wardley Studio")
        .run(|_app, _event| {
            #[cfg(feature = "chat")]
            if let tauri::RunEvent::Exit = _event {
                _app.state::<chat::ChatService>().shutdown();
            }
        });
}
