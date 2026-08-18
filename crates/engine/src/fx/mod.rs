//! Kerangka efek: kontrak authoring, registry, dan rak node.
//!
//! ## Kenapa `trait` untuk menulis, `enum` untuk memanggil
//!
//! `fx.rs` versi lama memilih dispatch `enum` alih-alih `dyn Trait` dengan
//! alasan yang masih berlaku (docs/01 §1c): tidak ada vtable dan tidak ada cache
//! miss di inner loop. Tapi `enum` telanjang membuat menambah efek jadi mahal —
//! tiap efek baru menuntut suntingan di enum, di tiap `match`, di alokator, dan
//! di UI.
//!
//! Kerangka ini memisahkan keduanya. Penulis efek mengimplementasi
//! [`Effect`] — satu file, satu impl, plus deskriptor parameternya. Macro
//! Macro `fx_registry!` lalu **menghasilkan** enum, seluruh
//! dispatch-nya, dan katalog statisnya. Menambah efek ke-20 berarti satu file
//! baru dan satu baris di daftar registry; tidak ada `match` yang perlu
//! disunting dan tidak ada kode UI yang perlu ditulis.
//!
//! ## Kenapa `prepare` dan `process` dipisah
//!
//! `Eq4` sudah mendokumentasikan invariannya sendiri: "koefisien di-hitung
//! ULANG PER BLOK, tidak per sample", karena state TDF-II maknanya bergantung
//! koefisien. Pemisahan ini menjadikan invarian itu bagian dari kontrak, bukan
//! kebiasaan: [`Effect::prepare`] berjalan sekali per blok penuh dan boleh
//! memakai transendental, [`Effect::process`] berjalan per sub-blok dan hanya
//! boleh memajukan state.
//!
//! Konsekuensi yang penting: karena `process` cuma memajukan state, memecah
//! satu blok 1024 frame jadi delapan sub-blok 128 frame menghasilkan bit yang
//! sama persis. Itulah yang membuat `null_test_block_size_invariance` — dan
//! karenanya seluruh klaim "realtime dan offline memakai jalur yang sama" —
//! tetap berlaku saat katalog efek bertambah.

pub mod arena;
pub mod comp;
#[cfg(test)]
mod conformance;
pub mod desc;
pub mod eq;
pub mod layout;
pub mod params;
pub mod registry;

pub use arena::{FxArena, MemHandle, FX_ARENA_FLOATS};
pub use comp::CompNode;
pub use desc::{Category, EffectDesc, ParamDesc, Smoothing, Taper, Unit};
pub use eq::Eq4;
pub use layout::{plan_chains, ChainEntry, FxLayout, BUILTIN_NODES};
pub use params::{param_map_json, PARAMS_PER_TRACK};
pub use registry::{FxKind, FxNode, CATALOG};

use alloc::boxed::Box;
use alloc::vec::Vec;

use daw_dsp::Smoother;
use daw_rt::MAX_BLOCK;

/// Nilai parameter yang sudah di-latch untuk satu node, plus konteks waktunya.
///
/// Dibaca `Effect::prepare` sekali per blok. Latch-nya terjadi tepat sekali per
/// `render_block`, di tempat yang sama dengan pertukaran plan — jadi parameter
/// **konstan di seluruh sub-blok**. Itu disengaja: kalau parameter bisa berubah
/// di tengah blok, hasil render jadi bergantung pada di mana batas sub-blok
/// kebetulan jatuh, yang berarti bergantung pada timing thread UI.
pub struct ParamCtx<'a> {
    vals: &'a [f32],
    /// Sample rate aktif. Tidak pernah dipaksa 48 kHz (docs/05 §Safari).
    pub sample_rate: f32,
    /// Panjang satu beat dalam frame di awal blok ini. Dipakai parameter
    /// bersatuan [`Unit::Beats`].
    pub frames_per_beat: f32,
}

impl<'a> ParamCtx<'a> {
    pub fn new(vals: &'a [f32], sample_rate: f32, frames_per_beat: f32) -> Self {
        ParamCtx {
            vals,
            sample_rate,
            frames_per_beat,
        }
    }

    /// Konteks tanpa parameter ter-latch.
    ///
    /// Dipakai selama jalur param block belum hidup: `prepare` melihat slice
    /// kosong dan mempertahankan apa pun yang sudah dipasang lewat setter
    /// bertipe dari snapshot, alih-alih menimpanya dengan nol.
    pub fn empty(sample_rate: f32) -> Self {
        ParamCtx {
            vals: &[],
            sample_rate,
            frames_per_beat: sample_rate * 0.5,
        }
    }

