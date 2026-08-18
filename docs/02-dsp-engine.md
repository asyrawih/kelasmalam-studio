# Bagian 2 — DSP Engine Internals

## 2a. Graph processing

### Topo-sort di-precompute, bukan per-callback

Graph DAW punya sifat penting: **topologi jarang berubah** (user menambah track/
send sesekali) tapi diproses 375×/detik. Jadi:

```
Perubahan graph (UI)
  → command AddTrack/AddSend/Reorder masuk ring
  → audio thread TIDAK menghitung ulang topo-sort (itu alokasi + O(V+E) tak terbatas)
  → main thread (Rust, instance non-RT) menghitung ProcessPlan baru
  → plan ditulis ke buffer B (double-buffer), lalu param_gen di-increment
  → audio thread swap pointer plan di awal blok berikutnya (satu atomic load)
  → plan lama di-*retire*: TIDAK di-drop di audio thread; audio thread menaruh
    handle-nya di ring "garbage" → main thread yang men-drop-nya
```

`ProcessPlan` adalah `Box<[Step]>` datar:

```rust
pub enum Step {
    ClearBuf { buf: u16 },
    RenderClips { track: u16, dst: u16 },          // voice → dst
    Fx { node: u16, buf: u16 },                    // in-place
    Fader { track: u16, buf: u16 },
    PanAdd { src: u16, dst: u16, pan: u16 },       // sum ke bus
    SendAdd { src: u16, dst: u16, amount: u16 },
    Meter { slot: u16, buf: u16 },
}
```

Datar + `enum` = tidak ada pointer chasing, tidak ada `dyn`, prefetch-friendly.

### Buffer strategy — berapa scratch minimum

Ini masalah **register allocation**: sama persis dengan alokasi register di
compiler, dan solusinya juga sama — *linear scan* pada interval hidup.

Analisis untuk graph target (32 track × [EQ→comp] → fader/pan → master, +2 send
bus reverb/delay):

- Track diproses **satu per satu** dan langsung di-*sum* ke master. Jadi hanya
  butuh **1 buffer track** yang dipakai ulang, bukan 32.
- Send bersifat post-fader: setelah fader, sinyal track ditambahkan ke akumulator
  send **sebelum** buffer track dipakai ulang. Butuh **2 buffer akumulator send**
  (reverb, delay), hidup sepanjang seluruh pass.
- Master akumulator: **1 buffer**, hidup sepanjang pass.
- Return dari send bus diproses setelah semua track selesai, lalu ditambahkan ke
  master. Reverb butuh **1 buffer kerja** (bisa pakai ulang buffer track).

Total: **track(1) + send_acc(2) + master(1) = 4 buffer stereo × 128 frame**
= 4 × 2 × 128 × 4 B = **4 KiB**. Muat di L1.

Aturan umum: `jumlah_buffer = 1 + max_concurrent_live_edges`, dihitung sekali
saat plan dibuat. Untuk graph dengan percabangan (satu track ke banyak tujuan),
linear-scan menaikkan angkanya sedikit; kita alokasi 16 buffer sebagai cadangan
dan gagal-kan penambahan node yang melebihi (dengan pesan UI), bukan alokasi
di RT.

Kenapa **planar** (`[f32; 128]` per channel, bukan interleaved): SIMD `f32x4`
memproses 4 sample channel yang sama sekaligus. Kalau interleaved, tiap `v128`
berisi L,R,L,R dan operasi per-channel (mis. pan) butuh shuffle. Interleaving
hanya dilakukan di boundary: output ke `AudioWorklet` (yang justru planar juga —
`outputs[0][0]`, `outputs[0][1]` — jadi malah gratis) dan saat menulis WAV.

### Parameter smoothing

Zipper noise muncul karena gain berubah step-wise di batas blok: diskontinuitas
= klik. Solusinya ramp.

**Per-blok vs per-sample:**
- Per-blok (ubah gain sekali per 128 frame) = tetap ada step, hanya 375 Hz
  bukannya sekali — masih terdengar untuk perubahan besar. Cukup untuk parameter
  yang tidak pernah bergerak cepat (mis. koefisien EQ, karena kita re-hitung
  koefisien per blok dan meng-interpolasi output-nya sudah cukup halus).
