//! Voice = satu clip yang sedang berbunyi.
//!
//! Isi file ini (docs/01 §1c + docs/02):
//! - pool voice dialokasi SEKALI; tidak pernah ada alokasi setelah `new()`
//! - fractional cursor + pembacaan cubic Hermite (`daw_dsp::hermite4`)
//! - clip gain, fade user, dan MICRO-FADE otomatis 2–5 ms di SETIAP tepi clip.
//!   Micro-fade hidup di engine, bukan di UI: tepi clip yang tidak melewati nol
//!   adalah diskontinuitas, dan diskontinuitas selalu terdengar sebagai klik.
//!   UI tidak boleh bisa "lupa" memasangnya.
//! - voice stealing saat pool habis: korban tertua/terpelan di-fade-out 2 ms
//!   lalu slot-nya dipakai clip baru (crossfade dalam satu voice). TIDAK PERNAH
//!   mengalokasi — "gagal dengan anggun" inilah beda engine realtime dari kode biasa.

use alloc::boxed::Box;
use alloc::vec::Vec;

use daw_dsp::{db_to_lin, hermite4};

use crate::snapshot::{FADE_EQUAL_POWER, FADE_LINEAR};

/// Panjang micro-fade default (ms). Spesifikasi: 2–5 ms.
pub const MICRO_FADE_MS: f32 = 3.0;

/// Fade-out saat voice dicuri / transport berhenti / loop wrap (ms).
pub const STEAL_FADE_MS: f32 = 2.0;

/// Gain fade pada posisi `t` (0 = sunyi, 1 = penuh) untuk kurva `curve`.
///
/// Rumusnya WAJIB sama persis dengan `fadeInGain` di
/// `web/src/studio/timeline/fade.ts` — kalau tidak, transisi yang didengar user
/// di preview dan yang tertulis ke file akan berbeda. Ujung-ujungnya dijepit
/// EKSPLISIT ke 0 dan 1: `sinf` yang meleset satu ULP di t=1 menjadi ekor yang
/// tidak pernah benar-benar diam.
#[inline]
pub fn fade_gain(curve: u8, t: f32) -> f32 {
    if t <= 0.0 {
        return 0.0;
    }
    if t >= 1.0 {
        return 1.0;
    }
    if curve == FADE_EQUAL_POWER {
        // sinf dipanggil hanya SELAMA fade (beberapa ms per tepi clip), bukan
        // sepanjang clip — biayanya tidak terasa di anggaran blok.
        libm::sinf(t * core::f32::consts::FRAC_PI_2)
    } else {
        t
    }
}

/// Asset PCM. Read-only di jalur RT; datanya hidup di shared linear memory dan
/// dibagi antara worklet dan worker export tanpa disalin (docs/03 §3a).
#[derive(Copy, Clone)]
pub struct Asset {
    /// Planar: channel `c` mulai di `data + c * frames`.
    pub data: *const f32,
    pub frames: usize,
    pub channels: u8,
    pub sample_rate: u32,
}

impl Asset {
    #[inline]
    fn sample(&self, ch: usize, idx: i64) -> f32 {
        if self.frames == 0 || self.data.is_null() {
            return 0.0;
        }
        // Clamp, bukan wrap: di luar clip kita memang tidak berbunyi, dan
        // clamping menghindari cabang panic dari indexing.
        let i = if idx < 0 {
            0usize
        } else if idx as usize >= self.frames {
            self.frames - 1
        } else {
            idx as usize
        };
        let ch = if (ch as u8) < self.channels { ch } else { 0 };
        // SAFETY: `data` menunjuk ke `channels * frames` f32 yang valid selama
        // asset terdaftar; `i < frames` dan `ch < channels` sudah dijamin di atas.
        unsafe { *self.data.add(ch * self.frames + i) }
    }
}

/// Tabel asset — hanya BACA di RT, mutasi lewat command dari sisi non-RT.
pub struct AssetTable {
    slots: Box<[Option<Asset>]>,
}

impl AssetTable {
    pub fn new(capacity: usize) -> Self {
        let mut v = Vec::with_capacity(capacity);
        v.resize(capacity, None);
        AssetTable {
            slots: v.into_boxed_slice(),
        }
    }

