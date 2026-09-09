/**
 * PEMBANGUN GRAF WEB AUDIO — SATU-SATUNYA tempat susunan node dibuat.
 *
 * Kenapa file ini dipisah dari `audio-preview.ts`: sejak export offline ada,
 * ADA DUA yang perlu merakit graf yang sama — preview realtime (`AudioContext`)
 * dan bounce (`OfflineAudioContext`). docs/03 memperingatkan tepat pada titik
 * ini: begitu ada dua jalur render, yang terdengar dan yang ter-export bisa
 * berbeda tanpa ada yang menyadarinya. Karena itu keduanya WAJIB memanggil
 * `buildProjectGraph()` di sini; tidak boleh ada implementasi kedua untuk gain,
 * EQ, fade, atau speed.
 *
 * Parameternya `BaseAudioContext` (bukan `AudioContext`) justru supaya
 * `OfflineAudioContext` masuk tanpa cabang khusus.
 *
 * Rantai per lane (urutan mengikuti signal flow docs/07):
 *   [stem] → clip gain (+fade) → EQ band 1..n → lane gain → destination
 *
 * Blok `[stem]` hanya ada kalau clip-nya benar-benar membuang sesuatu
 * (`isStemBypass`). Clip biasa tidak boleh membayar dua puluh node Web Audio
 * untuk pemrosesan yang hasilnya identik dengan tidak memproses apa pun —
 * dan karena rantai itu memang transparan saat bypass, melewatinya tidak
 * mengubah apa yang terdengar sedikit pun.
 */

import {
  DEFAULT_FADE_CURVE,
  effectiveSpeed,
  isAudible,
  isStemBypass,
  type EqSettings,
  type Samples,
  type StudioClip,
  type StudioLane,
  type StudioState,
} from '../model';
import { activeLoopLen, loopSourceOffset } from '../timeline/clip-loop';
import { createFxNode } from './fx-node';
import { fadeCurveArray, fadeOutGain } from '../timeline/fade';
import { stemOf } from '../timeline/stem';
import { buildStemChain, type StemNodes } from './stem-chain';
import type { ScnetStem } from '../../proof-stem/scnet-separate';
import type { AutoStemAudio, AutoStemMask } from '../../stem/auto-stem';

/** Ramp pendek supaya perubahan parameter tidak menimbulkan klik. */
export const PARAM_RAMP_SEC = 0.02;

/** Jumlah titik kurva yang dikirim ke `setValueCurveAtTime`. 128 titik untuk
 *  fade sepanjang detik sudah jauh di bawah ambang terdengarnya tangga. */
export const FADE_CURVE_POINTS = 128;

export function dbToLin(db: number): number {
  return db <= -60 ? 0 : 10 ** (db / 20);
}

/**
 * Node per lane yang masih hidup, supaya EQ dan fader bisa diubah SAAT
 * BERBUNYI tanpa menjadwalkan ulang apa pun.
 */
export interface LaneNodes {
  /** Satu filter per band, urutan SAMA dengan `lane.eq.bands` — itu yang
   *  membuat update parameter bisa dilakukan by-index tanpa mencari-cari. */
  readonly filters: BiquadFilterNode[];
  readonly gain: GainNode;
  /** Node `daw-fx` lane, kalau chain-nya tidak kosong dan runtime siap. */
  readonly fx: AudioWorkletNode | null;
}

