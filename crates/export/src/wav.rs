//! Penulis WAV: Pcm16 / Pcm24 / Float32.
//!
//! Semua buffer di engine PLANAR (aturan 3 docs/00). Interleaving hanya terjadi
//! DI SINI, di boundary file.
//!
//! Model streaming (docs/03 §3b): render 10 menit stereo 24-bit = 172 MB. Satu
//! `Vec<u8>` sebesar itu di WASM memaksa `memory.grow` besar, dan ruang alamat
//! wasm32 cuma 4 GB. Jadi:
//!   1. header ditulis dengan ukuran placeholder,
//!   2. data di-encode dalam chunk ~4 MiB; tiap chunk selesai worker mengirimnya
//!      sebagai ArrayBuffer transferable (zero-copy) lalu memanggil
//!      `release_chunk()` — `Vec`-nya `clear()` tapi KAPASITASNYA dipertahankan,
//!      jadi nol alokasi setelah chunk pertama,
//!   3. selesai: `patch_header()` menghasilkan 44 byte final setelah panjang
//!      total diketahui.

use std::io::Cursor;

use crate::dither::{quantize, Tpdf};

/// Ukuran chunk streaming (~4 MiB).
pub const CHUNK_BYTES: usize = 4 * 1024 * 1024;

/// Byte data maksimum yang MASIH bisa diwakili header RIFF klasik.
///
/// Dua field ukuran di header adalah `u32`, dan yang di offset 4 berisi
/// `36 + data_len` — jadi batasnya bukan 4 GiB bulat, melainkan 36 byte di
/// bawahnya. Melewatinya bukan "file besar yang sedikit salah": panjang yang
/// dibaca player menjadi angka yang sama sekali lain, dan file yang terdengar
/// normal di awal berhenti atau berderak di tengah.
pub const RIFF_MAX_DATA_BYTES: u64 = u32::MAX as u64 - 36;

/// Data melewati apa yang bisa diwakili header RIFF.
///
/// Membawa angkanya, bukan `String`: pemanggil di sisi UI perlu mengubahnya
/// jadi kalimat yang menyebut berapa lama audio yang masih muat, dan itu tidak
/// bisa dilakukan dari pesan yang sudah terlanjur diformat.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RiffOverflow {
    /// Byte data yang sudah (atau akan) ditulis.
    pub data_bytes: u64,
}

impl core::fmt::Display for RiffOverflow {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(
            f,
            "data WAV {} byte melewati batas RIFF 32-bit ({} byte) — format ini tidak bisa \
             menyatakan panjangnya. Pakai FLAC, kurangi bit depth, atau persempit rentangnya.",
            self.data_bytes, RIFF_MAX_DATA_BYTES
        )
    }
}

impl std::error::Error for RiffOverflow {}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum WavFormat {
    Pcm16,
    Pcm24,
    Float32,
}

impl WavFormat {
    #[inline]
    pub const fn bits(&self) -> u16 {
        match self {
            WavFormat::Pcm16 => 16,
            WavFormat::Pcm24 => 24,
            WavFormat::Float32 => 32,
        }
    }
    #[inline]
    pub const fn bytes_per_sample(&self) -> usize {
        (self.bits() / 8) as usize
    }
    /// Tag `wFormatTag` di chunk fmt: 1 = PCM integer, 3 = IEEE float.
    #[inline]
    pub const fn tag(&self) -> u16 {
        match self {
            WavFormat::Float32 => 3,
            _ => 1,
        }
    }
}

#[derive(Copy, Clone, Debug)]
pub struct WavSpec {
    pub sample_rate: u32,
    pub channels: u16,
    pub format: WavFormat,
}

/// Kebijakan dither. Default: NYALA untuk 16-bit, MATI untuk 24-bit (noise floor
/// 24-bit sudah di bawah noise floor ruang mana pun), TIDAK PERNAH untuk f32.
#[derive(Copy, Clone, Debug)]
pub struct DitherSettings {
    pub dither_16: bool,
    pub dither_24: bool,
    /// Seed dari setelan export → export byte-reproducible.
    pub seed: u64,
}