    /// # Safety
    /// `asset.data` harus valid untuk `channels * frames` f32 selama slot ini
    /// terdaftar, dan tidak boleh dimutasi selagi engine merender.
    pub unsafe fn register(&mut self, id: u16, asset: Asset) {
        if let Some(s) = self.slots.get_mut(id as usize) {
            *s = Some(asset);
        }
    }

    pub fn unregister(&mut self, id: u16) {
        if let Some(s) = self.slots.get_mut(id as usize) {
            *s = None;
        }
    }

    #[inline]
    pub fn get(&self, id: u16) -> Option<Asset> {
        self.slots.get(id as usize).copied().flatten()
    }
}

/// Parameter awal sebuah voice.
#[derive(Copy, Clone)]
pub struct VoiceStart {
    pub track: u16,
    pub asset: u16,
    /// Posisi baca awal di dalam asset (sample source, boleh pecahan lewat `speed`).
    pub source_offset: u64,
    /// Sisa panjang di timeline (sample).
    pub remaining: u64,
    /// Panjang total clip di timeline — dipakai untuk menghitung tepi fade-out.
    pub total_len: u64,
    /// Sudah berapa sample clip ini berjalan (>0 kalau voice dimulai di tengah
    /// clip, mis. setelah seek).
    pub played: u64,
    pub gain_db: f32,
    pub fade_in: u64,
    pub fade_out: u64,
    /// 0 = linear, 1 = equal-power. Lihat `ClipDesc::fade_curve`.
    pub fade_curve: u8,
    pub speed: f64,
}

#[derive(Copy, Clone, PartialEq, Eq)]
enum VoiceState {
    Free,
    Playing,
    /// Fade-out singkat lalu berhenti (atau lalu memulai `pending`).
    FadingOut,
}

pub struct Voice {
    state: VoiceState,
    track: u16,
    asset: u16,
    /// Posisi baca pecahan di dalam asset.
    pos: f64,
    speed: f64,
    gain: f32,
    remaining: u64,
    total_len: u64,
    played: u64,
    fade_in: u64,
    fade_out: u64,
    fade_curve: u8,
    /// Sisa sample fade-out paksa (steal/stop/loop).
    kill_remaining: u32,
    kill_len: u32,
    /// Clip yang akan menggantikan voice ini setelah fade-out selesai.
    pending: Option<VoiceStart>,
    /// Nomor urut alokasi — dipakai untuk memilih korban "tertua".
    age: u64,
    /// Puncak amplitudo blok terakhir — dipakai untuk memilih korban "terpelan".
    peak: f32,
}

impl Voice {
    fn idle() -> Self {
        Voice {
            state: VoiceState::Free,
            track: 0,
            asset: 0,
            pos: 0.0,
            speed: 1.0,
            gain: 1.0,
            remaining: 0,
            total_len: 0,
            played: 0,
            fade_in: 0,
            fade_out: 0,
            fade_curve: FADE_LINEAR,
            kill_remaining: 0,
            kill_len: 0,
            pending: None,
            age: 0,
            peak: 0.0,
        }
    }

    fn start(&mut self, s: &VoiceStart, micro: u64, age: u64) {
        self.state = VoiceState::Playing;
        self.track = s.track;
        self.asset = s.asset;
        self.pos = s.source_offset as f64;
        self.speed = if s.speed.is_finite() && s.speed > 0.0 {
            s.speed
        } else {
            1.0
        };
        self.gain = db_to_lin(s.gain_db);
        self.remaining = s.remaining;
        self.total_len = s.total_len.max(1);
        self.played = s.played;
        // Micro-fade WAJIB: fade user boleh 0, engine tetap memasang 2–5 ms.
        self.fade_in = s.fade_in.max(micro);
        self.fade_out = s.fade_out.max(micro);
        self.fade_curve = s.fade_curve;
        self.kill_remaining = 0;
        self.kill_len = 0;
        self.pending = None;
        self.age = age;
        self.peak = 0.0;
    }

    #[inline]
    pub fn active(&self) -> bool {
        self.state != VoiceState::Free
    }

    /// Amplop clip pada posisi `played` (fade-in dari awal, fade-out ke akhir).
    #[inline]
    fn clip_env(&self, played: u64) -> f32 {
        let mut e = 1.0f32;
        if played < self.fade_in {
            e *= fade_gain(self.fade_curve, played as f32 / self.fade_in as f32);
        }
        let to_end = self.total_len.saturating_sub(played);
        if to_end < self.fade_out && self.fade_out > 0 {
            e *= fade_gain(self.fade_curve, to_end as f32 / self.fade_out as f32);
        }
        e
    }

