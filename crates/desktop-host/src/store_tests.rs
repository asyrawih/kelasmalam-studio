//! Tes K0 (docs/21 §2d) di atas SQLite sementara. Cetak birunya
//! `backend/src/library/worker.test.ts`: dedup, refcount hapus, versi
//! project — ditambah taksonomi/antrean/katalog Roblox, relokasi, dan
//! keychain (mock).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use serde_json::json;

use crate::tracks::{ensure_disk_space, sha256_hex};
use crate::types::{
    CatalogFilter, CreatorKind, ModerationState, TargetSettings, TrackMetaInput, UploadInput,
    UploadStatus,
};
use crate::{HostError, SecretKey, SecretStore, Store, DB_FILE, SCHEMA_VERSION, TRACKS_SUBDIR};

// ---------------------------------------------------------------- Helper

/// Store di folder sementara dengan jam yang maju 1 ms tiap dibaca —
/// `updated_at` jadi monoton dan bisa dibandingkan.
fn open_temp() -> (tempfile::TempDir, Store) {
    let tmp = tempfile::tempdir().unwrap();
    let store = open_at(tmp.path());
    (tmp, store)
}

fn open_at(dir: &Path) -> Store {
    let tick = Arc::new(AtomicI64::new(1_700_000_000_000));
    Store::open_with_clock(dir, Box::new(move || tick.fetch_add(1, Ordering::SeqCst))).unwrap()
}

/// Byte deterministik yang tidak monoton, supaya kesalahan offset ketahuan.
fn body(seed: u32, len: usize) -> Vec<u8> {
    let mut x: u32 = 0x9E37_79B9 ^ seed;
    (0..len)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            (x & 0xFF) as u8
        })
        .collect()
}

/// WAV PCM 16-bit mono yang sah: header 44 byte + `frames` sampel nol.
fn wav(sample_rate: u32, frames: u32) -> Vec<u8> {
    let data_len = frames * 2;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&(sample_rate * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    out.resize(44 + data_len as usize, 0);
    out
}

/// Tulis berkas sumber di folder terpisah (seperti berkas yang dijatuhkan
/// dari Finder) dan impor.
fn import(store: &Store, src_dir: &Path, name: &str, bytes: &[u8]) -> crate::types::ImportedTrack {
    let path = src_dir.join(name);
    std::fs::write(&path, bytes).unwrap();
    store.import_path(&path).unwrap()
}

/// Lagu dummy `.mp3` (byte acak — header tidak terbaca, frames 0).
fn seed_track(store: &Store, src_dir: &Path, name: &str, seed: u32) -> String {
    import(store, src_dir, name, &body(seed, 3_000)).track.hash
}

fn track_files(dir: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir.join(TRACKS_SUBDIR))
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    v.sort();
    v
}

fn upload_input(hash: &str, name: &str) -> UploadInput {
    UploadInput {
        id: String::new(),
        hash: hash.to_owned(),
        file_name: format!("{name}.mp3"),
        bytes: 0,
        seconds: Some(12.5),
        name: name.to_owned(),
        description: String::new(),
        category_id: Some("kat:musik".into()),
        genre_id: Some("gen:musik/lo-fi".into()),
        creator_kind: CreatorKind::User,
        creator_id: "123".into(),
        status: UploadStatus::Draft,
        operation_id: None,
        asset_id: None,
        moderation_state: None,
        error: None,
        uploaded_at: None,
        approved_at: None,
    }
}

// ------------------------------------------------------------------ Buka

#[test]
fn open_creates_layout_and_seeds_taxonomy() {
    let (tmp, store) = open_temp();
    assert!(tmp.path().join(DB_FILE).is_file());
    assert!(tmp.path().join(TRACKS_SUBDIR).is_dir());
    assert!(tmp.path().join(crate::MODELS_SUBDIR).is_dir());
    assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);

    let tax = store.taxonomy().unwrap();
    assert_eq!(
        tax.categories
            .iter()
            .map(|c| c.name.as_str())
            .collect::<Vec<_>>(),
        ["Musik", "Efek suara", "Suara"]
    );
    assert_eq!(tax.genres.len(), 9 + 5 + 3);
    assert!(tax
        .genres
        .iter()
        .all(|g| tax.categories.iter().any(|c| c.id == g.category_id)));

    let info = store.info().unwrap();
    assert_eq!(info.dir, tmp.path().to_string_lossy());
    assert_eq!(
        (info.tracks, info.projects, info.schema_version),
        (0, 0, SCHEMA_VERSION)
    );
    assert!(info.bytes > 0, "library.sqlite sendiri sudah punya ukuran");

    // WAL + foreign_keys memang menyala di koneksi ini.
    let mode: String = store
        .conn()
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .unwrap();
    assert_eq!(mode, "wal");
    let fk: i64 = store
        .conn()
        .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
        .unwrap();
    assert_eq!(fk, 1);
}

#[test]
fn reopen_keeps_data_and_does_not_reseed() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tempfile::tempdir().unwrap();
    let hash = {
        let store = open_at(tmp.path());
        // User menghapus satu genre bawaan; membuka ulang tidak boleh
        // mengembalikannya.
        store.delete_genre("gen:musik/chiptune").unwrap();
        seed_track(&store, src.path(), "a.mp3", 1)
    };
    let store = open_at(tmp.path());
    assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
    assert!(store.has_track(&hash).unwrap());
    assert_eq!(store.taxonomy().unwrap().genres.len(), 16);
}

// ---------------------------------------------------------------- Impor