export interface BuiltGraph {
  readonly lanes: Map<string, LaneNodes>;
  /**
   * clipId → node stem, untuk clip yang punya rantai. Ada supaya slider REMOVE
   * bisa diubah SAAT BERBUNYI lewat `updateStemNodes`, sama seperti EQ lane —
   * membangun ulang graf tiap gerakan slider hanya menghasilkan deretan klik.
   */
  readonly clipStems: Map<string, StemNodes>;
  /** Clip yang memakai output SCNet asli, bukan fallback mid/side. */
  readonly clipMlStems: Map<string, MlStemNodes>;
  /** Node `daw-fx` master, kalau ada. */
  readonly masterFx: AudioWorkletNode | null;
  /** clipId → node `daw-fx` clip, untuk clip yang punya chain. */
  readonly clipFx: Map<string, AudioWorkletNode>;
  /**
   * Penanda tiap hal yang BENAR-BENAR diterapkan graf ini.
   *
   * Ada untuk satu tujuan: dibandingkan dengan penanda yang sama dari
   * `buildExportPayload`. Perbandingan sample tidak mungkin (biquad Web Audio
   * dan Rust bukan implementasi yang sama, dan Node tidak punya Web Audio),
   * tapi "apa yang diterapkan" bisa dibandingkan — dan itu sudah cukup untuk
   * menangkap satu-satunya kelas kegagalan yang pernah benar-benar terjadi di
   * sini: sebuah field yang dipakai preview dan tidak pernah dikirim ke export.
   */
  readonly features: ReadonlySet<string>;
  /** Source yang sudah di-`start()`; perlu di-`stop()` saat preview berhenti. */
  readonly voices: AudioBufferSourceNode[];
  /** Node non-source (gain, filter) — perlu di-disconnect saat berhenti. */
  readonly nodes: AudioNode[];
}

export interface MlStemNodes {
  readonly gains: Readonly<Record<ScnetStem, GainNode>>;
  readonly all: readonly AudioNode[];
}

export interface GraphBuildOptions {
  /** Posisi awal di TIMELINE (detik) yang dipetakan ke `startAt`. */
  readonly playheadSec: number;
  /** Waktu konteks (detik) tempat `playheadSec` jatuh. Offline: 0. */
  readonly startAt: number;
  /** PCM per asset. Clip tanpa buffer dilewati (clip demo tanpa audio nyata). */
  readonly getBuffer: (assetId: number) => AudioBuffer | undefined;
  /** Output SCNet runtime. Tidak diisi oleh export, jadi compile tetap deterministik. */
  readonly getSeparated?: (assetId: number) => AutoStemAudio | undefined;
  readonly getStemMask?: (clipId: string) => AutoStemMask;
  /** Default `audio.destination`. */
  readonly destination?: AudioNode;
  /**
   * Clip yang sedang DIAUDISI dan karenanya dilewati di mix utama.
   *
   * Lewat opsi dan bukan dibaca dari `state`, supaya jalur EXPORT tidak mungkin
   * ikut terpengaruh: `run-export` tidak pernah mengisinya, jadi file hasil
   * compile tidak akan pernah kehilangan satu clip hanya karena user lupa
   * mematikan audisi.
   */
  readonly skipClipId?: string;
}

interface EnvelopeTiming {
  readonly startAt: number;
  readonly wallDurationSec: number;
  readonly transportSpeed: number;
  /** Sudah berapa detik (timeline) clip ini berjalan saat play ditekan. */
  readonly clipElapsedSec: number;
}

/**
 * Rantai EQ parametrik lane: satu BiquadFilterNode per band, dirangkai
 * berurutan lalu masuk ke `output`. Elemen pertama adalah MASUKAN rantai.
 *
 * Band dengan 0 dB tetap dibuat supaya rantainya seragam dan indeksnya cocok
 * satu-satu dengan `lane.eq.bands` — itulah yang membuat update parameter live
 * cukup mengubah nilai dan tidak pernah menambah/menghapus node.
 */
export function buildEqChain(
  audio: BaseAudioContext,
  eq: EqSettings,
  output: AudioNode,
): BiquadFilterNode[] {
  const filters = eq.bands.map((band) => {
    const f = audio.createBiquadFilter();
    f.type = band.kind;
    f.frequency.value = band.freq;
    f.Q.value = band.q;
    f.gain.value = band.gainDb;
    return f;
  });

  for (let i = 0; i < filters.length; i++) {
    const next = filters[i + 1] ?? output;
    filters[i]!.connect(next);
  }
  return filters;
}