    fn begin_kill(&mut self, len: u32) {
        if self.state == VoiceState::Free {
            return;
        }
        if self.state != VoiceState::FadingOut || self.kill_remaining > len {
            self.kill_remaining = len;
            self.kill_len = len.max(1);
        }
        self.state = VoiceState::FadingOut;
    }
}

/// Pool voice sesuai pattern arena docs/01 §1c: `Box<[Voice]>` dialokasi sekali,
/// stack index bebas, daftar index aktif untuk iterasi.
///
/// CATATAN KONTRAK: docs/00 menyebut `daw_rt::Pool<T>` (alloc/free/iter_active)
/// tapi tidak mendefinisikan signature-nya. Struktur di bawah adalah pattern
/// yang sama persis dengan yang didokumentasikan di docs/01 §1c; kalau
/// `daw_rt::Pool` sudah mendarat dengan API konkret, isi struct ini tinggal
/// ditukar tanpa mengubah pemanggilnya.
pub struct VoicePool {
    voices: Box<[Voice]>,
    free: Box<[u16]>,
    free_len: usize,
    active: Box<[u16]>,
    active_len: usize,
    next_age: u64,
    micro_fade: u64,
    steal_fade: u32,
}

impl VoicePool {
    pub fn new(capacity: usize, sample_rate: u32) -> Self {
        let mut voices = Vec::with_capacity(capacity);
        let mut free = Vec::with_capacity(capacity);
        for i in 0..capacity {
            voices.push(Voice::idle());
            // Stack bebas: isi terbalik supaya pop() memberi index 0 lebih dulu
            // (deterministik, memudahkan tes null).
            free.push((capacity - 1 - i) as u16);
        }
        let mut active = Vec::with_capacity(capacity);
        active.resize(capacity, 0u16);
        let sr = sample_rate as f32;
        VoicePool {
            voices: voices.into_boxed_slice(),
            free: free.into_boxed_slice(),
            free_len: capacity,
            active: active.into_boxed_slice(),
            active_len: 0,
            next_age: 1,
            micro_fade: (MICRO_FADE_MS * 0.001 * sr) as u64,
            steal_fade: (STEAL_FADE_MS * 0.001 * sr) as u32,
        }
    }

    #[inline]
    pub fn active_count(&self) -> usize {
        self.active_len
    }

    #[inline]
    fn push_active(&mut self, id: u16) {
        if self.active_len < self.active.len() {
            self.active[self.active_len] = id;
            self.active_len += 1;
        }
    }

    /// Mulai satu voice. Kalau pool habis: CURI, jangan alokasi.
    pub fn trigger(&mut self, s: &VoiceStart) {
        let age = self.next_age;
        self.next_age = self.next_age.wrapping_add(1);
        if self.free_len > 0 {
            self.free_len -= 1;
            let id = self.free[self.free_len];
            if let Some(v) = self.voices.get_mut(id as usize) {
                v.start(s, self.micro_fade, age);
            }
            self.push_active(id);
            return;
        }
        // Voice stealing: korban = paling pelan; kalau seri, paling tua.
        let mut victim: Option<u16> = None;
        let mut best = (f32::MAX, u64::MAX);
        for i in 0..self.active_len {
            let id = self.active[i];
            if let Some(v) = self.voices.get(id as usize) {
                // Voice yang sudah dijadwal diganti tidak dicuri dua kali.
                if v.pending.is_some() {
                    continue;
                }
                let key = (v.peak, v.age);
                if key.0 < best.0 || (key.0 == best.0 && key.1 < best.1) {
                    best = key;
                    victim = Some(id);
                }
            }
        }
        if let Some(id) = victim {
            let fade = self.steal_fade;
            if let Some(v) = self.voices.get_mut(id as usize) {
                v.begin_kill(fade);
                v.pending = Some(*s);
                v.age = age;
            }
        }
        // Kalau semua voice sudah punya `pending`, trigger ini memang dibuang —
        // itu keputusan sadar (drop) dan bukan alokasi.
    }

    /// Fade-out cepat SEMUA voice (loop wrap, stop, seek).
    pub fn kill_all(&mut self) {
        let fade = self.steal_fade;
        for i in 0..self.active_len {
            let id = self.active[i];
            if let Some(v) = self.voices.get_mut(id as usize) {
                v.pending = None;
                v.begin_kill(fade);
            }
        }
    }