    #[inline]
    pub fn len(&self) -> usize {
        self.vals.len()
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        self.vals.is_empty()
    }

    /// Nilai parameter ke-`i`, atau `fallback` kalau belum ada yang di-latch.
    #[inline]
    pub fn at_or(&self, i: usize, fallback: f32) -> f32 {
        match self.vals.get(i) {
            Some(v) if v.is_finite() => *v,
            _ => fallback,
        }
    }

    /// Parameter bersatuan beat → frame, dibatasi ke rentang yang masuk akal.
    #[inline]
    pub fn beats_to_frames(&self, beats: f32) -> f32 {
        let f = beats * self.frames_per_beat;
        if !(f > 1.0) {
            1.0
        } else if f > self.sample_rate * 8.0 {
            self.sample_rate * 8.0
        } else {
            f
        }
    }
}

/// Kontrak yang diimplementasi setiap efek.
///
/// Aturan yang mengikat seluruh implementor (docs/01 §1c):
/// - `process` dan `end_block`: tanpa alokasi, tanpa `panic!`, tanpa `format!`
/// - `process` wajib **resumable**: memecah satu blok jadi beberapa sub-blok
///   harus menghasilkan bit yang sama dengan satu panggilan utuh
/// - seluruh memori berasal dari `mem`, yang berasal dari [`FxArena`]
pub trait Effect: Sized {
    /// Deskriptor statis. Sumber tunggal untuk UI, penyimpanan, dan validasi.
    const DESC: EffectDesc;

    /// Berapa f32 yang dibutuhkan instance ini pada sample rate ini.
    ///
    /// Dihitung dari batas ATAS deskriptor, bukan dari nilai parameter saat
    /// ini — supaya menggerakkan knob tidak pernah menuntut realokasi.
    fn mem_frames(sample_rate: f32) -> usize {
        let _ = sample_rate;
        0
    }

    /// Konstruksi. NON-RT: dipanggil saat rack disusun ulang. Boleh menulis ke
    /// `mem`, tidak boleh mengalokasi heap.
    fn new(sample_rate: f32, mem: &mut [f32]) -> Self;

    /// Sekali di AWAL tiap blok penuh, sebelum `prepare`. Tempat menolkan
    /// akumulator per-blok (mis. gain reduction maksimum).
    fn begin_block(&mut self, mem: &mut [f32]) {
        let _ = mem;
    }