impl Default for DitherSettings {
    fn default() -> Self {
        DitherSettings {
            dither_16: true,
            dither_24: false,
            seed: 0x5eed_0000_0000_0001,
        }
    }
}

impl DitherSettings {
    fn active_for(&self, f: WavFormat) -> bool {
        match f {
            WavFormat::Pcm16 => self.dither_16,
            WavFormat::Pcm24 => self.dither_24,
            WavFormat::Float32 => false,
        }
    }
}

/// 24-bit little-endian. Perhatikan: clamp ke rentang 24-bit SEBELUM shift, dan
/// `>>` pada `i32` adalah arithmetic shift sehingga byte ke-3 membawa bit tanda.
#[inline]
fn write_i24_le(out: &mut Vec<u8>, v: i32) {
    let v = v.clamp(-8_388_608, 8_388_607);
    out.push((v & 0xFF) as u8);
    out.push(((v >> 8) & 0xFF) as u8);
    out.push(((v >> 16) & 0xFF) as u8);
}

/// Header untuk `data_bytes` byte data, atau `Err` kalau angkanya tidak muat
/// di field 32-bit RIFF.
///
/// Di sini dulu ada `saturating_add`: file >4 GiB tetap ditulis, dengan panjang
/// yang dijepit ke `u32::MAX` dan tanpa satu pun error yang sampai ke user.
/// Satu-satunya jalan menghasilkan header adalah lewat cek ini.
pub(crate) fn header_bytes(spec: &WavSpec, data_bytes: u64) -> Result<[u8; 44], RiffOverflow> {
    if data_bytes > RIFF_MAX_DATA_BYTES {
        return Err(RiffOverflow { data_bytes });
    }
    Ok(header_bytes_raw(spec, data_bytes as u32))
}

/// Perakitan 44 byte-nya saja. `data_len` HARUS sudah lolos cek di
/// [`header_bytes`]; satu-satunya pemanggil lain adalah header placeholder,
/// yang selalu memakai 0.
fn header_bytes_raw(spec: &WavSpec, data_len: u32) -> [u8; 44] {
    debug_assert!(data_len as u64 <= RIFF_MAX_DATA_BYTES);
    let mut h = [0u8; 44];
    let bits = spec.format.bits();
    let block_align = spec.channels * (bits / 8);
    let byte_rate = spec.sample_rate * block_align as u32;

    h[0..4].copy_from_slice(b"RIFF");
    h[4..8].copy_from_slice(&(36 + data_len).to_le_bytes());
    h[8..12].copy_from_slice(b"WAVE");
    h[12..16].copy_from_slice(b"fmt ");
    h[16..20].copy_from_slice(&16u32.to_le_bytes());
    h[20..22].copy_from_slice(&spec.format.tag().to_le_bytes());
    h[22..24].copy_from_slice(&spec.channels.to_le_bytes());
    h[24..28].copy_from_slice(&spec.sample_rate.to_le_bytes());
    h[28..32].copy_from_slice(&byte_rate.to_le_bytes());
    h[32..34].copy_from_slice(&block_align.to_le_bytes());
    h[34..36].copy_from_slice(&bits.to_le_bytes());
    h[36..40].copy_from_slice(b"data");
    h[40..44].copy_from_slice(&data_len.to_le_bytes());
    h
}

/// Penulis WAV streaming. Header + chunk 4 MiB + patch header di akhir.
pub struct WavStreamWriter {
    spec: WavSpec,
    dither: Option<Tpdf>,
    chunk: Vec<u8>,
    chunk_limit: usize,
    data_bytes: u64,
    frames: u64,
    /// Statistik untuk membuktikan "nol alokasi setelah chunk pertama".
    grow_events: u32,
}

impl WavStreamWriter {
    pub fn new(spec: WavSpec, dither: DitherSettings) -> Self {
        Self::with_chunk_size(spec, dither, CHUNK_BYTES)
    }

