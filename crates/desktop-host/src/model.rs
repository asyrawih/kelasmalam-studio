//! Model SCNet yang tidak ikut bundel desktop (docs/20 §1g, D4).
//!
//! Di web, `scnet-model.ts` mem-`fetch` model dari `/models/scnet/` dan
//! menyimpannya di OPFS. Di desktop jalur itu tidak dipakai — COEP
//! `require-corp` menuntut header CORP dari server model, dan mengalirkan
//! byte lewat IPC menghindari seluruh pertanyaan itu. Maka unduhan terjadi
//! di sini, ke `appDataDir()/models/`, dan hasilnya dibaca sebagai `Vec<u8>`
//! untuk `InferenceSession.create(bytes)`.
//!
//! Angka ukuran dan hash di bawah HARUS sama dengan `SCNET_MODELS` di
//! `web/src/proof-stem/scnet-model.ts`; keduanya adalah kebenaran yang sama
//! ditulis dua kali karena Rust dan TS tidak berbagi konstanta. Kalau model
//! diganti, ubah keduanya.
//!
//! Invarian berkas: path akhir hanya pernah berisi berkas yang SUDAH lolos
//! verifikasi ukuran (dan hash). Unduhan berjalan ke `<path>.part` dan baru
//! di-`rename` (atomik pada satu filesystem) setelah verifikasi. Jadi
//! "ada berkas di path akhir dengan ukuran benar" boleh dipercaya tanpa
//! meng-hash ulang 170 MB setiap kali app dibuka — itu yang dipakai
//! [`model_is_ready`].

use std::fmt;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use crate::HostError;

/// Subdirektori di dalam `data_dir` tempat model disimpan.
pub const MODELS_SUBDIR: &str = "models";

/// Akhiran berkas unduhan yang belum diverifikasi.
const PART_SUFFIX: &str = ".part";

/// Varian model. Urutannya mengikuti `SCNET_MODELS` di TS.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ModelId {
    /// 44 MB, untuk pratinjau realtime.
    Base,
    /// 170 MB, kualitas.
    Large,
}

impl ModelId {
    /// Semua varian, urutan tetap.
    pub const ALL: [ModelId; 2] = [ModelId::Base, ModelId::Large];

    /// Id seperti di TS: `"base"` / `"large"`.
    pub fn as_str(self) -> &'static str {
        match self {
            ModelId::Base => "base",
            ModelId::Large => "large",
        }
    }

    /// Nama berkas, sama dengan yang ada di `web/public/models/scnet/`.
    pub fn file_name(self) -> String {
        format!("scnet-{}.onnx", self.as_str())
    }

    fn bytes(self) -> u64 {
        match self {
            ModelId::Base => 44_516_685,
            ModelId::Large => 170_914_085,
        }
    }

    fn sha256(self) -> [u8; 32] {
        match self {
            ModelId::Base => {
                hex32(b"29137273515c3f10dc69e22a84a63bfc09b71abdf27cf801da463e0644870ade")
            }
            ModelId::Large => {
                hex32(b"b604b88207a8b3830b7969c7aef708c56710a39bd1c8b196f105ee7b68c0f939")
            }
        }
    }
}

impl fmt::Display for ModelId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for ModelId {
    type Err = HostError;

    fn from_str(s: &str) -> Result<Self, HostError> {
        match s {
            "base" => Ok(ModelId::Base),
            "large" => Ok(ModelId::Large),
            other => Err(HostError::UnknownModel(other.to_owned())),
        }
    }
}

/// Spesifikasi satu model: dari mana diunduh dan bagaimana diverifikasi.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelSpec {
    pub id: ModelId,
    /// URL lengkap berkas `.onnx`.
    pub url: String,
    /// Ukuran yang wajib; unduhan/berkas dengan ukuran lain ditolak.
    pub bytes: u64,
    /// SHA-256 kalau diketahui. `None` = hanya ukuran yang diverifikasi
    /// (dipakai tes dengan byte acak; produksi selalu `Some`).
    pub sha256: Option<[u8; 32]>,
}