- **Per-sample untuk gain & pan.** Ini yang dipakai. Biayanya 1 add + 1 mul per
  sample — nol dibanding biaya lain.

Target ramp 10–20 ms. Di 48 kHz, 15 ms = 720 sample = ~5.6 blok.

**Implementasi branchless** (`crates/dsp/src/smooth.rs`): one-pole eksponensial,
bukan linear-ramp-dengan-counter. Alasannya justru *branchless*-nya:

```rust
#[derive(Clone, Copy)]
pub struct Smoother { cur: f32, target: f32, coeff: f32 }

impl Smoother {
    /// coeff = exp(-1 / (tau_seconds * sample_rate)); tau = 15ms/3 (99% dlm 15ms)
    #[inline(always)]
    pub fn next(&mut self) -> f32 {
        self.cur += (self.target - self.cur) * self.coeff;   // tanpa if
        self.cur
    }
}
```

Linear ramp butuh `if remaining > 0 { .. } else { cur = target }` — branch di
inner loop, mispredict di akhir ramp. One-pole tidak pernah *persis* sampai
target, tapi selisihnya turun di bawah -120 dB dengan cepat; ditambah **denormal
guard** (lihat 2b) supaya `cur - target` tidak jadi denormal.

Kalau butuh linear presisi (mis. otomasi yang harus mencapai nilai tepat di
sample tertentu), pakai **sub-blok split** dari 2c: pecah blok di sample event,
set nilai persis di batas — bukan branch di inner loop.

## 2b. DSP blocks

### Biquad TDF-II — kenapa bukan DF-I

Kode: [`crates/dsp/src/biquad.rs`](../crates/dsp/src/biquad.rs)

- **DF-I** menyimpan 4 state: `x[n-1], x[n-2], y[n-1], y[n-2]`. Penjumlahan
  dilakukan pada nilai yang sudah dikalikan koefisien besar — di f32, urutan
  penjumlahan-nya membuat error pembulatan terakumulasi di jalur feedback,
  terutama untuk **filter Q tinggi di frekuensi rendah** (mis. low shelf 40 Hz
  di 48 kHz: pole sangat dekat unit circle, koefisien mendekati ±2 dan ±1).
- **TDF-II (transposed direct form II)** menyimpan 2 state (`s1, s2`) yang
  merupakan *akumulator* — nilainya berskala kecil, dan tiap sample hanya satu
  penjumlahan yang menyentuh output. Ini memberikan **noise floor lebih rendah
  di f32** dan lebih tahan untuk koefisien ekstrem. Sensitivitas koefisiennya
  juga lebih baik daripada DF-II (non-transposed), yang punya masalah overflow
  internal di jalur `w[n]`.
- Bonus: TDF-II butuh 2 register state per channel, bukan 4 → lebih ramah cache
  saat 32 track × 4 band × 2 channel = 256 instance.

Konsekuensi: TDF-II **tidak suka koefisien yang berubah tiap sample** (state-nya
punya arti fisik yang bergantung koefisien). Karena itu kita ubah koefisien
**per blok**, bukan per sample, dan untuk sweep filter cepat (otomasi cutoff)
kita pecah blok di batas event (2c) atau crossfade dua instance.

Koefisien dari **RBJ Audio EQ Cookbook** (peaking, low/high shelf, LPF/HPF),
dinormalisasi dengan `a0` saat dihitung sehingga inner loop tidak membagi.

### Feed-forward compressor

Kode: [`crates/dsp/src/comp.rs`](../crates/dsp/src/comp.rs)

Rantainya, dalam urutan:

```
sidechain in ─► detektor (peak | RMS) ─► ke dB ─► gain computer (soft knee)
                                                       │
                                                   overshoot dB
                                                       ▼
                                            envelope follower (att/rel one-pole)
                                                       ▼
                                        gain_lin = 10^((-gr + makeup)/20)
                                                       ▼
                                              input × gain_lin ─► out
```

Keputusan penting:

1. **Feed-forward, bukan feedback.** Feed-forward (deteksi dari input) berperilaku
   terprediksi dan ratio-nya eksak. Feedback (deteksi dari output) terdengar
   lebih "vintage" tapi ratio efektifnya bergantung level dan sulit dibuat
   sample-accurate. Untuk DAW default, feed-forward.
