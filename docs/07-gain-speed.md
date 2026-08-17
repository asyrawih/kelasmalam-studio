# Bagian 7 & 8 — Gain Staging, Mixing, Metering, dan Playback Speed

Kode terkait: [`crates/dsp/src/mix.rs`](../crates/dsp/src/mix.rs) ·
[`crates/dsp/src/resample.rs`](../crates/dsp/src/resample.rs) ·
[`crates/timeline-core/src/coords.rs`](../crates/timeline-core/src/coords.rs)

---

## 7a. Signal flow — urutan yang pasti

Ini deliverable **(j)**. Urutan di bawah adalah kontrak: `render_block` mengikuti
persis ini, dan `ProcessPlan` (docs/02 §2a) adalah linearisasi datar darinya.

```
                                   PER VOICE (satu clip aktif)
  ┌───────────────────────────────────────────────────────────────────────────┐
  │  asset PCM (f32 planar, read-only di shared linear memory)                │
  │        │                                                                   │
  │        ▼                                                                   │
  │  ① FRACTIONAL READ CURSOR + interpolasi cubic Hermite      ◄── speed_ratio │
  │     pos += effective_ratio  (f64)                              × master    │
  │        │                                                                   │
  │        ▼                                                                   │
  │  ② CLIP GAIN            (smoothed, per-sample; dari gain_db)               │
  │        │                                                                   │
  │        ▼                                                                   │
  │  ③ CLIP FADE IN/OUT     (linear atau equal-power, timeline-space)          │
  │        │                                                                   │
  │        ▼                                                                   │
  │  ④ MICRO-FADE 3 ms      (SELALU, di setiap tepi; docs/06 §6d)              │
  │        │                                                                   │
  │        ▼                                                                   │
  │  ⑤ [per-clip FX]        ← TIDAK ADA di MVP (docs/06 §6e). Slot dicadangkan.│
  └────────┬──────────────────────────────────────────────────────────────────┘
           │  voice di-SUM ke buffer track (add, bukan copy — clip bisa overlap
           ▼  saat crossfade)
  ┌───────────────────────────────────────────────────────────────────────────┐
  │                          PER TRACK (×32)                                   │
  │  ⑥ TRACK INSERT CHAIN   EQ → compressor → …   (in-place, TDF-II biquad)    │
  │        │                                                                   │
  │        ▼                                                                   │
  │  ⑦ TRACK FADER          (smoothed, per-sample; dari fader_db)              │
  │        │                                                                   │
  │        ├──────────────► ⑧ SEND (post-fader, default)  ──► akumulator send  │
  │        │                                                                   │
  │        ▼                                                                   │
  │  ⑨ PAN                  -3 dB equal-power (sin/cos)                        │
  │        │                                                                   │
  │        ▼                                                                   │
  │  ⑩ METER TRACK          peak + RMS → SAB meter block (baca-saja bagi UI)   │
  │        │                                                                   │
  └────────┼──────────────────────────────────────────────────────────────────┘
           │  add ke akumulator bus tujuan
           ▼
  ┌───────────────────────────────────────────────────────────────────────────┐
  │  SEND BUS (reverb, delay) — diproses SETELAH semua track                   │
  │  ⑪ bus insert chain → ⑫ bus fader → ⑬ pan  ──add──► master akumulator      │
  └────────┬──────────────────────────────────────────────────────────────────┘
           ▼
  ┌───────────────────────────────────────────────────────────────────────────┐
  │                              MASTER                                        │
  │  ⑭ MASTER INSERT CHAIN                                                     │
  │        ▼                                                                   │
  │  ⑮ MASTER FADER  (smoothed)                                                │
  │        ▼                                                                   │
  │  ⑯ SOFT-CLIP / LIMITER (opsional, default ON — lihat §7d)                  │
  │        ▼                                                                   │
  │  ⑰ METER MASTER (peak + RMS + clip hold) → SAB                             │
  │        ▼                                                                   │
  │  ⑱ OUTPUT                                                                  │
  │     ├─ realtime : outputs[0][0..1] AudioWorklet (planar, sudah cocok)      │
  │     └─ offline  : OfflineRenderer → WAV/MP3/OGG (docs/03)                  │
  └───────────────────────────────────────────────────────────────────────────┘
```

Empat hal di diagram ini yang urutannya bukan selera:

1. **Clip gain sebelum fade (② sebelum ③).** Kalau dibalik, mengubah clip gain
   akan mengubah *bentuk* fade yang sudah user dengar. Gain adalah properti
   sumber; fade adalah amplop di atasnya.
2. **Micro-fade paling akhir di rantai voice (④).** Ia harus mengalahkan semua
   yang lain — kalau clip gain di-otomasi melompat tepat di tepi clip,
   micro-fade tetap yang menentukan bahwa tepi itu mulai dari nol.
3. **Send post-fader (⑧ setelah ⑦).** Ini default yang benar: menurunkan fader
   track harus juga menurunkan jumlah reverb-nya, kalau tidak, menurunkan fader
   sampai −∞ menyisakan reverb hantu. Pre-fader tetap tersedia per-send
   (`Send::pre_fader`) untuk cue/headphone mix.