#[test]
fn import_twice_yields_one_row_and_one_file() {
    let (tmp, store) = open_temp();
    let src = tempfile::tempdir().unwrap();
    let bytes = body(7, 50_000);

    let first = import(&store, src.path(), "Lagu Malam.mp3", &bytes);
    assert!(!first.existed);
    assert_eq!(first.track.hash, sha256_hex(&bytes));
    assert_eq!(first.track.name, "Lagu Malam.mp3");
    assert_eq!(first.track.bytes, 50_000);
    assert_eq!(first.track.mime, "audio/mpeg");
    assert_eq!(first.track.marks, None);

    // Nama berbeda, isi sama: dedup lewat hash.
    let second = import(&store, src.path(), "salinan.mp3", &bytes);
    assert!(second.existed);
    assert_eq!(second.track.hash, first.track.hash);
    assert_eq!(
        second.track.name, "Lagu Malam.mp3",
        "nama pertama yang menang"
    );

    assert_eq!(store.tracks().unwrap().len(), 1);
    let files = track_files(tmp.path());
    assert_eq!(files.len(), 1, "tidak ada .part yang tertinggal: {files:?}");
    assert_eq!(
        files[0].file_name().unwrap().to_string_lossy(),
        format!("{}.mp3", first.track.hash)
    );
    assert_eq!(store.blob(&first.track.hash).unwrap(), bytes);
    assert_eq!(store.info().unwrap().tracks, 1);
}

#[test]
fn import_reads_wav_header_for_duration() {
    let (_tmp, store) = open_temp();
    let src = tempfile::tempdir().unwrap();
    let got = import(&store, src.path(), "klik.WAV", &wav(44_100, 4_410));
    assert_eq!(got.track.mime, "audio/wav");
    assert_eq!(got.track.sample_rate, 44_100);
    assert_eq!(got.track.frames, 4_410);
}

#[test]
fn import_unreadable_header_falls_back_to_zero() {
    let (_tmp, store) = open_temp();
    let src = tempfile::tempdir().unwrap();
    let got = import(&store, src.path(), "rusak.flac", &body(3, 2_000));
    assert_eq!((got.track.frames, got.track.sample_rate), (0, 0));
    assert_eq!(got.track.mime, "audio/flac");
}

#[test]
fn import_rejects_unsupported_format() {
    let (tmp, store) = open_temp();
    let src = tempfile::tempdir().unwrap();
    let path = src.path().join("arsip.zip");
    std::fs::write(&path, b"PK").unwrap();
    match store.import_path(&path) {
        Err(HostError::Invalid(msg)) => assert!(msg.contains("zip"), "{msg}"),
        other => panic!("harus Invalid, dapat {other:?}"),
    }
    assert!(track_files(tmp.path()).is_empty());
}

#[test]
fn disk_full_is_reported_before_writing() {
    let (tmp, _store) = open_temp();
    match ensure_disk_space(&tmp.path().join(TRACKS_SUBDIR), u64::MAX) {
        Err(HostError::DiskFull { needed, .. }) => assert_eq!(needed, u64::MAX),
        other => panic!("harus DiskFull, dapat {other:?}"),
    }
    assert_eq!(
        HostError::DiskFull {
            needed: 1,
            available: 0
        }
        .code(),
        "DISK_FULL"
    );
}

// ---------------------------------------------------- put_bytes + commit

#[test]
fn put_bytes_then_commit_mirrors_upload_flow() {
    let (tmp, store) = open_temp();
    let bytes = body(9, 4_096);
    let hash = sha256_hex(&bytes);

    // Commit sebelum byte ada: ditolak (BELUM_TERUNGGAH).
    let meta = TrackMetaInput {
        hash: hash.clone(),
        name: "x.ogg".into(),
        bytes: 4_096,
        mime: "audio/ogg".into(),
        frames: 0,
        sample_rate: 0,
    };
    assert!(matches!(
        store.commit_track(&meta),
        Err(HostError::Invalid(_))
    ));
    assert!(!store.has_track(&hash).unwrap());

    // Hash bohong: ditolak, tidak ada berkas.
    assert!(matches!(
        store.put_bytes(&"0".repeat(64), "ogg", &bytes),
        Err(HostError::Invalid(_))
    ));
    assert!(matches!(
        store.put_bytes(&hash, "exe", &bytes),
        Err(HostError::Invalid(_))
    ));
    assert!(track_files(tmp.path()).is_empty());

    store.put_bytes(&hash, "ogg", &bytes).unwrap();
    assert!(
        !store.has_track(&hash).unwrap(),
        "put_bytes tidak menulis baris"
    );

    // Ukuran tidak cocok dengan yang di disk (UKURAN_TIDAK_COCOK).
    let wrong = TrackMetaInput {
        bytes: 999,
        ..meta.clone()
    };
    assert!(matches!(
        store.commit_track(&wrong),
        Err(HostError::Invalid(_))
    ));

    store.commit_track(&meta).unwrap();
    // Commit ulang (jaringan putus di antara PUT dan commit): idempoten.
    store
        .commit_track(&TrackMetaInput {
            name: "nama baru.ogg".into(),
            ..meta.clone()
        })
        .unwrap();
    let tracks = store.tracks().unwrap();
    assert_eq!(tracks.len(), 1);
    assert_eq!(tracks[0].name, "nama baru.ogg");
    assert_eq!(store.blob(&hash).unwrap(), bytes);

    // Commit ulang mengisi durasi yang tadinya 0 (probe `<audio>` di TS
    // sesudah import_path)...
    store
        .commit_track(&TrackMetaInput {
            frames: 96_000,
            sample_rate: 48_000,
            ..meta.clone()
        })
        .unwrap();
    let t = &store.tracks().unwrap()[0];
    assert_eq!((t.frames, t.sample_rate), (96_000, 48_000));
    // ...tapi 0 tidak pernah menimpa nilai yang sudah diketahui.
    store.commit_track(&meta).unwrap();
    let t = &store.tracks().unwrap()[0];
    assert_eq!((t.frames, t.sample_rate), (96_000, 48_000));
    // put_bytes ulang untuk hash yang sama: no-op, satu berkas.
    store.put_bytes(&hash, "ogg", &bytes).unwrap();
    assert_eq!(track_files(tmp.path()).len(), 1);
}