    /// Sekali per blok PENUH, sebelum loop sub-blok. Di sinilah transendental
    /// boleh dipanggil untuk nilai yang datang dari **param block**: resolusi
    /// beat→frame, set target smoother, desain koefisien dari knob.
    ///
    /// Perhatikan bahwa ini BUKAN tempat menanggapi perubahan yang datang
    /// lewat command ring. Command ber-timestamp memecah blok jadi sub-blok
    /// supaya berlaku sample-accurate; kalau tanggapannya ditunda ke sini,
    /// perubahan di tengah blok akan tertunda 1024 sample pada render offline
    /// tapi cuma 128 sample pada realtime — dan block-size invariance patah.
    /// Efek yang punya setting bertipe menanggapinya di `process`, dijaga flag
    /// `dirty`, persis seperti yang sudah dilakukan `Eq4`.
    fn prepare(&mut self, p: &ParamCtx<'_>);

    /// Sekali per SUB-BLOK. In-place, stereo planar. Wajib resumable.
    fn process(&mut self, mem: &mut [f32], l: &mut [f32], r: &mut [f32]);

    /// Sekali per blok penuh, setelah loop sub-blok. Tempat membuang denormal.
    fn end_block(&mut self, mem: &mut [f32]) {
        let _ = mem;
    }

    /// Nolkan seluruh state. Dipanggil saat seek, loop wrap, dan pergantian plan.
    fn reset(&mut self, mem: &mut [f32]);

    /// Sisa ekor dalam frame pada state SEKARANG.
    ///
    /// **Wajib fungsi murni dari parameter dan sample rate.** Tidak boleh
    /// mengukur energi: pengukuran energi dilakukan atas slice yang diberikan
    /// pemanggil, jadi ambangnya akan dilewati di sample yang berbeda antara
    /// render 128-frame dan 1024-frame — dan itu mematahkan null-test secara
    /// intermiten, hanya pada project yang punya ekor.
    fn tail_frames(&self, sample_rate: f32) -> u32 {
        let _ = sample_rate;
        0
    }

    /// Perkiraan biaya, flop per frame stereo. Dipakai `build_plan` untuk
    /// memperingatkan sebelum project-nya terlalu berat, bukan sesudahnya.
    fn cost_flops(&self) -> u32;

    /// Gain reduction untuk meter. Nol kecuali efek dinamika.
    fn gain_reduction_db(&self) -> f32 {
        0.0
    }
}

/// Waktu ramp bypass.
///
/// Bukan 3 ms seperti micro-fade tepi clip: 3 ms terdengar sebagai klik pada
/// jalur KERING yang masuk kembali, karena yang berubah bukan awal sebuah nada
/// melainkan level sinyal yang sedang berbunyi.
pub const BYPASS_FADE_MS: f32 = 10.0;

/// Satu slot terpasang di rak: node, memorinya, parameternya, dan bypass-nya.
pub struct FxSlot {
    pub node: FxNode,
    pub mem: MemHandle,
    /// Nilai parameter, diindeks urutan `EffectDesc::params`.
    pub params: Vec<f32>,
    bypassed: bool,
    /// Gain masuk ke node. Bypass menyala → meluncur ke 0.
    in_gain: Smoother,
    /// Gain jalur kering yang dilewatkan. Bypass menyala → meluncur ke 1.
    dry_gain: Smoother,
    /// Sisa frame sebelum node boleh benar-benar dilewati.
    tail_left: u32,
    sleeping: bool,
}

impl FxSlot {
    fn new(node: FxNode, mem: MemHandle, params: Vec<f32>, sample_rate: f32) -> Self {
        // tau = fade/3 → 95% tercapai dalam BYPASS_FADE_MS.
        let tau = BYPASS_FADE_MS / 3.0;
        FxSlot {
            node,
            mem,
            params,
            bypassed: false,
            in_gain: Smoother::new(sample_rate, tau, 1.0),
            dry_gain: Smoother::new(sample_rate, tau, 0.0),
            tail_left: 0,
            sleeping: false,
        }
    }

    /// Nyalakan/matikan bypass.
    ///
    /// Yang diredam adalah INPUT node, bukan keluarannya, sementara jalur
    /// kering dilewatkan kembali. Crossfade wet→dry yang lazim akan memotong
    /// ekor reverb tepat saat tombol ditekan; dengan meredam input, ekornya
    /// meluruh alami dan totalnya tidak pernah diskontinu.
    pub fn set_bypass(&mut self, on: bool) {
        if on == self.bypassed {
            return;
        }
        self.bypassed = on;
        self.in_gain.set_target(if on { 0.0 } else { 1.0 });
        self.dry_gain.set_target(if on { 1.0 } else { 0.0 });
        if !on {
            self.sleeping = false;
        }
    }

    pub fn is_bypassed(&self) -> bool {
        self.bypassed
    }

    /// Node tidur = sudah ter-bypass DAN ekornya habis. Biayanya satu cabang.
    pub fn is_sleeping(&self) -> bool {
        self.sleeping
    }
}

/// Tabel FX datar. Node diindeks `Step::Fx { node }`.
pub struct FxRack {
    slots: Box<[FxSlot]>,
    arena: FxArena,
    /// Salinan jalur kering selama transisi bypass. Efek tidak pernah
    /// bersarang, jadi satu buffer cukup untuk seluruh rak.
    dry: Box<[f32]>,
    sample_rate: f32,
}

impl FxRack {
    /// Rak bawaan tanpa chain user: dua node per unit (EQ, kompresor).
    pub fn new(units: usize, sample_rate: f32) -> Self {
        let mut slots: Vec<FxSlot> = Vec::with_capacity(units * layout::BUILTIN_PER_UNIT);
        for _ in 0..units {
            slots.push(FxSlot::new(
                FxNode::Eq(Eq4::new(sample_rate, &mut [])),
                MemHandle::EMPTY,
                Vec::new(),
                sample_rate,
            ));
            slots.push(FxSlot::new(
                FxNode::Comp(CompNode::new(sample_rate, &mut [])),
                MemHandle::EMPTY,
                Vec::new(),
                sample_rate,
            ));
        }
        FxRack {
            slots: slots.into_boxed_slice(),
            arena: FxArena::empty(),
            dry: alloc::vec![0.0f32; MAX_BLOCK * 2].into_boxed_slice(),
            sample_rate,
        }
    }

