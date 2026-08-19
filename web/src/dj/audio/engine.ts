/**
 * Lapisan audio halaman DJ: kepemilikan, siklus hidup, dan penerapan state.
 *
 * ## Kenapa `AudioContext`-nya DIPINJAM, bukan dibuat sendiri
 *
 * `studio/preview/audio-preview.ts` sudah memiliki satu `AudioContext` dan satu
 * cache `AudioBuffer` yang dipakai bersama oleh import, waveform, dan playback.
 * Membuat context kedua berarti men-decode ulang setiap lagu — puluhan megabyte
 * dan beberapa detik per lagu — untuk mendapatkan buffer yang isinya persis
 * sama. Jadi halaman ini meminjam keduanya.
 *
 * Konsekuensinya harus disebut: `teardown()` yang dipanggil salah satu halaman
 * mematikan yang lain. Halaman DJ karena itu TIDAK PERNAH memanggilnya; ia hanya
 * membongkar graf miliknya sendiri.
 *
 * ## Kenapa dibangun dari GESTUR, bukan saat mount
 *
 * Safari (dan kebijakan autoplay Chrome) menolak `AudioContext` yang dibuat di
 * luar handler gestur user — dan yang lebih buruk, ia dibuat dalam keadaan
 * `suspended` tanpa gejala apa pun selain "tidak ada suara". `main.tsx` sudah
 * memutuskan hal yang sama untuk engine Studio. Jadi `ensureDjAudio()` dipanggil
 * dari klik pertama apa pun (PLAY, CUE, memuat lagu), bukan dari `useEffect`.
 *
 * ## Arah data
 *
 * ```
 *   store ──(apply)──► graf Web Audio        satu arah, dipicu perubahan store
 *   graf  ──(clock)──► store.playhead        satu arah, dipicu rAF
 * ```
 *
 * Keduanya tidak bisa berputar karena yang mengalir balik hanya POSISI, dan
 * posisi ditulis lewat `syncFromClock` yang TIDAK menaikkan `seekEpoch`. Justru
 * itulah kenapa `seekEpoch` ada: ia memisahkan "playhead maju sendiri" dari
 * "user melompat", persis seperti di `usePreviewPlayback`.
 */

import { resolveBeatGrid } from '../../studio/analysis/beat-grid';
import { ensureContext, getBuffer, previewSampleRate } from '../../studio/preview/audio-preview';
import { ensureFxRuntime, fxCatalog } from '../../studio/preview/fx-node';
import { studioStore } from '../../studio/store';
import { djStore as djStoreRef } from '../store';
import {
  DECK_IDS,
  effectiveRate,
  loopLen,
  tempoRatio,
  type DeckId,
  type DeckState,
  type DjState,
} from '../model';
import { FxInsertSlot } from './fx-insert';
import { Metronome } from './metronome';
import { CueOutput } from './cue-output';
import {
  applyChannel,
  applyCrossfader,
  applyMaster,
  buildDjGraph,
  disposeGraph,
  type DjGraph,
} from './dj-graph';

interface DeckSnapshot {
  readonly assetId: number | null;
  readonly playing: boolean;
  readonly seekEpoch: number;
  readonly rate: number;
  readonly loopKey: string;
  readonly slip: boolean;
}

function loopKeyOf(d: DeckState): string {
  const len = loopLen(d.loop);
  return d.loop.active && len !== null ? `${d.loop.inAt}:${d.loop.outAt}` : '';
}

function snapshotOf(d: DeckState): DeckSnapshot {
  return {
    assetId: d.assetId,
    playing: d.playing,
    seekEpoch: d.seekEpoch,
    rate: effectiveRate(d),
    loopKey: loopKeyOf(d),
    slip: d.slip,
  };
}

const EMPTY_SNAPSHOT: DeckSnapshot = {
  assetId: null,
  playing: false,
  seekEpoch: -1,
  rate: 1,
  loopKey: '',
  slip: false,
};

export class DjAudio {
  readonly graph: DjGraph;
  readonly cue = new CueOutput();
  private readonly metronome: Metronome;
  private readonly fxSlot = new FxInsertSlot();
  /** Dipasang pemanggil supaya kegagalan FX terbaca di layar, bukan senyap. */
  onFxFault: ((message: string) => void) | null = null;
  private last: Record<DeckId, DeckSnapshot> = { A: EMPTY_SNAPSHOT, B: EMPTY_SNAPSHOT };
  private readonly peakBuf: Float32Array<ArrayBuffer>;

  constructor(graph: DjGraph) {
    this.graph = graph;
    this.metronome = new Metronome(graph.ctx, graph.metronome);
    this.peakBuf = new Float32Array(new ArrayBuffer(graph.masterAnalyser.fftSize * 4));
    if (graph.cueOut !== null) this.cue.attach(graph.cueOut.stream);
  }

  get ctx(): AudioContext {
    return this.graph.ctx;
  }