4. **Pan setelah fader (⑨ setelah ⑦), meter setelah pan (⑩).** Meter track
   menunjukkan apa yang benar-benar dikirim ke bus — itu yang berguna saat
   gain staging.

---

## 7b. dB ↔ linear dan taper fader

### Kenapa fader UI tidak linear terhadap dB

Fader yang linear-dB dari −∞ sampai +6 dB menghabiskan setengah travel-nya untuk
rentang −∞…−30 dB, di mana hampir tidak ada yang terjadi secara musikal, dan
menyisakan beberapa milimeter untuk −6…+6 dB, di mana **semua** kerja mixing
terjadi. Fader hardware menyelesaikan ini dengan taper mekanis; kita menirunya.

**Hukum taper yang dipakai** — piecewise linear di domain dB, dengan unity
(0 dB) di **75% travel**:

| Travel `t` (0..1) | dB |
|---|---|
| 0.00 | −∞ (mute) |
| 0.00 – 0.25 | −∞ → −40 (kurva, tidak linear) |
| 0.25 – 0.50 | −40 → −20 |
| 0.50 – 0.75 | −20 → **0** |
| 0.75 – 1.00 | 0 → +6 |

```rust
/// travel (0..1) → dB. Unity tepat di t = 0.75.
pub fn fader_taper(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    if t <= 0.0        { f32::NEG_INFINITY }
    else if t < 0.25   { -40.0 - (0.25 - t) * 4.0 * 56.0 }  // -40 .. -96, lalu di-mute
    else if t < 0.50   { -40.0 + (t - 0.25) * 4.0 * 20.0 }  // -40 .. -20
    else if t < 0.75   { -20.0 + (t - 0.50) * 4.0 * 20.0 }  // -20 ..   0
    else               {         (t - 0.75) * 4.0 *  6.0 }  //   0 ..  +6
}
```

Hasilnya: **25% travel teratas mencakup 6 dB** (resolusi ~0,06 dB per pixel pada
fader 100 px) dan 25% terbawah mencakup 56 dB. Persis pembagian yang kita mau.
Unity di 75% dan bukan di 100% penting karena mixing yang benar sering butuh
*menaikkan* satu track, dan fader yang maksimum di unity memaksa user
menurunkan semua track lain.

Fader adalah **murni transformasi UI**. Yang disimpan di model dan dikirim ke
engine selalu dB (`fader_db`); `fader_taper` hidup di TypeScript. Engine tidak
pernah tahu tentang travel.

### dB → linear di engine

`gain = 10^(db/20)`, lewat `daw_dsp::fastmath::db_to_lin` (`fast_exp2` berbasis
manipulasi eksponen f32; error < 0,01 dB, tanpa `powf`). Nilai hasilnya menjadi
`target` sebuah `Smoother` (docs/02 §2a) — **tidak pernah** dipakai langsung,
karena perubahan gain step-wise di batas blok adalah zipper noise.

`gain_db <= -96` dipetakan ke linear **0 tepat**, bukan `1.6e-5`. Ini bukan
kosmetik: nilai denormal di jalur feedback (delay, reverb) memicu penalti
denormal di beberapa CPU, dan −96 dB sudah di bawah noise floor 16-bit.

---

## 7c. Pan law −3 dB equal-power

```rust
// pan: -1 (kiri) .. 0 (tengah) .. +1 (kanan)
let theta = (pan + 1.0) * (core::f32::consts::FRAC_PI_4);  // 0 .. π/2
let gain_l = theta.cos();
let gain_r = theta.sin();
```

Di tengah: `cos(π/4) = sin(π/4) = 0,7071` = **−3,01 dB di kedua channel**.

Kenapa −3 dB dan bukan 0 dB (linear/"−6 dB law"):

| Pan law | Gain di tengah | Konstan yang dijaga | Cocok untuk |
|---|---|---|---|
| Linear (−6 dB) | 0,5 / 0,5 | **Amplitudo** | Monitoring mono murni |
| **Equal-power (−3 dB)** | 0,707 / 0,707 | **Daya** (`L²+R²`) | **Speaker stereo — dipilih** |
| −4,5 dB | 0,595 | kompromi | Konsol yang menargetkan keduanya |

Dua sinyal identik dari dua speaker yang terpisah di ruangan **tidak** menjumlah
secara koheren di telinga; mereka menjumlah dalam daya. Equal-power karena itu
membuat sumber terdengar sama kerasnya di posisi pan mana pun — yang merupakan
seluruh gunanya kontrol pan.

**Mono compatibility.** Yang harus dinyatakan jujur: pada penjumlahan mono
(`(L+R)/2`), sinyal yang di-pan tengah dengan equal-power menjadi **+3 dB lebih
keras** relatif terhadap sinyal yang di-pan keras kiri/kanan. Itu inheren pada
−3 dB law dan tidak bisa "diperbaiki" tanpa memilih pan law lain. Yang kita
lakukan:

- Tombol **Mono** di master (sum ke mono, kirim ke kedua channel) supaya user
  bisa memeriksanya sendiri — itu satu-satunya jawaban yang benar.
- Meter korelasi fase di master (`(L·R) / (|L|·|R|)`, satu nilai per blok di SAB).
  Korelasi negatif = ada yang akan hilang di mono, dan itu masalah yang jauh
  lebih sering daripada +3 dB.

Pan di-*smoothed* per-sample seperti gain, dengan `Smoother` yang sama, karena
pan adalah dua gain.

---

## 7d. Clip gain vs track fader, headroom, dan master clip policy

### Di mana masing-masing diterapkan

| | Diterapkan di | Alasan |
|---|---|---|
| **Clip gain** | ② — di dalam render voice, sebelum sum ke track | Ia properti *sumber*. Harus di-apply sebelum sinyal bertemu clip lain di track yang sama, kalau tidak crossfade jadi salah. |
| **Track fader** | ⑦ — setelah insert chain | Ia properti *jalur*. Setelah kompresor, supaya menurunkan fader tidak mengubah jumlah kompresi (perilaku yang dikenal semua orang dari konsol). |

Keduanya memakai `Smoother` yang sama (one-pole, τ = 5 ms, docs/02 §2a). Otomasi
tidak menghasilkan event per sample; ia menghasilkan *ramp segment* dan smoother
yang mengeksekusinya.

### Headroom & summing

Akumulator internal f32 tidak clip secara matematis — rentang f32 sampai 3,4e38,
dan menjumlah 32 track pada 0 dBFS memberi paling buruk +30 dBFS, yang direpresentasi
dengan presisi penuh. **Yang clip adalah DAC di ±1,0**, dan encoder integer
(WAV 16/24-bit) di titik yang sama.

Jadi tidak ada alasan teknis untuk khawatir soal headroom internal, dan kita
**tidak** melakukan gain-staging otomatis (tidak ada pengurangan −6 dB
tersembunyi di master). Yang ada: meter yang jujur di setiap titik, sehingga user
melihat +8 dBFS di master dan tahu harus berbuat apa.

### Kebijakan master clip

| Opsi | Perilaku | Biaya CPU | Masalahnya |
|---|---|---|---|
| Tidak ada | Sample > 1,0 lolos ke DAC | 0 | Distorsi keras, dan di WAV float32 file-nya "benar" tapi tidak bisa diputar |
| Hard clamp | `x.clamp(-1,1)` | ~0 | Distorsi order-tinggi, aliasing, terdengar buruk sekali |
| **Soft clip (cubic)** | Linear sampai 2/3, lalu kurva; hard clamp di ±1 | ~2 ns/sample | Harmonik ganjil ringan saat digeber |
| True-peak limiter | Lookahead 1,5 ms + gain reduction | ~1% CPU + latency | Mengubah dinamika secara diam-diam; menyembunyikan masalah gain staging |

**Rekomendasi MVP: soft clipper cubic, default ON, bisa dimatikan, dengan
indikator yang menyala saat ia aktif.**

```rust
/// Kurva cubic klasik, dinormalisasi dua kali supaya:
///   (a) sinyal kecil lewat pada UNITY (slope 1 di x = 0) — soft clipper tidak
///       boleh mewarnai mix yang sudah benar levelnya;
///   (b) keluaran maksimum tepat ±1.0, tercapai pada input ±1.5 (≈ +3,5 dBFS).
/// Turunannya nol di titik saturasi → tidak ada patahan sudut, dan karenanya
/// tidak ada harmonik order-tinggi seperti pada hard clamp.
#[inline(always)]
fn soft_clip(x: f32) -> f32 {
    let u = x * (2.0 / 3.0);                          // pre-scale
    let u = if u > 1.0 { 1.0 } else if u < -1.0 { -1.0 } else { u };
    (u - (u * u * u) * (1.0 / 3.0)) * 1.5             // post-scale
}
// soft_clip(0.5) = 0.4815  (-0.33 dB)
// soft_clip(1.0) = 0.8519  (-1.39 dB)   → mulai jelas terasa tepat di 0 dBFS
// soft_clip(1.5) = 1.0     (batas)      → di atas ini rata
```

Alasan memilih ini di atas limiter:

- Limiter **menyembunyikan** masalah. User yang mixnya +8 dBFS akan mendengar
  sesuatu yang terdengar baik-baik saja dan tidak pernah belajar bahwa mixnya
  terlalu keras — sampai ia mengekspor ke float32 dan file-nya rusak.
- Soft clipper terdengar "hangat" untuk overshoot kecil (±0,5 dB) dan jelas
  buruk untuk overshoot besar. Itu umpan balik yang benar.
- Ia bebas latency. Limiter dengan lookahead menambah delay yang harus
  dikompensasi di export supaya offline dan realtime tetap sample-aligned —
  jalur kompleksitas yang tidak sepadan untuk MVP.
