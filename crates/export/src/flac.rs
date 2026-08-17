//! Penulis FLAC streaming — lossless, kira-kira separuh ukuran WAV.
//!
//! Kenapa FLAC dan bukan "kompresi WAV": WAV adalah wadah PCM mentah; tidak ada
//! cara mengecilkannya tanpa berhenti menjadi WAV. FLAC menyimpan SAMPLE YANG
//! SAMA PERSIS (bit-exact saat di-decode) dengan prediktor + Rice coding, jadi
//! ia satu-satunya jawaban jujur untuk "kecilkan file export tanpa merusak
//! audio".
//!
//! Bentuknya sengaja dibuat identik dengan [`crate::wav::WavStreamWriter`]:
//! `header()` placeholder → chunk-chunk → `patch_header()`. Alasannya bukan
//! kerapian: `run-export.ts` hanya punya SATU loop, dan loop itu sudah tahu cara
//! menukar part pertama Blob dengan header final. Format yang butuh bentuk lain
//! akan memaksa jalur render kedua — persis yang dilarang docs/03.
//!
//! STREAMINFO berukuran TETAP 34 byte apa pun isinya (`total_samples` 36 bit,
//! md5 16 byte), jadi header placeholder dan header final panjangnya sama dan
//! penukaran part itu selalu valid.
//!
//! Kuantisasi memakai `dither::quantize` YANG SAMA dengan WAV: FLAC menyimpan
//! integer, jadi f32 → i32 tetap harus terjadi, dan kalau rumusnya beda dengan
//! WAV maka dua format lossless dari render yang sama akan berbeda isinya.

use flacenc::bitsink::MemSink;
use flacenc::component::{BitRepr, StreamInfo};
use flacenc::config;
use flacenc::encode_fixed_size_frame;
use flacenc::error::Verify;
use flacenc::source::{Context, Fill, FrameBuf};

use crate::dither::{quantize, Tpdf};
use crate::wav::{DitherSettings, CHUNK_BYTES};

/// Ukuran blok FLAC. 4096 adalah nilai yang dipakai `flac -8` referensi dan
/// yang diasumsikan optimal oleh hampir semua decoder.
pub const BLOCK_SIZE: usize = 4096;

/// Kedalaman bit FLAC. Tidak ada float32: format FLAC hanya menyimpan integer,
/// dan menawarkan "FLAC 32-bit float" berarti berbohong soal apa yang ditulis.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum FlacBits {
    Pcm16,
    Pcm24,
}

impl FlacBits {
    #[inline]
    pub const fn bits(&self) -> usize {
        match self {
            FlacBits::Pcm16 => 16,
            FlacBits::Pcm24 => 24,
        }
    }
    /// Batas kuantisasi — sama persis dengan yang dipakai jalur WAV.
    #[inline]
    const fn range(&self) -> (f32, f32, f32) {
        match self {
            FlacBits::Pcm16 => (32767.0, -32768.0, 32767.0),
            FlacBits::Pcm24 => (8_388_607.0, -8_388_608.0, 8_388_607.0),
        }
    }
}

#[derive(Copy, Clone, Debug)]
pub struct FlacSpec {
    pub sample_rate: u32,
    pub channels: u16,
    pub bits: FlacBits,
}

/// Kesalahan yang bisa muncul dari encoder FLAC. Sengaja `String`: pemanggilnya
/// adalah boundary JS, yang toh hanya bisa menampilkan teks.
#[derive(Debug)]
pub struct FlacError(pub String);

impl core::fmt::Display for FlacError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for FlacError {}

fn err<E: core::fmt::Debug>(what: &str, e: E) -> FlacError {
    FlacError(format!("{what}: {e:?}"))
}

/// 4 byte magic + 4 byte header metadata-block (last-block flag | type 0,
/// panjang 34) + 34 byte STREAMINFO.
pub const HEADER_BYTES: usize = 4 + 4 + 34;

fn header_bytes(info: &StreamInfo) -> Result<Vec<u8>, FlacError> {
    let mut sink = MemSink::<u8>::new();
    info.write(&mut sink)
        .map_err(|e| err("tulis STREAMINFO", e))?;
    let payload = sink.into_inner();
    // 272 bit = 34 byte, dijamin oleh `StreamInfo::count_bits`. Kalau ini pernah
    // gagal, penukaran part pertama Blob di run-export akan merusak file.
    if payload.len() != 34 {
        return Err(FlacError(format!(
            "STREAMINFO {} byte, seharusnya 34 — header placeholder dan final tidak lagi sama panjang",
            payload.len()
        )));
    }
    let mut out = Vec::with_capacity(HEADER_BYTES);
    out.extend_from_slice(b"fLaC");
    // 0x80 = bit "last metadata block", type 0 = STREAMINFO. Kita memang tidak
    // menulis blok metadata lain (tanpa VORBIS_COMMENT, tanpa SEEKTABLE).
    out.push(0x80);
    out.extend_from_slice(&[0, 0, 34]);
    out.extend_from_slice(&payload);
    Ok(out)
}