#[test]
fn blob_of_unknown_hash_is_not_found() {
    let (_tmp, store) = open_temp();
    assert!(matches!(
        store.blob(&"a".repeat(64)),
        Err(HostError::NotFound(_))
    ));
    assert!(matches!(
        store.blob("../etc/passwd"),
        Err(HostError::Invalid(_))
    ));
}

// ---------------------------------------------------------------- Marks

#[test]
fn marks_round_trip_and_require_track() {
    let (_tmp, store) = open_temp();
    let src = tempfile::tempdir().unwrap();
    let hash = seed_track(&store, src.path(), "a.mp3", 1);
    let marks = json!({ "cues": [{ "at": 1.5, "label": "drop" }], "bpm": 128 });
    store.put_marks(&hash, &marks).unwrap();
    assert_eq!(store.tracks().unwrap()[0].marks, Some(marks.clone()));

    // Menimpa, bukan menambah.
    store.put_marks(&hash, &json!({ "cues": [] })).unwrap();
    assert_eq!(
        store.tracks().unwrap()[0].marks,
        Some(json!({ "cues": [] }))
    );

    assert!(matches!(
        store.put_marks(&"b".repeat(64), &marks),
        Err(HostError::NotFound(_))
    ));
}

// --------------------------------------------------------------- Project

#[test]
fn project_versions_reject_stale_saves() {
    let (_tmp, mut store) = open_temp();
    let made = store
        .create_project("Set malam", &json!({ "v": 1 }), &[])
        .unwrap();
    assert_eq!(made.version, 1);

    // Tab A menyimpan versi 1 → 2.
    assert_eq!(
        store
            .update_project(&made.id, "Set malam", &json!({ "v": 2 }), 1)
            .unwrap(),
        2
    );
    // Tab B masih memegang versi 1: DIBERI TAHU, bukan ditimpa.
    match store.update_project(&made.id, "Set malam", &json!({ "v": 3 }), 1) {
        Err(HostError::VersionConflict { current }) => assert_eq!(current, 2),
        other => panic!("harus VersionConflict, dapat {other:?}"),
    }
    let body = store.project(&made.id).unwrap();
    assert_eq!(body.json, json!({ "v": 2 }));
    assert_eq!(body.summary.version, 2);
    assert_eq!(body.summary.name, "Set malam");

    // Project yang tidak ada: NotFound, bukan VersionConflict.
    assert!(matches!(
        store.update_project("tidak-ada", "x", &json!({}), 1),
        Err(HostError::NotFound(_))
    ));
    let e = HostError::VersionConflict { current: 2 }.to_local();
    assert_eq!((e.code, e.current_version), ("VERSION_CONFLICT", Some(2)));
}

#[test]
fn project_create_requires_known_tracks() {
    let (_tmp, mut store) = open_temp();
    match store.create_project("A", &json!({}), &["c".repeat(64)]) {
        Err(HostError::NotFound(msg)) => assert!(msg.contains(&"c".repeat(64))),
        other => panic!("harus NotFound, dapat {other:?}"),
    }
    assert!(
        store.projects().unwrap().is_empty(),
        "tidak ada baris setengah jadi"
    );
    assert!(matches!(
        store.create_project("  ", &json!({}), &[]),
        Err(HostError::Invalid(_))
    ));
}

#[test]
fn project_is_a_folder_and_lists_newest_first() {
    let (_tmp, mut store) = open_temp();
    let src = tempfile::tempdir().unwrap();
    let a = seed_track(&store, src.path(), "a.mp3", 1);
    let b = seed_track(&store, src.path(), "b.mp3", 2);

    let p1 = store
        .create_project("P1", &json!({ "lanes": [] }), std::slice::from_ref(&a))
        .unwrap();
    let p2 = store.create_project("P2", &json!({}), &[]).unwrap();
    let list = store.projects().unwrap();
    assert_eq!(
        list.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
        [p2.id.as_str(), p1.id.as_str()]
    );

    store.add_project_track(&p1.id, &b).unwrap();
    store.add_project_track(&p1.id, &b).unwrap(); // idempoten
    let body = store.project(&p1.id).unwrap();
    assert_eq!(body.tracks, vec![a.clone(), b.clone()]);
    assert_eq!(body.json, json!({ "lanes": [] }));

    // Mengganti timeline tidak membuang anggota folder.
    store
        .update_project(&p1.id, "P1", &json!({ "lanes": [1] }), 1)
        .unwrap();
    assert_eq!(store.project(&p1.id).unwrap().tracks.len(), 2);

    assert!(matches!(
        store.add_project_track("tidak-ada", &a),
        Err(HostError::NotFound(_))
    ));
    assert!(matches!(
        store.add_project_track(&p1.id, &"d".repeat(64)),
        Err(HostError::NotFound(_))
    ));

    // Hapus project: keanggotaan ikut, lagunya tidak.
    store.delete_project(&p1.id).unwrap();
    assert!(matches!(store.project(&p1.id), Err(HostError::NotFound(_))));
    assert!(matches!(
        store.delete_project(&p1.id),
        Err(HostError::NotFound(_))
    ));
    assert_eq!(store.tracks().unwrap().len(), 2);
    assert!(store.projects_referencing(&a).unwrap().is_empty());
}

// ------------------------------------------------------- Hapus & refcount

