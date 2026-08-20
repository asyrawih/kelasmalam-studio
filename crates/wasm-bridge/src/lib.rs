//! `daw-wasm` — jembatan WASM DawOnWeb.
//!
//! Crate ini adalah SATU-SATUNYA yang boleh menyentuh `wasm-bindgen`
//! (docs/04-build.md §layout workspace, docs/00-api-contract.md aturan 1).
//! Isinya sengaja tipis: semua logika ada di `daw-engine` / `daw-export`.
//!
//! Ada DUA surface yang sengaja dipisah (docs/01-threads-memory.md §1a):
//!
//! | Surface | File | Konsumen | Aturan |
//! |---|---|---|---|
//! | `raw`     | [`raw`]     | AudioWorklet (hot path) | `#[no_mangle] extern "C"`, argumen & return **numerik saja**. Tanpa wasm-bindgen, tanpa string, tanpa `JsValue`, tanpa alokasi setelah `engine_new`. |
//! | `bindgen` | [`bindgen`] | main thread + Web Worker | `#[wasm_bindgen]`. Boleh string, `Vec`, `Result`, alokasi. TIDAK realtime. |
//!
//! Worklet meng-instantiate modul yang sama tapi hanya memanggil
//! `instance.exports.engine_*` langsung — tidak ada glue JS di hot path.
//! Karena satu modul membawa dua surface, import wasm-bindgen (`__wbindgen_*`)
//! tetap ada di modul; worklet menyediakan stub yang tidak pernah dipanggil.
//! Lihat `web/src/audio/worklet-processor.ts` (`buildStubImports`).

#![cfg_attr(not(feature = "panic-hook"), allow(unused))]
// `unsafe` di crate ini semuanya ada di surface `raw` dan setiap blok wajib
// punya komentar `# Safety`.
#![forbid(unsafe_op_in_unsafe_fn)]

pub mod bindgen;
pub mod catalog;
pub mod raw;
pub mod studio;

/// Versi ABI antara JS dan WASM. Dinaikkan setiap kali tanda tangan fungsi di
/// [`raw`] atau [`bindgen`] berubah, atau layout SAB berubah. JS
/// memverifikasinya saat load (`wasm-loader.ts`) supaya artefak basi di cache
/// tidak dipakai diam-diam.
///
/// [`bindgen`] BARU masuk cakupan di versi 2. Sebelumnya cakupannya hanya
/// [`raw`] + SAB, jadi menambah export bindgen tidak pernah menaikkan angka ini
/// — dan artefak yang belum punya export itu tetap lolos cek, lalu gagal jauh
/// belakangan sebagai `... is not a function`. Itu terjadi dua kali
/// (`assetBytesLive`, lalu `beginAsset`). `REQUIRED_EXPORTS` di
/// `wasm-loader.ts` menutup lubangnya tanpa bergantung pada seseorang ingat
/// menaikkan angka ini; angka ini tetap ada sebagai jaring pertama.
pub const ABI_VERSION: u32 = 2;

/// Panic hook — **hanya** untuk surface non-RT.
///
/// Di jalur realtime `panic!` berarti trap `unreachable`, dan itu mematikan
/// `AudioContext` secara permanen (docs/05 §underrun). Hook ini tidak mencegah
/// apa pun di sana; gunanya murni supaya panic di main thread / worker muncul
/// sebagai stack trace yang terbaca di console, bukan "unreachable executed".
#[cfg(all(target_arch = "wasm32", feature = "panic-hook"))]
pub(crate) fn set_panic_hook() {
    use core::sync::atomic::{AtomicBool, Ordering};
    static DONE: AtomicBool = AtomicBool::new(false);
    if !DONE.swap(true, Ordering::Relaxed) {
        console_error_panic_hook::set_once();
    }
}

// Stub untuk build NON-wasm (mis. `cargo test` di host). Tidak ada yang
// memanggilnya di sana — itu memang maksudnya — jadi lint "never used"
// dimatikan di sini, bukan dengan menambah pemanggilan palsu.
#[cfg(not(all(target_arch = "wasm32", feature = "panic-hook")))]
#[allow(dead_code)]
pub(crate) fn set_panic_hook() {}
