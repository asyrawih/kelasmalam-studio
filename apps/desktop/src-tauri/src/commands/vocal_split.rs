//! `vocal_split_*` (docs/26 P3b) — pemisahan vokal Kim_Vocal_2 native di
//! Rust (`daw_desktop_host::vocal_split`), PCM masuk dan keluar lewat IPC
//! biner sekali jalan.
//!
//! Kontrak (cermin `apps/desktop/src/platform/local-commands.ts`):
//!
//! - `vocal_split_run`: badan MENTAH Float32 little-endian `[left(N), right(N)]`
//!   pada 44 100 Hz (TS sudah me-resample dan menggandakan mono). Header
//!   wajib `x-job-id`, `x-frames` (N), `x-model` (`kim-vocal-2`), `x-overlap`
//!   (`0.25` | `0.5`), `x-denoise` (`0` | `1`), `x-accel` (`cpu` | `coreml`);
//!   opsional `x-threads`. Balasan biner Float32 LE
//!   `[voc_l(N), voc_r(N), inst_l(N), inst_r(N)]`. Progres per segmen lewat
//!   event `daw://vocal-split-progress` `{ id, done, total }`.
//! - `vocal_split_cancel(id)`: menyalakan flag batal job itu; `vocal_split_run`
//!   lalu gagal dengan kode `CANCELLED`.
//! - `vocal_split_accels()`: `["cpu"]` atau `["cpu", "coreml"]` di macOS.
//!
//! Kode galat khusus: `MODEL_MISSING` (berkas model belum diunduh — TS
//! memanggil `model_download` dulu), `BUSY` (job lain sedang berjalan; satu
//! sesi ORT dipakai bergiliran, bukan diantre di sini), `CANCELLED`,
//! `INFERENCE` (ORT menolak).
//!
//! Model tinggal di `<folder kepustakaan>/models/` seperti `model_download`.
//! Sesi ORT di-cache per `(model, accel)` di `AppState.vocal_split`; job
//! berjalan di `spawn_blocking` sambil memegang `Mutex`-nya, sehingga
//! `try_lock` yang gagal = `BUSY`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, TryLockError};

use daw_desktop_host::vocal_split::{
    mdx_params, separate, Accel, SeparateOptions, VocalSplitEngine,
};
use daw_desktop_host::{model_path, ModelId};
use serde::Serialize;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, State};

use super::{with_store, AppState, CmdError, CmdResult, VOCAL_SPLIT_PROGRESS_EVENT};

/// Flag batal per job, dipegang `AppState.vocal_split_jobs`.
pub type VocalSplitJobs = Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>;

/// Sesi ORT yang di-cache, dipegang `AppState.vocal_split`.
pub type VocalSplitState = Arc<Mutex<VocalSplitEngine>>;

#[derive(Clone, Serialize)]
struct VocalSplitProgress<'a> {
    id: &'a str,
    done: u64,
    total: u64,
}

/// Sample rate yang dituntut model; TS me-resample sebelum mengirim.
const SAMPLE_RATE: u32 = 44_100;

fn lock_jobs(jobs: &VocalSplitJobs) -> std::sync::MutexGuard<'_, HashMap<String, Arc<AtomicBool>>> {
    jobs.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn invalid(message: impl Into<String>) -> CmdError {
    CmdError::new("INVALID", message)
}

