use serde::Serialize;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    hash::{Hash, Hasher},
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub type Result<T> = std::result::Result<T, String>;
const MAX_FILE: u64 = 8 * 1024 * 1024;
const MODEL: &str = include_str!("../../examples/metamodel.json");
const SEEDS: [(&str, &str); 3] = [
    (
        "coffee-shop",
        include_str!("../../examples/maps/coffee-shop.json"),
    ),
    (
        "platform-future",
        include_str!("../../examples/maps/platform-future.json"),
    ),
    (
        "working-practices",
        include_str!("../../examples/maps/working-practices.json"),
    ),
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    path: String,
    metamodel: Value,
    maps: Vec<Value>,
    warnings: Vec<String>,
    revisions: HashMap<String, String>,
    metamodel_revision: String,
}
pub struct Repository {
    pub root: PathBuf,
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn check(ok: bool, message: impl Into<String>) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(message.into())
    }
}
fn array<'a>(v: &'a Value, key: &str) -> Result<&'a Vec<Value>> {
    v[key]
        .as_array()
        .ok_or_else(|| format!("{key} must be an array"))
}
fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key].as_str().ok_or_else(|| format!("{key} must be text"))
}
fn nonempty(v: &Value, key: &str) -> Result<()> {
    check(
        !text(v, key)?.trim().is_empty(),
        format!("{key} cannot be empty"),
    )
}
fn slug(s: &str) -> bool {
    !s.is_empty()
        && s.as_bytes()[0].is_ascii_lowercase()
        && s.bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}