/// Penulis FLAC streaming. Bentuknya cermin `WavStreamWriter`.
pub struct FlacStreamWriter {
    spec: FlacSpec,
    config: flacenc::error::Verified<config::Encoder>,
    info: StreamInfo,
    framebuf: FrameBuf,
    ctx: Context,
    dither: Option<Tpdf>,
    /// Sample interleaved yang belum cukup untuk satu blok penuh.
    pending: Vec<i32>,
    chunk: Vec<u8>,
    chunk_limit: usize,
    frames: u64,
    frame_number: usize,
    /// Ukuran blok/frame yang BENAR-BENAR keluar. Baru diketahui setelah frame
    /// terakhir (yang boleh lebih pendek), jadi hanya dipakai di `patch_header`.
    min_block: usize,
    max_block: usize,
    min_frame: usize,
    max_frame: usize,
}

impl FlacStreamWriter {
    pub fn new(spec: FlacSpec, dither: DitherSettings) -> Result<Self, FlacError> {
        Self::with_chunk_size(spec, dither, CHUNK_BYTES)
    }

    pub fn with_chunk_size(
        spec: FlacSpec,
        dither: DitherSettings,
        chunk_limit: usize,
    ) -> Result<Self, FlacError> {
        let channels = spec.channels.max(1) as usize;
        let bits = spec.bits.bits();

        let config = config::Encoder::default()
            .into_verified()
            .map_err(|e| err("config flacenc", e))?;

        let mut info = StreamInfo::new(spec.sample_rate as usize, channels, bits)
            .map_err(|e| err("StreamInfo", e))?;
        // Blok TETAP: min == max. Ini yang memberi decoder hak menghitung posisi
        // sample langsung dari nomor frame — tanpa itu seek jadi linear scan.
        info.set_block_sizes(BLOCK_SIZE, BLOCK_SIZE)
            .map_err(|e| err("block sizes", e))?;

        // Dither hanya relevan untuk 16-bit, sama seperti WAV: 24-bit sudah di
        // bawah noise floor ruangan mana pun.
        let d = match spec.bits {
            FlacBits::Pcm16 if dither.dither_16 => Some(Tpdf::new(dither.seed)),
            FlacBits::Pcm24 if dither.dither_24 => Some(Tpdf::new(dither.seed)),
            _ => None,
        };

        Ok(FlacStreamWriter {
            spec: FlacSpec {
                channels: channels as u16,
                ..spec
            },
            config,
            info,
            framebuf: FrameBuf::with_size(channels, BLOCK_SIZE).map_err(|e| err("FrameBuf", e))?,
            ctx: Context::new(bits, channels),
            dither: d,
            pending: Vec::with_capacity(BLOCK_SIZE * channels),
            chunk: Vec::with_capacity(chunk_limit.min(CHUNK_BYTES) + 64 * 1024),
            chunk_limit,
            frames: 0,
            frame_number: 0,
            min_block: usize::MAX,
            max_block: 0,
            min_frame: usize::MAX,
            max_frame: 0,
        })
    }

    /// Header dengan `total_samples`/md5 masih nol. Ditulis lebih dulu, diganti
    /// oleh [`Self::patch_header`] setelah semua frame selesai.
    pub fn placeholder_header(&self) -> Result<Vec<u8>, FlacError> {
        header_bytes(&self.info)
    }

    /// Header final: jumlah sample total + md5 sinyal asli terisi. md5 itulah
    /// yang membuat `flac -t` bisa membuktikan file ini benar-benar lossless.
    pub fn patch_header(&self) -> Result<Vec<u8>, FlacError> {
        let mut info = self.info.clone();
        // Blok TERAKHIR boleh lebih pendek dari 4096, jadi min_block_size yang
        // sebenarnya baru diketahui sekarang. Menuliskan 4096/4096 padahal frame
        // terakhir 3808 berarti mengklaim "fixed block size stream" yang tidak
        // benar — decoder yang mempercayainya untuk seek akan meleset di ujung.
        if self.max_block > 0 {
            info.set_block_sizes(self.min_block, self.max_block)
                .map_err(|e| err("block sizes final", e))?;
        }
        if self.max_frame > 0 {
            info.set_frame_sizes(self.min_frame, self.max_frame)
                .map_err(|e| err("frame sizes final", e))?;
        }
        info.set_total_samples(self.frames as usize);
        info.set_md5_digest(&self.ctx.md5_digest());
        header_bytes(&info)
    }