    pub fn with_chunk_size(spec: WavSpec, dither: DitherSettings, chunk_limit: usize) -> Self {
        let d = if dither.active_for(spec.format) {
            Some(Tpdf::new(dither.seed))
        } else {
            None
        };
        WavStreamWriter {
            spec,
            dither: d,
            // Kapasitas sedikit di atas limit supaya satu blok terakhir tidak
            // memicu realokasi tepat di ambang.
            chunk: Vec::with_capacity(chunk_limit.min(CHUNK_BYTES) + 64 * 1024),
            chunk_limit,
            data_bytes: 0,
            frames: 0,
            grow_events: 0,
        }
    }

    /// Header awal dengan ukuran placeholder (0). Ditulis duluan, lalu ditimpa
    /// oleh [`Self::patch_header`] di akhir.
    pub fn placeholder_header(&self) -> [u8; 44] {
        // 0 selalu muat, jadi tidak ada cabang error yang perlu ditangani.
        header_bytes_raw(&self.spec, 0)
    }

    /// Header final — dipanggil setelah semua data ditulis dan panjang total
    /// diketahui.
    ///
    /// `Err` di sini berarti file yang sudah terlanjur ada di disk TIDAK bisa
    /// diberi header yang benar. Itu kabar buruk di ujung export, tapi jauh
    /// lebih baik daripada menutup file dengan panjang yang bohong — lihat
    /// [`RiffOverflow`]. Pencegahan yang sebenarnya ada di [`Self::max_frames`],
    /// yang dipakai memeriksa SEBELUM render dimulai.
    pub fn patch_header(&self) -> Result<[u8; 44], RiffOverflow> {
        header_bytes(&self.spec, self.data_bytes)
    }

    /// Frame maksimum yang masih bisa dinyatakan header RIFF untuk spec ini.
    ///
    /// Ini angka yang dipakai sisi JS untuk menolak export SEBELUM render
    /// berjam-jam dimulai. Ia bergantung pada jumlah channel dan bit depth,
    /// jadi ia harus datang dari sini dan bukan dihitung ulang di JS: dua rumus
    /// untuk satu batas berarti dua jawaban yang berbeda.
    pub fn max_frames(&self) -> u64 {
        let per_frame = self.spec.channels as u64 * self.spec.format.bytes_per_sample() as u64;
        if per_frame == 0 {
            0
        } else {
            RIFF_MAX_DATA_BYTES / per_frame
        }
    }

    /// `Some` begitu data yang sudah ditulis melewati batas RIFF. Dipakai
    /// encoder untuk berhenti di tengah jalan alih-alih menyelesaikan file yang
    /// pasti tidak bisa diberi header.
    pub fn riff_overflow(&self) -> Option<RiffOverflow> {
        if self.data_bytes > RIFF_MAX_DATA_BYTES {
            Some(RiffOverflow {
                data_bytes: self.data_bytes,
            })
        } else {
            None
        }
    }

    pub fn frames_written(&self) -> u64 {
        self.frames
    }
    pub fn data_bytes(&self) -> u64 {
        self.data_bytes
    }
    pub fn grow_events(&self) -> u32 {
        self.grow_events
    }

    /// Tulis `n` frame dari buffer PLANAR. Interleaving terjadi di sini saja.
    pub fn write_planar(&mut self, planar: &[&[f32]]) {
        let ch = self.spec.channels as usize;
        if planar.len() < ch || ch == 0 {
            return;
        }
        let n = planar.iter().take(ch).map(|c| c.len()).min().unwrap_or(0);
        let before = self.chunk.capacity();
        for i in 0..n {
            for c in planar.iter().take(ch) {
                let x = c[i];
                match self.spec.format {
                    WavFormat::Float32 => {
                        self.chunk.extend_from_slice(&x.to_le_bytes());
                    }
                    WavFormat::Pcm16 => {
                        let v = quantize(x, 32767.0, -32768.0, 32767.0, self.dither.as_mut());
                        self.chunk.extend_from_slice(&(v as i16).to_le_bytes());
                    }
                    WavFormat::Pcm24 => {
                        let v = quantize(
                            x,
                            8_388_607.0,
                            -8_388_608.0,
                            8_388_607.0,
                            self.dither.as_mut(),
                        );
                        write_i24_le(&mut self.chunk, v);
                    }
                }
            }
        }
        if self.chunk.capacity() != before {
            self.grow_events += 1;
        }
        self.data_bytes += (n * ch * self.spec.format.bytes_per_sample()) as u64;
        self.frames += n as u64;
    }