    /// Bangun rak dari penomoran [`FxLayout`]. NON-RT.
    ///
    /// `arena` sudah dibagikan `FxLayout::assign_memory`, jadi handle di tiap
    /// entri berlaku untuk arena yang dipindahkan ke sini.
    pub fn build(layout: &FxLayout, sample_rate: f32, mut arena: FxArena) -> Self {
        let mut slots: Vec<FxSlot> = Vec::with_capacity(layout.total_nodes());
        // Blok bawaan dulu, padat, supaya `unit*2` tetap berlaku.
        for _ in 0..(layout::BUILTIN_NODES / layout::BUILTIN_PER_UNIT) {
            slots.push(FxSlot::new(
                FxNode::Eq(Eq4::new(sample_rate, &mut [])),
                MemHandle::EMPTY,
                Vec::new(),
                sample_rate,
            ));
            slots.push(FxSlot::new(
                FxNode::Comp(CompNode::new(sample_rate, &mut [])),
                MemHandle::EMPTY,
                Vec::new(),
                sample_rate,
            ));
        }
        for e in layout.entries.iter() {
            let node = {
                let block = arena.block(e.mem);
                FxNode::make(e.kind, sample_rate, block)
            };
            let mut slot = FxSlot::new(node, e.mem, e.params.clone(), sample_rate);
            if e.bypass {
                slot.set_bypass(true);
                // Dipasang sudah ter-bypass: mulai dari nilai akhir, jangan
                // meluncur dari aktif ke bypass di blok pertama.
                slot.in_gain.set_immediate(0.0);
                slot.dry_gain.set_immediate(1.0);
            }
            slots.push(slot);
        }
        FxRack {
            slots: slots.into_boxed_slice(),
            arena,
            dry: alloc::vec![0.0f32; MAX_BLOCK * 2].into_boxed_slice(),
            sample_rate,
        }
    }

    /// Rak sebagai **chain lepas**: satu deret node tanpa konsep unit.
    ///
    /// Dipakai worklet `daw-fx` di jalur preview. Alasan ia memakai ulang
    /// `FxRack` alih-alih tipe baru: dengan begitu preview dan export
    /// menjalankan objek DSP yang sama persis — bypass, arena, tidur, dan
    /// urutan `prepare`/`process`-nya satu implementasi, bukan dua yang mirip.
    /// Dua implementasi mirip adalah persis cara `clip.stem` bisa terdengar di
    /// preview tapi hilang dari file export.
    pub fn chain(kinds: &[(FxKind, bool)], sample_rate: f32) -> Self {
        let need: usize = kinds
            .iter()
            .map(|(k, _)| k.mem_frames(sample_rate))
            .sum();
        let mut arena = FxArena::new(need);
        let mut slots: Vec<FxSlot> = Vec::with_capacity(kinds.len());
        for (kind, bypass) in kinds.iter() {
            let mem = arena.alloc(kind.mem_frames(sample_rate)).unwrap_or(MemHandle::EMPTY);
            let node = {
                let block = arena.block(mem);
                FxNode::make(*kind, sample_rate, block)
            };
            // Parameter dimulai dari default deskriptor, bukan nol: nol adalah
            // nilai yang sah untuk sebagian parameter dan akan terdengar
            // sebagai setelan yang salah sampai UI mengirim yang pertama.
            let params: Vec<f32> = kind.desc().params.iter().map(|p| p.default).collect();
            let mut slot = FxSlot::new(node, mem, params, sample_rate);
            if *bypass {
                slot.set_bypass(true);
                slot.in_gain.set_immediate(0.0);
                slot.dry_gain.set_immediate(1.0);
            }
            slots.push(slot);
        }
        FxRack {
            slots: slots.into_boxed_slice(),
            arena,
            dry: alloc::vec![0.0f32; MAX_BLOCK * 2].into_boxed_slice(),
            sample_rate,
        }
    }

    /// Jalankan SELURUH slot berurutan pada satu buffer stereo.
    #[inline]
    pub fn process_all(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..self.slots.len() {
            self.process_node(i as u16, l, r);
        }
    }

    /// Setel satu parameter. Nilainya dibaca `prepare` di awal blok berikutnya.
    pub fn set_param(&mut self, slot: usize, index: usize, value: f32) {
        if let Some(s) = self.slots.get_mut(slot) {
            if let Some(p) = s.params.get_mut(index) {
                *p = value;
            }
        }
    }

    pub fn set_bypass(&mut self, slot: usize, on: bool) {
        if let Some(s) = self.slots.get_mut(slot) {
            s.set_bypass(on);
        }
    }