- Biayanya satu perkalian dan satu pembagian per sample.

Yang diterima: soft clipper tidak menjamin true-peak ≤ 0 dBTP setelah encoding
lossy. Limiter true-peak masuk fase 2 sebagai **plugin master** (bukan bagian
tetap dari jalur), supaya latency-nya dilaporkan lewat mekanisme delay
compensation yang sama dengan plugin lain.

---

## 7e. Metering

Ditulis **audio thread**, dibaca **UI via rAF**. Tidak ada `postMessage`.
Layout blok meter ada di [docs/01 §1b](01-threads-memory.md).

```
per slot (track / bus / master), 16 byte:
  f32 peak_display   ← peak dengan decay ballistics
  f32 rms            ← RMS window 300 ms
  f32 peak_hold      ← nilai puncak, di-reset UI atau setelah 2 detik
  u32 flags          ← bit0: clip (|x| >= 1.0) sejak reset
```

### Ballistics

**Peak: attack instan, release 20 dB/detik.**

```rust
// sekali per blok, bukan per sample — 375 Hz sudah jauh di atas persepsi mata
let block_peak = mix::peak(buf);                       // sudah SIMD
if block_peak > self.peak_display {
    self.peak_display = block_peak;                    // attack: instan
} else {
    self.peak_display *= self.decay_coeff;             // 20 dB/s
}
// decay_coeff = 10^(-20/20 * frames/sample_rate)
```

Attack instan itu wajib: meter yang melewatkan transien 1 sample adalah meter
yang berbohong tentang clipping. Release 20 dB/s adalah kompromi yang dipakai
konsol digital — cukup lambat untuk dibaca mata, cukup cepat untuk tidak
tertinggal dari musik.

**RMS: window 300 ms**, dihitung sebagai one-pole di domain kuadrat
(`ms += (x² − ms) · α`), bukan buffer melingkar. Alasan: buffer melingkar 300 ms
× 34 slot = 470 KB dan satu pass tambahan per blok; one-pole adalah dua operasi
dan hasilnya tidak bisa dibedakan secara visual. Akar kuadrat diambil **di UI**,
bukan di audio thread.

**Clip hold**: bit di-set saat `|x| >= 1.0` **sebelum** soft clipper (kalau
sesudah, ia tidak akan pernah menyala). Di-reset hanya oleh klik user — indikator
clip yang hilang sendiri tidak ada gunanya.

### Kenapa seqlock dan bukan atomic biasa

Blok meter ditulis sebagai unit yang konsisten dengan `SeqWriter`/`SeqReader`
(docs/00, `daw-rt`). Tanpa itu, UI bisa membaca `peak` dari blok N dan `rms`
dari blok N+1 — jarang terlihat untuk meter, tapi mekanismenya sudah ada dan
gratis, dan blok yang sama dipakai untuk data yang **tidak** toleran terhadap
tearing (posisi playhead).

---

## 7f. Export memakai `render_block` yang identik, dan null-test yang membuktikannya

Ini aturan emas #3 di [ARCHITECTURE.md](../ARCHITECTURE.md), dan di sini adalah
tesnya.

`OfflineRenderer` (docs/00) memanggil `Engine::render_block` — fungsi yang **sama
persis**, bukan salinan, bukan "versi offline". Yang berbeda hanya siapa yang
memanggil dan seberapa cepat. Konsekuensi yang harus dijaga supaya ini bermakna:

| Sumber non-determinisme | Cara dimatikan |
|---|---|
| Ukuran blok berbeda (128 realtime vs 1024 offline) | Semua state DSP di-*update per sample* atau per sub-blok, tidak pernah "per blok" dengan asumsi ukuran. Smoother koefisiennya turunan sample rate, bukan ukuran blok. Filter koefisien di-update di batas event, bukan di batas blok. |
| `SIMD vs scalar` | Jalur SIMD dan scalar wajib menghasilkan hasil yang identik-toleran; blok yang menjumlah dalam urutan berbeda diberi urutan reduksi yang tetap. |
| Tempo map | Integer penuh (docs/02 §2c). Tidak ada float. |
| Konversi posisi clip | Integer + `f64` deterministik (`timeline_to_source`). |
| Denormal flush mode | Di-set eksplisit sama di kedua instance. |
| Reverb/delay tail dari playback sebelumnya | Instance engine **kedua** untuk export (docs/03 §3a). |

**Null-test sebagai tes korektnes** (`crates/export/tests/`, milik agen lain —
di sini kontraknya):

```
1. Render project X offline → wav_a (float32, tanpa dither)
2. Render project X offline lagi, dengan ukuran blok BERBEDA (128 vs 1024) → wav_b
3. null = wav_a - wav_b   →  peak(null) harus 0.0 EKSAK (bit-identical)

4. Capture playback realtime project X lewat tap di master → wav_c
5. Align (offset = latency output yang dilaporkan), lalu null = wav_a - wav_c
6. peak(null) harus < -120 dBFS
```

