//! Tes bentuk kontrak: `web/src/platform/local-commands.ts` adalah sumber
//! kebenaran, dan sisi Rust harus mengikutinya PERSIS (docs/21 §2a).
//!
//! Dua hal yang dijaga, keduanya dengan parser teks sederhana — bukan parser
//! TypeScript, cukup untuk bentuk berkas kontrak yang memang ditulis supaya
//! bisa dibaca begini:
//!
//! 1. Setiap nama di `LOCAL_COMMAND_NAMES` terdaftar di `generate_handler!`
//!    crate Tauri (`desktop/src-tauri/src/commands/mod.rs`), dan tidak ada
//!    command `library_*`/`roblox_*`/`store_*`/`secret_*` di Rust yang tidak
//!    ada di TS.
//! 2. Kunci JSON tiap struct `types.rs` sama dengan field interface TS-nya.
//!
//! Tes ini ikut `cargo test --workspace` di CI Ubuntu — crate Tauri-nya tidak
//! dikompilasi di sana, tapi teks sumbernya tetap bisa dibaca.

use std::collections::BTreeSet;
use std::path::PathBuf;

use serde::Serialize;
use serde_json::json;

use crate::types::*;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

fn contract_ts() -> String {
    std::fs::read_to_string(repo_root().join("web/src/platform/local-commands.ts"))
        .expect("kontrak web/src/platform/local-commands.ts harus ada")
}

fn commands_rs() -> String {
    std::fs::read_to_string(repo_root().join("desktop/src-tauri/src/commands/mod.rs"))
        .expect("desktop/src-tauri/src/commands/mod.rs harus ada")
}