2. **Gain computer di domain log (dB), bukan linear.** Ratio dan knee didefinisikan
   dalam dB; melakukannya di linear butuh `powf` per sample. Di log cukup
   penjumlahan/perkalian. `log10` per sample tetap mahal → pakai aproksimasi
   `log2` berbasis manipulasi bit eksponen f32 (akurasi ±0.01 dB, cukup untuk
   detektor) — lihat `fast_log2` di `dsp/src/fastmath.rs`.
3. **Soft knee** dengan lebar `W` dB di sekitar threshold `T`:
   ```
   x = level_db
   if 2(x-T) < -W        → out = x                          (di bawah knee)
   if |2(x-T)| <= W      → out = x + (1/ratio - 1)(x-T+W/2)²/(2W)   (kuadratik)
   else                  → out = T + (x-T)/ratio            (di atas knee)
   ```
   Kurva ini C¹-kontinu di kedua batas — inilah alasan pakai bentuk kuadratik itu.
4. **Envelope follower one-pole asimetris:**
   ```rust
   let c = if overshoot > env { att_coeff } else { rel_coeff };
   env += (overshoot - env) * c;   // coeff = 1 - exp(-1/(t_sec * sr))
   ```
   Satu branch per sample; predictable karena polanya panjang (attack atau
   release bertahan ratusan sample). Bisa dibuat branchless dengan `select`
   tapi keuntungannya marginal.
5. **Peak vs RMS sidechain:**
   - *Peak* (`|x|`): merespons transien, dipakai untuk limiting/drum. Deteksi
     instan, tapi tidak berkorelasi dengan loudness.
   - *RMS* (rata-rata kuadrat berjendela one-pole ~10 ms lalu `sqrt`): berkorelasi
     dengan persepsi loudness, dipakai untuk bus/vokal. Melewatkan transien
     pendek (yang justru sering diinginkan).
   Implementasinya satu enum + branch di luar inner loop (dua fungsi ter-monomorfisasi
   lewat generic `<D: Detector>`) supaya inner loop tetap bersih.
6. **Make-up gain**: manual (dB) + opsi auto = `-(gain_computer(0 dB) )` yaitu
   kompensasi berdasarkan threshold/ratio. Auto-makeup ikut di-smooth.
7. **Gain reduction dilaporkan ke UI** lewat blok METER (`gain_reduction_db`),
   nilai maksimum dalam blok, dengan ballistics release ~300 ms di sisi UI.

### Denormal di WASM

Fakta yang perlu dipahami:

- WASM **tidak punya** FTZ (flush-to-zero) / DAZ (denormals-are-zero). Spesifikasi
  WASM mewajibkan aritmetika IEEE-754 yang deterministik, dan denormal adalah
  bagian dari itu. V8/SpiderMonkey **tidak** mengekspos MXCSR ke kode WASM, dan
  memang tidak boleh — determinisme adalah janji WASM.
- Namun: pada CPU x86-64 modern (Sandy Bridge ke atas), penalti denormal untuk
  ADD/MUL sudah jauh lebih kecil dari era Pentium 4 — tetapi **masih ada**,
  terutama di jalur yang menghasilkan denormal berulang (IIR yang meluruh,
  delay line yang senyap, reverb tail). Penalti ~10–100× pada operasi terdampak
  masih terdokumentasi di beberapa mikroarsitektur, dan di ARM (Apple Silicon)
  perilakunya berbeda lagi.
- Karena itu: **jangan mengandalkan hardware, tangani manual.** Ini murah.

Tiga pattern yang dipakai:

1. **DC offset injection** pada input filter/delay yang berpotensi senyap:
   tambahkan sinyal DC sangat kecil yang berganti tanda tiap sample
   (`±1e-20`, bukan DC murni supaya tidak menghasilkan offset yang terdengar):
   ```rust
   const ANTI_DENORM: f32 = 1.0e-20;
   self.sign = -self.sign;
   let x = x + ANTI_DENORM * self.sign;
   ```
2. **Flush manual** pada state IIR, sekali per blok (bukan per sample):
   ```rust
   #[inline(always)]
   fn flush(x: f32) -> f32 { if x.abs() < 1.0e-18 { 0.0 } else { x } }
   ```
   Sekali per blok cukup: state butuh ratusan sample untuk meluruh ke denormal.