/// Spesifikasi kedua model dengan URL `base_url + "/models/scnet/<file>"`.
/// `base_url` adalah origin web yang sudah menyajikan model untuk browser
/// (mis. `https://studio.kelasmalam.app`), dengan atau tanpa `/` di akhir.
pub fn model_specs(base_url: &str) -> [ModelSpec; 2] {
    let base = base_url.trim_end_matches('/');
    ModelId::ALL.map(|id| ModelSpec {
        id,
        url: format!("{base}/models/scnet/{}", id.file_name()),
        bytes: id.bytes(),
        sha256: Some(id.sha256()),
    })
}

/// Path akhir model di dalam `data_dir` (`appDataDir()` Tauri).
pub fn model_path(data_dir: &Path, id: ModelId) -> PathBuf {
    data_dir.join(MODELS_SUBDIR).join(id.file_name())
}

fn part_path(final_path: &Path) -> PathBuf {
    let mut name = final_path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(PART_SUFFIX);
    final_path.with_file_name(name)
}

/// `true` kalau berkas akhir ada DAN ukurannya cocok. Hash tidak dihitung di
/// sini — lihat invarian di header modul.
pub fn model_is_ready(data_dir: &Path, spec: &ModelSpec) -> bool {
    std::fs::metadata(model_path(data_dir, spec.id))
        .map(|m| m.is_file() && m.len() == spec.bytes)
        .unwrap_or(false)
}

/// Unduh model ke `data_dir` dan kembalikan path akhirnya.
///
/// `progress(diterima, total)` dipanggil setiap chunk tiba dan sekali di
/// akhir dengan `(total, total)`; `total` selalu `spec.bytes`, bukan
/// `Content-Length`, supaya UI punya penyebut yang sama sebelum dan sesudah
/// respons datang. Kalau model sudah siap, tidak ada permintaan HTTP:
/// `progress(total, total)` sekali lalu path dikembalikan.
///
/// Gagal di mana pun (jaringan putus, ukuran/hash salah) menghapus `.part`
/// dan TIDAK menyentuh berkas akhir yang mungkin sudah ada.
///
/// Utang: tidak ada resume `Range`. Melanjutkan `.part` berarti meng-hash
/// ulang bagian yang sudah ada dan percaya server menghormati `Range` —
/// bisa, tapi belum dibutuhkan untuk 170 MB sekali seumur instalasi.
pub async fn download_model(
    data_dir: &Path,
    spec: &ModelSpec,
    mut progress: impl FnMut(u64, u64),
) -> Result<PathBuf, HostError> {
    let final_path = model_path(data_dir, spec.id);
    if model_is_ready(data_dir, spec) {
        progress(spec.bytes, spec.bytes);
        return Ok(final_path);
    }

    let dir = final_path
        .parent()
        .expect("model_path selalu punya direktori induk");
    tokio::fs::create_dir_all(dir).await?;
    let part = part_path(&final_path);
    // `.part` dari unduhan sebelumnya yang putus: tanpa resume ia tidak
    // berguna, dan membiarkannya berarti `File::create` menimpanya diam-diam
    // — sama saja, tapi lebih jujur dihapus eksplisit.
    remove_if_exists(&part).await?;

    let result = download_to_part(&part, spec, &mut progress).await;
    if let Err(e) = result {
        // Best-effort: error asli lebih penting daripada gagal hapus.
        let _ = tokio::fs::remove_file(&part).await;
        return Err(e);
    }

    // Verifikasi sudah lolos; baru sekarang berkas akhir boleh muncul.
    tokio::fs::rename(&part, &final_path).await?;
    progress(spec.bytes, spec.bytes);
    Ok(final_path)
}