    /// Matikan seketika (dipakai saat mengganti project) — boleh klik karena
    /// tidak ada audio yang mengalir saat itu.
    pub fn reset(&mut self) {
        let cap = self.voices.len();
        for v in self.voices.iter_mut() {
            *v = Voice::idle();
        }
        for i in 0..cap {
            self.free[i] = (cap - 1 - i) as u16;
        }
        self.free_len = cap;
        self.active_len = 0;
    }

    /// Render semua voice milik `track` ke buffer stereo (SUM, tidak menimpa).
    ///
    /// Ini menjalankan: source PCM → cubic Hermite → clip gain → clip fade ×
    /// micro-fade. Zero alloc, tanpa panic.
    pub fn render_track(&mut self, track: u16, assets: &AssetTable, l: &mut [f32], r: &mut [f32]) {
        let n = l.len().min(r.len());
        if n == 0 {
            return;
        }
        let micro = self.micro_fade;
        let mut i = 0usize;
        while i < self.active_len {
            let id = self.active[i];
            let done = {
                let v = match self.voices.get_mut(id as usize) {
                    Some(v) => v,
                    None => {
                        i += 1;
                        continue;
                    }
                };
                if v.track != track || v.state == VoiceState::Free {
                    i += 1;
                    continue;
                }
                render_voice(v, assets, l, r, n, micro)
            };
            if done {
                // Voice selesai → kembalikan slot ke free stack, tanpa alokasi.
                if self.free_len < self.free.len() {
                    self.free[self.free_len] = id;
                    self.free_len += 1;
                }
                self.active_len -= 1;
                self.active[i] = self.active[self.active_len];
            } else {
                i += 1;
            }
        }
    }
}

/// Mengembalikan `true` kalau voice sudah selesai dan slotnya boleh dibebaskan.
fn render_voice(
    v: &mut Voice,
    assets: &AssetTable,
    out_l: &mut [f32],
    out_r: &mut [f32],
    n: usize,
    micro: u64,
) -> bool {
    let asset = match assets.get(v.asset) {
        Some(a) => a,
        None => return true,
    };
    let mut peak = 0.0f32;
    let mut k = 0usize;
    while k < n {
        if v.state == VoiceState::Free {
            break;
        }
        if v.remaining == 0 && v.state != VoiceState::FadingOut {
            // Tepi akhir clip: fade_out di atas sudah menutupnya sampai nol.
            v.state = VoiceState::Free;
            break;
        }

        // Amplop = clip fade (sudah termasuk micro-fade) × kill fade.
        let mut env = v.clip_env(v.played);
        if v.state == VoiceState::FadingOut {
            let kl = v.kill_len.max(1) as f32;
            env *= v.kill_remaining as f32 / kl;
            if v.kill_remaining == 0 {
                // Fade-out selesai: mulai clip pengganti (voice stealing) atau mati.
                match v.pending.take() {
                    Some(s) => {
                        let age = v.age;
                        v.start(&s, micro, age);
                        continue;
                    }
                    None => {
                        v.state = VoiceState::Free;
                        break;
                    }
                }
            }
            v.kill_remaining -= 1;
        }

        let base = libm_floor(v.pos);
        let idx = base as i64;
        let t = (v.pos - base) as f32;
        let g = v.gain * env;

        let sl = hermite4(
            asset.sample(0, idx - 1),
            asset.sample(0, idx),
            asset.sample(0, idx + 1),
            asset.sample(0, idx + 2),
            t,
        );
        let sr = if asset.channels > 1 {
            hermite4(
                asset.sample(1, idx - 1),
                asset.sample(1, idx),
                asset.sample(1, idx + 1),
                asset.sample(1, idx + 2),
                t,
            )
        } else {
            sl
        };

        let ol = sl * g;
        let orr = sr * g;
        out_l[k] += ol;
        out_r[k] += orr;
        let a = if ol < 0.0 { -ol } else { ol };
        if a > peak {
            peak = a;
        }

        v.pos += v.speed;
        v.played = v.played.saturating_add(1);
        v.remaining = v.remaining.saturating_sub(1);
        k += 1;
    }
    v.peak = peak;
    v.state == VoiceState::Free
}

