/**
 * Isi landing page — disalin PERSIS dari `renderVals()` di
 * `design/Landing Pages.dc.html`.
 *
 * Semuanya statis, jadi ia hidup di modul sendiri dan bukan di dalam
 * komponen: teks marketing berubah jauh lebih sering daripada layout-nya,
 * dan memisahkannya membuat perubahan copy tidak menyentuh JSX sama sekali.
 *
 * Field `k` dari design (key untuk sc-for) tidak dibawa — React memakai
 * indeks/id yang stabil karena daftar ini tidak pernah diurutkan ulang.
 */

export interface HeroStat {
  readonly val: string;
  readonly label: string;
}

export interface Feature {
  readonly tag: string;
  readonly title: string;
  readonly body: string;
}

export interface Step {
  readonly n: string;
  readonly title: string;
  readonly body: string;
}

export interface Spec {
  readonly label: string;
  readonly val: string;
}

export type PlanId = 'd7' | 'd30' | 'life';

export interface Plan {
  readonly id: PlanId;
  readonly name: string;
  readonly price: string;
  readonly unit: string;
  readonly per: string;
  readonly desc: string;
  readonly badge: string;
  readonly items: readonly string[];
}

export interface WasmStat {
  readonly val: string;
  readonly unit: string;
  readonly label: string;
  readonly note: string;
}

export interface Bench {
  readonly name: string;
  readonly time: string;
  /** Panjang bar dalam persen — relatif terhadap kandidat paling lambat. */
  readonly w: number;
  readonly color: string;
  readonly fill: string;
}

export interface Faq {
  readonly q: string;
  readonly a: string;
}

/** Satu lane di mock timeline hero. `l`/`w` dalam persen lebar timeline. */
export interface HeroLane {
  readonly name: string;
  readonly color: string;
  readonly l: number;
  readonly w: number;
  readonly barCount: number;
  readonly seed: number;
}

export const HERO_STATS: readonly HeroStat[] = [
  { val: '∞', label: 'LANE PER PROJECT' },
  { val: '0', label: 'FILE DIUPLOAD' },
  { val: '1', label: 'FILE HASIL COMPILE' },
];

export const HERO_LANES: readonly HeroLane[] = [
  { name: 'FIRST', color: '#ffd400', l: 0, w: 74, barCount: 34, seed: 3 },
  { name: 'VOCAL', color: '#ffb020', l: 18, w: 42, barCount: 20, seed: 9 },
  { name: 'AMBIENCE', color: '#a07a10', l: 8, w: 88, barCount: 40, seed: 17 },
  { name: 'DROP FX', color: '#6f6a5e', l: 56, w: 26, barCount: 12, seed: 23 },
];

export const FEATURES: readonly Feature[] = [
  {
    tag: 'CORE',
    title: 'TIMELINE MULTI-LANE',
    body: 'Lane tak terbatas, rename bebas, mute/solo per lane. Geser clip horizontal untuk waktu, vertikal untuk pindah lane.',
  },
  {
    tag: 'NAV',
    title: 'ZOOM & PAN PRESISI',
    body: 'Scroll untuk zoom sampai 400 px/detik, drag untuk pan. Ruler dan overview ikut bergerak, playhead auto-follow saat play.',
  },
  {
    tag: 'EDIT',
    title: 'CLIP DETAIL',
    body: 'Klik clip untuk merender waveform penuhnya: trim, fade in/out linear atau equal-power, normalize, split di playhead.',
  },
  {
    tag: 'MIX',
    title: 'LANE MIXER + EQ',
    body: 'Fader dan gain per lane, EQ tiga band dengan preset. Semua perubahan langsung terdengar di preview.',
  },
  {
    tag: 'RENDER',
    title: 'VARISPEED RENDER',
    body: 'Render 0.5x sampai 2x dengan pitch ikut bergeser — mode klasik tape, bukan time-stretch artefak.',
  },
  {
    tag: 'OUT',
    title: 'COMPILE SATU FILE',
    body: 'Semua lane dijumlahkan jadi satu WAV 24-bit atau MP3. Tanpa limiter tersembunyi — apa yang kamu dengar itu yang keluar.',
  },
];

export const STEPS: readonly Step[] = [
  {
    n: '01',
    title: 'DROP FILE',
    body: 'Tarik audio ke lane kosong. MP3, WAV, OGG, M4A — didekode langsung di browser.',
  },
  {
    n: '02',
    title: 'SUSUN DI TIMELINE',
    body: 'Geser clip ke posisi waktunya, tumpuk di lane berbeda, rename lane sesuai peran.',
  },
  {
    n: '03',
    title: 'RAPIKAN TRANSISI',
    body: 'Fade equal-power antar lagu, trim ekor, atur gain supaya peak tetap di bawah 0 dBFS.',
  },
  {
    n: '04',
    title: 'COMPILE',
    body: 'Pilih format, tekan compile, file turun ke device. Tidak ada yang pernah menyentuh server.',
  },
];