    #[inline]
    pub fn len(&self) -> usize {
        self.slots.len()
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        self.slots.is_empty()
    }

    #[inline]
    pub fn get_mut(&mut self, node: u16) -> Option<&mut FxNode> {
        self.slots.get_mut(node as usize).map(|s| &mut s.node)
    }

    pub fn slot_mut(&mut self, node: u16) -> Option<&mut FxSlot> {
        self.slots.get_mut(node as usize)
    }

    /// Jalankan satu node pada buffer yang diberikan.
    ///
    /// Ada sebagai metode, bukan `get_mut(..).process(..)` di pemanggil, karena
    /// node, arena, dan buffer kering sama-sama milik `self`: memisahkan
    /// pinjamannya harus terjadi di dalam sini.
    #[inline]
    pub fn process_node(&mut self, node: u16, l: &mut [f32], r: &mut [f32]) {
        let FxRack {
            slots, arena, dry, ..
        } = self;
        let Some(slot) = slots.get_mut(node as usize) else {
            return;
        };
        if slot.sleeping {
            return;
        }
        let mem = arena.block(slot.mem);

        // Jalur cepat: sepenuhnya aktif. Ini 99% blok, jadi ia tidak boleh
        // membayar apa pun untuk mekanisme bypass.
        if !slot.bypassed && slot.in_gain.is_settled() {
            slot.node.process(mem, l, r);
            return;
        }

        let n = l.len().min(r.len()).min(MAX_BLOCK);
        let (dl, dr) = dry.split_at_mut(MAX_BLOCK);
        dl[..n].copy_from_slice(&l[..n]);
        dr[..n].copy_from_slice(&r[..n]);
        for i in 0..n {
            let g = slot.in_gain.next();
            l[i] *= g;
            r[i] *= g;
        }
        slot.node.process(mem, l, r);
        for i in 0..n {
            let d = slot.dry_gain.next();
            l[i] += dl[i] * d;
            r[i] += dr[i] * d;
        }
    }

    pub fn eq_mut(&mut self, unit: u16) -> Option<&mut Eq4> {
        match self
            .slots
            .get_mut(unit as usize * layout::BUILTIN_PER_UNIT)
        {
            Some(FxSlot {
                node: FxNode::Eq(e),
                ..
            }) => Some(e),
            _ => None,
        }
    }

    pub fn comp_mut(&mut self, unit: u16) -> Option<&mut CompNode> {
        match self
            .slots
            .get_mut(unit as usize * layout::BUILTIN_PER_UNIT + 1)
        {
            Some(FxSlot {
                node: FxNode::Comp(c),
                ..
            }) => Some(c),
            _ => None,
        }
    }

    /// GR blok terakhir untuk unit tsb (0.0 kalau bukan kompresor).
    pub fn gain_reduction(&self, unit: u16) -> f32 {
        match self.slots.get(unit as usize * layout::BUILTIN_PER_UNIT + 1) {
            Some(s) => s.node.gain_reduction_db(),
            None => 0.0,
        }
    }

    /// Perkiraan biaya seluruh rak, flop per frame stereo. Node tidur tidak
    /// dihitung — itu yang membuat rak besar tetap terjangkau.
    pub fn cost_flops(&self) -> u32 {
        self.slots
            .iter()
            .filter(|s| !s.sleeping)
            .map(|s| s.node.cost_flops())
            .fold(0u32, |a, b| a.saturating_add(b))
    }

    /// Ekor terpanjang di seluruh rak, dalam frame. NON-RT.
    pub fn tail_frames(&self) -> u32 {
        self.slots
            .iter()
            .map(|s| s.node.tail_frames(self.sample_rate))
            .max()
            .unwrap_or(0)
    }

    /// Sekali di AWAL tiap blok penuh (bukan sub-blok).
    pub fn begin_block(&mut self) {
        let sr = self.sample_rate;
        let FxRack { slots, arena, .. } = self;
        for s in slots.iter_mut() {
            if s.sleeping {
                continue;
            }
            let mem = arena.block(s.mem);
            s.node.begin_block(mem);
            let ctx = ParamCtx::new(&s.params, sr, sr * 0.5);
            s.node.prepare(&ctx);
        }
    }

