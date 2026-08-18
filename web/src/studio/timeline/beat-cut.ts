/**
 * LOOP CUT — memotong clip jadi satu region yang selaras ketukan, lalu
 * mengulanginya.
 *
 * Ditulis sebagai FUNGSI MURNI, bukan langsung di dalam store seperti
 * `splitClipAtPlayhead`. Alasannya konkret: pemotongan ini melintasi dua ruang
 * koordinat (source ↔ timeline) sekaligus membuat beberapa clip baru, dan itu
 * jenis aritmetika yang salahnya tidak kelihatan dari layar — hanya terdengar
 * sebagai loop yang perlahan meleset. Yang seperti itu harus bisa dites tanpa
 * merender apa pun.
 *
 * KEPUTUSAN: pengulangan dibuat sebagai CLIP TERPISAH, bukan field `loopCount`
 * di clip.
 *   - Renderer, export, drag, copy, dan delete semuanya sudah bekerja untuk
 *     clip. Field baru berarti kelima jalur itu harus diajari mengenalinya.
 *   - Tiap pengulangan jadi bisa diedit sendiri: geser satu, hapus satu, ganti
 *     gain satu. Itu justru yang orang lakukan setelah memotong loop.
 *   `Clip.loop_count` di `crates/timeline-core` baru relevan kalau engine Rust
 *   sudah menjadi jalur hidup, dan saat itu ia bisa diturunkan dari deretan ini.
 */

import { timelineLenFor, type Samples, type StudioClip, type StudioLane } from '../model';
import { clampFadeMs } from './fade';

/** Batas atas pengulangan. 64 bar loop 1-bar sudah lebih panjang dari lagunya. */
export const MAX_LOOP_REPEAT = 64;

export interface LoopCutSpec {
  /** Awal region, absolut di SOURCE-space asset. */
  readonly sourceStart: Samples;
  /** Panjang region di SOURCE-space. */
  readonly sourceLen: Samples;
  /** Berapa kali region ini muncul di timeline. 1 = hanya dipotong. */
  readonly repeat: number;
  /**
   * Panjang asset (frames). Region di-clamp ke sini kalau diberikan.
   *
   * Opsional karena bagian ini tidak selalu diketahui pemanggil (clip demo
   * tanpa asset), tapi kalau ada ia WAJIB dipakai: region yang melewati ujung
   * asset menghasilkan `src.start()` yang melempar, dan `graph-builder`
   * menangkap lalu MELEWATI clip itu — clip terlihat ada di layar tapi bisu.
   */
  readonly assetFrames?: Samples;
}

/** Region yang sudah dipastikan sah. Dipisah supaya UI bisa memakainya untuk
 *  pratinjau (menggambar sorotan) dengan angka yang PERSIS sama dengan yang
 *  nanti dipotong. */
export interface ClampedRegion {
  readonly sourceStart: Samples;
  readonly sourceLen: Samples;
  readonly repeat: number;
}

export function clampLoopSpec(spec: LoopCutSpec): ClampedRegion {
  const limit =
    spec.assetFrames !== undefined && spec.assetFrames > 0 ? spec.assetFrames : Number.MAX_SAFE_INTEGER;
  const start = Math.max(0, Math.min(limit - 1, Math.round(spec.sourceStart)));
  const wanted = Math.round(spec.sourceLen);
  const len = Math.max(1, Math.min(limit - start, Number.isFinite(wanted) ? wanted : 1));
  const repeat = Math.max(
    1,
    Math.min(MAX_LOOP_REPEAT, Number.isFinite(spec.repeat) ? Math.round(spec.repeat) : 1),
  );
  return { sourceStart: start, sourceLen: len, repeat };
}

/**
 * Ganti satu clip dengan deretan potongan loop. Clip pertama MEMPERTAHANKAN
 * `id` aslinya supaya seleksi user tidak lompat ke tempat lain setelah memotong.
 *
 * `makeId` disuntikkan (bukan memanggil generator store) supaya fungsi ini
 * tetap murni dan tesnya tidak bergantung pada waktu.
 */
export function applyLoopCut(
  lane: StudioLane,
  clip: StudioClip,
  spec: LoopCutSpec,
  makeId: () => string,
  sampleRate: number,
): StudioClip[] {
  const region = clampLoopSpec(spec);
  // SATU-SATUNYA konversi source→timeline, lewat helper yang sudah ada
  // (`model.ts`). Menuliskan `len / speedRatio` di sini akan jadi rumus kedua
  // yang bisa berbeda diam-diam dari yang dipakai `setLaneSpeed`.
  const tlLen = timelineLenFor(region.sourceLen, lane.speedRatio);

  const out: StudioClip[] = [];
  for (let i = 0; i < region.repeat; i++) {
    const base: StudioClip = {
      ...clip,
      id: i === 0 ? clip.id : makeId(),
      start: clip.start + i * tlLen,
      len: tlLen,
      sourceStart: region.sourceStart,
      sourceLen: region.sourceLen,
      // Fade hanya di potongan PERTAMA. Kalau tiap pengulangan ikut membawa
      // fade-out clip asal, tiap sambungan loop akan melubang — persis cacat
      // yang membuat loop terdengar "berdenyut" dan bukan mengulang.
      fadeInMs: i === 0 ? clip.fadeInMs : 0,
      fadeOutMs: i === 0 ? clip.fadeOutMs : 0,
      seed: clip.seed + i,
    };
    if (i === 0) {
      // Region baru bisa jauh lebih pendek dari clip asal, dan fade lama bisa
      // lebih panjang darinya.
      out.push({
        ...base,
        fadeInMs: clampFadeMs(base, 'in', base.fadeInMs, sampleRate),
        fadeOutMs: clampFadeMs(base, 'out', base.fadeOutMs, sampleRate),
      });
    } else {
      out.push(base);
    }
  }
  return out;
}
