//! Registry efek — **satu-satunya tempat** daftar efek ditulis.
//!
//! Macro di bawah menghasilkan, dari satu daftar: enum `FxKind`, enum `FxNode`,
//! seluruh dispatch-nya, dan katalog statis yang dibaca UI. Menambah efek
//! berarti menambah satu file dan satu baris — bukan menyunting lima `match`
//! yang tersebar dan berharap tidak ada yang terlewat.
//!
//! Diskriminan `FxKind` **ikut tersimpan di snapshot project**. Menggesernya
//! membuat project lama dibaca sebagai efek yang berbeda, tanpa error. Karena
//! itu angkanya ditulis eksplisit dan dikunci oleh `const _: () = assert!(..)`
//! di akhir berkas — idiom yang sama dengan `crates/rt/src/layout.rs`.

use super::desc::EffectDesc;
use super::{Effect, ParamCtx};

/// Tipe yang disimpan varian enum: `T`, atau `Box<T>` kalau ditandai `boxed`.
macro_rules! fx_hold {
    ($ty:ty) => {
        $ty
    };
    ($ty:ty, boxed) => {
        alloc::boxed::Box<$ty>
    };
}

/// Bungkus nilai sesuai penanda yang sama.
macro_rules! fx_wrap {
    ($e:expr) => {
        $e
    };
    ($e:expr, boxed) => {
        alloc::boxed::Box::new($e)
    };
}

/// Bangun `FxKind`, `FxNode`, dispatch, dan `CATALOG` dari satu daftar.
///
/// Penanda `boxed` untuk efek berstate besar: tanpanya, ukuran enum ditentukan
/// varian terbesar dan SETIAP node membayarnya. REVERB sendirian sekitar 272
/// byte; di rak berisi ratusan node itu puluhan kilobyte terbuang untuk slot
/// yang isinya EQ. Dengan `boxed`, variannya cuma menyimpan satu penunjuk, dan
/// harganya satu pointer-chase per node per sub-blok — tidak terukur
/// dibandingkan kerja yang dilakukannya.
macro_rules! fx_registry {
    ($( $kind:literal => $variant:ident : $ty:ty $(, $boxed:ident)? ; )*) => {

        /// Jenis efek. Diskriminannya kontrak serialisasi.
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        #[repr(u16)]
        pub enum FxKind { $( $variant = $kind ),* }

        impl FxKind {
            /// Semua jenis, untuk iterasi di tes konformans.
            pub const ALL: &'static [FxKind] = &[ $( FxKind::$variant ),* ];

            /// Dari nilai tersimpan. `None` = efek tidak dikenal versi ini,
            /// yang dilaporkan sebagai peringatan, bukan dibuang diam-diam.
            pub fn from_u16(v: u16) -> Option<Self> {
                match v { $( $kind => Some(FxKind::$variant), )* _ => None }
            }

            #[inline]
            pub fn as_u16(self) -> u16 {
                self as u16
            }

            pub fn desc(self) -> &'static EffectDesc {
                match self { $( FxKind::$variant => &<$ty as Effect>::DESC, )* }
            }

            /// Berapa f32 arena yang dibutuhkan satu instance jenis ini.
            pub fn mem_frames(self, sample_rate: f32) -> usize {
                match self { $( FxKind::$variant => <$ty as Effect>::mem_frames(sample_rate), )* }
            }
        }

        /// Node insert. Dispatch `enum`, bukan `dyn Trait` (docs/01 §1c).
        pub enum FxNode { $( $variant( fx_hold!($ty $(, $boxed)?) ) ),* }

        impl FxNode {
            /// Buat node baru dari jenisnya. NON-RT.
            pub fn make(kind: FxKind, sample_rate: f32, mem: &mut [f32]) -> FxNode {
                match kind { $(
                    FxKind::$variant => FxNode::$variant(
                        fx_wrap!(<$ty as Effect>::new(sample_rate, mem) $(, $boxed)?)
                    ),
                )* }
            }

            #[inline]
            pub fn kind(&self) -> FxKind {
                match self { $( FxNode::$variant(_) => FxKind::$variant, )* }
            }

            #[inline]
            pub fn desc(&self) -> &'static EffectDesc {
                self.kind().desc()
            }

            #[inline]
            pub fn begin_block(&mut self, mem: &mut [f32]) {
                match self { $( FxNode::$variant(x) => x.begin_block(mem), )* }
            }

            #[inline]
            pub fn prepare(&mut self, p: &ParamCtx<'_>) {
                match self { $( FxNode::$variant(x) => x.prepare(p), )* }
            }

            /// In-place, stereo planar. Zero alloc, no panic.
            #[inline]
            pub fn process(&mut self, mem: &mut [f32], l: &mut [f32], r: &mut [f32]) {
                match self { $( FxNode::$variant(x) => x.process(mem, l, r), )* }
            }

            #[inline]
            pub fn end_block(&mut self, mem: &mut [f32]) {
                match self { $( FxNode::$variant(x) => x.end_block(mem), )* }
            }

            #[inline]
            pub fn reset(&mut self, mem: &mut [f32]) {
                match self { $( FxNode::$variant(x) => x.reset(mem), )* }
            }

            #[inline]
            pub fn tail_frames(&self, sample_rate: f32) -> u32 {
                match self { $( FxNode::$variant(x) => x.tail_frames(sample_rate), )* }
            }

            #[inline]
            pub fn cost_flops(&self) -> u32 {
                match self { $( FxNode::$variant(x) => x.cost_flops(), )* }
            }

            #[inline]
            pub fn gain_reduction_db(&self) -> f32 {
                match self { $( FxNode::$variant(x) => x.gain_reduction_db(), )* }
            }
        }

        /// Katalog lengkap. Diekspor ke JS sebagai JSON dan dibaca UI untuk
        /// merakit knob — jadi tidak ada kode UI per-efek.
        pub static CATALOG: &[EffectDesc] = &[ $( <$ty as Effect>::DESC ),* ];
    };
}