Langkah 3 harus **bit-identical**, bukan "cukup dekat": kalau ukuran blok
mengubah hasil, ada state DSP yang bergantung ukuran blok, dan itu bug yang akan
muncul sebagai "export saya terdengar beda" di kondisi yang tidak bisa
direproduksi. Langkah 6 memberi toleransi karena capture realtime melewati
konversi sample rate device dan jitter callback.

---

# BAGIAN 8 — Playback Speed

## 8a. Keputusan fundamental: varispeed vs time-stretch

| | **Varispeed (resampling)** | Time-stretch (pitch-preserved) |
|---|---|---|
| Pitch | Ikut berubah | Tetap |
| Model mental | Tape / turntable | "Warp" (Ableton), "Elastic Audio" (Pro Tools) |
| CPU | ~4 mul/sample (Hermite) | WSOLA ~15×, phase vocoder ~60× |
| Latency | 0 | Frame/hop (23–46 ms) |
| Kualitas | Sempurna secara definisi (ia *memang* pemutaran lebih cepat) | Bergantung material; artefak selalu ada |
| Rentang berguna | Tak terbatas | 0,75×–1,5× sebelum artefak jelas |
| Kode | ~80 baris | 300 (WSOLA) – 1500 (PV) |

**Rekomendasi produk: MVP = varispeed saja, dengan toggle `warp: bool` yang sudah
ada di model tapi disabled di UI. Time-stretch = fase 2.**

Justifikasinya bukan "yang mudah dulu":

1. **Varispeed bukan versi murahan dari time-stretch; ia efek yang berbeda dan
   diinginkan sendiri.** "Tape mode" adalah fitur yang orang cari (pitch-down
   drum break, tape stop, vinyl slow). Mengirimkannya bukan mengirim setengah
   fitur.
2. **Ia satu-satunya yang benar-benar transparan.** Time-stretch selalu punya
   artefak; user yang mendengar artefak pada 1,02× akan menyalahkan DAW-nya.
   Varispeed pada 1,02× terdengar persis seperti pemutaran 2% lebih cepat, karena
   memang itu.
3. **Arsitekturnya tidak berubah saat time-stretch masuk.** Voice sudah membaca
   lewat fractional cursor; time-stretch nanti masuk sebagai *sumber alternatif*
   di titik ① (pre-rendered buffer, §8c), bukan sebagai perombakan jalur sinyal.
   `warp` dan `speed_ratio` sudah di file project v1.
4. Anggaran CPU (docs/02) tidak menyisakan ruang untuk 32 track time-stretch
   realtime. Mengirimkannya sekarang berarti mengirimkannya dengan batas jumlah
   track yang harus dijelaskan ke user — lebih buruk daripada belum ada.

Model Ableton (Warp on/off per-clip) adalah tujuan akhir yang benar, dan itulah
kenapa `warp` ada di model sejak v1. Yang tidak kita lakukan adalah mengirim
keduanya sekaligus dengan keduanya setengah jadi.

---

## 8b. Varispeed engine

### Fractional cursor + cubic Hermite

API di [docs/00](00-api-contract.md), implementasi di
`crates/dsp/src/resample.rs` (dimiliki agen DSP):

```rust
#[inline(always)] pub fn hermite4(y_m1: f32, y0: f32, y1: f32, y2: f32, t: f32) -> f32;
pub struct FracCursor { pub pos: f64, pub ratio: f64 }
```

Pemakaian dari sisi timeline (yang menghubungkan keduanya adalah
`coords::timeline_to_source_frac`):

```rust
// posisi awal voice saat playhead masuk clip — SATU KALI, dari timeline space
cursor.pos   = timeline_to_source_frac(&clip.geometry(), transport.playhead);
cursor.ratio = project.effective_ratio(&clip);      // clip × master

// per sample, di dalam render_span:
let i  = cursor.pos as usize;         // integer part
let t  = (cursor.pos - i as f64) as f32;
let y  = hermite4(src[i-1], src[i], src[i+1], src[i+2], t);
cursor.pos += cursor.ratio;
```

Tiga detail yang menentukan benar/tidaknya:

- **`pos` adalah `f64`, tidak boleh `f32`.** Pada 48 kHz, setelah 5 menit, posisi
  mencapai 1,4e7. `f32` punya 24 bit mantissa → resolusi di angka itu adalah
  ~1 sample: fraksinya hilang sepenuhnya dan varispeed berubah jadi
  nearest-neighbour. `f64` memberi resolusi 1e-9 sample bahkan setelah berjam-jam.
- **Posisi awal dihitung sekali dari timeline space**, bukan diakumulasi dari
  awal lagu. Seek ke bar 40 harus menghasilkan posisi source yang sama persis
  dengan memutar dari bar 0 sampai bar 40 — itulah yang membuat seek dan
  null-test konsisten.
- **`i-1` dan `i+2`** berarti butuh 1 sample sebelum dan 2 sesudah region. Di
  tepi asset, sample yang tidak ada di-*clamp* ke sample terdekat (bukan nol —
  nol menghasilkan diskontinuitas dan micro-fade tidak selalu menutupinya).