export const SPECS: readonly Spec[] = [
  { label: 'Sample rate', val: '48 kHz' },
  { label: 'Bit depth output', val: '24-bit WAV' },
  { label: 'Format masuk', val: 'MP3 · WAV · OGG · M4A · FLAC' },
  { label: 'Zoom range', val: '2 → 400 px/s' },
  { label: 'Fade curve', val: 'Linear · Equal-power' },
  { label: 'Varispeed', val: '0.5× → 2× (pitch ikut)' },
  { label: 'Proses audio', val: '100% lokal di browser' },
  { label: 'Batas project', val: 'Sebatas RAM device' },
];

export const PLANS: readonly Plan[] = [
  {
    id: 'd7',
    name: '7 DAYS',
    price: 'Rp50.000',
    unit: '/ 7 hari',
    per: '≈ Rp7.100 per hari',
    desc: 'Akses penuh untuk satu rilisan. Paling sering diambil.',
    badge: 'PALING DIAMBIL',
    items: [
      'Semua fitur studio dibuka',
      'Lane tak terbatas',
      'Export WAV 24-bit & MP3',
      'Varispeed render 0.5×–2×',
    ],
  },
  {
    id: 'd30',
    name: '30 DAYS',
    price: 'Rp149.000',
    unit: '/ 30 hari',
    per: '≈ Rp4.900 per hari',
    desc: 'Untuk yang rilis rutin tiap minggu.',
    badge: 'HEMAT 30%',
    items: [
      'Semua isi paket 7 Days',
      'Simpan project di device',
      'Preset fade & EQ custom',
      'Antrian compile lebih panjang',
    ],
  },
  {
    id: 'life',
    name: 'LIFETIME',
    price: 'Rp399.000',
    unit: '/ sekali bayar',
    per: 'balik modal di bulan ke-3',
    desc: 'Bayar sekali, plus jalur request fitur.',
    badge: 'REQUEST FITUR',
    items: [
      'Semua fitur, selamanya',
      'Semua update berikutnya',
      'Bisa request fitur langsung ke developer',
      'Nama masuk daftar early supporter',
    ],
  },
];

export const WASM_STATS: readonly WasmStat[] = [
  {
    val: '18',
    unit: '×',
    label: 'LEBIH CEPAT DARI JS MURNI',
    note: 'Loop mixing SIMD 4-lane, tanpa garbage collector di jalur audio.',
  },
  {
    val: '<3',
    unit: 'ms',
    label: 'LATENSI ROUND-TRIP',
    note: 'Buffer 128 frame di AudioWorklet, terpisah dari thread UI.',
  },
  {
    val: '60',
    unit: 'fps',
    label: 'TIMELINE TETAP MULUS',
    note: 'Waveform di-decimate di WASM, UI cuma menggambar hasilnya.',
  },
];

export const BENCH: readonly Bench[] = [
  {
    name: 'WASM SIMD (dipakai di sini)',
    time: '4.1 s',
    w: 12,
    color: 'var(--cy-accent)',
    fill: 'linear-gradient(90deg,#ffd400,#ffb020)',
  },
  {
    name: 'JavaScript murni',
    time: '74.6 s',
    w: 100,
    color: 'var(--cy-text-dim)',
    fill: '#2f2c25',
  },
];

export const WASM_BULLETS: readonly string[] = [
  'Inti DSP Rust → WebAssembly, nol dependency runtime.',
  'Memori linear sekali alokasi: tidak ada GC pause saat render.',
  'Resampler cubic Hermite dengan cursor pecahan presisi sample.',
  'Decode & mixdown jalan di worker, UI tidak pernah ter-block.',
  'Fallback JS otomatis kalau browser tidak mendukung SIMD.',
];

export const WASM_TAGS: readonly string[] = [
  'RUST',
  'WEBASSEMBLY SIMD',
  'AUDIOWORKLET',
  'WEB WORKERS',
  'ZERO-COPY BUFFER',
  'OFFLINE-READY',
];

export const FAQS: readonly Faq[] = [
  {
    q: 'Audio saya diupload ke server?',
    a: 'Tidak. Dekode, mixing, dan render berjalan di browser lewat Web Audio API. File tidak pernah meninggalkan device kamu.',
  },
  {
    q: 'Berapa panjang project maksimum?',
    a: 'Dibatasi RAM device. Di laptop 8 GB, project satu jam dengan empat lane masih nyaman.',
  },
  {
    q: 'Apakah ada limiter di output?',
    a: 'Tidak ada limiter maupun soft-clip. Sample di atas 0 dBFS lewat apa adanya, jadi turunkan gain sampai peak aman.',
  },
  {
    q: 'Bisa dipakai offline?',
    a: 'Bisa. Setelah halaman dimuat sekali, studio berjalan tanpa koneksi.',
  },
];
