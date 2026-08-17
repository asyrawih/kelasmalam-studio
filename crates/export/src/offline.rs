//! Offline renderer.
//!
//! Dua alasan export TIDAK lewat AudioWorklet (docs/03 §3a):
//! 1. realtime terikat wall-clock — `process()` dipanggil 375×/detik apa pun
//!    kecepatan CPU, jadi render 5 menit makan 5 menit. Loop offline memanggil
//!    `render_block` secepat CPU sanggup;
//! 2. export akan merusak transport realtime — playhead harus dipindah ke 0 dan
//!    dijalankan, artinya user tidak bisa mendengar apa pun selama export.
//!
//! Renderer ini memanggil `Engine::render_block` YANG SAMA — tidak ada jalur DSP
//! kedua, jadi hasil export identik dengan yang didengar user.
//!
//! Tidak ada timing/sleep di sini sama sekali. Batching + yield adalah urusan
//! pemanggil (worker JS); yang disediakan Rust hanyalah "render N blok".

use daw_engine::Engine;
use daw_rt::MAX_BLOCK;
use daw_timeline::TimelineSample;

/// Default 100 blok = 12800 frame ≈ 267 ms audio @48k (docs/03 §3a).
pub const DEFAULT_BATCH_BLOCKS: usize = 100;

pub struct OfflineRenderer {
    engine: Engine,
    start: u64,
    end: u64,
    rendered: u64,
    block: usize,
    cancelled: bool,
}

impl OfflineRenderer {
    pub fn new(engine: Engine, start: TimelineSample, end: TimelineSample) -> Self {
        Self::with_block_size(engine, start, end, 128)
    }

    pub fn with_block_size(
        mut engine: Engine,
        start: TimelineSample,
        end: TimelineSample,
        block: usize,
    ) -> Self {
        let block = block.clamp(1, MAX_BLOCK);
        engine.seek(start);
        engine.play();
        OfflineRenderer {
            engine,
            start: start.0,
            end: end.0.max(start.0),
            rendered: 0,
            block,
            cancelled: false,
        }
    }

    pub fn total_frames(&self) -> u64 {
        self.end - self.start
    }

    pub fn rendered_frames(&self) -> u64 {
        self.rendered
    }

    pub fn block_size(&self) -> usize {
        self.block
    }

    /// Progress 0.0..1.0 — pemanggil yang men-throttle laporannya (maks 20×/detik
    /// wall-clock, atau tiap 1%, mana yang lebih jarang).
    pub fn progress(&self) -> f32 {
        let t = self.total_frames();
        if t == 0 {
            1.0
        } else {
            (self.rendered as f64 / t as f64) as f32
        }
    }

    pub fn is_finished(&self) -> bool {
        self.cancelled || self.rendered >= self.total_frames()
    }

    /// Pembatalan dicek SEKALI PER BATCH, bukan per blok: 375 atomic load/detik
    /// untuk nilai yang berubah sekali seumur hidup itu boros. Telat 267 ms
    /// untuk membatalkan bukan masalah (ordering Relaxed di sisi SAB).
    pub fn request_cancel(&mut self) {
        self.cancelled = true;
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled
    }

    /// Render `blocks` blok ke buffer planar. Mengembalikan jumlah frame yang
    /// dihasilkan; 0 = selesai (atau dibatalkan).
    pub fn render_batch(&mut self, blocks: usize, out_l: &mut [f32], out_r: &mut [f32]) -> usize {
        self.render_batch_with(blocks, out_l, out_r, || false)
    }

    /// Versi dengan hook pembatalan yang di-poll SATU KALI di awal batch —
    /// bentuk generic supaya tidak ada `Box<dyn Fn>` (dan tidak ada alokasi).
    pub fn render_batch_with<F: FnMut() -> bool>(
        &mut self,
        blocks: usize,
        out_l: &mut [f32],
        out_r: &mut [f32],
        mut cancel_check: F,
    ) -> usize {
        if cancel_check() {
            self.cancelled = true;
        }
        if self.is_finished() {
            return 0;
        }
        let cap = out_l.len().min(out_r.len());
        let remaining_total = (self.total_frames() - self.rendered) as usize;
        let mut produced = 0usize;
        let mut done_blocks = 0usize;

        while done_blocks < blocks && produced < cap && produced < remaining_total {
            let n = self
                .block
                .min(cap - produced)
                .min(remaining_total - produced);
            if n == 0 {
                break;
            }
            self.engine.render_block(
                &mut out_l[produced..produced + n],
                &mut out_r[produced..produced + n],
            );
            produced += n;
            done_blocks += 1;
        }
        self.rendered += produced as u64;
        produced
    }

    /// Mengembalikan engine (mis. untuk dipakai lagi / dibuang eksplisit).
    pub fn into_engine(self) -> Engine {
        self.engine
    }

    pub fn engine_mut(&mut self) -> &mut Engine {
        &mut self.engine
    }
}