Kenapa cubic Hermite (Catmull-Rom) untuk MVP:

| Interpolator | Biaya/sample | SNR @ratio 1,5 | Catatan |
|---|---|---|---|
| Nearest | ~0 | ~20 dB | Tidak bisa dipakai |
| Linear | 2 mul | ~45 dB | Aliasing dan lowpass yang bergantung fraksi (terdengar sebagai "kusam yang berdenyut") |
| **Cubic Hermite** | 4 mul + 4 add | **~75 dB** | Dipilih. Response-nya halus, tanpa state, tanpa tabel |
| Windowed-sinc 16-tap | 16 mul + tabel | ~110 dB | Fase 2 |

75 dB SNR berada di bawah noise floor material musik apa pun dan di bawah dither
16-bit. Sinc polyphase masuk sebagai opsi kualitas "Bounce" (dipakai hanya saat
export) di fase 2 — di situ CPU tidak dibatasi realtime.

### Anti-aliasing saat `ratio > 1.0`

Saat clip diputar lebih cepat, konten di atas `Nyquist / ratio` akan melipat
turun. Pada `ratio = 2,0`, konten di atas 12 kHz (di project 48k) muncul kembali
sebagai aliasing di bawah 12 kHz — inharmonis dan sangat terdengar pada material
cerah (cymbal, gitar akustik).

Solusi yang benar: lowpass pre-filter dengan cutoff mengikuti ratio,
`fc = 0,45 · sr / ratio`, sebelum interpolasi.

**Yang diterima MVP, dinyatakan jujur: aliasing tidak difilter untuk
`ratio > 1.0`.** Alasannya:

- Filter yang cutoff-nya mengikuti ratio berarti **koefisien biquad berubah
  setiap kali ratio berubah**, dan TDF-II tidak suka koefisien yang berubah
  cepat (docs/02 §2b) — butuh crossfade dua instance filter, yang berarti dua
  filter per voice.
- Filter satu-biquad (12 dB/oct) hampir tidak menolong: konten 6 kHz di atas
  cutoff hanya teredam ~12 dB dan tetap terdengar. Yang benar butuh 4 kaskade
  (48 dB/oct) = 8 biquad stereo per voice.
- Varispeed **speed-up** jauh lebih jarang dipakai daripada slow-down
  (`ratio < 1.0`), dan slow-down **tidak punya masalah aliasing sama sekali** —
  ia hanya interpolasi di antara sample yang ada.

Jadi biaya-manfaatnya jelas: filter untuk kasus yang jarang, dengan biaya yang
dibayar setiap voice. Yang kita lakukan sebagai gantinya: UI menampilkan
peringatan halus ("aliasing mungkin terdengar") saat `ratio > 1.5`, dan jalur
sinc polyphase fase 2 akan membawa oversampling sekalian — itu tempat yang benar
untuk menyelesaikannya, bukan menambal sekarang.

### Ratio berubah saat playing

Menyetel `cursor.ratio` langsung dari nilai baru menghasilkan diskontinuitas
turunan posisi — terdengar sebagai klik atau "loncatan". Ratio karena itu punya
`Smoother` sendiri:

```rust
// tau 60 ms — jauh lebih panjang daripada gain (5 ms), karena telinga
// mendeteksi perubahan pitch yang tiba-tiba jauh lebih peka daripada perubahan
// level, dan karena efek "tape glide" yang dihasilkan memang diinginkan.
cursor.ratio = self.ratio_smoother.next() as f64;
```

Bonusnya bukan kebetulan: ramp 60 ms **adalah** tape glide. Menyeret slider speed
dari 1,0 ke 0,5 terdengar seperti tape yang melambat, bukan seperti pemotongan.
Untuk tape-stop yang lebih dramatis, UI cukup mengirim ramp otomasi
(`ParamTarget::ClipSpeed`) — tidak ada kode engine tambahan.

Yang harus dijaga: `ratio` yang di-smooth berarti posisi source setelah ramp
**tidak** sama dengan `timeline_to_source(t)` yang dihitung ulang. Karena itu
posisi voice tidak pernah di-resync saat playing; ia hanya diinisialisasi saat
voice mulai dan saat seek. Itu juga alasan `speed_ratio` yang di-otomasi
memerlukan render offline dan realtime memulai voice pada posisi yang sama —
dijamin karena keduanya memulai voice di batas clip yang sama.

---

## 8c. Time-stretch (fase 2, arsitektur disiapkan sekarang)

### Kandidat

| | **WSOLA sendiri (Rust)** | signalsmith-stretch | Rubber Band |
|---|---|---|---|
| Lisensi | Milik kami | MIT | **GPL v2** / komersial berbayar |
| Bahasa | Rust, `no_std` | C++17 header-only | C++ |
| WASM | Native, tanpa toolchain tambahan | Perlu emcc atau `cc` crate ke wasm32; header-only membantu, tapi butuh libc++ shim | Perlu emcc; besar |
| Ukuran | ~300 baris, ~8 KB | ~120 KB WASM | ~400 KB+ WASM |
| Kualitas | Baik 0,75×–1,5×, khususnya perkusif | Sangat baik, formant-aware | Referensi industri |
| CPU | ~15× varispeed | ~40× | ~50× |
| Binding Rust | — | Tidak resmi; FFI manual | `rubberband-sys` (mewarisi GPL) |

