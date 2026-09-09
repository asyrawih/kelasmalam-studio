/**
 * METRONOM — klik yang dijadwalkan DARI GRID, untuk memeriksanya dengan telinga.
 *
 * Gunanya bukan bermain mengikuti ketukan: gunanya adalah **audit**. Grid yang
 * meleset 0.3 BPM terlihat benar di layar selama satu bar dan baru terbukti
 * salah setelah dua menit — sedangkan telinga mendengarnya sebagai klik yang
 * merayap keluar dari kick dalam beberapa detik. Ini alat ukur yang paling
 * peka yang dimiliki halaman ini, dan itulah kenapa ia ikut dibangun.
 *
 * ## SATU ATURAN YANG TIDAK BISA DITAWAR
 *
 * **Klik masuk ke bus CUE saja, tidak pernah ke MASTER.** Metronom yang bocor
 * ke keluaran utama adalah kesalahan yang terdengar oleh seluruh ruangan, dan
 * ia tidak akan ketahuan saat menguji dengan satu perangkat keluaran — persis
 * keadaan yang paling sering dipakai saat mengembangkan.
 *
 * Aturannya tidak dijaga dengan kehati-hatian, melainkan oleh TOPOLOGI:
 * `graph.metronome` hanya tersambung ke `cueLevel`, dan `cueLevel` di
 * `dj-graph.ts` hanya tersambung ke `cueOut` (`MediaStreamAudioDestination`) —
 * TIDAK pernah ke `ctx.destination`. Jadi tidak ada jalan dari klik ke speaker
 * utama, dan `dj-graph.test.ts` mengunci ketiadaan jalan itu sebagai tes.
 *
 * ## Penjadwalan
 *
 * Bunyinya dijadwalkan KE DEPAN dengan jam audio, bukan dibunyikan dari rAF.
 * `setTimeout`/rAF meleset puluhan milidetik di bawah beban — dan alat yang
 * dipakai untuk mengukur ketelitian 25 ms tidak boleh punya galat sebesar
 * galat yang sedang diukurnya.
 *
 * Laju baca deck ikut diperhitungkan: menggeser tempo fader mempercepat lagu
 * DAN kliknya. Grid milik materi, jadi jarak antar-klik dalam waktu nyata
 * adalah `panjang_ketukan / rate`.
 */

import { beatIndexAt, samplesPerBeat, sourceAtBeat, type BeatGrid } from '../../studio/analysis/beat-grid';

/** Mati, lalu tiga tingkat — persis rekordbox. */
export type MetroLevel = 0 | 1 | 2 | 3;
export const METRO_LEVELS: readonly MetroLevel[] = [0, 1, 2, 3];

/**
 * Gain per tingkat. Puncaknya sengaja rendah: klik adalah transien pendek dan
 * terdengar jauh lebih keras daripada angkanya, dan ia berbunyi LANGSUNG di
 * headphone tanpa melewati fader mana pun.
 */
const LEVEL_GAIN: Readonly<Record<MetroLevel, number>> = { 0: 0, 1: 0.12, 2: 0.25, 3: 0.5 };

/**
 * Seberapa jauh ke depan klik dijadwalkan. 150 ms cukup untuk menahan satu
 * frame rAF yang hilang; lebih panjang berarti perubahan grid butuh lebih lama
 * untuk terdengar, dan justru saat menyunting grid itu yang paling terasa.
 */
const LOOKAHEAD_SEC = 0.15;

/** Panjang satu klik. Cukup untuk punya nada, cukup pendek untuk punya titik. */
const CLICK_SEC = 0.035;
const DOWNBEAT_HZ = 1600;
const BEAT_HZ = 1000;

export interface MetroTick {
  readonly grid: BeatGrid;
  readonly level: MetroLevel;
  /** Posisi SOURCE yang terdengar SEKARANG, sample. */
  readonly positionSamples: number;
  /** Laju baca deck (tempo fader + bend). */
  readonly rate: number;
  readonly sampleRate: number;
  /** Jam audio sekarang. */
  readonly now: number;
}