#[test]
fn delete_track_in_project_is_rejected_naming_the_project() {
    let (tmp, mut store) = open_temp();
    let src = tempfile::tempdir().unwrap();
    let a = seed_track(&store, src.path(), "a.mp3", 1);
    let p = store
        .create_project("Set malam", &json!({}), std::slice::from_ref(&a))
        .unwrap();
    let q = store
        .create_project("Besar", &json!({}), std::slice::from_ref(&a))
        .unwrap();

    match store.delete_track(&a) {
        Err(HostError::InUse { message, count }) => {
            assert_eq!(count, 2);
            assert!(
                message.contains("Set malam") && message.contains("Besar"),
                "{message}"
            );
            let local = HostError::InUse {
                message: message.clone(),
                count,
            }
            .to_local();
            assert_eq!((local.code, local.count), ("IN_USE", Some(2)));
        }
        other => panic!("harus InUse, dapat {other:?}"),
    }
    assert!(store.has_track(&a).unwrap());
    assert_eq!(track_files(tmp.path()).len(), 1);

    // Lepas dari satu folder: masih dipakai yang lain → lagu tetap.
    assert!(!store.remove_project_track(&p.id, &a).unwrap());
    assert!(store.has_track(&a).unwrap());
    // Lepas dari folder terakhir: lagu ikut hilang, berkas juga.
    assert!(store.remove_project_track(&q.id, &a).unwrap());
    assert!(!store.has_track(&a).unwrap());
    assert!(track_files(tmp.path()).is_empty());
    // Lepas yang sudah tidak ada: false, bukan error.
    assert!(!store.remove_project_track(&q.id, &a).unwrap());
    assert!(matches!(
        store.delete_track(&a),
        Err(HostError::NotFound(_))
    ));
}

#[test]
fn unused_track_can_be_deleted_with_its_file_and_marks() {
    let (tmp, mut store) = open_temp();
    let src = tempfile::tempdir().unwrap();
    let a = seed_track(&store, src.path(), "a.mp3", 1);
    let b = seed_track(&store, src.path(), "b.mp3", 2);
    store
        .create_project("A", &json!({}), std::slice::from_ref(&a))
        .unwrap();
    store.put_marks(&b, &json!({ "cues": [] })).unwrap();

    store.delete_track(&b).unwrap();
    assert_eq!(store.tracks().unwrap().len(), 1);
    assert_eq!(track_files(tmp.path()).len(), 1);
    let marks: i64 = store
        .conn()
        .query_row("SELECT COUNT(*) FROM marks", [], |r| r.get(0))
        .unwrap();
    assert_eq!(marks, 0, "marks ikut terhapus");
}

#[test]
fn active_roblox_upload_blocks_delete_but_settled_one_does_not() {
    let (_tmp, mut store) = open_temp();
    let src = tempfile::tempdir().unwrap();
    let a = seed_track(&store, src.path(), "a.mp3", 1);
    let row = store.queue_put(&upload_input(&a, "Lagu")).unwrap();

    match store.delete_track(&a) {
        Err(HostError::InUse { count, message }) => {
            assert_eq!(count, 1);
            assert!(message.contains("antrean"), "{message}");
        }
        other => panic!("harus InUse, dapat {other:?}"),
    }
    // Lewat folder project pun sama: refcount menghitung antrean.
    let p = store
        .create_project("P", &json!({}), std::slice::from_ref(&a))
        .unwrap();
    assert!(!store.remove_project_track(&p.id, &a).unwrap());
    assert!(store.has_track(&a).unwrap());

    // Sudah selesai: lagunya boleh dihapus, dan baris KATALOG-nya bertahan
    // lengkap dengan `bytes` (migrasi 0002 — assetId-nya masih hidup di
    // Creator Hub; catatan di mesin ini tidak boleh ikut lenyap).
    let bytes_before = row.bytes;
    store.mark_failed(&row.id, "ditolak").unwrap();
    store.delete_track(&a).unwrap();
    assert!(!store.has_track(&a).unwrap());
    let catalog = store.catalog_list(&CatalogFilter::default()).unwrap();
    assert_eq!(catalog.len(), 1);
    assert_eq!(catalog[0].id, row.id);
    assert_eq!(
        catalog[0].hash, a,
        "hash tetap menunjuk lagu yang sudah tiada"
    );
    assert_eq!(catalog[0].bytes, bytes_before);
    assert_eq!(catalog[0].status, UploadStatus::Failed);

    // Baris katalog tanpa lagu masih bisa ditulis ulang oleh TS (upsert
    // dengan id yang sama) — `bytes` lamanya dipertahankan; baris BARU untuk
    // lagu yang tidak ada tetap ditolak.
    let mut again = upload_input(&a, "Lagu (ganti nama)");
    again.id = row.id.clone();
    again.status = UploadStatus::Failed;
    let rewritten = store.queue_put(&again).unwrap();
    assert_eq!(rewritten.bytes, bytes_before);
    assert_eq!(rewritten.name, "Lagu (ganti nama)");
    assert!(matches!(
        store.queue_put(&upload_input(&a, "baru")),
        Err(HostError::NotFound(_))
    ));

    // Dan barisnya tetap bisa dihapus dari katalog seperti biasa.
    store.queue_remove(&row.id).unwrap();
    assert!(store
        .catalog_list(&CatalogFilter::default())
        .unwrap()
        .is_empty());
}