/// `f64::floor` ada di `std`, bukan `core`. Karena `pos` selalu >= 0 di jalur
/// ini (offset source tidak pernah negatif), truncate = floor.
#[inline(always)]
fn libm_floor(x: f64) -> f64 {
    let t = x as i64 as f64;
    if t > x {
        t - 1.0
    } else {
        t
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pool_with(cap: usize) -> VoicePool {
        VoicePool::new(cap, 48_000)
    }

    #[test]
    fn micro_fade_is_forced_even_when_clip_asks_for_none() {
        let mut p = pool_with(4);
        p.trigger(&VoiceStart {
            track: 0,
            asset: 0,
            source_offset: 0,
            remaining: 4800,
            total_len: 4800,
            played: 0,
            gain_db: 0.0,
            fade_in: 0,
            fade_out: 0,
            fade_curve: 0,
            speed: 1.0,
        });
        let v = &p.voices[p.active[0] as usize];
        assert_eq!(v.fade_in, (MICRO_FADE_MS * 0.001 * 48_000.0) as u64);
        assert_eq!(v.fade_out, v.fade_in);
    }

    /// Equal-power ADA supaya dua fade yang saling silang menjaga daya total
    /// tetap 1. Kalau ini pecah, transisi lagu hasil export akan melubang di
    /// tengah persis seperti fade linear — bug yang cuma terdengar, tidak
    /// terlihat di mana pun.
    #[test]
    fn equal_power_fade_keeps_total_power_constant() {
        for i in 0..=100 {
            let t = i as f32 / 100.0;
            let in_g = fade_gain(FADE_EQUAL_POWER, t);
            let out_g = fade_gain(FADE_EQUAL_POWER, 1.0 - t);
            assert!(
                (in_g * in_g + out_g * out_g - 1.0).abs() < 1e-4,
                "t={t} in={in_g} out={out_g}"
            );
        }
        // Linear justru TIDAK konstan — itulah alasan kedua kurva ada.
        let mid = fade_gain(FADE_LINEAR, 0.5);
        assert!((2.0 * mid * mid - 0.5).abs() < 1e-6);
    }

    /// Ujung fade harus TEPAT 0 dan 1 untuk kedua kurva: nilai "hampir nol" di
    /// akhir fade-out terdengar sebagai ekor yang tidak pernah diam.
    #[test]
    fn fade_endpoints_are_exact() {
        for curve in [FADE_LINEAR, FADE_EQUAL_POWER] {
            assert_eq!(fade_gain(curve, 0.0), 0.0);
            assert_eq!(fade_gain(curve, 1.0), 1.0);
            assert_eq!(fade_gain(curve, -0.5), 0.0);
            assert_eq!(fade_gain(curve, 2.0), 1.0);
        }
    }

    /// Amplop equal-power harus di ATAS linear di tengah fade — kalau kurva
    /// tidak benar-benar terpasang di voice, keduanya akan sama persis.
    #[test]
    fn voice_applies_the_curve_it_was_given() {
        let mut lin = Voice::idle();
        let mut eqp = Voice::idle();
        let start = VoiceStart {
            track: 0,
            asset: 0,
            source_offset: 0,
            remaining: 48_000,
            total_len: 48_000,
            played: 0,
            gain_db: 0.0,
            fade_in: 24_000,
            fade_out: 0,
            fade_curve: FADE_LINEAR,
            speed: 1.0,
        };
        lin.start(&start, 0, 0);
        eqp.start(
            &VoiceStart {
                fade_curve: FADE_EQUAL_POWER,
                ..start
            },
            0,
            0,
        );
        let (a, b) = (lin.clip_env(12_000), eqp.clip_env(12_000));
        assert!((a - 0.5).abs() < 1e-6, "linear di tengah fade = 0.5, dapat {a}");
        assert!((b - core::f32::consts::FRAC_1_SQRT_2).abs() < 1e-4, "equal-power = 1/√2, dapat {b}");
    }

    #[test]
    fn stealing_never_grows_the_pool() {
        let mut p = pool_with(2);
        let s = VoiceStart {
            track: 0,
            asset: 0,
            source_offset: 0,
            remaining: 4800,
            total_len: 4800,
            played: 0,
            gain_db: 0.0,
            fade_in: 0,
            fade_out: 0,
            fade_curve: 0,
            speed: 1.0,
        };
        for _ in 0..10 {
            p.trigger(&s);
        }
        assert_eq!(p.voices.len(), 2);
        assert!(p.active_count() <= 2);
    }
}