    /// Sekali di AKHIR tiap blok penuh.
    ///
    /// Di sinilah slot yang sudah ter-bypass dan ekornya habis ditidurkan.
    /// Tanpa langkah ini, sebuah rak berisi ratusan node membayar penuh untuk
    /// efek yang sudah lama dimatikan user.
    pub fn end_block(&mut self, frames: u32) {
        let sr = self.sample_rate;
        let FxRack { slots, arena, .. } = self;
        for s in slots.iter_mut() {
            if s.sleeping {
                continue;
            }
            let mem = arena.block(s.mem);
            s.node.end_block(mem);

            if s.bypassed && s.in_gain.is_settled() {
                if s.tail_left == 0 {
                    s.tail_left = s.node.tail_frames(sr).max(1);
                }
                s.tail_left = s.tail_left.saturating_sub(frames);
                if s.tail_left == 0 {
                    s.node.reset(mem);
                    s.sleeping = true;
                }
            } else {
                s.tail_left = 0;
            }
        }
    }

    /// Reset seluruh state IIR/envelope — dipakai saat seek & saat plan diganti.
    pub fn reset_all(&mut self) {
        let FxRack { slots, arena, .. } = self;
        for s in slots.iter_mut() {
            let mem = arena.block(s.mem);
            s.node.reset(mem);
            s.tail_left = 0;
            // Slot yang di-bypass tetap bypass, tapi bangun kembali supaya ia
            // ikut meredam input lagi kalau user mematikannya nanti.
            s.sleeping = false;
        }
    }
}

#[cfg(test)]
mod chain_tests {
    use super::*;

    /// Chain lepas harus benar-benar memproses audio yang masuk — inilah yang
    /// dipakai worklet preview, dan kalau ia diam saja maka preview dan file
    /// hasil export berbeda tanpa ada yang tahu.
    #[test]
    fn a_standalone_chain_processes_incoming_audio() {
        let mut rack = FxRack::chain(&[(FxKind::Eq, false)], 48_000.0);
        // Highpass 1 kHz pada DC murni: yang tersisa harus mendekati nol.
        rack.set_param(0, 0, 1.0); // b1_kind = HighPass
        rack.set_param(0, 1, 1_000.0);
        rack.set_param(0, 2, 0.707);
        rack.set_param(0, 4, 1.0); // b1_on

        let mut worst = 0.0f32;
        for blk in 0..40 {
            let mut l = alloc::vec![0.5f32; 128];
            let mut r = alloc::vec![0.5f32; 128];
            rack.begin_block();
            rack.process_all(&mut l, &mut r);
            rack.end_block(128);
            if blk >= 20 {
                for v in l.iter().chain(r.iter()) {
                    worst = worst.max(v.abs());
                }
            }
        }
        assert!(worst < 0.05, "highpass tidak berjalan, DC tersisa {worst}");
    }

    /// Chain kosong harus melewatkan sinyal apa adanya — bit demi bit.
    #[test]
    fn an_empty_chain_is_bit_transparent() {
        let mut rack = FxRack::chain(&[], 48_000.0);
        let src: [f32; 128] = core::array::from_fn(|i| (i as f32) * 0.001 - 0.06);
        let mut l = src;
        let mut r = src;
        rack.begin_block();
        rack.process_all(&mut l, &mut r);
        rack.end_block(128);
        assert_eq!(l, src);
        assert_eq!(r, src);
    }

    /// Efek yang dibangun dalam keadaan bypass tidak boleh menyentuh sinyal.
    #[test]
    fn a_chain_built_bypassed_passes_signal_through() {
        let mut rack = FxRack::chain(&[(FxKind::Eq, true)], 48_000.0);
        rack.set_param(0, 0, 1.0);
        rack.set_param(0, 1, 1_000.0);
        rack.set_param(0, 4, 1.0);
        let src = alloc::vec![0.5f32; 128];
        let mut l = src.clone();
        let mut r = src.clone();
        rack.begin_block();
        rack.process_all(&mut l, &mut r);
        rack.end_block(128);
        for (i, v) in l.iter().enumerate() {
            assert!((v - 0.5).abs() < 1e-4, "bypass tidak transparan di {i}: {v}");
        }
        let _ = r;
    }

    /// Parameter default diambil dari deskriptor, bukan nol — nol adalah nilai
    /// yang sah untuk sebagian parameter dan akan terdengar sebagai setelan
    /// yang salah sampai UI mengirim yang pertama.
    #[test]
    fn a_new_chain_starts_from_descriptor_defaults() {
        let rack = FxRack::chain(&[(FxKind::Comp, false)], 48_000.0);
        let want: Vec<f32> = FxKind::Comp.desc().params.iter().map(|p| p.default).collect();
        assert_eq!(rack.slots[0].params, want);
    }
}