/**
 * Gain clip + fade in/out sebagai otomasi pada satu GainNode.
 *
 * Kasus yang mudah salah: render/play dimulai di TENGAH fade-in. Kalau kita
 * selalu mulai dari 0, potongan yang seharusnya sudah keras akan terdengar
 * mengecil lagi. Karena itu kurva yang dijadwalkan adalah POTONGAN SISA-nya
 * (`from = elapsed/fadeIn`), bukan kurva penuh dari nol. Ini juga yang membuat
 * render bersegmen aman: segmen kedua menyambung di nilai yang benar.
 *
 * Kurvanya dikirim lewat `setValueCurveAtTime`, bukan `linearRampToValueAtTime`:
 * equal-power berbentuk sin/cos dan tidak bisa dinyatakan sebagai ramp lurus
 * sama sekali. Linear pun lewat jalur yang sama supaya hanya ada satu perilaku
 * penjadwalan yang perlu dipahami.
 */
export function applyClipGainEnvelope(
  gain: GainNode,
  clip: StudioClip,
  t: EnvelopeTiming,
): void {
  const target = dbToLin(clip.gainDb);
  const { startAt, wallDurationSec, transportSpeed, clipElapsedSec } = t;
  // Durasi fade disimpan di waktu TIMELINE; jadwal Web Audio memakai jam
  // dinding. Transport 2× membuat fade 4 detik selesai dalam 2 detik nyata.
  const fadeInSec = clip.fadeInMs / 1000 / transportSpeed;
  const fadeOutSec = clip.fadeOutMs / 1000 / transportSpeed;
  const elapsedWall = clipElapsedSec / transportSpeed;
  const curve = clip.fadeCurve === 'linear' ? 'linear' : DEFAULT_FADE_CURVE;

  gain.gain.cancelScheduledValues(0);

  // ── Fade in ──
  // Sisa fade-out juga dihitung dulu: kalau fade-in dan fade-out sampai
  // bersentuhan, jadwal keduanya tidak boleh tumpang tindih — `setValueCurve`
  // melempar NotSupportedError kalau ada event lain di dalam rentangnya, dan
  // exception itu akan membunuh penjadwalan clip-clip berikutnya.
  const outLen = fadeOutSec > 0 ? Math.min(fadeOutSec, wallDurationSec) : 0;
  const outStart = wallDurationSec > 0 && outLen > 0 ? startAt + (wallDurationSec - outLen) : Infinity;

  const inRemaining = Math.min(fadeInSec - elapsedWall, outStart - startAt);
  if (fadeInSec > 0 && inRemaining > 0) {
    const from = Math.max(0, Math.min(1, elapsedWall / fadeInSec));
    const to = Math.min(1, from + inRemaining / fadeInSec);
    // TIDAK ada setValueAtTime di titik yang sama: kurva sudah dimulai dari
    // nilai yang benar, dan event tambahan di `startAt` justru bentrok.
    gain.gain.setValueCurveAtTime(
      fadeCurveArray(curve, 'in', target, FADE_CURVE_POINTS, from, to),
      startAt,
      inRemaining,
    );
  } else {
    gain.gain.setValueAtTime(target, startAt);
  }

  // ── Fade out ──
  if (outLen > 0) {
    // Fade out bisa SUDAH berjalan saat mulai (playhead di dalamnya): yang
    // dijadwalkan hanya sisanya, mulai dari posisi yang tepat.
    const from = 1 - outLen / fadeOutSec;
    if (outStart > startAt && !(fadeInSec > 0 && inRemaining > 0)) {
      // Tahan nilai penuh sampai fade-out mulai; tanpa ini titik otomasi
      // terakhir tertarik lebih awal dan seluruh clip ikut meredup.
      gain.gain.setValueAtTime(target * fadeOutGain(curve, from), Math.max(0, outStart - 1e-4));
    }
    gain.gain.setValueCurveAtTime(
      fadeCurveArray(curve, 'out', target, FADE_CURVE_POINTS, from, 1),
      outStart,
      outLen,
    );
  }
}