    /// `Some(chunk)` kalau sudah mencapai ambang 4 MiB. Pemanggil mengirimkannya
    /// (transferable) lalu WAJIB memanggil `release_chunk()`.
    pub fn poll_chunk(&mut self) -> Option<&[u8]> {
        if self.chunk.len() >= self.chunk_limit {
            Some(&self.chunk)
        } else {
            None
        }
    }

    /// Chunk terakhir (boleh kosong) di akhir export.
    pub fn finish(&mut self) -> &[u8] {
        &self.chunk
    }

    /// `clear()` mempertahankan kapasitas → nol alokasi untuk chunk berikutnya.
    pub fn release_chunk(&mut self) {
        self.chunk.clear();
    }
}

/// Encode sekali jalan (dipakai untuk file pendek / tes). Byte-nya IDENTIK
/// dengan hasil `WavStreamWriter` yang chunk-nya disambung.
pub fn encode_all(
    planar: &[&[f32]],
    spec: WavSpec,
    dither: DitherSettings,
) -> Result<Vec<u8>, RiffOverflow> {
    let mut w = WavStreamWriter::with_chunk_size(spec, dither, usize::MAX);
    w.write_planar(planar);
    let header = w.patch_header()?;
    let mut out = Vec::with_capacity(44 + w.chunk.len());
    out.extend_from_slice(&header);
    out.extend_from_slice(&w.chunk);
    Ok(out)
}

/// Jalur alternatif berbasis `hound` di atas `Cursor<Vec<u8>>` (tidak ada
/// filesystem di WASM). Dipertahankan karena docs/03 §3b menyebutnya eksplisit
/// dan karena ia berguna sebagai pembanding independen di tes.
pub fn encode_all_hound(
    planar: &[&[f32]],
    spec: WavSpec,
    dither: DitherSettings,
) -> Result<Vec<u8>, hound::Error> {
    let ch = spec.channels as usize;
    let n = planar.iter().take(ch).map(|c| c.len()).min().unwrap_or(0);
    let estimated = 44 + n * ch * spec.format.bytes_per_sample();
    let mut cursor = Cursor::new(Vec::<u8>::with_capacity(estimated));
    let hspec = hound::WavSpec {
        channels: spec.channels,
        sample_rate: spec.sample_rate,
        bits_per_sample: spec.format.bits(),
        sample_format: match spec.format {
            WavFormat::Float32 => hound::SampleFormat::Float,
            _ => hound::SampleFormat::Int,
        },
    };
    let mut d = if dither.active_for(spec.format) {
        Some(Tpdf::new(dither.seed))
    } else {
        None
    };
    {
        let mut w = hound::WavWriter::new(&mut cursor, hspec)?;
        for i in 0..n {
            for c in planar.iter().take(ch) {
                let x = c[i];
                match spec.format {
                    WavFormat::Float32 => w.write_sample(x)?,
                    WavFormat::Pcm16 => {
                        w.write_sample(quantize(x, 32767.0, -32768.0, 32767.0, d.as_mut()) as i16)?
                    }
                    // hound menerima i32 dengan bits_per_sample = 24 dan
                    // menuliskannya 3 byte little-endian.
                    WavFormat::Pcm24 => w.write_sample(quantize(
                        x,
                        8_388_607.0,
                        -8_388_608.0,
                        8_388_607.0,
                        d.as_mut(),
                    ))?,
                }
            }
        }
        w.finalize()?;
    }
    Ok(cursor.into_inner())
}
