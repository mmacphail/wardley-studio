use serde::Serialize;
use tauri::State;

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppFeatures {
    pub chat: bool,
    pub chat_compiled: bool,
}
fn enabled(compiled: bool, value: Option<&str>) -> bool {
    compiled
        && value.is_none_or(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "on"
            )
        })
}
impl AppFeatures {
    pub fn from_env() -> Self {
        let chat_compiled = cfg!(feature = "chat");
        Self {
            chat: enabled(
                chat_compiled,
                std::env::var("WARDLEY_CHAT_ENABLED").ok().as_deref(),
            ),
            chat_compiled,
        }
    }
}
#[tauri::command]
pub fn app_features(state: State<AppFeatures>) -> AppFeatures {
    *state
}

#[cfg(test)]
mod tests {
    use super::enabled;
    #[test]
    fn runtime_flag_cannot_enable_a_compiled_out_feature() {
        for value in [None, Some("1"), Some("true"), Some("on")] {
            assert!(!enabled(false, value));
            assert!(enabled(true, value));
        }
        for value in [
            Some("0"),
            Some("false"),
            Some("off"),
            Some("invalid"),
            Some(""),
        ] {
            assert!(!enabled(true, value));
        }
        assert!(enabled(true, Some(" TRUE ")));
    }
}