/**
 * Rakit SELURUH project menjadi graf Web Audio pada `audio`.
 *
 * `speed` (transport) diterapkan sebagai `playbackRate` DAN sebagai pembagi
 * waktu jadwal: clip yang mulai 10 detik lagi pada speed 2× harus berbunyi 5
 * detik lagi. `lane.speedRatio` selain itu juga mengubah RUANG WAKTU source:
 * satu detik timeline memakan `speedRatio` detik buffer.
 */
export function buildProjectGraph(
  audio: BaseAudioContext,
  state: StudioState,
  opts: GraphBuildOptions,
): BuiltGraph {
  const lanesOut = new Map<string, LaneNodes>();
  const features = new Set<string>();
  const clipStems = new Map<string, StemNodes>();
  const clipMlStems = new Map<string, MlStemNodes>();
  const clipFx = new Map<string, AudioWorkletNode>();
  const voices: AudioBufferSourceNode[] = [];
  const nodes: AudioNode[] = [];

  const sr = state.sampleRate;
  const speed = state.speed;
  const { playheadSec, startAt } = opts;
  const rawDestination = opts.destination ?? audio.destination;

  // Chain master disisipkan SEBELUM tujuan akhir, jadi seluruh lane melewatinya
  // — urutan yang sama dengan `build_plan` di Rust (master chain berjalan
  // setelah semua bus dijumlahkan, sebelum fader master).
  state.masterChain.forEach((fx, i) => features.add(`masterFx:${i}:${fx.kind}`));
  const masterFx = createFxNode(audio, state.masterChain);
  if (masterFx !== null) {
    masterFx.connect(rawDestination);
    nodes.push(masterFx);
  }
  const destination: AudioNode = masterFx ?? rawDestination;

  for (const lane of state.lanes) {
    if (!isAudible(lane, state.lanes)) continue;
    // Kecepatan efektif = kecepatan lane × transport (docs/07 §8d).
    const rate = effectiveSpeed(lane, speed);
    const laneRatio = lane.speedRatio;

    const laneGainNode = audio.createGain();
    laneGainNode.gain.value = dbToLin(lane.gainDb);
    // Urutan mengikuti docs/07 dan `build_plan`: EQ bawaan dulu, baru insert
    // chain user, baru fader lane. Menukarnya membuat preview dan file hasil
    // export terdengar berbeda untuk chain yang sama.
    features.add(`laneGain:${lane.id}`);
    if (lane.eq.bands.length > 0) features.add(`eq:${lane.id}`);
    lane.chain.forEach((fx, i) => features.add(`fx:${lane.id}:${i}:${fx.kind}`));
    const laneFx = createFxNode(audio, lane.chain);
    const afterEq: AudioNode = laneFx ?? laneGainNode;
    if (laneFx !== null) {
      laneFx.connect(laneGainNode);
      nodes.push(laneFx);
    }
    const filters = buildEqChain(audio, lane.eq, afterEq);
    laneGainNode.connect(destination);
    nodes.push(laneGainNode, ...filters);
    lanesOut.set(lane.id, { filters, gain: laneGainNode, fx: laneFx });
    // Lane tanpa band sama sekali tetap harus berbunyi: masuk langsung ke
    // chain FX kalau ada, atau ke fader.
    const eqInput: AudioNode = filters[0] ?? afterEq;

    for (const clip of lane.clips) {
      // Clip yang sedang diaudisi berbunyi dari pemutar audisi, bukan dari
      // sini — kalau tidak, ia terdengar dua kali dari dua posisi berbeda.
      if (clip.id === opts.skipClipId) continue;
      const buffer = opts.getBuffer(clip.assetId);
      if (buffer === undefined) continue; // clip demo tanpa PCM asli — dilewati

      const clipStartSec = clip.start / sr;
      const clipEndSec = (clip.start + clip.len) / sr;
      if (clipEndSec <= playheadSec) continue; // sudah lewat

      // Offset di dalam source kalau playhead jatuh di tengah clip.
      // KONVERSI RUANG: `intoClipSec` diukur di TIMELINE, tapi `offset` dan
      // `duration` milik AudioBufferSourceNode diukur di SOURCE (waktu buffer).
      // Clip 2× lebih cepat berarti tiap detik timeline memakan dua detik
      // source — mengabaikan ini membuat clip mulai dari titik yang salah dan
      // berhenti terlalu cepat/lambat.
      const intoClipSec = Math.max(0, playheadSec - clipStartSec);
      const loopLen = activeLoopLen(clip);
      // Clip yang LOOP membaca materinya melingkar: titik masuknya modulo
      // panjang putaran, bukan jarak lurus dari awal clip. Lihat
      // `timeline/clip-loop.ts` — konversi timeline->source-nya sama persis
      // dengan cabang lurus di bawah, hanya sisanya yang diambil.
      const offsetSec =
        loopLen === null
          ? clip.sourceStart / sr + intoClipSec * laneRatio
          : loopSourceOffset(clip, loopLen, intoClipSec * laneRatio * sr) / sr;
      const remainingTimelineSec = clipEndSec - Math.max(playheadSec, clipStartSec);
      if (remainingTimelineSec <= 0) continue;
      const remainingSec = remainingTimelineSec * laneRatio;

      const whenSec = startAt + Math.max(0, clipStartSec - playheadSec) / speed;

      const configureSource = (src: AudioBufferSourceNode, sourceBuffer: AudioBuffer): void => {
        src.buffer = sourceBuffer;
        src.playbackRate.value = rate;
        if (loopLen === null) return;
        // Pengulangan diserahkan ke Web Audio, alasan yang sama dengan pemutar
        // audisi di bawah: `loop` menyambung akurat per-sample, sedangkan
        // menjadwalkan satu voice per putaran menumpuk galat dan terdengar
        // sebagai klik di tiap sambungan.
        //
        // `duration` di `src.start()` TIDAK ikut berubah: untuk source yang
        // loop, ia menghitung total materi yang diputar (sudah termasuk
        // putaran), jadi angka yang sama tetap berarti "sampai clip habis".
        src.loop = true;
        src.loopStart = clip.sourceStart / sr;
        src.loopEnd = Math.min(sourceBuffer.duration, (clip.sourceStart + loopLen) / sr);
      };

      const gain = audio.createGain();
      features.add(`clipGain:${clip.id}`);
      if (clip.fadeInMs > 0 || clip.fadeOutMs > 0) features.add(`fade:${clip.id}`);
      applyClipGainEnvelope(gain, clip, {
        startAt: whenSec,
        // Durasi di JAM DINDING, bukan timeline: transport 2× membuat clip
        // 10 detik selesai dalam 5 detik nyata, jadi fade-nya juga separuh.
        wallDurationSec: remainingTimelineSec / speed,
        transportSpeed: speed,
        clipElapsedSec: intoClipSec,
      });

      // Stem SEBELUM gain clip: pembuangan stem membentuk MATERI-nya, sedangkan
      // gain + fade adalah level akhir clip itu. Menaruh fade di dalam rantai
      // stem berarti kurvanya ikut difilter dan dijumlahkan tiga kali.
      const stem = stemOf(clip);
      const separated = opts.getSeparated?.(clip.assetId);
      const mlMask = opts.getStemMask?.(clip.id);
      const mlActive = separated !== undefined && mlMask !== undefined &&
        Object.values(mlMask).some((enabled) => !enabled);
      let head: AudioNode = gain;
      if (!mlActive && !isStemBypass(clip.stem)) {
        features.add(`stem:${clip.id}`);
        const chain = buildStemChain(audio, stem);
        chain.output.connect(gain);
        clipStems.set(clip.id, chain);
        nodes.push(...chain.all);
        head = chain.input;
      }

      // Insert chain CLIP: sesudah gain + fade, sebelum EQ lane. Urutan yang
      // sama dengan `build_plan` di Rust — chain tidak pernah melihat
      // diskontinuitas tepi clip, yang akan membuat FILTER resonan berdenging.
      //
      // Penanda fiturnya sengaja ditulis DI SINI, bukan di dekat penanda
      // lain di atas: versi sebelumnya menandai `clipFx:` tanpa pernah
      // membangun node-nya, dan penanda yang berbohong itu justru membuat
      // guard paritas lulus sementara efek clip tidak pernah berbunyi.
      const clipNode = createFxNode(audio, clip.chain);
      if (clipNode !== null) {
        clip.chain.forEach((fx, i) => features.add(`clipFx:${clip.id}:${i}:${fx.kind}`));
        gain.connect(clipNode);
        clipNode.connect(eqInput);
        clipFx.set(clip.id, clipNode);
        nodes.push(clipNode);
      } else {
        gain.connect(eqInput);
      }
      if (mlActive && separated !== undefined && mlMask !== undefined) {
        const stemIds: readonly ScnetStem[] = ['vocals', 'drums', 'bass', 'other'];
        const gains = {} as Record<ScnetStem, GainNode>;
        const mlNodes: AudioNode[] = [];
        for (const id of stemIds) {
          const stemGain = audio.createGain();
          stemGain.gain.value = mlMask[id] ? 1 : 0;
          stemGain.connect(gain);
          gains[id] = stemGain;
          mlNodes.push(stemGain);

          const source = audio.createBufferSource();
          configureSource(source, separated.stems[id]);
          source.connect(stemGain);
          try {
            source.start(whenSec, offsetSec, remainingSec);
          } catch {
            source.disconnect();
            continue;
          }
          voices.push(source);
        }
        features.add(`scnet:${clip.id}`);
        clipMlStems.set(clip.id, { gains, all: mlNodes });
        nodes.push(...mlNodes);
      } else {
        const src = audio.createBufferSource();
        configureSource(src, buffer);
        src.connect(head);
        try {
          src.start(whenSec, offsetSec, remainingSec);
        } catch {
          continue; // offset di luar buffer — lewati, jangan bunuh yang lain
        }
        voices.push(src);
      }
      nodes.push(gain);
    }
  }

  return { lanes: lanesOut, clipStems, clipMlStems, clipFx, masterFx, features, voices, nodes };
}