    pub fn frames_written(&self) -> u64 {
        self.frames
    }

    /// Tulis `n` frame dari buffer PLANAR. Interleaving + kuantisasi di sini.
    pub fn write_planar(&mut self, planar: &[&[f32]]) -> Result<(), FlacError> {
        let ch = self.spec.channels as usize;
        if planar.len() < ch || ch == 0 {
            return Ok(());
        }
        let n = planar.iter().take(ch).map(|c| c.len()).min().unwrap_or(0);
        let (scale, lo, hi) = self.spec.bits.range();
        for i in 0..n {
            for c in planar.iter().take(ch) {
                self.pending
                    .push(quantize(c[i], scale, lo, hi, self.dither.as_mut()));
            }
        }
        self.frames += n as u64;
        self.drain_full_blocks()
    }

    /// Encode setiap blok PENUH yang sudah terkumpul. Blok terakhir yang tidak
    /// penuh sengaja ditinggal untuk [`Self::finish`] — FLAC mengizinkan frame
    /// terakhir lebih pendek, tapi hanya frame TERAKHIR.
    fn drain_full_blocks(&mut self) -> Result<(), FlacError> {
        let ch = self.spec.channels as usize;
        let per_block = BLOCK_SIZE * ch;
        let mut consumed = 0usize;
        while self.pending.len() - consumed >= per_block {
            let block = consumed..consumed + per_block;
            self.encode_block(block)?;
            consumed += per_block;
        }
        if consumed > 0 {
            self.pending.drain(..consumed);
        }
        Ok(())
    }

    fn encode_block(&mut self, range: core::ops::Range<usize>) -> Result<(), FlacError> {
        let ch = self.spec.channels as usize;
        let len = range.len();
        // Tuple `(FrameBuf, Context)` mengisi keduanya sekaligus: buffer untuk
        // encoder, Context untuk md5 + penomoran frame. Kalau salah satunya
        // dilewati, md5 di header akan salah dan `flac -t` menolak file yang
        // sebenarnya baik-baik saja.
        let mut pair = (&mut self.framebuf, &mut self.ctx);
        pair.fill_interleaved(&self.pending[range])
            .map_err(|e| err("isi FrameBuf", e))?;

        let frame =
            encode_fixed_size_frame(&self.config, &self.framebuf, self.frame_number, &self.info)
                .map_err(|e| err("encode frame FLAC", e))?;
        self.frame_number += 1;

        let mut sink = MemSink::<u8>::new();
        frame.write(&mut sink).map_err(|e| err("tulis frame", e))?;
        let bytes = sink.as_slice();
        let block = len / ch;
        self.min_block = self.min_block.min(block);
        self.max_block = self.max_block.max(block);
        self.min_frame = self.min_frame.min(bytes.len());
        self.max_frame = self.max_frame.max(bytes.len());
        self.chunk.extend_from_slice(bytes);
        Ok(())
    }

    /// `Some(chunk)` kalau ambang chunk tercapai. Pemanggil mengirimkannya lalu
    /// WAJIB memanggil `release_chunk()`.
    pub fn poll_chunk(&mut self) -> Option<&[u8]> {
        if self.chunk.len() >= self.chunk_limit {
            Some(&self.chunk)
        } else {
            None
        }
    }

    /// Encode sisa sample (frame terakhir yang lebih pendek) dan kembalikan
    /// chunk terakhir.
    pub fn finish(&mut self) -> Result<&[u8], FlacError> {
        if !self.pending.is_empty() {
            let range = 0..self.pending.len();
            self.encode_block(range)?;
            self.pending.clear();
        }
        Ok(&self.chunk)
    }

    /// `clear()` mempertahankan kapasitas → nol alokasi untuk chunk berikutnya.
    pub fn release_chunk(&mut self) {
        self.chunk.clear();
    }
}

/// Encode sekali jalan (tes / file pendek). Byte-nya IDENTIK dengan hasil
/// `FlacStreamWriter` yang chunk-nya disambung.
pub fn encode_all(
    planar: &[&[f32]],
    spec: FlacSpec,
    dither: DitherSettings,
) -> Result<Vec<u8>, FlacError> {
    let mut w = FlacStreamWriter::with_chunk_size(spec, dither, usize::MAX)?;
    w.write_planar(planar)?;
    w.finish()?;
    let header = w.patch_header()?;
    let mut out = Vec::with_capacity(header.len() + w.chunk.len());
    out.extend_from_slice(&header);
    out.extend_from_slice(&w.chunk);
    Ok(out)
}