/// Folder yang dibuka versi pra-0002 (FK CASCADE, tanpa kolom `bytes`)
/// bermigrasi tanpa kehilangan baris, `bytes` diisi dari `track`, dan FK-nya
/// benar-benar lepas: sesudah migrasi, hapus lagu tidak menyeret barisnya.
#[test]
fn migration_0002_keeps_uploads_fills_bytes_and_drops_cascade() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join(DB_FILE);
    {
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        conn.execute_batch("CREATE TABLE schema_version (version INTEGER NOT NULL)")
            .unwrap();
        conn.execute_batch(include_str!("../migrations/0001_init.sql"))
            .unwrap();
        conn.execute("INSERT INTO schema_version (version) VALUES (1)", [])
            .unwrap();
        conn.execute(
            "INSERT INTO track (hash, name, bytes, mime, frames, sample_rate, created_at)
             VALUES ('h1', 'a.mp3', 4321, 'audio/mpeg', 0, 0, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO roblox_upload (id, hash, file_name, name, category_id, genre_id,
                creator_kind, creator_id, status, asset_id, moderation_state, created_at, updated_at, approved_at)
             VALUES ('u1', 'h1', 'a.mp3', 'A', 'kat:musik', 'gen:musik/lo-fi',
                'user', '1', 'done', 'asset-1', 'approved', 1, 2, 3)",
            [],
        )
        .unwrap();
        // Kolom `bytes` belum ada di 0001 — itulah yang dimigrasi.
        assert!(conn.execute("SELECT bytes FROM roblox_upload", []).is_err());
    }

    let store = open_at(tmp.path());
    // Membuka folder lama menjalankan SEMUA migrasi yang tersisa, bukan hanya
    // 0002 — jadi yang diperiksa versi akhirnya, bukan angka 2.
    assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
    let row = store.upload("u1").unwrap();
    assert_eq!(row.bytes, 4321, "bytes disalin dari track");
    assert_eq!(row.asset_id.as_deref(), Some("asset-1"));
    assert_eq!(row.status, UploadStatus::Done);
    assert_eq!(row.moderation_state, Some(ModerationState::Approved));
    assert_eq!(row.approved_at, Some(3));

    // FK sudah lepas: DELETE track langsung di SQL pun tidak menyeret baris.
    store
        .conn()
        .execute("DELETE FROM track WHERE hash = 'h1'", [])
        .unwrap();
    assert_eq!(store.upload("u1").unwrap().bytes, 4321);
    // Indeks dibuat ulang dengan nama yang sama.
    let indexes: i64 = store
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index'
               AND name IN ('roblox_upload_status', 'roblox_upload_hash', 'roblox_upload_genre', 'roblox_upload_category')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(indexes, 4);
    // FK ke taksonomi tetap ditegakkan.
    assert!(store
        .conn()
        .execute(
            "UPDATE roblox_upload SET genre_id = 'gen:tidak-ada' WHERE id = 'u1'",
            []
        )
        .is_err());
    // Buka lagi: migrasi tidak dijalankan dua kali.
    drop(store);
    let store = open_at(tmp.path());
    assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
    assert_eq!(store.upload("u1").unwrap().bytes, 4321);
}

// ------------------------------------------------------------- Taksonomi

#[test]
fn taxonomy_upsert_rename_move_and_duplicates() {
    let (_tmp, store) = open_temp();
    let cat = store.upsert_category(None, "  Podcast ", None).unwrap();
    assert_eq!(cat.name, "Podcast");
    assert_eq!(cat.sort, 3, "sort bawaan = paling akhir");
    assert!(matches!(
        store.upsert_category(None, "Musik", None),
        Err(HostError::Invalid(_))
    ));
    assert!(matches!(
        store.upsert_category(Some("tidak-ada"), "X", None),
        Err(HostError::Invalid(_)) | Err(HostError::NotFound(_))
    ));
    // Ganti nama, sort dipertahankan.
    let renamed = store
        .upsert_category(Some(&cat.id), "Siniar", None)
        .unwrap();
    assert_eq!((renamed.name.as_str(), renamed.sort), ("Siniar", 3));

    let genre = store
        .upsert_genre(None, &cat.id, "Wawancara", None)
        .unwrap();
    assert_eq!(genre.sort, 0);
    assert!(
        matches!(
            store.upsert_genre(None, &cat.id, "wawancara", None),
            Err(HostError::Invalid(_))
        ),
        "nama kembar beda huruf besar-kecil tetap kembar"
    );
    assert!(matches!(
        store.upsert_genre(None, "tidak-ada", "X", None),
        Err(HostError::NotFound(_))
    ));
    // Nama yang sama di kategori lain boleh.
    store
        .upsert_genre(None, "kat:musik", "Wawancara", None)
        .unwrap();

    // Pindah genre ke kategori lain.
    let moved = store
        .upsert_genre(Some(&genre.id), "kat:suara", "Wawancara", Some(9))
        .unwrap();
    assert_eq!((moved.category_id.as_str(), moved.sort), ("kat:suara", 9));
    let tax = store.taxonomy().unwrap();
    assert!(tax
        .genres
        .iter()
        .any(|g| g.id == genre.id && g.category_id == "kat:suara"));
}

#[test]
fn delete_genre_in_use_reports_count() {
    let (_tmp, store) = open_temp();
    let src = tempfile::tempdir().unwrap();
    let a = seed_track(&store, src.path(), "a.mp3", 1);
    let b = seed_track(&store, src.path(), "b.mp3", 2);
    store.queue_put(&upload_input(&a, "A")).unwrap();
    store.queue_put(&upload_input(&b, "B")).unwrap();

    match store.delete_genre("gen:musik/lo-fi") {
        Err(HostError::InUse { count, message }) => {
            assert_eq!(count, 2);
            assert!(
                message.contains("Lo-fi") && message.contains('2'),
                "{message}"
            );
        }
        other => panic!("harus InUse, dapat {other:?}"),
    }
    store.delete_genre("gen:musik/jazz").unwrap();
    assert!(matches!(
        store.delete_genre("gen:musik/jazz"),
        Err(HostError::NotFound(_))
    ));

    // Kategori dengan lagu: count = lagu; tanpa lagu tapi ada genre: count = genre.
    match store.delete_category("kat:musik") {
        Err(HostError::InUse { count, .. }) => assert_eq!(count, 2),
        other => panic!("harus InUse, dapat {other:?}"),
    }
    match store.delete_category("kat:suara") {
        Err(HostError::InUse { count, message }) => {
            assert_eq!(count, 3);
            assert!(message.contains("genre"), "{message}");
        }
        other => panic!("harus InUse, dapat {other:?}"),
    }
    for g in ["gen:suara/jingle", "gen:suara/narasi", "gen:suara/vokal"] {
        store.delete_genre(g).unwrap();
    }
    store.delete_category("kat:suara").unwrap();
    assert_eq!(store.taxonomy().unwrap().categories.len(), 2);
}