**Implikasi lisensi Rubber Band, dieja terang-terangan:** GPL v2 bersifat
*copyleft* dan menular. Menautkannya ke DawOnWeb berarti **seluruh aplikasi harus
dirilis di bawah GPL**, termasuk kode UI dan engine. Untuk produk komersial atau
SaaS berbayar, satu-satunya jalan yang sah adalah membeli lisensi komersial dari
Particular Programming (harga per-produk, dinegosiasikan). "Kami hanya
memanggilnya lewat WASM module terpisah" **tidak** menghindari ini: modul yang
di-load bersama dan berkomunikasi lewat memori bersama adalah karya turunan
menurut interpretasi FSF, dan mempertaruhkan produk pada interpretasi yang
menguntungkan diri sendiri bukan strategi. Jadi: **Rubber Band tidak dipakai
kecuali lisensi komersial dibeli.**

**Rekomendasi: WSOLA sendiri untuk fase 2**, dengan signalsmith-stretch sebagai
jalur upgrade kalau kualitas WSOLA tidak cukup untuk material tonal. Alasan:
lisensi bersih, tanpa toolchain C++ di CI (docs/04 sudah cukup rumit), `no_std`,
dan 300 baris yang kita pahami sepenuhnya lebih baik daripada 120 KB yang tidak.

### Realtime vs pre-rendered

**Pre-rendered adalah default; realtime hanya untuk preview saat menyeret.**

```
user menyeret slider stretch
   │
   ├─ selama drag  : varispeed realtime (pitch ikut berubah) sebagai preview.
   │                 Instan, nol biaya, dan jelas berbeda dari hasil akhir
   │                 sehingga tidak ada yang salah paham.
   │
   └─ 300 ms setelah drag berhenti (debounce)
         │
         ▼
      stretch-worker: WSOLA seluruh region clip → cache buffer di OPFS + memory
         │  progress kecil di badan clip
         ▼
      selesai → voice beralih ke cache buffer, ratio kembali 1.0
                (crossfade 20 ms antara preview dan hasil, supaya tidak "klik" saat siap)
```

Kapan masing-masing masuk akal:

| | Pre-render | Realtime |
|---|---|---|
| Ratio jarang berubah (kasus normal) | ✓ CPU playback nol | Bayar 15× selamanya |
| Ratio di-otomasi (berubah kontinu) | ✗ mustahil di-cache | ✓ satu-satunya cara |
| Banyak clip di-stretch | ✓ skala bebas | ✗ 32 track × 15× = di luar anggaran |
| Memori | +1 buffer per clip yang di-stretch | 0 |
| Latency perubahan | ~1–3 detik | Instan |

Otomasi `ClipSpeed` karena itu tetap dibatasi ke varispeed di fase 2 juga — dan
itu keputusan yang benar, karena stretch yang ratio-nya berubah kontinu memang
tidak punya arti yang stabil.

### Latency & lookahead di konteks render quantum 128

Phase vocoder butuh frame 2048 dengan hop 512 → latency algoritmik ~43 ms @48k.
Render quantum 128 tidak bisa "menunggu" frame; jalannya harus:

- Stretcher punya **ring input dan ring output sendiri**. `render_block` menarik
  128 sample dari ring output; ketika ring output turun di bawah ambang, satu
  frame diproses. Beban karena itu **tidak rata**: satu blok dari empat
  mengerjakan FFT 2048.
- Beban tidak rata adalah pembunuh realtime (docs/05): satu blok yang melewati
  2,67 ms = underrun, meskipun rata-ratanya jauh di bawah. Mitigasinya adalah
  memecah FFT lintas blok (*load spreading*) — dan itu, sekali lagi, argumen
  paling kuat untuk **pre-render**: buffer yang sudah jadi tidak punya beban
  tidak rata sama sekali.
- Latency algoritmik harus dilaporkan ke plugin delay compensation supaya clip
  yang di-stretch tetap sample-aligned dengan yang tidak. Untuk jalur
  pre-render, latency-nya **nol** — alasan keempat.

---

## 8d. Interaksi per-clip × global speed

### `effective_ratio = clip_ratio × master_ratio`

```rust
// crates/timeline-core/src/model.rs
pub fn effective_ratio(&self, clip: &Clip) -> f64 {
    clip.speed_ratio * self.master_speed
}
```

Perkalian, bukan penjumlahan: ratio adalah faktor skala, dan dua faktor
berkomposisi dengan perkalian. Clip 2× di dalam master 0,5× harus kembali ke
kecepatan asli, dan hanya perkalian yang memberikan itu.