// ── Pemutar audisi ───────────────────────────────────────────────────────────

export interface AuditionBuildOptions {
  readonly lane: StudioLane;
  readonly clip: StudioClip;
  readonly buffer: AudioBuffer;
  /** Region yang diulang, SOURCE-space absolut di asset. */
  readonly sourceStart: Samples;
  readonly sourceLen: Samples;
  readonly sampleRate: number;
  /** Kecepatan transport, dikalikan dengan `lane.speedRatio`. */
  readonly transportSpeed: number;
  readonly startAt: number;
  readonly destination: AudioNode;
}

export interface AuditionVoice {
  readonly source: AudioBufferSourceNode;
  readonly stem: StemNodes | null;
  readonly gain: GainNode;
  readonly filters: BiquadFilterNode[];
  readonly laneGain: GainNode;
  /** Node `daw-fx` lane dan clip, kalau chain-nya tidak kosong. */
  readonly laneFx: AudioWorkletNode | null;
  readonly clipFx: AudioWorkletNode | null;
  /** Semua node, untuk di-disconnect saat audisi berhenti. */
  readonly nodes: AudioNode[];
  /** Waktu konteks saat sample pertama region keluar. */
  readonly startAt: number;
  readonly loopStartSec: number;
  readonly loopEndSec: number;
  /** Detik SOURCE yang dilewati per detik jam dinding. */
  readonly rate: number;
}