#[tauri::command]
pub async fn vocal_split_run(
    app: AppHandle,
    state: State<'_, AppState>,
    request: Request<'_>,
) -> CmdResult<Response> {
    let header = |name: &str| -> CmdResult<String> {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
            .ok_or_else(|| invalid(format!("header {name} wajib ada")))
    };
    let optional = |name: &str| -> Option<String> {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
    };

    let id = header("x-job-id")?;
    let frames: usize = header("x-frames")?
        .parse()
        .map_err(|_| invalid("x-frames harus bilangan bulat"))?;
    if frames == 0 {
        return Err(invalid("x-frames harus > 0"));
    }
    let model_id: ModelId = header("x-model")?.parse().map_err(CmdError::from)?;
    let params = mdx_params(model_id)
        .ok_or_else(|| invalid(format!("model {model_id} bukan model MDX-Net")))?;
    let overlap: f32 = match header("x-overlap")?.as_str() {
        "0.25" => 0.25,
        "0.5" => 0.5,
        other => return Err(invalid(format!("x-overlap {other:?} harus 0.25 atau 0.5"))),
    };
    let denoise = match header("x-denoise")?.as_str() {
        "0" => false,
        "1" => true,
        other => return Err(invalid(format!("x-denoise {other:?} harus 0 atau 1"))),
    };
    let threads = match optional("x-threads") {
        Some(t) => Some(
            t.parse::<usize>()
                .map_err(|_| invalid("x-threads harus bilangan bulat"))?,
        ),
        None => None,
    };
    let accel = Accel::parse(&header("x-accel")?, threads).map_err(CmdError::from)?;
    if let Some(rate) = optional("x-sample-rate") {
        if rate != SAMPLE_RATE.to_string() {
            return Err(invalid(format!(
                "sample rate {rate} tidak didukung; kirim {SAMPLE_RATE} Hz"
            )));
        }
    }

    let bytes: &[u8] = match request.body() {
        InvokeBody::Raw(bytes) => bytes,
        InvokeBody::Json(_) => {
            return Err(invalid(
                "vocal_split_run butuh badan mentah (ArrayBuffer), bukan JSON",
            ))
        }
    };
    let expected = 2 * frames * 4;
    if bytes.len() != expected {
        return Err(invalid(format!(
            "badan {} byte, diharapkan {expected} (2 × {frames} × Float32)",
            bytes.len()
        )));
    }
    let pcm: Vec<f32> = bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect();

    // Model harus sudah ada — unduhan adalah command tersendiri (`model_download`).
    let dir = with_store(&state.store, |s| Ok(s.dir().to_path_buf())).await?;
    let path = model_path(&dir, model_id);
    if !path.is_file() {
        return Err(CmdError::new(
            "MODEL_MISSING",
            format!("model {model_id} belum diunduh ({})", path.display()),
        ));
    }

    // Daftarkan flag batal SEBELUM kerja mulai supaya `vocal_split_cancel`
    // yang datang lebih awal tidak jatuh ke id yang belum dikenal.
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut jobs = lock_jobs(&state.vocal_split_jobs);
        if jobs.contains_key(&id) {
            return Err(invalid(format!("job {id} sudah berjalan")));
        }
        jobs.insert(id.clone(), Arc::clone(&cancel));
    }
    let jobs = Arc::clone(&state.vocal_split_jobs);
    let engine = Arc::clone(&state.vocal_split);

    let job_id = id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut guard = match engine.try_lock() {
            Ok(guard) => guard,
            Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
            Err(TryLockError::WouldBlock) => {
                return Err(CmdError::new(
                    "BUSY",
                    "vocal split lain sedang berjalan; tunggu sampai selesai",
                ))
            }
        };
        let model = guard
            .model(&path, model_id, accel)
            .map_err(CmdError::from)?;
        let (left, right) = pcm.split_at(frames);
        let opts = SeparateOptions {
            overlap,
            denoise,
            compensate: true,
        };
        let mut progress = |done: u64, total: u64| {
            let _ = app.emit(
                VOCAL_SPLIT_PROGRESS_EVENT,
                VocalSplitProgress {
                    id: &job_id,
                    done,
                    total,
                },
            );
        };
        let out = separate(model, &params, left, right, &opts, &mut progress, &cancel)
            .map_err(CmdError::from)?;

        let mut buf = Vec::with_capacity(4 * frames * 4);
        for channel in [&out.vocals_l, &out.vocals_r, &out.inst_l, &out.inst_r] {
            for v in channel {
                buf.extend_from_slice(&v.to_le_bytes());
            }
        }
        Ok(buf)
    })
    .await
    .map_err(|e| CmdError::new("IO", format!("thread kerja gagal: {e}")));

    lock_jobs(&jobs).remove(&id);
    Ok(Response::new(result??))
}

/// Idempoten: id yang tidak dikenal (job sudah selesai) bukan galat.
#[tauri::command]
pub async fn vocal_split_cancel(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    if let Some(flag) = lock_jobs(&state.vocal_split_jobs).get(&id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
pub async fn vocal_split_accels() -> CmdResult<Vec<&'static str>> {
    Ok(Accel::available().to_vec())
}