/// Isi `LOCAL_COMMAND_NAMES = [ 'a', 'b', ... ]`.
fn ts_command_names(src: &str) -> BTreeSet<String> {
    let start = src
        .find("const LOCAL_COMMAND_NAMES")
        .expect("LOCAL_COMMAND_NAMES ada di kontrak");
    // `= [` — bukan `[` pertama, yang adalah `LocalCommandName[]` di tipenya.
    let open = start + src[start..].find("= [").unwrap() + 2;
    let close = open + src[open..].find("];").unwrap();
    src[open + 1..close]
        .split(',')
        .map(|s| s.trim().trim_matches('\'').trim_matches('"').to_owned())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Ident di dalam `generate_handler![ ... ]`.
fn rust_handler_names(src: &str) -> BTreeSet<String> {
    let start = src
        .find("generate_handler![")
        .expect("generate_handler! ada di commands/mod.rs");
    let open = start + src[start..].find('[').unwrap();
    let close = open + src[open..].find(']').unwrap();
    src[open + 1..close]
        .lines()
        .map(|l| l.split("//").next().unwrap_or(""))
        .flat_map(|l| l.split(',').map(str::trim).map(String::from))
        .map(|s| s.rsplit("::").next().unwrap_or("").to_owned())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Field `readonly x:`/`readonly x?:` dari `export interface Name`, termasuk
/// yang diwarisi lewat `extends`.
fn ts_interface_fields(src: &str, name: &str) -> BTreeSet<String> {
    let needle = format!("export interface {name} ");
    let start = src
        .find(&needle)
        .unwrap_or_else(|| panic!("interface {name} ada di kontrak"));
    let open = start + src[start..].find('{').unwrap();
    let close = open + src[open..].find("\n}").unwrap();
    let header = &src[start..open];
    let mut fields: BTreeSet<String> = src[open + 1..close]
        .lines()
        .filter_map(|l| {
            let l = l.trim();
            let rest = l.strip_prefix("readonly ")?;
            let name: String = rest
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                .collect();
            (!name.is_empty()).then_some(name)
        })
        .collect();
    if let Some(parent) = header.split("extends").nth(1) {
        let parent = parent.trim().trim_end_matches('{').trim();
        fields.extend(ts_interface_fields(src, parent));
    }
    fields
}

fn json_keys<T: Serialize>(value: &T) -> BTreeSet<String> {
    serde_json::to_value(value)
        .unwrap()
        .as_object()
        .expect("struct kontrak diserialisasi sebagai objek")
        .keys()
        .cloned()
        .collect()
}

fn assert_same_shape<T: Serialize>(ts_name: &str, sample: &T) {
    let ts = ts_interface_fields(&contract_ts(), ts_name);
    let rust = json_keys(sample);
    assert_eq!(
        rust, ts,
        "kunci JSON Rust untuk {ts_name} harus sama dengan field interface TS-nya"
    );
}

/// Command yang sah ada di Rust tanpa ada di kontrak lokal: `ping` (D1) dan
/// dua command model (docs/20, kontrak wave 1 di `platform/desktop.ts`).
const OUTSIDE_CONTRACT: &[&str] = &["ping", "model_download", "model_read"];

#[test]
fn every_contract_command_is_registered_in_tauri() {
    let ts = ts_command_names(&contract_ts());
    let rust = rust_handler_names(&commands_rs());
    assert!(ts.len() >= 30, "parser TS gagal: {ts:?}");

    let missing: Vec<_> = ts.difference(&rust).collect();
    assert!(
        missing.is_empty(),
        "command kontrak yang belum terdaftar di generate_handler!: {missing:?}"
    );

    let extra: Vec<_> = rust
        .difference(&ts)
        .filter(|n| !OUTSIDE_CONTRACT.contains(&n.as_str()))
        .collect();
    assert!(
        extra.is_empty(),
        "command Rust yang tidak ada di kontrak TS: {extra:?}"
    );
}

#[test]
fn event_names_match_the_contract() {
    let ts = contract_ts();
    let rust = commands_rs();
    for (key, name) in [
        ("storeRelocate", "daw://store-relocate"),
        ("robloxProgress", "daw://roblox-progress"),
    ] {
        assert!(
            ts.contains(&format!("{key}: '{name}'")),
            "LOCAL_EVENTS.{key} = {name}"
        );
        assert!(
            rust.contains(&format!("\"{name}\"")),
            "Rust memancarkan {name}"
        );
    }
}

#[test]
fn secret_keys_match_the_contract() {
    let ts = contract_ts();
    for key in crate::SecretKey::ALL {
        assert!(
            ts.contains(&format!("'{}'", key.as_str())),
            "SecretKey {key} ada di kontrak"
        );
    }
}

#[test]
fn struct_shapes_match_the_contract() {
    assert_same_shape(
        "StoreInfo",
        &StoreInfo {
            dir: "/x".into(),
            bytes: 1,
            tracks: 2,
            projects: 3,
            schema_version: 1,
        },
    );
    let track = LocalTrack {
        hash: "h".into(),
        name: "n".into(),
        bytes: 1,
        mime: "audio/mpeg".into(),
        frames: 0,
        sample_rate: 0,
        marks: None,
        created_at: 1,
    };
    assert_same_shape("LocalTrack", &track);
    assert_same_shape(
        "ImportedTrack",
        &ImportedTrack {
            track: track.clone(),
            existed: false,
        },
    );
    assert_same_shape(
        "TrackMetaInput",
        &TrackMetaInput {
            hash: "h".into(),
            name: "n".into(),
            bytes: 1,
            mime: "m".into(),
            frames: 0,
            sample_rate: 0,
        },
    );
    let summary = ProjectSummary {
        id: "i".into(),
        name: "n".into(),
        updated_at: 1,
        version: 1,
    };
    assert_same_shape("LocalProjectSummary", &summary);
    assert_same_shape(
        "LocalProjectBody",
        &ProjectBody {
            summary,
            json: json!({}),
            tracks: vec![],
        },
    );
    assert_same_shape(
        "RobloxCategory",
        &Category {
            id: "i".into(),
            name: "n".into(),
            sort: 0,
        },
    );
    assert_same_shape(
        "RobloxGenre",
        &Genre {
            id: "i".into(),
            category_id: "c".into(),
            name: "n".into(),
            sort: 0,
        },
    );
    assert_same_shape("RobloxTaxonomy", &Taxonomy::default());
    let row = UploadRow {
        id: "i".into(),
        hash: "h".into(),
        file_name: "f".into(),
        bytes: 1,
        seconds: None,
        name: "n".into(),
        description: String::new(),
        category_id: None,
        genre_id: None,
        creator_kind: CreatorKind::User,
        creator_id: "1".into(),
        status: UploadStatus::Draft,
        operation_id: None,
        asset_id: None,
        moderation_state: None,
        error: None,
        created_at: 1,
        updated_at: 1,
        uploaded_at: None,
        approved_at: None,
    };
    assert_same_shape("RobloxUploadRow", &row);
    // Argumen `roblox_queue_put.row` = baris tanpa createdAt/updatedAt.
    let mut without_times = ts_interface_fields(&contract_ts(), "RobloxUploadRow");
    without_times.remove("createdAt");
    without_times.remove("updatedAt");
    let input: UploadInput = serde_json::from_value(serde_json::to_value(&row).unwrap()).unwrap();
    assert_eq!(json_keys(&input), without_times);
    assert_same_shape(
        "RobloxOperationState",
        &OperationState {
            done: false,
            asset_id: None,
            moderation_state: None,
        },
    );
    assert_same_shape("RobloxTargetSettings", &TargetSettings::default());
}

#[test]
fn enums_serialize_as_contract_string_literals() {
    let ts = contract_ts();
    for s in UploadStatus::ALL {
        assert_eq!(serde_json::to_value(s).unwrap(), json!(s.as_str()));
        assert!(
            ts.contains(&format!("'{}'", s.as_str())),
            "status {s} ada di RobloxUploadStatus"
        );
    }
    for m in [
        ModerationState::Reviewing,
        ModerationState::Approved,
        ModerationState::Rejected,
    ] {
        assert_eq!(serde_json::to_value(m).unwrap(), json!(m.as_str()));
        assert!(ts.contains(&format!("'{}'", m.as_str())));
    }
    assert_eq!(
        serde_json::to_value(CreatorKind::Group).unwrap(),
        json!("group")
    );
    // Argumen camelCase diterima apa adanya dari TS.
    let f: CatalogFilter =
        serde_json::from_value(json!({ "categoryId": "c", "query": "q" })).unwrap();
    assert_eq!(f.category_id.as_deref(), Some("c"));
    assert_eq!(f.genre_id, None);
}