#[test]
fn queue_put_accepts_ids_made_by_ts() {
    let (_tmp, store) = open_temp();
    let src = tempfile::tempdir().unwrap();
    let a = seed_track(&store, src.path(), "a.mp3", 1);
    let mut input = upload_input(&a, "Dari TS");
    input.id = "8b1f5c1e-0000-4000-8000-000000000001".into();
    let row = store.queue_put(&input).unwrap();
    assert_eq!(row.id, input.id, "id non-kosong yang belum ada = INSERT");
    assert_eq!(
        store.upload_genre_names(&row.id).unwrap(),
        Some(("Musik".to_owned(), "Lo-fi".to_owned()))
    );
    input.genre_id = None;
    input.category_id = None;
    store.queue_put(&input).unwrap();
    assert_eq!(store.upload_genre_names(&row.id).unwrap(), None);
    assert!(matches!(
        store.upload_genre_names("tidak-ada"),
        Err(HostError::NotFound(_))
    ));
}

#[test]
fn moving_a_genre_moves_its_uploads_category() {
    let (_tmp, store) = open_temp();
    let src = tempfile::tempdir().unwrap();
    let a = seed_track(&store, src.path(), "a.mp3", 1);
    let row = store.queue_put(&upload_input(&a, "A")).unwrap();
    store
        .upsert_genre(Some("gen:musik/lo-fi"), "kat:suara", "Lo-fi", None)
        .unwrap();
    assert_eq!(
        store.upload(&row.id).unwrap().category_id.as_deref(),
        Some("kat:suara")
    );
}

// ------------------------------------------------------ Antrean & katalog

#[test]
fn queue_put_assigns_id_and_times_and_validates_references() {
    let (_tmp, store) = open_temp();
    let src = tempfile::tempdir().unwrap();
    let a = seed_track(&store, src.path(), "a.mp3", 1);

    let row = store.queue_put(&upload_input(&a, "Lagu")).unwrap();
    assert!(!row.id.is_empty());
    assert_eq!(row.bytes, 3_000, "bytes dari track, bukan dari input");
    assert_eq!(row.seconds, Some(12.5));
    assert_eq!(row.status, UploadStatus::Draft);
    assert!(row.created_at > 0 && row.updated_at >= row.created_at);

    // Upsert dengan id yang sama: createdAt tetap, updatedAt maju.
    let mut again = upload_input(&a, "Lagu (edit)");
    again.id = row.id.clone();
    again.status = UploadStatus::Queued;
    let updated = store.queue_put(&again).unwrap();
    assert_eq!(updated.id, row.id);
    assert_eq!(updated.created_at, row.created_at);
    assert!(updated.updated_at > row.updated_at);
    assert_eq!(updated.name, "Lagu (edit)");
    assert_eq!(store.queue_list().unwrap().len(), 1);

    // Referensi yang tidak ada / tidak konsisten.
    let mut bad = upload_input(&"e".repeat(64), "X");
    assert!(matches!(store.queue_put(&bad), Err(HostError::NotFound(_))));
    bad = upload_input(&a, "X");
    bad.genre_id = Some("gen:efek-suara/ui".into()); // bukan milik "kat:musik"
    assert!(matches!(store.queue_put(&bad), Err(HostError::Invalid(_))));
    bad = upload_input(&a, "X");
    bad.genre_id = Some("tidak-ada".into());
    assert!(matches!(store.queue_put(&bad), Err(HostError::NotFound(_))));
    bad = upload_input(&a, "X");
    bad.category_id = None;
    bad.genre_id = None;
    store.queue_put(&bad).unwrap(); // draft tanpa genre boleh — validasi unggah di TS

    store.queue_remove(&row.id).unwrap();
    assert!(matches!(
        store.queue_remove(&row.id),
        Err(HostError::NotFound(_))
    ));
}