/// Tulis body HTTP ke `part` sambil menghitung byte dan hash. Tidak
/// membersihkan apa pun kalau gagal — itu tugas pemanggil.
async fn download_to_part(
    part: &Path,
    spec: &ModelSpec,
    progress: &mut impl FnMut(u64, u64),
) -> Result<(), HostError> {
    let client = reqwest::Client::builder().build()?;
    let mut response = client.get(&spec.url).send().await?;
    let status = response.status();
    if !status.is_success() {
        return Err(HostError::HttpStatus {
            status: status.as_u16(),
            url: spec.url.clone(),
        });
    }
    // Kalau server sudah bilang ukurannya salah, gagal sekarang — lebih baik
    // daripada mengunduh 170 MB yang pasti ditolak.
    if let Some(len) = response.content_length() {
        if len != spec.bytes {
            return Err(HostError::SizeMismatch {
                expected: spec.bytes,
                actual: len,
            });
        }
    }

    let mut file = tokio::fs::File::create(part).await?;
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    while let Some(chunk) = response.chunk().await? {
        received += chunk.len() as u64;
        // Server yang mengirim lebih dari yang dijanjikan (tanpa
        // Content-Length) dihentikan di sini, bukan setelah disk penuh.
        if received > spec.bytes {
            return Err(HostError::SizeMismatch {
                expected: spec.bytes,
                actual: received,
            });
        }
        hasher.update(&chunk);
        file.write_all(&chunk).await?;
        progress(received, spec.bytes);
    }
    // `sync_all` sebelum rename: rename atomik tidak berarti apa-apa kalau
    // datanya sendiri masih di cache halaman saat listrik padam.
    file.flush().await?;
    file.sync_all().await?;
    drop(file);

    if received != spec.bytes {
        return Err(HostError::SizeMismatch {
            expected: spec.bytes,
            actual: received,
        });
    }
    if let Some(expected) = &spec.sha256 {
        let actual: [u8; 32] = hasher.finalize().into();
        if &actual != expected {
            return Err(HostError::HashMismatch);
        }
    }
    Ok(())
}

async fn remove_if_exists(path: &Path) -> Result<(), HostError> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// Baca model yang sudah diunduh. Menolak berkas dengan ukuran salah
/// (`SizeMismatch`) — cermin `assertModelSize` — dan berkas yang tidak ada
/// (`Io` NotFound); pemanggil diharapkan memanggil [`download_model`] dulu.
///
/// Sinkron dan memuat seluruh berkas: ORT di WebView memang butuh seluruh
/// byte sekaligus untuk `InferenceSession.create`, jadi tidak ada gunanya
/// streaming di sini.
pub fn read_model(data_dir: &Path, spec: &ModelSpec) -> Result<Vec<u8>, HostError> {
    let path = model_path(data_dir, spec.id);
    let len = std::fs::metadata(&path)?.len();
    if len != spec.bytes {
        return Err(HostError::SizeMismatch {
            expected: spec.bytes,
            actual: len,
        });
    }
    let bytes = std::fs::read(&path)?;
    // Berkas bisa berubah antara metadata dan read; ukuran yang dipulangkan
    // adalah yang dijamin.
    if bytes.len() as u64 != spec.bytes {
        return Err(HostError::SizeMismatch {
            expected: spec.bytes,
            actual: bytes.len() as u64,
        });
    }
    Ok(bytes)
}

/// Dekode 64 digit hex jadi 32 byte pada waktu kompilasi. Konstanta hash
/// ditulis sebagai string supaya bisa dibandingkan mata dengan TS.
const fn hex32(hex: &[u8; 64]) -> [u8; 32] {
    const fn nibble(c: u8) -> u8 {
        match c {
            b'0'..=b'9' => c - b'0',
            b'a'..=b'f' => c - b'a' + 10,
            b'A'..=b'F' => c - b'A' + 10,
            _ => panic!("digit hex tidak sah dalam konstanta SHA-256"),
        }
    }
    let mut out = [0u8; 32];
    let mut i = 0;
    while i < 32 {
        out[i] = (nibble(hex[2 * i]) << 4) | nibble(hex[2 * i + 1]);
        i += 1;
    }
    out
}

/// Hex huruf kecil dari 32 byte — untuk pesan/tes, bukan jalur panas.
#[cfg(test)]
pub(crate) fn to_hex(bytes: &[u8; 32]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
pub(crate) fn part_path_for_test(final_path: &Path) -> PathBuf {
    part_path(final_path)
}