### Master varispeed vs tempo change — semantiknya

Ini pertanyaan yang harus dijawab tegas karena keduanya sering dikira sama.

| | **Master varispeed (`master_speed`)** | Tempo change (tempo map) |
|---|---|---|
| Transport clock | **Tetap.** Playhead maju 1 sample per sample | Tetap juga, tapi tick per sample berubah |
| Grid / bar line | **Tidak bergerak** | Bergerak: satu bar jadi lebih pendek/panjang di layar |
| Panjang clip di timeline | **Tidak berubah** | Tidak berubah (clip audio tidak mengikuti tempo di MVP) |
| Isi audio | Semua clip di-resample, pitch berubah | Tidak tersentuh |
| Analogi | Memutar seluruh tape lebih cepat | Metronome diganti |
| Efek pada export | Durasi file **sama**, isinya lebih cepat/pitch naik | Durasi sama, isi sama |

**Rekomendasi untuk DAW berbasis clip audio: `master_speed` adalah varispeed
murni, dan ia TIDAK menyentuh tempo map.**

Alasannya: kalau `master_speed` juga mengubah tempo map, ia menjadi operasi yang
mengubah *dokumen* (posisi bar, snap, otomasi ber-tick) — dan itu berarti
mengubahnya lalu mengembalikannya ke 1,0 tidak dijamin mengembalikan project ke
keadaan semula (pembulatan tick). Sebuah kontrol pemutaran tidak boleh punya
konsekuensi yang tidak reversibel terhadap dokumen. Dengan definisi kami,
`master_speed` sepenuhnya reversibel: ia hanya faktor yang dikalikan di titik ①.

Konsekuensi ke tempo map ([docs/02 §2c](02-dsp-engine.md)): **tidak ada.**
`tick_to_sample`/`sample_to_tick` tidak pernah melihat `master_speed`. Grid,
snap, dan otomasi tetap di posisi sample yang sama. Yang terdengar berubah, yang
terlihat tidak.

Konsekuensi yang harus disebut jujur: pada `master_speed != 1.0`, **metronome dan
audio jadi tidak sinkron secara musikal** (metronome tetap 120 BPM, audio
terdengar 132 BPM). Karena itu UI mematikan metronome secara otomatis saat
`master_speed != 1.0` dan menampilkan badge "VARISPEED 1,10×" di transport.
Untuk kebutuhan "percepat lagunya termasuk grid", jawabannya adalah mengubah
tempo map — operasi yang berbeda, dengan tombol yang berbeda.

### Timeline-space vs source-space geometry

Konsekuensi paling praktis dari `speed_ratio` adalah:

```
timeline_len = source_len / ratio
```

dan karena itu **semua** geometri UI bekerja di timeline space:

| Operasi | Space | Konversi |
|---|---|---|
| Hit-test, drag, snap, culling viewport | Timeline | — |
| Menggambar batas clip, handle, fade | Timeline | — |
| `trim_left` menyimpan `source_start` | Timeline → Source | `timeline_to_source` |
| `split_at` menghitung `source_start` clip kanan | Timeline → Source | `timeline_to_source` |
| Voice membaca sample | Timeline → Source | `timeline_to_source_frac` (**tanpa** pembulatan) |
| Marker/cue di dalam asset digambar di timeline | Source → Timeline | `source_to_timeline` |

Aturan yang tidak boleh dilanggar, dan alasannya ada di §"Dua koordinat space"
di [docs/06](06-timeline-clips.md): **jangan pernah menyimpan hasil round-trip
kembali ke clip.** Round-trip punya error sampai `ceil(1/ratio)+1` sample; kalau
UI melakukannya per gerakan mouse, clip melayang.

### Waveform clip yang di-stretch: stride, bukan regenerate

```rust
pyramid.read_clip_range(&clip.geometry(), viewport_from, viewport_to, &mut out);
```

Fungsi ini mengonversi rentang timeline ke rentang source lalu membaca pyramid
seperti biasa. Untuk `ratio = 2,0`, rentang source-nya dua kali lebih panjang
untuk lebar pixel yang sama — yaitu **striding dengan faktor ratio**, dan
pemilihan level pyramid otomatis naik untuk mengompensasi.

Biaya mengubah `speed_ratio`: **nol**. Tidak ada pyramid baru, tidak ada
invalidasi cache pyramid (cache *canvas* memang invalid, karena bentuknya
berubah — itu wajar), tidak ada worker yang dibangunkan. Ini di-tes: hasil
`read_clip_range` pada clip `ratio = 2,0` sepanjang seluruh clip identik dengan
`read_range` langsung atas seluruh rentang source.

Yang jujur harus disebut: untuk clip yang di-**time-stretch** dan sudah
di-pre-render ke cache buffer, pyramid **harus** dibangun ulang untuk buffer itu
(bentuk gelombangnya benar-benar berbeda, bukan sekadar diregangkan). Itu bagian
dari pekerjaan stretch-worker dan sudah termasuk di progress-nya — bukan biaya
tambahan yang mengejutkan.