  /**
   * Apakah context BENAR-BENAR berbunyi.
   *
   * `suspended` adalah keadaan yang paling menyesatkan di Web Audio: seluruh
   * graf terpasang, tiap parameter benar, tidak ada satu pun error — dan tidak
   * ada suara. Kebijakan autoplay browser bisa mengembalikannya ke sana kapan
   * saja (tab disembunyikan, perangkat keluaran berganti), jadi keadaannya
   * dibaca ULANG, bukan diasumsikan dari keberhasilan pembangunan.
   */
  get running(): boolean {
    return this.ctx.state === 'running';
  }

  /** Coba bangunkan lagi. Aman dipanggil berkali-kali. */
  resume(): void {
    void this.ctx.resume().catch(() => undefined);
  }

  /** Posisi SOURCE (sample) yang benar-benar terdengar, atau `null` kalau diam. */
  positionSamples(id: DeckId): number | null {
    const p = this.graph.channels[id].player;
    if (!p.hasBuffer) return null;
    return p.positionAt(this.ctx.currentTime);
  }

  /**
   * Jadwalkan klik metronom untuk deck yang sedang disunting grid-nya.
   *
   * Dipanggil TIAP FRAME dari `useDjAudio`, bukan dari `apply`: `apply` hanya
   * berjalan saat store berubah, dan penjadwalan yang menunggu store berubah
   * akan berhenti persis saat tidak ada yang menyentuh kontrol — yaitu saat
   * orang sedang mendengarkan.
   */
  tickMetronome(s: DjState): void {
    const id = s.gridEdit.deck;
    if (id === null || s.gridEdit.metroLevel === 0) {
      this.metronome.setLevel(0);
      return;
    }

    const level = s.gridEdit.metroLevel;
    const deck = s.decks[id];
    const asset = deck.assetId === null ? undefined : studioStore.getState().assets[deck.assetId];
    const grid = asset === undefined ? null : resolveBeatGrid(asset);
    const player = this.graph.channels[id].player;
    const pos = this.positionSamples(id);

    if (grid === null || pos === null || !deck.playing) {
      // Deck diam atau tanpa grid: tidak ada yang perlu diaudit, dan klik yang
      // berjalan sendiri di atas lagu yang berhenti hanya membingungkan.
      this.metronome.setLevel(level);
      this.metronome.reset();
      return;
    }

    this.metronome.schedule({
      grid,
      level,
      positionSamples: pos,
      rate: player.playbackRate,
      sampleRate: player.sampleRate,
      now: this.ctx.currentTime,
    });
  }

  /** Peak linear 0..1 dari analyser. Dipakai meter; nol berarti benar-benar nol. */
  peak(which: DeckId | 'master'): number {
    const an = which === 'master' ? this.graph.masterAnalyser : this.graph.channels[which].analyser;
    an.getFloatTimeDomainData(this.peakBuf);
    let max = 0;
    for (let i = 0; i < this.peakBuf.length; i += 1) {
      const v = Math.abs(this.peakBuf[i] ?? 0);
      if (v > max) max = v;
    }
    return max;
  }

  /**
   * Terapkan seluruh state ke graf.
   *
   * Transport hanya bereaksi pada TRANSISI (`snapshot` dibandingkan dengan yang
   * terakhir diterapkan), bukan pada tiap perubahan state. Kalau ia bereaksi
   * pada `playhead`, setiap kiriman jam akan menjadwalkan ulang source dan yang
   * terdengar hanya deretan klik — persis peringatan di kepala
   * `usePreviewPlayback`.
   */
  apply(s: DjState, cueMonitored: boolean): void {
    const now = this.ctx.currentTime;

    for (const id of DECK_IDS) {
      const deck = s.decks[id];
      const player = this.graph.channels[id].player;
      const prev = this.last[id];
      const next = snapshotOf(deck);

      if (next.assetId !== prev.assetId) {
        player.load(next.assetId === null ? null : (getBuffer(next.assetId) ?? null), deck.playhead);
      }

      if (next.rate !== prev.rate) player.setRate(next.rate);

      if (next.loopKey !== prev.loopKey) {
        const len = loopLen(deck.loop);
        player.setLoop(
          deck.loop.active && len !== null && deck.loop.inAt !== null && deck.loop.outAt !== null
            ? { inAt: deck.loop.inAt, outAt: deck.loop.outAt }
            : null,
        );
      }

      if (next.slip !== prev.slip) player.setSlip(next.slip);

      // Lompatan EKSPLISIT: hanya `seekEpoch` yang menandainya.
      if (next.seekEpoch !== prev.seekEpoch && next.assetId !== null) {
        player.seek(deck.playhead);
      }

      if (next.playing !== prev.playing) {
        if (next.playing) player.play(deck.playhead);
        else player.pause();
      }

      this.last[id] = next;
      applyChannel(this.graph.channels[id], s.mixer.channels[id], now);
    }

    // Beat FX. Tempo-nya dari deck TARGET (atau deck master kalau efeknya di
    // master), supaya "1/4 ketukan" berarti 1/4 ketukan LAGU ITU — bukan 1/4
    // ketukan pada 120 BPM, yang jadi satu-satunya jawaban sebelum
    // `fxchain_set_tempo` ada di ABI.
    this.fxSlot.sync(this.graph, s.fx, fxCatalog(), framesPerBeatFor(s), (message) => {
      this.onFxFault?.(message);
    });

    applyCrossfader(this.graph, s.mixer.crossfader, s.mixer.curve, now);
    applyMaster(
      this.graph,
      {
        masterDb: s.mixer.masterDb,
        cueDb: s.mixer.cueDb,
        cueMix: s.mixer.cueMix,
        cueMonitored,
      },
      now,
    );
  }