fn safe_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}
fn fingerprint(s: &str) -> String {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    format!("{:016x}", h.finish())
}
fn no_symlink(path: &Path) -> Result<()> {
    if let Ok(meta) = fs::symlink_metadata(path) {
        check(
            !meta.file_type().is_symlink(),
            "Symbolic links are not supported for workspace data files.",
        )?;
    }
    Ok(())
}
pub fn read_json(path: &Path) -> Result<(Value, String)> {
    no_symlink(path)?;
    check(
        fs::metadata(path).map_err(err)?.len() <= MAX_FILE,
        "JSON file exceeds the 8 MB limit.",
    )?;
    let raw = fs::read_to_string(path).map_err(err)?;
    Ok((serde_json::from_str(&raw).map_err(err)?, fingerprint(&raw)))
}
pub fn atomic_write(path: &Path, value: &Value) -> Result<String> {
    no_symlink(path)?;
    let raw = format!("{}\n", serde_json::to_string_pretty(value).map_err(err)?);
    check(
        raw.len() as u64 <= MAX_FILE,
        "JSON file exceeds the 8 MB limit.",
    )?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(err)?
        .as_nanos();
    let temp = path.with_extension(format!("{}.{nonce}.tmp", std::process::id()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(err)?;
        file.write_all(raw.as_bytes()).map_err(err)?;
        file.sync_all().map_err(err)?;
        fs::rename(&temp, path).map_err(err)?;
        Ok(fingerprint(&raw))
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
fn revision_matches(path: &Path, expected: Option<&str>) -> Result<()> {
    if path.exists() {
        let (_, current) = read_json(path)?;
        check(expected == Some(current.as_str()), "This file changed on disk. Reload the workspace before saving to avoid overwriting external changes.")
    } else {
        check(
            expected.is_none(),
            "This file was removed on disk. Reload the workspace before saving.",
        )
    }
}
pub fn validate_metamodel(v: &Value) -> Result<()> {
    check(
        v["schemaVersion"] == 1,
        "Unsupported metamodel schemaVersion",
    )?;
    nonempty(v, "name")?;
    let types = array(v, "componentTypes")?;
    check(!types.is_empty(), "Add at least one component type")?;
    let mut ids = HashSet::new();
    for t in types {
        let id = text(t, "id")?;
        check(
            slug(id) && ids.insert(id),
            "Component type IDs must be unique lowercase slugs",
        )?;
        nonempty(t, "label")?;
        text(t, "description")?;
        let color = text(t, "color")?;
        check(
            color.len() == 7
                && color.starts_with('#')
                && color[1..].bytes().all(|c| c.is_ascii_hexdigit()),
            "Colors must be six-digit hex values",
        )?;
        check(
            ["circle", "square", "diamond", "hexagon", "person"].contains(&text(t, "shape")?),
            "Invalid component shape",
        )?;
        let labels = array(t, "stageLabels")?;
        check(
            labels.len() == 4
                && labels
                    .iter()
                    .all(|l| l.as_str().is_some_and(|s| !s.trim().is_empty())),
            "Each component type needs four stage labels",
        )?;
    }
    let kinds = array(v, "mapKinds")?;
    check(!kinds.is_empty(), "Add at least one map kind")?;
    let mut kind_ids = HashSet::new();
    for k in kinds {
        let id = text(k, "id")?;
        check(
            slug(id) && kind_ids.insert(id),
            "Map kind IDs must be unique lowercase slugs",
        )?;
        nonempty(k, "label")?;
        text(k, "description")?;
        check(
            ids.contains(text(k, "axisType")?),
            "Map kind axisType must refer to a component type",
        )?;
    }
    Ok(())
}
pub fn validate_map(v: &Value, model: &Value) -> Result<()> {
    check(v["schemaVersion"] == 1, "Unsupported map schemaVersion")?;
    check(
        safe_id(text(v, "id")?),
        "Map ID must contain only letters, numbers, hyphens or underscores",
    )?;
    nonempty(v, "title")?;
    text(v, "description")?;
    for key in ["createdAt", "updatedAt"] {
        check(
            time::OffsetDateTime::parse(
                text(v, key)?,
                &time::format_description::well_known::Rfc3339,
            )
            .is_ok(),
            format!("{key} must be an RFC 3339 timestamp"),
        )?;
    }
    check(
        array(model, "mapKinds")?
            .iter()
            .any(|k| k["id"] == v["kind"]),
        "Unknown map kind",
    )?;
    let mut nodes = HashSet::new();
    for n in array(v, "nodes")? {
        let id = text(n, "id")?;
        check(
            !id.is_empty() && nodes.insert(id),
            "Node IDs must be nonempty and unique",
        )?;
        nonempty(n, "label")?;
        text(n, "notes")?;
        check(
            array(model, "componentTypes")?
                .iter()
                .any(|t| t["id"] == n["type"]),
            "Unknown component type",
        )?;
        for key in ["evolution", "visibility"] {
            check(
                n[key]
                    .as_f64()
                    .is_some_and(|x| x.is_finite() && (0.0..=1.0).contains(&x)),
                format!("{key} must be between 0 and 1"),
            )?;
        }
        if let Some(target) = n.get("targetEvolution") {
            check(
                target
                    .as_f64()
                    .is_some_and(|x| x >= n["evolution"].as_f64().unwrap_or(0.0) && x <= 1.0),
                "Target evolution must be between current evolution and 1",
            )?;
        }
        if let Some(inertia) = n.get("inertia") {
            check(inertia.is_boolean(), "Inertia must be boolean")?;
        }
    }
    let mut ids = HashSet::new();
    let mut links = HashSet::new();
    for e in array(v, "edges")? {
        let id = text(e, "id")?;
        check(
            !id.is_empty() && ids.insert(id),
            "Edge IDs must be nonempty and unique",
        )?;
        let source = text(e, "source")?;
        let target = text(e, "target")?;
        let kind = text(e, "kind")?;
        check(
            source != target && nodes.contains(source) && nodes.contains(target),
            "Every edge must connect two existing, different nodes",
        )?;
        check(
            ["dependency", "evolution"].contains(&kind),
            "Invalid connection kind",
        )?;
        text(e, "label")?;
        check(links.insert((source, target, kind)), "Duplicate connection")?;
    }
    Ok(())
}
impl Repository {
    pub fn open(root: PathBuf) -> Result<Self> {
        fs::create_dir_all(&root).map_err(err)?;
        let root = fs::canonicalize(root).map_err(err)?;
        no_symlink(&root.join("maps"))?;
        fs::create_dir_all(root.join("maps")).map_err(err)?;
        let first = !root.join("metamodel.json").exists();
        if first {
            atomic_write(
                &root.join("metamodel.json"),
                &serde_json::from_str(MODEL).map_err(err)?,
            )?;
            let has_maps = fs::read_dir(root.join("maps"))
                .map_err(err)?
                .filter_map(|e| e.ok())
                .any(|e| e.path().extension().is_some_and(|x| x == "json"));
            if !has_maps {
                for (id, raw) in SEEDS {
                    atomic_write(
                        &root.join("maps").join(format!("{id}.json")),
                        &serde_json::from_str(raw).map_err(err)?,
                    )?;
                }
            }
        }
        let repo = Self { root };
        let (mut model, revision) = repo.model()?;
        let mut migrated = false;
        for component in model["componentTypes"].as_array_mut().unwrap() {
            if ["user", "need", "activity"].contains(&component["id"].as_str().unwrap_or(""))
                && component["stageLabels"]
                    == serde_json::json!(["Genesis", "Custom built", "Product", "Commodity"])
            {
                component["stageLabels"] = serde_json::json!([
                    "Genesis",
                    "Custom built",
                    "Product (+ rental)",
                    "Commodity (+ utility)"
                ]);
                migrated = true;
            }
        }
        if migrated {
            let path = repo.root.join("metamodel.json");
            revision_matches(&path, Some(&revision))?;
            atomic_write(&path, &model)?;
        }
        Ok(repo)
    }
    fn model(&self) -> Result<(Value, String)> {
        let (v, revision) = read_json(&self.root.join("metamodel.json"))?;
        validate_metamodel(&v)?;
        Ok((v, revision))
    }
    fn map_path(&self, id: &str) -> Result<PathBuf> {
        check(safe_id(id), "Invalid map ID")?;
        no_symlink(&self.root.join("maps"))?;
        Ok(self.root.join("maps").join(format!("{id}.json")))
    }
    pub fn load(&self) -> Result<Workspace> {
        let (model, model_revision) = self.model()?;
        let mut ws = Workspace {
            path: self.root.to_string_lossy().into(),
            metamodel: model,
            maps: vec![],
            warnings: vec![],
            revisions: HashMap::new(),
            metamodel_revision: model_revision,
        };
        no_symlink(&self.root.join("maps"))?;
        for entry in fs::read_dir(self.root.join("maps")).map_err(err)? {
            let entry = entry.map_err(err)?;
            let path = entry.path();
            if path.extension().is_none_or(|x| x != "json") {
                continue;
            }
            let parsed: Result<(Value, String)> = (|| {
                let (map, revision) = read_json(&path)?;
                validate_map(&map, &ws.metamodel)?;
                check(
                    path.file_stem().and_then(|s| s.to_str()) == map["id"].as_str(),
                    "Filename must match the map ID",
                )?;
                Ok((map, revision))
            })();
            match parsed {
                Ok((map, revision)) => {
                    ws.revisions.insert(text(&map, "id")?.into(), revision);
                    ws.maps.push(map);
                }
                Err(e) => ws
                    .warnings
                    .push(format!("{}: {e}", entry.file_name().to_string_lossy())),
            }
        }
        ws.maps
            .sort_by(|a, b| a["title"].as_str().cmp(&b["title"].as_str()));
        Ok(ws)
    }
    pub fn save_map(&self, map: &Value, expected: Option<&str>) -> Result<String> {
        validate_map(map, &self.model()?.0)?;
        let path = self.map_path(text(map, "id")?)?;
        revision_matches(&path, expected)?;
        atomic_write(&path, map)
    }
    pub fn save_model(&self, model: &Value, expected: &str) -> Result<String> {
        validate_metamodel(model)?;
        let path = self.root.join("metamodel.json");
        revision_matches(&path, Some(expected))?;
        // A metamodel edit must also remain compatible with maps not open in the editor.
        no_symlink(&self.root.join("maps"))?;
        for entry in fs::read_dir(self.root.join("maps")).map_err(err)? {
            let path = entry.map_err(err)?.path();
            if path.extension().is_some_and(|x| x == "json") {
                validate_map(&read_json(&path)?.0, model)?;
            }
        }
        atomic_write(&path, model)
    }
    pub fn delete_map(&self, id: &str, expected: Option<&str>) -> Result<()> {
        let path = self.map_path(id)?;
        revision_matches(&path, expected)?;
        let trash = self.root.join(".trash");
        no_symlink(&trash)?;
        fs::create_dir_all(&trash).map_err(err)?;
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(err)?
            .as_nanos();
        fs::rename(path, trash.join(format!("{id}-{stamp}.json"))).map_err(err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn migrates_only_legacy_labels_and_keeps_invalid_files_readable_as_warnings() {
        let repo = repo();
        let (mut model, _) = repo.model().unwrap();
        model["componentTypes"][0]["stageLabels"] =
            json!(["Genesis", "Custom built", "Product", "Commodity"]);
        model["componentTypes"][2]["stageLabels"] = json!(["One", "Two", "Three", "Four"]);
        atomic_write(&repo.root.join("metamodel.json"), &model).unwrap();
        fs::write(repo.root.join("maps/broken.json"), "broken").unwrap();
        let reopened = Repository::open(repo.root.clone()).unwrap();
        let workspace = reopened.load().unwrap();
        assert_eq!(
            workspace.metamodel["componentTypes"][0]["stageLabels"][2],
            "Product (+ rental)"
        );
        assert_eq!(
            workspace.metamodel["componentTypes"][2]["stageLabels"][2],
            "Three"
        );
        assert_eq!(workspace.warnings.len(), 1);
        fs::remove_dir_all(repo.root).unwrap();
    }
    fn repo() -> Repository {
        Repository::open(std::env::temp_dir().join(format!(
                "wardley-test-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            )))
        .unwrap()
    }
    #[test]
    fn roundtrip_conflicts_and_recovery() {
        let repo = repo();
        let ws = repo.load().unwrap();
        assert_eq!(ws.maps.len(), 3);
        let mut map = ws.maps[0].clone();
        let id = map["id"].as_str().unwrap().to_string();
        map["title"] = json!("Changed");
        assert!(repo.save_map(&map, None).is_err());
        let revision = repo
            .save_map(&map, ws.revisions.get(&id).map(String::as_str))
            .unwrap();
        assert!(repo
            .save_map(&map, ws.revisions.get(&id).map(String::as_str))
            .is_err());
        assert!(repo.map_path("../escape").is_err());
        repo.delete_map(&id, Some(&revision)).unwrap();
        assert_eq!(repo.load().unwrap().maps.len(), 2);
        assert_eq!(fs::read_dir(repo.root.join(".trash")).unwrap().count(), 1);
        fs::remove_dir_all(repo.root).unwrap();
    }
    #[test]
    fn invalid_and_incompatible_data_is_preserved() {
        let repo = repo();
        let ws = repo.load().unwrap();
        fs::write(repo.root.join("maps/broken.json"), "{broken").unwrap();
        let loaded = repo.load().unwrap();
        assert_eq!(loaded.warnings.len(), 1);
        assert_eq!(loaded.maps.len(), 3);
        assert_eq!(
            fs::read_to_string(repo.root.join("maps/broken.json")).unwrap(),
            "{broken"
        );
        fs::remove_file(repo.root.join("maps/broken.json")).unwrap();
        let mut model = ws.metamodel.clone();
        model["componentTypes"]
            .as_array_mut()
            .unwrap()
            .retain(|t| t["id"] != "user");
        validate_metamodel(&model).unwrap();
        assert!(repo.save_model(&model, &ws.metamodel_revision).is_err());
        let mut map = ws.maps[0].clone();
        map["nodes"][0]["visibility"] = json!(2);
        assert!(validate_map(&map, &ws.metamodel).is_err());
        let mut invalid_date = ws.maps[0].clone();
        invalid_date["updatedAt"] = json!("not-a-date");
        assert!(validate_map(&invalid_date, &ws.metamodel).is_err());
        fs::remove_dir_all(repo.root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn symlinks_are_rejected() {
        let repo = repo();
        let external = repo.root.join("outside.json");
        fs::write(&external, "{}").unwrap();
        std::os::unix::fs::symlink(&external, repo.root.join("maps/link.json")).unwrap();
        assert_eq!(repo.load().unwrap().warnings.len(), 1);
        assert!(
            atomic_write(&repo.root.join("maps/link.json"), &json!({"changed": true})).is_err()
        );
        assert_eq!(fs::read_to_string(external).unwrap(), "{}");
        fs::remove_dir_all(repo.root).unwrap();
    }
}