3. **Smoother**: `cur += (target-cur)*c` menghasilkan denormal saat mendekati
   target. Di-flush per blok dengan cara yang sama.

Ukur dulu sebelum menyebar `flush` ke mana-mana: ada benchmark
`cargo bench --bench denorm` yang membandingkan reverb tail dengan/tanpa guard.

### SIMD — `core::arch::wasm32` v128

Kode: [`crates/dsp/src/mix.rs`](../crates/dsp/src/mix.rs)

Yang layak di-vektorisasi:
- **Buffer summing** (`dst += src * gain`) — memory bound, tapi 4× lebih sedikit
  instruksi loop.
- **Gain/pan ramp** — smoother bisa di-unroll: hitung 4 nilai smoother sekaligus
  dengan koefisien pangkat (`c, c², c³, c⁴`).
- **Peak/RMS detection** — `f32x4_max`, lalu horizontal reduce sekali di akhir.
- **Waveform peak generation** (min/max per bucket) di worker.

Yang **tidak** layak: biquad. IIR punya dependensi serial (`s1` sample n butuh
sample n-1). Vektorisasinya butuh block-processing transform yang rumit dan
merusak sifat numerik TDF-II. Yang dilakukan sebagai gantinya: proses **4 channel
sekaligus** kalau kebetulan ada 4 biquad identik (mis. stereo × 2 track), atau
biarkan skalar — biquad 4-band × 32 track × 2 ch masih hanya ~10% budget.

**Feature detection + fallback:** WASM tidak punya runtime feature detection di
dalam modul — modul dengan instruksi SIMD **gagal di-*validate*** kalau engine
tidak dukung. Jadi deteksi harus di JS **sebelum** memilih file:

```ts
// wasm-feature-detect
const simd = await simdSupported();
const url = simd ? '/engine-simd.wasm' : '/engine.wasm';
```

Dua artefak build (`--cfg simd` / tanpa). Praktisnya, per 2026 SIMD128 didukung
semua browser evergreen; build scalar dipertahankan hanya sebagai jaring pengaman
dan boleh dibuang setelah telemetri membuktikan tidak ada yang memakainya.
Alternatif Rust-native: `#[cfg(target_feature = "simd128")]` di sekitar
implementasi, dengan fallback skalar di `#[cfg(not(...))]` — satu source, dua build.

## 2c. Sample-accurate sequencing

### Transport clock = `u64` sample counter

`AudioContext.currentTime` **tidak boleh** jadi sumber kebenaran:

1. Ia `f64` **detik**. Di 48 kHz, setelah 8 jam (2.88e4 s), presisi f64 masih
   sangat baik — masalahnya bukan presisi absolut, tapi **konversi**: setiap
   `round(currentTime * sampleRate)` bisa meleset ±1 sample tergantung
   pembulatan, dan kesalahannya tidak monoton.
2. Ia di-*quantize* oleh implementasi (Chrome memajukannya per render quantum,
   dan menambahkan `outputLatency`), jadi ia menyatakan waktu *output*, bukan
   posisi *render*.
3. Ia bisa "melompat" saat AudioContext di-suspend/resume.

Yang dipakai: `currentFrame` (tersedia di worklet, `u64`-ish, bertambah tepat 128
per callback) untuk **deteksi gap**, dan counter internal engine sebagai
**posisi transport**:

```rust
pub struct Transport {
    pub playhead: u64,     // sample sejak awal timeline
    pub playing: bool,
    pub loop_range: Option<(u64, u64)>,
    pub sample_rate: u32,
}
```

Semua penjadwalan, panjang clip, posisi clip, otomasi — semuanya `u64` sample.
Konversi ke detik/bar/beat hanya terjadi di UI.

### Event queue + sub-block split

Event (note-on, param change ber-timestamp, loop jump, clip start) disimpan di
priority queue tersortir `at_sample`. `render_block` memecah blok:

```rust
pub fn render_block(&mut self, out: &mut StereoBlock, frames: usize) {
    let mut offset = 0usize;
    while offset < frames {
        // 1. terapkan semua event yang jatuh tepat di playhead+offset
        while let Some(ev) = self.queue.peek_at(self.transport.playhead + offset as u64) {
            self.apply_event(ev);           // O(1), tanpa alokasi
            self.queue.pop();
        }
        // 2. sub-blok berhenti di event berikutnya (atau akhir blok)
        let next = self.queue.next_time()
            .map(|t| (t - self.transport.playhead) as usize)
            .unwrap_or(frames)
            .min(frames);
        let n = (next - offset).max(1);
        self.render_span(out, offset, n);   // jalur DSP sesungguhnya
        offset += n;
    }
    self.transport.playhead += frames as u64;
}
```