/**
 * Pemutar KEDUA: satu region, berulang, berjalan berdampingan dengan timeline.
 *
 * Bukan bagian dari `buildProjectGraph` karena hidupnya memang berbeda — ia
 * menyala dan mati lewat tombol LOOP PLAY, bukan lewat transport, dan tetap
 * berbunyi saat transport berhenti. Menyatukannya berarti setiap perubahan
 * kecil pada audisi menjadwalkan ulang seluruh project.
 *
 * Rantainya SAMA dengan clip biasa (stem → gain → EQ lane → fader lane) supaya
 * yang didengar saat audisi adalah suara yang sama dengan yang akan keluar dari
 * mix — kecuali dua hal yang sengaja beda:
 *
 *  - MUTE/SOLO DILEWATI. LOOP PLAY perintah eksplisit atas satu clip; tombol
 *    yang diam karena lane-nya kebetulan di-mute lebih membingungkan daripada
 *    tombol yang sementara mengabaikan setelan mix.
 *  - TANPA FADE. Kurva fade clip hanya akan berbunyi di putaran pertama, jadi
 *    putaran ke-2 dan seterusnya terdengar berbeda tanpa sebab yang terlihat.
 *    Gain clip tetap dipakai — itu level, bukan bentuk.
 */
export function buildAuditionVoice(
  audio: BaseAudioContext,
  o: AuditionBuildOptions,
): AuditionVoice | null {
  const sr = o.sampleRate;
  const loopStartSec = o.sourceStart / sr;
  const loopEndSec = (o.sourceStart + o.sourceLen) / sr;
  if (!(loopEndSec > loopStartSec)) return null;

  const nodes: AudioNode[] = [];
  const laneGain = audio.createGain();
  laneGain.gain.value = dbToLin(o.lane.gainDb);
  // Audisi HARUS memakai rantai yang sama dengan pemutar utama. Kalau tidak,
  // loop region terdengar berbeda dari lagunya sendiri — dan bedanya persis
  // efek yang barusan dipasang user.
  const laneFx = createFxNode(audio, o.lane.chain);
  const afterEq: AudioNode = laneFx ?? laneGain;
  if (laneFx !== null) {
    laneFx.connect(laneGain);
    nodes.push(laneFx);
  }
  const filters = buildEqChain(audio, o.lane.eq, afterEq);
  laneGain.connect(o.destination);
  nodes.push(laneGain, ...filters);
  const eqInput: AudioNode = filters[0] ?? afterEq;

  const gain = audio.createGain();
  gain.gain.value = dbToLin(o.clip.gainDb);
  const clipFxNode = createFxNode(audio, o.clip.chain);
  if (clipFxNode !== null) {
    gain.connect(clipFxNode);
    clipFxNode.connect(eqInput);
    nodes.push(clipFxNode);
  } else {
    gain.connect(eqInput);
  }
  nodes.push(gain);

  let stem: StemNodes | null = null;
  let head: AudioNode = gain;
  if (!isStemBypass(o.clip.stem)) {
    stem = buildStemChain(audio, stemOf(o.clip));
    stem.output.connect(gain);
    nodes.push(...stem.all);
    head = stem.input;
  }

  const rate = effectiveSpeed(o.lane, o.transportSpeed);
  const source = audio.createBufferSource();
  source.buffer = o.buffer;
  source.playbackRate.value = rate;
  // Pengulangan diserahkan ke Web Audio, bukan dijadwalkan sendiri: `loop`
  // menyambung akurat per-sample dan tidak pernah menumpuk galat, sedangkan
  // menjadwalkan ulang tiap putaran terdengar sebagai klik di tiap sambungan.
  source.loop = true;
  source.loopStart = loopStartSec;
  source.loopEnd = loopEndSec;
  source.connect(head);
  try {
    source.start(o.startAt, loopStartSec);
  } catch {
    for (const n of nodes) n.disconnect();
    return null;
  }
  nodes.push(source);

  return {
    source,
    stem,
    gain,
    filters,
    laneGain,
    laneFx,
    clipFx: clipFxNode,
    nodes,
    startAt: o.startAt,
    loopStartSec,
    loopEndSec,
    rate,
  };
}