  /**
   * Arahkan keluaran CUE ke perangkat lain. `null` mematikan monitoring.
   *
   * Mengembalikan alasan kegagalan, atau `null` kalau berhasil. Gain headphone
   * diterapkan ulang di sini supaya perubahannya langsung terdengar tanpa
   * menunggu perubahan state berikutnya.
   */
  async selectCueDevice(deviceId: string | null, s: DjState): Promise<string | null> {
    const err = await this.cue.select(deviceId);
    applyMaster(
      this.graph,
      {
        masterDb: s.mixer.masterDb,
        cueDb: s.mixer.cueDb,
        cueMix: s.mixer.cueMix,
        cueMonitored: this.cue.isMonitoring,
      },
      this.ctx.currentTime,
    );
    return err;
  }

  /** true kalau materi deck ini sudah habis dan tidak sedang loop. */
  reachedEnd(id: DeckId): boolean {
    return this.graph.channels[id].player.reachedEnd(this.ctx.currentTime);
  }

  dispose(): void {
    this.fxSlot.detach();
    disposeGraph(this.graph);
    this.cue.dispose();
  }
}

/**
 * Panjang satu ketukan (frame) untuk unit Beat FX.
 *
 * Diambil dari deck TARGET; kalau efeknya di master, dari deck MASTER — dan
 * kalau tidak ada master, dari deck mana pun yang sedang berbunyi. `null` kalau
 * tidak ada satu pun grid: lebih baik parameter beat tidak diperbarui daripada
 * diperbarui dengan tebakan.
 */
function framesPerBeatFor(s: DjState): number | null {
  const pick: DeckId | null =
    s.fx.target === 'master'
      ? (s.masterDeck ?? DECK_IDS.find((id) => s.decks[id].playing) ?? null)
      : s.fx.target;
  if (pick === null) return null;
  const deck = s.decks[pick];
  if (deck.assetId === null) return null;
  const asset = studioStore.getState().assets[deck.assetId];
  const grid = asset === undefined ? null : resolveBeatGrid(asset);
  if (grid === null) return null;
  const bpm = grid.bpm * tempoRatio(deck.tempo);
  if (!(bpm > 0)) return null;
  return (60 / bpm) * deck.sampleRate;
}

let instance: DjAudio | null = null;
let failure: string | null = null;

/**
 * Bangun lapisan audio kalau belum ada. **Panggil dari handler gestur user.**
 *
 * Mengembalikan `null` kalau lingkungannya tidak punya Web Audio (jsdom, atau
 * browser yang menolak). Itu keadaan yang sah dan dilaporkan lewat
 * `djAudioError()`, bukan dilempar: halaman harus tetap bisa dilihat.
 */
export function ensureDjAudio(): DjAudio | null {
  if (instance !== null) return instance;
  const sr = previewSampleRate() || studioStore.getState().sampleRate;
  const ctx = ensureContext(sr);
  if (ctx === null) {
    failure = 'Web Audio tidak tersedia di lingkungan ini';
    return null;
  }
  try {
    instance = new DjAudio(buildDjGraph(ctx));
    failure = null;
  } catch (err: unknown) {
    failure = err instanceof Error ? err.message : 'gagal membangun graf audio';
    instance = null;
  }
  /*
   * Katalog + worklet FX disiapkan di sini, bukan menunggu panel FX ter-mount:
   * Beat FX harus bisa dipasang bahkan kalau barisnya sedang tidak terlihat.
   *
   * Pemuatannya ASINKRON, jadi `apply()` pertama pasti melihat katalog kosong
   * dan tidak memasang apa pun. Tanpa penerapan ulang di sini, efek yang sudah
   * dipilih user sebelum katalog datang tidak akan pernah terpasang — sampai
   * kebetulan ada perubahan state lain. Itu bug yang muncul sebagai "kadang FX
   * tidak jalan", yaitu bentuk paling sulit dilacak.
   */
  void ensureFxRuntime().then(() => {
    const live = instance;
    if (live !== null) live.apply(djStoreRef.getState(), live.cue.isMonitoring);
  });
  // Context yang lahir `suspended` (kebijakan autoplay) baru berbunyi setelah
  // di-resume; aman dipanggil berkali-kali.
  void ctx.resume().catch(() => undefined);
  return instance;
}

export function djAudio(): DjAudio | null {
  return instance;
}

export function djAudioError(): string | null {
  return failure;
}

/** Hanya untuk tes. */
export function __disposeDjAudioForTest(): void {
  instance?.dispose();
  instance = null;
  failure = null;
}
