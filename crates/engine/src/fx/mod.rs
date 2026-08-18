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
pub mod desc;
pub mod eq;
pub mod registry;

pub use arena::{FxArena, MemHandle, FX_ARENA_FLOATS};
pub use comp::CompNode;
pub use desc::{Category, EffectDesc, ParamDesc, Smoothing, Taper, Unit};
pub use eq::Eq4;
pub use registry::{FxKind, FxNode, CATALOG};

use alloc::boxed::Box;
use alloc::vec::Vec;

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

/// Satu slot terpasang di rak: node plus region arenanya.
pub struct FxSlot {
    pub node: FxNode,
    pub mem: MemHandle,
}

/// Tabel FX datar. Node diindeks `Step::Fx { node }`.
pub struct FxRack {
    slots: Box<[FxSlot]>,
    arena: FxArena,
    sample_rate: f32,
}

/// Jumlah node per unit pada tata letak sekarang: EQ lalu kompresor.
pub const SLOTS_PER_UNIT: usize = 2;

impl FxRack {
    /// Rak bawaan: dua node per unit (EQ, kompresor), dialokasi SEKALI.
    ///
    /// Arena-nya kosong karena kedua efek bawaan tidak butuh memori delay.
    /// Efek berbasis delay mendapat arenanya lewat [`FxRack::with_arena`].
    pub fn new(units: usize, sample_rate: f32) -> Self {
        Self::with_arena(units, sample_rate, FxArena::empty())
    }

    pub fn with_arena(units: usize, sample_rate: f32, arena: FxArena) -> Self {
        let mut v = Vec::with_capacity(units * SLOTS_PER_UNIT);
        for _ in 0..units {
            v.push(FxSlot {
                node: FxNode::Eq(Eq4::new(sample_rate, &mut [])),
                mem: MemHandle::EMPTY,
            });
            v.push(FxSlot {
                node: FxNode::Comp(CompNode::new(sample_rate, &mut [])),
                mem: MemHandle::EMPTY,
            });
        }
        FxRack {
            slots: v.into_boxed_slice(),
            arena,
            sample_rate,
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

    /// Jalankan satu node pada buffer yang diberikan.
    ///
    /// Ada sebagai metode, bukan `get_mut(..).process(..)` di pemanggil, karena
    /// node dan arenanya sama-sama milik `self`: memisahkan pinjamannya harus
    /// terjadi di dalam sini, di mana destrukturisasi `self` membuat keduanya
    /// jadi field yang lepas satu sama lain.
    #[inline]
    pub fn process_node(&mut self, node: u16, l: &mut [f32], r: &mut [f32]) {
        let FxRack { slots, arena, .. } = self;
        if let Some(slot) = slots.get_mut(node as usize) {
            let mem = arena.block(slot.mem);
            slot.node.process(mem, l, r);
        }
    }

    pub fn eq_mut(&mut self, unit: u16) -> Option<&mut Eq4> {
        match self.slots.get_mut(unit as usize * SLOTS_PER_UNIT) {
            Some(FxSlot {
                node: FxNode::Eq(e),
                ..
            }) => Some(e),
            _ => None,
        }
    }

    pub fn comp_mut(&mut self, unit: u16) -> Option<&mut CompNode> {
        match self.slots.get_mut(unit as usize * SLOTS_PER_UNIT + 1) {
            Some(FxSlot {
                node: FxNode::Comp(c),
                ..
            }) => Some(c),
            _ => None,
        }
    }

    /// GR blok terakhir untuk unit tsb (0.0 kalau bukan kompresor).
    pub fn gain_reduction(&self, unit: u16) -> f32 {
        match self.slots.get(unit as usize * SLOTS_PER_UNIT + 1) {
            Some(s) => s.node.gain_reduction_db(),
            None => 0.0,
        }
    }

    /// Perkiraan biaya seluruh rak, flop per frame stereo.
    pub fn cost_flops(&self) -> u32 {
        self.slots
            .iter()
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
    ///
    /// `prepare` dipanggil dengan konteks kosong selama jalur param block
    /// belum hidup — tiap efek mempertahankan setting bertipenya alih-alih
    /// ditimpa nol. Begitu `Engine::latch_params` ada, satu-satunya yang
    /// berubah di sini adalah slice yang dimasukkan ke `ParamCtx`.
    pub fn begin_block(&mut self) {
        let sr = self.sample_rate;
        let FxRack { slots, arena, .. } = self;
        let ctx = ParamCtx::empty(sr);
        for s in slots.iter_mut() {
            let mem = arena.block(s.mem);
            s.node.begin_block(mem);
            s.node.prepare(&ctx);
        }
    }

    /// Sekali di AKHIR tiap blok penuh. Membuang denormal dari state IIR.
    pub fn end_block(&mut self) {
        let FxRack { slots, arena, .. } = self;
        for s in slots.iter_mut() {
            let mem = arena.block(s.mem);
            s.node.end_block(mem);
        }
    }

    /// Reset seluruh state IIR/envelope — dipakai saat seek & saat plan diganti.
    pub fn reset_all(&mut self) {
        let FxRack { slots, arena, .. } = self;
        for s in slots.iter_mut() {
            let mem = arena.block(s.mem);
            s.node.reset(mem);
        }
    }
}