fx_registry! {
    0 => Eq   : super::eq::Eq4;
    1 => Comp : super::comp::CompNode;
}

// Diskriminan ikut ke snapshot: menggesernya menafsirkan ulang project lama.
const _: () = assert!(FxKind::Eq as u16 == 0);
const _: () = assert!(FxKind::Comp as u16 == 1);

// Ukuran enum bagian dari kontrak, bukan kebetulan: rak bisa berisi ratusan
// node, jadi tiap byte dikali ratusan. Kalau assert ini pecah, kandidat
// pertamanya adalah efek baru yang lupa ditandai `boxed`.
const _: () = assert!(core::mem::size_of::<FxNode>() <= 256);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_covers_every_kind() {
        assert_eq!(CATALOG.len(), FxKind::ALL.len());
        for k in FxKind::ALL {
            let d = k.desc();
            assert_eq!(d.kind, k.as_u16(), "desc {} salah kind", d.id);
            assert!(
                CATALOG.iter().any(|c| c.kind == d.kind),
                "{} tidak ada di CATALOG",
                d.id
            );
        }
    }

    /// Deskriptor yang tidak konsisten harus ketahuan saat `cargo test`, bukan
    /// saat efeknya dipakai. Ini tes yang membuat efek ke-20 murah: satu file
    /// baru langsung ikut tervalidasi tanpa menulis tes baru.
    #[test]
    fn every_descriptor_in_the_catalog_is_valid() {
        for d in CATALOG {
            assert!(d.is_valid(), "deskriptor tidak valid: {}", d.id);
        }
    }

    #[test]
    fn ids_and_kinds_are_unique() {
        for (i, a) in CATALOG.iter().enumerate() {
            for b in CATALOG.iter().skip(i + 1) {
                assert_ne!(a.id, b.id, "id efek duplikat: {}", a.id);
                assert_ne!(a.kind, b.kind, "kind duplikat: {}", a.kind);
            }
        }
    }

    #[test]
    fn from_u16_roundtrips_and_rejects_unknown() {
        for k in FxKind::ALL {
            assert_eq!(FxKind::from_u16(k.as_u16()), Some(*k));
        }
        assert_eq!(FxKind::from_u16(9999), None);
    }

    /// Katalog awal tidak boleh punya latensi: `ProcessPlan` belum bisa
    /// menyatakan kompensasi delay, jadi efek berlatensi akan menggeser satu
    /// track terhadap seluruh mix — dan null-test tetap lulus sambil mix-nya
    /// salah, jadi tidak ada yang menangkapnya selain aturan ini.
    #[test]
    fn no_effect_declares_latency_yet() {
        for d in CATALOG {
            assert_eq!(d.latency_frames, 0, "{} memperkenalkan latensi", d.id);
        }
    }

    #[test]
    fn make_produces_the_requested_kind() {
        for k in FxKind::ALL {
            let n = FxNode::make(*k, 48_000.0, &mut []);
            assert_eq!(n.kind(), *k);
        }
    }
}
