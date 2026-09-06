//! Berkas lagu di `tracks/<sha256>.<ext>` (docs/21 §1b).
//!
//! Nama berkas ADALAH content hash — identitas yang sama dengan objek R2
//! `tracks/<sha256>` di docs/16 §3, sehingga project yang disimpan lokal
//! tetap merujuk lagu yang benar setelah folder dipindah, dan dua impor
//! berkas yang sama menghasilkan satu berkas. Ekstensi ikut supaya berkas di
//! Finder bisa dibuka orang tanpa menebak formatnya; ia TIDAK disimpan di
//! basis data — mencarinya berarti memindai `tracks/` untuk `<hash>.*`, dan
//! itu murah untuk ribuan berkas.
//!
//! Invarian yang sama dengan `model.rs`: path akhir hanya pernah berisi
//! berkas yang sudah LENGKAP. Penulisan berjalan ke `.part`, dan baru
//! di-`rename` (atomik pada satu filesystem) sesudah selesai. Impor dari
//! path meng-hash SAMBIL menyalin — satu kali baca, tidak pernah memuat
//! seluruh berkas ke memori — dan baru tahu nama akhirnya sesudah selesai,
//! jadi `.part`-nya bernama acak.
//!
//! Durasi (`frames`/`sample_rate`) dibaca dari header lewat `symphonia`,
//! hanya probe format — tanpa decode. Kalau gagal (format asing, header
//! rusak, MP3 tanpa Xing) nilainya 0, dan jalur probe `<audio>` di TS yang
//! sudah ada mengisinya kemudian; nol adalah "tidak diketahui" di kontrak
//! Worker juga.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::HostError;

/// Subdirektori di dalam folder kepustakaan.
pub const TRACKS_SUBDIR: &str = "tracks";

/// Ekstensi yang diterima, dengan MIME kanoniknya (cermin `MIME` di Worker).
/// Urutannya dipakai `find_track_file` sebagai urutan tebakan pertama.
const FORMATS: &[(&str, &str)] = &[
    ("mp3", "audio/mpeg"),
    ("ogg", "audio/ogg"),
    ("wav", "audio/wav"),
    ("flac", "audio/flac"),
];

/// Ruang yang harus tetap tersisa SESUDAH menyalin. Disk yang penuh sampai
/// byte terakhir membuat SQLite (WAL) dan OS sendiri gagal menulis.
const DISK_MARGIN: u64 = 64 * 1024 * 1024;

/// Hasil pembacaan header: `(frames, sample_rate)`, 0 kalau tidak diketahui.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Probe {
    pub frames: u64,
    pub sample_rate: u32,
}

/// Ekstensi kanonik dari nama berkas (`.MP3` → `mp3`), atau `Invalid` untuk
/// format yang tidak didukung kepustakaan.
pub fn ext_of(path: &Path) -> Result<&'static str, HostError> {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let ext = match ext.as_str() {
        "wave" => "wav",
        "oga" => "ogg",
        other => other,
    };
    canonical_ext(ext).ok_or_else(|| {
        HostError::Invalid(format!(
            "format {} tidak didukung; kepustakaan menerima MP3, OGG, WAV, FLAC",
            if ext.is_empty() {
                "tanpa ekstensi"
            } else {
                ext
            }
        ))
    })
}

/// `Some(ext)` kalau `ext` salah satu format yang didukung.
pub fn canonical_ext(ext: &str) -> Option<&'static str> {
    FORMATS.iter().find(|(e, _)| *e == ext).map(|(e, _)| *e)
}

/// MIME kanonik untuk ekstensi yang didukung.
pub fn mime_for(ext: &str) -> &'static str {
    FORMATS
        .iter()
        .find(|(e, _)| *e == ext)
        .map(|(_, m)| *m)
        .unwrap_or("application/octet-stream")
}