export class Metronome {
  private readonly ctx: BaseAudioContext;
  private readonly out: GainNode;
  /**
   * Indeks ketukan terakhir yang SUDAH dijadwalkan. `null` = belum ada.
   *
   * Ini yang membuat rAF boleh berjalan 60×/detik tanpa menghasilkan 60 klik
   * per ketukan. Ia direset tiap kali deretannya putus (metronom dimatikan,
   * deck berhenti, playhead melompat) — tanpa reset, melompat mundur ke intro
   * akan membisukan metronom sampai lagunya kembali melewati titik terjauh
   * yang pernah dicapai.
   */
  private lastBeat: number | null = null;
  private level: MetroLevel = 0;

  constructor(ctx: BaseAudioContext, out: GainNode) {
    this.ctx = ctx;
    this.out = out;
    this.out.gain.value = 0;
  }

  /** Hentikan deretan. Klik yang TERLANJUR dijadwalkan tetap berbunyi — semuanya
   *  di dalam 150 ms ke depan, dan memotongnya berbunyi lebih buruk. */
  reset(): void {
    this.lastBeat = null;
  }

  setLevel(level: MetroLevel): void {
    if (this.level === level) return;
    this.level = level;
    this.out.gain.value = LEVEL_GAIN[level];
    if (level === 0) this.reset();
  }

  /**
   * Jadwalkan klik yang jatuh di dalam jendela lihat-ke-depan.
   *
   * Dipanggil tiap frame. Mengembalikan berapa klik yang baru dijadwalkan —
   * hanya untuk tes; tidak ada pemanggil produksi yang memakainya.
   */
  schedule(t: MetroTick): number {
    this.setLevel(t.level);
    if (t.level === 0 || !(t.rate > 0) || !(t.sampleRate > 0)) {
      this.reset();
      return 0;
    }

    const spb = samplesPerBeat(t.grid, t.sampleRate);
    if (!Number.isFinite(spb) || spb <= 0) return 0;

    const beatNow = beatIndexAt(t.positionSamples, t.grid, t.sampleRate);
    // Ketukan yang sudah lewat lebih dari setengah ketukan berarti deretannya
    // putus — playhead melompat, atau frame-nya tertinggal jauh.
    if (this.lastBeat !== null && (this.lastBeat < beatNow - 1 || this.lastBeat > beatNow + 8)) {
      this.lastBeat = null;
    }

    // Detik nyata per ketukan = panjang ketukan materi dibagi laju baca.
    const secPerBeat = spb / (t.sampleRate * t.rate);
    let scheduled = 0;
    let beat = this.lastBeat === null ? Math.ceil(beatNow) : this.lastBeat + 1;

    // Batas keras: grid rusak (BPM 300 pada rate tinggi) tidak boleh membuat
    // loop ini menjadwalkan ribuan node dalam satu frame.
    for (let guard = 0; guard < 64; guard++) {
      const dt = (sourceAtBeat(beat, t.grid, t.sampleRate) - t.positionSamples) / (t.sampleRate * t.rate);
      if (dt > LOOKAHEAD_SEC) break;
      // Klik yang waktunya sudah lewat dijadwalkan di `now`, bukan dibuang:
      // membuangnya membuat ketukan pertama setelah PLAY selalu hilang.
      const at = t.now + Math.max(0, dt);
      this.click(at, beat % t.grid.beatsPerBar === 0);
      this.lastBeat = beat;
      beat += 1;
      scheduled += 1;
      if (!(secPerBeat > 0)) break;
    }
    return scheduled;
  }

  /** Satu klik. Node dibuang sendiri setelah berbunyi — Web Audio menjamin itu. */
  private click(at: number, downbeat: boolean): void {
    const ctx = this.ctx;
    if (typeof ctx.createOscillator !== 'function') return;

    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = downbeat ? DOWNBEAT_HZ : BEAT_HZ;

    // Serangan 1 ms, bukan nol: langkah tegak di gain menghasilkan klik KEDUA
    // dari diskontinuitasnya sendiri, dan yang terdengar bukan lagi ketukannya.
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(downbeat ? 1 : 0.6, at + 0.001);
    env.gain.exponentialRampToValueAtTime(0.0001, at + CLICK_SEC);

    osc.connect(env);
    env.connect(this.out);
    osc.start(at);
    osc.stop(at + CLICK_SEC);
    osc.onended = () => {
      osc.disconnect();
      env.disconnect();
    };
  }
}