Catatan implementasi:
- **`.max(1)`** mencegah infinite loop kalau ada dua event di sample yang sama
  yang tidak ter-drain (sebenarnya loop `while` di langkah 1 sudah mencegahnya,
  tapi ini jaring pengaman tanpa biaya).
- Sub-blok bisa sangat pendek (1 sample). Overhead per sub-blok harus kecil →
  itulah alasan `ProcessPlan` datar dan koefisien di-cache.
- Untuk otomasi kontinu (kurva), **jangan** buat event per sample. Otomasi
  di-render sebagai *ramp segment*: satu event "ramp ke X selama N sample", lalu
  smoother yang menanganinya. Sub-block split hanya untuk **diskontinuitas**.
- Loop jump: saat playhead mencapai `loop_end`, sub-blok dipotong di situ,
  playhead di-set ke `loop_start`, voice di-*retrigger* dengan micro-fade 2 ms
  (lihat Bagian 6d) supaya tidak klik.

### Tempo map — hindari akumulasi error float

Konversi PPQ ↔ sample dengan tempo yang berubah adalah sumber drift klasik kalau
dilakukan inkremental (`pos += samples_per_tick` per tick).

Solusinya: **tempo map sebagai daftar segmen dengan titik jangkar yang di-precompute
secara eksak**, dan konversi selalu *absolut* dari jangkar terdekat — tidak pernah
inkremental.

```rust
pub struct TempoSegment {
    pub tick:          u64,   // posisi mulai segmen dalam PPQ tick
    pub sample:        u64,   // posisi mulai segmen dalam sample (JANGKAR, eksak)
    pub micros_per_qn: u32,   // seperti MIDI tempo meta-event (integer!)
}
```

- Tempo disimpan sebagai **`micros_per_quarter_note` (integer)**, sama seperti
  MIDI — bukan BPM float. BPM 128 → 468750 µs. Semua tempo "bulat" di UI jadi
  integer eksak.
- Konversi di dalam segmen (tempo konstan):
  ```
  samples = sample_anchor + (tick - tick_anchor) * micros_per_qn * sample_rate
                            ─────────────────────────────────────────────────
                                        PPQ * 1_000_000
  ```
  Dihitung dengan **`u128`** untuk pembilang, lalu satu pembagian integer.
  Tidak ada float sama sekali → deterministik dan reversibel.
- Jangkar `sample` tiap segmen dihitung sekali (saat tempo map berubah) dengan
  rumus yang sama secara berantai. Error tidak terakumulasi lintas segmen karena
  tiap jangkar adalah integer eksak; yang tersisa hanya pembulatan ≤1 sample per
  batas segmen — dan itu *stabil* (tidak bertambah tiap kali dibaca).
- PPQ = 960 (bukan 480) supaya triplet & 128th note representable eksak.

Fungsi publik ada di `timeline-core`:
```rust
pub fn tick_to_sample(map: &TempoMap, tick: u64, sr: u32) -> u64;
pub fn sample_to_tick(map: &TempoMap, sample: u64, sr: u32) -> u64;
```
Keduanya di-property-test dengan `proptest`: `sample_to_tick(tick_to_sample(t))`
harus kembali ke `t` (dengan toleransi 0 tick untuk tick di batas grid).

---

## 2d. Insert FX

Enam efek gaya rekordbox — FILTER, ECHO, SPIRAL, FLANGER, REVERB, PITCH —
plus EQ 4-band dan kompresor bawaan. Bisa dipasang di **track**, **master**,
dan **clip**.

### Kerangkanya, bukan efeknya

Yang menentukan biaya jangka panjang bukan enam efek pertamanya, melainkan
berapa mahal efek ke-dua puluh. Karena itu efek ditulis sebagai `trait Effect`
(`crates/engine/src/fx/mod.rs`) dan didaftarkan lewat satu macro:

```rust
fx_registry! {
    2 => Filter : super::filter::FilterFx;
    3 => Echo   : super::echo::EchoFx;
    6 => Reverb : super::reverb::ReverbFx, boxed;
}
```

Macro itu menghasilkan `FxKind`, `FxNode`, seluruh dispatch-nya, dan `CATALOG`.
Menambah efek = **satu berkas + satu baris**. Tidak ada `match` yang perlu
disunting, tidak ada schema yang berubah, dan tidak ada kode UI baru — panel FX
merakit knob dari deskriptor yang diekspor `fxCatalogJson()`.

Diskriminan `FxKind` **ikut tersimpan di snapshot**; menggesernya membuat
project lama dibaca sebagai efek yang berbeda. Angkanya karena itu ditulis
eksplisit dan dikunci `const _: () = assert!(..)`.

### `prepare` vs `process`

`Eq4` sudah lama mendokumentasikan invariannya sendiri: "koefisien di-hitung
ULANG PER BLOK, tidak per sample". Pemisahan ini menjadikannya kontrak:

- `prepare` — sekali per blok penuh. Boleh transendental.
- `process` — sekali per sub-blok. **Wajib resumable**: memecah satu blok 1024
  frame jadi 8×128 harus menghasilkan bit yang sama.

Yang mendesain ulang koefisien melakukannya pada **grid sample absolut**
(`GRID = 32`), bukan di batas blok pemanggil. Kalau di batas blok, refresh
jatuh delapan kali lebih sering pada render 128-frame dibanding 1024-frame dan
hasilnya berhenti bit-identical. 32 sample juga menaikkan laju refresh ke
1500 Hz, yang memang dibutuhkan filter yang disapu cepat.

### Memori

Efek berbasis delay mengambil memorinya dari **arena** yang dialokasi sekali
(`fx/arena.rs`), bukan dari `Box` per node. Nge-`Box` per efek berarti memanggil
alokator — dan mungkin `memory.grow` — di AudioWorklet thread, dan `memory.grow`
di sana menginvalidasi setiap `Float32Array` yang dipegang main thread
(docs/05). Kehabisan anggaran jadi `PlanError::OutOfFxMemory`, ditolak sebelum
plan dipasang dan dilaporkan ke UI.

`daw_dsp::Delay` karena itu **meminjam** memorinya. Panjangnya pangkat dua, dan
alasan utamanya bukan kecepatan: indeks ter-mask selalu di dalam rentang, jadi
read pointer SPIRAL yang meluncur melewati batas menghasilkan wrap — bukan
jalur panic. `render_block` tidak boleh panic.

### Anggaran CPU (terukur, bukan aritmetika)

Diukur dengan criterion, relatif terhadap `biquad/eq4_stereo_128` = 1.96 µs,
satuan yang menghubungkan bench ke anggaran §2a:

| primitif | terukur | rasio EQ4 |
|---|---|---|
| `delay_read_frac_mono_128` | 274 ns | 0.14× |
| `echo_core_stereo_128` | 1.14 µs | 0.58× |
| `flanger_core_stereo_128` | 630 ns | 0.32× |
| `fdn8_stereo_128` | 3.47 µs | 1.77× |

REVERB ~1.6 poin persen per instance: pada 32 track itu ~51 poin persen, jauh
di atas headroom yang tersisa. **REVERB dan ECHO praktis milik send bus.**
`build_plan` menghitung estimasi statis dan mengeluarkan PERINGATAN di atas
ambang — itu beda antara "app-nya patah-patah di sebagian mesin" dan "app-nya
sudah mengatakannya".

### Ukuran artefak

156.7 KB gz sebelum FX → 189.3 KB gz sesudahnya, dengan gate 307.200. Enam
efek menambah ~1.8 KB gz masing-masing; efek ke-20 diperkirakan mendarat ~90 KB
di bawah gate.

### Bypass

Bypass **bukan** crossfade wet/dry: itu memotong ekor reverb tepat saat tombol
ditekan. Yang diredam adalah **input** node (10 ms) sambil jalur kering
dilewatkan kembali, sehingga ekornya meluruh alami dan totalnya tidak pernah
diskontinu. Konsekuensinya `Step::Fx` **selalu** diemit, termasuk untuk efek
yang di-bypass; slot yang ekornya habis lalu ditidurkan dan biayanya jadi satu
cabang.