/// Hash harus 64 digit hex huruf kecil — ia jadi nama berkas, jadi ini juga
/// penjaga path traversal.
pub fn validate_hash(hash: &str) -> Result<(), HostError> {
    if hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        Ok(())
    } else {
        Err(HostError::Invalid(
            "hash harus 64 digit hex huruf kecil (SHA-256)".into(),
        ))
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Berkas `tracks/<hash>.*` kalau ada. Empat `stat` untuk format yang
/// dikenal; tidak ada pemindaian direktori.
pub fn find_track_file(tracks_dir: &Path, hash: &str) -> Option<PathBuf> {
    FORMATS
        .iter()
        .map(|(ext, _)| tracks_dir.join(format!("{hash}.{ext}")))
        .find(|p| p.is_file())
}

/// Tolak sebelum menulis kalau ruang sisa (dikurangi margin) lebih kecil
/// dari `needed`. Kalau OS tidak bisa menjawab (filesystem eksotis), lanjut
/// saja — ENOSPC nanti tetap jadi `Io`, hanya lebih lambat ketahuan.
pub fn ensure_disk_space(tracks_dir: &Path, needed: u64) -> Result<(), HostError> {
    if let Ok(available) = fs4::available_space(tracks_dir) {
        if available.saturating_sub(DISK_MARGIN) < needed {
            return Err(HostError::DiskFull { needed, available });
        }
    }
    Ok(())
}

/// Hasil [`import_file`].
#[derive(Debug)]
pub struct ImportedFile {
    pub hash: String,
    pub ext: &'static str,
    pub bytes: u64,
    /// Berkas akhir. Kalau byte yang sama sudah ada, ini berkas LAMA-nya
    /// (mungkin berekstensi lain — hash sama berarti isi sama) dan salinan
    /// baru dibuang; "sudah ada" diputuskan dari baris `track`, bukan dari
    /// sini.
    pub path: PathBuf,
}

/// Salin `src` ke `tracks/` sambil menghitung SHA-256-nya (streaming).
pub fn import_file(tracks_dir: &Path, src: &Path) -> Result<ImportedFile, HostError> {
    let ext = ext_of(src)?;
    let size = fs::metadata(src)?.len();
    ensure_disk_space(tracks_dir, size)?;

    let part = tracks_dir.join(format!(".import-{}.part", uuid::Uuid::new_v4()));
    let result = copy_hashing(src, &part);
    let (hash, bytes) = match result {
        Ok(v) => v,
        Err(e) => {
            let _ = fs::remove_file(&part);
            return Err(e);
        }
    };

    let path = tracks_dir.join(format!("{hash}.{ext}"));
    if let Some(existing) = find_track_file(tracks_dir, &hash) {
        fs::remove_file(&part)?;
        return Ok(ImportedFile {
            hash,
            ext,
            bytes,
            path: existing,
        });
    }
    fs::rename(&part, &path)?;
    Ok(ImportedFile {
        hash,
        ext,
        bytes,
        path,
    })
}

fn copy_hashing(src: &Path, dst: &Path) -> Result<(String, u64), HostError> {
    let mut input = fs::File::open(src)?;
    let mut output = fs::File::create(dst)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut total = 0u64;
    loop {
        let n = input.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        output.write_all(&buf[..n])?;
        total += n as u64;
    }
    output.flush()?;
    // `sync_all` sebelum rename: rename atomik tidak berarti apa-apa kalau
    // datanya sendiri masih di cache halaman saat listrik padam.
    output.sync_all()?;
    Ok((hex(&hasher.finalize()), total))
}

/// `library_put_bytes`: tulis byte yang sudah ada di memori (jalur
/// `putUpload` `LibraryApi`, byte datang dari WebView). Hash diverifikasi:
/// nama berkas adalah janji tentang isinya, dan memeriksanya di sini lebih
/// murah daripada kepustakaan yang isinya salah.
pub fn put_bytes(
    tracks_dir: &Path,
    hash: &str,
    ext: &str,
    bytes: &[u8],
) -> Result<PathBuf, HostError> {
    validate_hash(hash)?;
    let ext = canonical_ext(ext).ok_or_else(|| {
        HostError::Invalid(format!(
            "ekstensi {ext:?} tidak didukung; pakai mp3, ogg, wav, atau flac"
        ))
    })?;
    if hex(&Sha256::digest(bytes)) != hash {
        return Err(HostError::Invalid(
            "SHA-256 byte tidak sama dengan hash yang diklaim".into(),
        ));
    }
    if let Some(existing) = find_track_file(tracks_dir, hash) {
        return Ok(existing);
    }
    ensure_disk_space(tracks_dir, bytes.len() as u64)?;

    let path = tracks_dir.join(format!("{hash}.{ext}"));
    let part = tracks_dir.join(format!("{hash}.{ext}.part"));
    let write = (|| -> Result<(), HostError> {
        let mut f = fs::File::create(&part)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        Ok(())
    })();
    if let Err(e) = write {
        let _ = fs::remove_file(&part);
        return Err(e);
    }
    fs::rename(&part, &path)?;
    Ok(path)
}

/// Baca seluruh byte lagu. Sinkron dan memuat semuanya: penerimanya adalah
/// `decodeAudioData` di WebView yang memang butuh seluruh byte sekaligus.
pub fn read_track(tracks_dir: &Path, hash: &str) -> Result<Vec<u8>, HostError> {
    validate_hash(hash)?;
    let path = find_track_file(tracks_dir, hash).ok_or_else(|| {
        HostError::NotFound("byte lagu ini tidak ada di folder kepustakaan".into())
    })?;
    Ok(fs::read(path)?)
}

/// Hapus `tracks/<hash>.*`. Tidak ada = bukan error (baris sudah dihapus,
/// berkasnya boleh sudah tidak ada).
pub fn remove_track_file(tracks_dir: &Path, hash: &str) -> Result<(), HostError> {
    if let Some(path) = find_track_file(tracks_dir, hash) {
        fs::remove_file(path)?;
    }
    Ok(())
}

/// Baca header untuk `frames` + `sample_rate`. Tidak pernah gagal: format
/// yang tidak terbaca = `Probe { 0, 0 }` (lihat header modul).
pub fn probe_header(path: &Path) -> Probe {
    probe_symphonia(path).unwrap_or(Probe {
        frames: 0,
        sample_rate: 0,
    })
}

fn probe_symphonia(path: &Path) -> Option<Probe> {
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;

    let file = fs::File::open(path).ok()?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .ok()?;
    let track = probed.format.default_track()?;
    let params = &track.codec_params;
    let sample_rate = params.sample_rate.unwrap_or(0);
    // Tanpa sample rate, jumlah frame tidak berarti apa-apa untuk durasi.
    let frames = if sample_rate > 0 {
        params.n_frames.unwrap_or(0)
    } else {
        0
    };
    Some(Probe {
        frames,
        sample_rate,
    })
}

#[cfg(test)]
pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}