#[test]
fn status_transitions_and_catalog_split() {
    let (_tmp, store) = open_temp();
    let src = tempfile::tempdir().unwrap();
    let a = seed_track(&store, src.path(), "a.mp3", 1);
    let b = seed_track(&store, src.path(), "b.mp3", 2);
    let ra = store.queue_put(&upload_input(&a, "Lo-fi malam")).unwrap();
    let mut ib = upload_input(&b, "Tembakan");
    ib.category_id = Some("kat:efek-suara".into());
    ib.genre_id = Some("gen:efek-suara/senjata".into());
    let rb = store.queue_put(&ib).unwrap();

    let up = store.mark_uploading(&ra.id).unwrap();
    assert_eq!(up.status, UploadStatus::Uploading);
    let proc = store.mark_processing(&ra.id, "op-1").unwrap();
    assert_eq!(proc.status, UploadStatus::Processing);
    assert_eq!(proc.operation_id.as_deref(), Some("op-1"));
    assert_eq!(proc.moderation_state, Some(ModerationState::Reviewing));
    assert!(proc.uploaded_at.is_some());
    assert_eq!(
        store.queue_list().unwrap().len(),
        2,
        "processing masih antrean"
    );
    assert!(store
        .catalog_list(&CatalogFilter::default())
        .unwrap()
        .is_empty());

    let done = store
        .mark_done(&ra.id, Some("asset-9"), ModerationState::Approved)
        .unwrap();
    assert_eq!(done.status, UploadStatus::Done);
    assert_eq!(done.asset_id.as_deref(), Some("asset-9"));
    assert!(done.approved_at.is_some());
    let failed = store.mark_failed(&rb.id, "HTTP 429").unwrap();
    assert_eq!(failed.status, UploadStatus::Failed);
    assert_eq!(failed.error.as_deref(), Some("HTTP 429"));
    assert!(failed.approved_at.is_none());

    assert!(store.queue_list().unwrap().is_empty());
    let catalog = store.catalog_list(&CatalogFilter::default()).unwrap();
    assert_eq!(catalog.len(), 2);
    assert_eq!(catalog[0].id, rb.id, "terbaru dulu");

    // Filter kategori / genre / teks.
    let musik = store
        .catalog_list(&CatalogFilter {
            category_id: Some("kat:musik".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(
        musik.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
        [ra.id.as_str()]
    );
    let senjata = store
        .catalog_list(&CatalogFilter {
            genre_id: Some("gen:efek-suara/senjata".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(senjata.len(), 1);
    let by_asset = store
        .catalog_list(&CatalogFilter {
            query: Some("asset-9".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(by_asset.len(), 1);
    let escaped = store
        .catalog_list(&CatalogFilter {
            query: Some("%".into()),
            ..Default::default()
        })
        .unwrap();
    assert!(
        escaped.is_empty(),
        "wildcard user di-escape, bukan cocok semua"
    );
    let none = store
        .catalog_list(&CatalogFilter {
            category_id: Some("kat:musik".into()),
            genre_id: Some("gen:efek-suara/senjata".into()),
            ..Default::default()
        })
        .unwrap();
    assert!(none.is_empty());

    assert!(matches!(
        store.mark_uploading("tidak-ada"),
        Err(HostError::NotFound(_))
    ));
}

#[test]
fn target_settings_default_and_round_trip() {
    let (_tmp, store) = open_temp();
    assert_eq!(store.target().unwrap(), TargetSettings::default());
    let t = TargetSettings {
        creator_kind: CreatorKind::Group,
        creator_id: " 4242 ".into(),
        genre_to_description: false,
    };
    store.set_target(&t).unwrap();
    assert_eq!(
        store.target().unwrap(),
        TargetSettings {
            creator_id: "4242".into(),
            ..t
        }
    );
}

// --------------------------------------------------------------- Relokasi

#[test]
fn relocate_moves_everything_and_reports_progress() {
    let (old, mut store) = open_temp();
    let src = tempfile::tempdir().unwrap();
    let a = seed_track(&store, src.path(), "a.mp3", 1);
    let b = seed_track(&store, src.path(), "b.wav", 2);
    store.put_marks(&a, &json!({ "cues": [1] })).unwrap();
    // Sisa .part yang tertinggal tidak ikut dipindah.
    std::fs::write(old.path().join(TRACKS_SUBDIR).join("x.part"), b"sisa").unwrap();

    let parent = tempfile::tempdir().unwrap();
    let new_dir = parent.path().join("Kepustakaan");
    let mut calls = Vec::new();
    let mut committed = None;
    let info = store
        .relocate(
            &new_dir,
            |done, total| calls.push((done, total)),
            |dir| {
                committed = Some(dir.to_path_buf());
                Ok(())
            },
        )
        .unwrap();

    assert_eq!(committed.as_deref(), Some(new_dir.as_path()));
    assert_eq!(info.dir, new_dir.to_string_lossy());
    assert_eq!(info.tracks, 2);
    assert_eq!(store.dir(), new_dir);
    assert!(!old.path().exists(), "folder lama dihapus");
    assert_eq!(track_files(&new_dir).len(), 2);
    assert!(
        calls.windows(2).all(|w| w[0].0 <= w[1].0),
        "progres monoton"
    );
    let (_, total) = calls[0];
    assert!(total > 0 && calls.iter().all(|&(_, t)| t == total));
    assert_eq!(*calls.last().unwrap(), (total, total));

    // Store yang sama masih bekerja di folder baru...
    assert_eq!(store.tracks().unwrap().len(), 2);
    assert_eq!(store.blob(&b).unwrap().len(), 3_000);
    assert_eq!(
        store
            .tracks()
            .unwrap()
            .iter()
            .find(|t| t.hash == a)
            .unwrap()
            .marks,
        Some(json!({ "cues": [1] }))
    );
    // ...dan begitu pula kalau dibuka lagi dari nol (seperti app dibuka ulang).
    drop(store);
    let reopened = open_at(&new_dir);
    assert_eq!(reopened.tracks().unwrap().len(), 2);
}

#[test]
fn relocate_failed_commit_leaves_old_folder_intact() {
    let (old, mut store) = open_temp();
    let src = tempfile::tempdir().unwrap();
    let a = seed_track(&store, src.path(), "a.mp3", 1);
    let parent = tempfile::tempdir().unwrap();
    let new_dir = parent.path().join("baru");

    let err = store
        .relocate(
            &new_dir,
            |_, _| {},
            |_| {
                Err(HostError::Io(std::io::Error::other(
                    "config tidak bisa ditulis",
                )))
            },
        )
        .expect_err("commit gagal harus error");
    assert!(matches!(err, HostError::Io(_)));
    assert_eq!(store.dir(), old.path());
    assert!(!new_dir.exists(), "salinan setengah jadi dibersihkan");
    assert_eq!(track_files(old.path()).len(), 1);
    assert_eq!(store.blob(&a).unwrap().len(), 3_000);
    assert_eq!(store.tracks().unwrap().len(), 1);
    // Masih bisa menulis: koneksi dibuka lagi di folder lama.
    store.put_marks(&a, &json!({})).unwrap();
}

#[cfg(unix)]
#[test]
fn relocate_copy_failure_midway_leaves_old_folder_intact() {
    use std::os::unix::fs::PermissionsExt;
    let (old, mut store) = open_temp();
    let src = tempfile::tempdir().unwrap();
    let a = seed_track(&store, src.path(), "a.mp3", 1);
    let parent = tempfile::tempdir().unwrap();
    let new_dir = parent.path().join("baru");
    std::fs::create_dir(&new_dir).unwrap();
    // Folder tujuan kosong tapi tidak bisa ditulis: salinan gagal di tengah.
    std::fs::set_permissions(&new_dir, std::fs::Permissions::from_mode(0o500)).unwrap();
    if std::fs::write(new_dir.join("probe"), b"").is_ok() {
        // Berjalan sebagai root: izin tidak berlaku, tes ini tidak bermakna.
        return;
    }

    let mut committed = false;
    let err = store
        .relocate(
            &new_dir,
            |_, _| {},
            |_| {
                committed = true;
                Ok(())
            },
        )
        .expect_err("salinan gagal harus error");
    assert!(matches!(err, HostError::Io(_)), "{err:?}");
    assert!(
        !committed,
        "commit tidak boleh dipanggil kalau salinan gagal"
    );
    assert_eq!(store.dir(), old.path());
    assert_eq!(track_files(old.path()).len(), 1);
    assert_eq!(store.blob(&a).unwrap().len(), 3_000);
    store.put_marks(&a, &json!({})).unwrap();
    // Folder tujuan yang kosong boleh sudah dibersihkan; kalau masih ada,
    // kembalikan izinnya supaya tempdir bisa dihapus.
    let _ = std::fs::set_permissions(&new_dir, std::fs::Permissions::from_mode(0o700));
}

#[test]
fn relocate_rejects_nested_or_non_empty_targets() {
    let (old, mut store) = open_temp();
    let inside = old.path().join("dalam");
    assert!(matches!(
        store.relocate(&inside, |_, _| {}, |_| Ok(())),
        Err(HostError::Invalid(_))
    ));
    let parent = tempfile::tempdir().unwrap();
    std::fs::write(parent.path().join("isi.txt"), b"x").unwrap();
    assert!(matches!(
        store.relocate(parent.path(), |_, _| {}, |_| Ok(())),
        Err(HostError::Invalid(_))
    ));
    assert!(matches!(
        store.relocate(old.path(), |_, _| {}, |_| Ok(())),
        Err(HostError::Invalid(_))
    ));
    assert_eq!(store.dir(), old.path());
    assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
}

// ------------------------------------------------------------ SecretStore

#[test]
fn secret_in_memory_round_trip() {
    let store = SecretStore::in_memory("app.kelasmalam.test");
    assert!(!store.is_persistent());
    assert_eq!(store.service(), "app.kelasmalam.test");
    assert_eq!(store.get(SecretKey::RobloxApiKey).unwrap(), None);

    store.set(SecretKey::RobloxApiKey, "key-1").unwrap();
    assert_eq!(
        store.get(SecretKey::RobloxApiKey).unwrap().as_deref(),
        Some("key-1")
    );
    assert_eq!(
        store.get(SecretKey::RobloxCookie).unwrap(),
        None,
        "kunci terpisah"
    );

    store.set(SecretKey::RobloxApiKey, "key-2").unwrap();
    assert_eq!(
        store.get(SecretKey::RobloxApiKey).unwrap().as_deref(),
        Some("key-2")
    );
    assert!(matches!(
        store.set(SecretKey::RobloxCookie, "  "),
        Err(HostError::Invalid(_))
    ));

    store.clear(SecretKey::RobloxApiKey).unwrap();
    assert_eq!(store.get(SecretKey::RobloxApiKey).unwrap(), None);
    store
        .clear(SecretKey::RobloxApiKey)
        .unwrap_or_else(|e| panic!("clear kedua idempoten: {e}"));
    assert!(
        !format!("{store:?}").contains("key-2"),
        "Debug tidak membocorkan nilai"
    );
}

#[test]
fn secret_keys_are_a_closed_list() {
    assert_eq!(
        "roblox.api_key".parse::<SecretKey>().unwrap(),
        SecretKey::RobloxApiKey
    );
    assert_eq!(
        "roblox.cookie".parse::<SecretKey>().unwrap(),
        SecretKey::RobloxCookie
    );
    match "session.token".parse::<SecretKey>() {
        Err(HostError::Invalid(msg)) => assert!(msg.contains("session.token")),
        other => panic!("harus Invalid, dapat {other:?}"),
    }
    let a = SecretStore::in_memory("svc");
    let b = SecretStore::in_memory("svc");
    a.set(SecretKey::RobloxCookie, "milik-a").unwrap();
    assert_eq!(
        b.get(SecretKey::RobloxCookie).unwrap(),
        None,
        "store in-memory tidak berbagi isi"
    );
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
#[test]
fn secret_new_falls_back_to_memory_on_unsupported_os() {
    // Di Linux (CI Ubuntu) `new` harus tetap bisa dipakai tanpa dbus.
    let store = SecretStore::new("app.kelasmalam.test");
    assert!(!store.is_persistent());
    store.set(SecretKey::RobloxApiKey, "x").unwrap();
    assert_eq!(
        store.get(SecretKey::RobloxApiKey).unwrap().as_deref(),
        Some("x")
    );
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[test]
fn secret_new_uses_native_store_without_touching_it() {
    // Hanya konstruksi: tidak ada get/set supaya tes tidak memicu prompt
    // Keychain di mesin pengembang atau runner.
    let store = SecretStore::new("app.kelasmalam.test");
    assert!(store.is_persistent());
    assert!(format!("{store:?}").contains("app.kelasmalam.test"));
}

// ---------------------------------------------------------- LocalError

#[test]
fn local_error_serializes_like_the_contract() {
    let plain =
        serde_json::to_value(HostError::NotFound("lagu tidak ada".into()).to_local()).unwrap();
    assert_eq!(
        plain,
        json!({ "code": "NOT_FOUND", "message": "lagu tidak ada" })
    );

    let in_use = serde_json::to_value(
        HostError::InUse {
            message: "dipakai".into(),
            count: 3,
        }
        .to_local(),
    )
    .unwrap();
    assert_eq!(
        in_use,
        json!({ "code": "IN_USE", "message": "dipakai", "count": 3 })
    );

    let http = serde_json::to_value(
        HostError::HttpStatus {
            status: 429,
            url: "u".into(),
        }
        .to_local(),
    )
    .unwrap();
    assert_eq!(http["code"], "HTTP");
    assert_eq!(http["status"], 429);

    assert_eq!(
        HostError::KeyringUnavailable("x".into()).code(),
        "SECRET_UNAVAILABLE"
    );
    assert_eq!(HostError::Invalid("x".into()).code(), "INVALID");
    assert_eq!(HostError::Io(std::io::Error::other("x")).code(), "IO");
}
