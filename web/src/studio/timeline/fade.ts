/**
 * Matematika fade clip — SATU sumber bentuk kurva untuk ketiga konsumennya:
 * panel Clip Detail (gambar), overlay clip di timeline (gambar), dan
 * `applyClipGainEnvelope` (suara). Kalau salah satunya punya rumus sendiri,
 * yang terlihat dan yang terdengar akan berbeda tanpa ada yang menyadarinya.
 *
 * KENAPA ADA DUA KURVA. Fade dipakai user untuk dua hal yang berbeda:
 *
 *   - `linear`     : turun lurus ke nol. Benar untuk fade tunggal ke SUNYI —
 *                    tidak ada apa pun yang harus mengisi kekosongannya.
 *   - `equalPower` : gain mengikuti sin/cos posisi. Benar untuk TRANSISI antar
 *                    lagu. Dua fade linear yang saling silang menjumlahkan
 *                    AMPLITUDO, dan karena loudness yang dipersepsi mengikuti
 *                    DAYA (kuadrat amplitudo), di tengah transisi dayanya jadi
 *                    2×0.5² = 0.5 — turun ~3 dB, terdengar sebagai lubang.
 *                    Dengan sin/cos, sin²+cos² = 1 di setiap titik, jadi daya
 *                    total konstan dan transisinya rata. Itu sebabnya default
 *                    clip baru adalah equalPower.
 */

import type { FadeCurve, Samples, StudioClip } from '../model';
import { DEFAULT_FADE_CURVE } from '../model';

/**
 * Gain fade-IN pada posisi `t` (0 = awal fade, 1 = akhir fade).
 * Dijamin tepat 0 di t=0 dan tepat 1 di t=1 untuk KEDUA kurva — nilai
 * "hampir 0" di ujung fade-out akan terdengar sebagai ekor yang tidak pernah
 * benar-benar diam.
 */
export function fadeInGain(curve: FadeCurve, t: number): number {
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
  if (x === 0) return 0;
  if (x === 1) return 1;
  return curve === 'equalPower' ? Math.sin((x * Math.PI) / 2) : x;
}

/** Gain fade-OUT pada posisi `t` (0 = awal fade, 1 = akhir fade = sunyi). */
export function fadeOutGain(curve: FadeCurve, t: number): number {
  return fadeInGain(curve, 1 - t);
}

/**
 * Deret gain untuk `setValueCurveAtTime`. `linearRampToValueAtTime` hanya bisa
 * garis lurus, jadi equal-power WAJIB lewat jalur array ini.
 *
 * `from`/`to` memotong kurva: saat play ditekan di TENGAH fade, yang dikirim
 * bukan kurva penuh melainkan sisanya, supaya gain tidak melompat mundur.
 */
export function fadeCurveArray(
  curve: FadeCurve,
  direction: 'in' | 'out',
  peak: number,
  points = 128,
  from = 0,
  to = 1,
): Float32Array {
  const n = Math.max(2, Math.round(points));
  const out = new Float32Array(n);
  const g = direction === 'in' ? fadeInGain : fadeOutGain;
  for (let i = 0; i < n; i++) {
    const t = from + ((to - from) * i) / (n - 1);
    out[i] = peak * g(curve, t);
  }
  return out;
}

// ── Konversi satuan ─────────────────────────────────────────────────────────
// Fade disimpan dalam MILIDETIK (bentuk lama, ikut tersimpan di project user),
// tapi ditampilkan dan diedit dalam DETIK: transisi lagu berukuran 4–16 detik
// dan tidak ada yang mencarinya dengan mengetik angka ribuan.

export const msToSec = (ms: number): number => ms / 1000;
export const secToMs = (sec: number): number => sec * 1000;

/** Panjang fade dalam sample pada sample rate project. */
export function fadeSamples(ms: number, sampleRate: number): Samples {
  return Math.max(0, Math.round((ms / 1000) * sampleRate));
}

/** Kebalikannya — dipakai saat membandingkan fade dengan panjang clip. */
export function samplesToFadeMs(samples: Samples, sampleRate: number): number {
  return sampleRate > 0 ? (samples / sampleRate) * 1000 : 0;
}

export type FadeSide = 'in' | 'out';

/**
 * Batasi durasi fade agar sah: tidak negatif, tidak melebihi panjang clip, dan
 * TIDAK menabrak fade di sisi seberang.
 *
 * Yang dikorbankan selalu fade yang sedang di tangan user (`side`), bukan yang
 * satunya: kalau kita malah memendekkan fade seberang, user melihat nilai yang
 * tidak ia sentuh ikut berubah saat drag — perilaku yang tidak bisa ia batalkan
 * dengan melepas pointer.
 */
export function clampFadeMs(
  clip: Pick<StudioClip, 'len' | 'fadeInMs' | 'fadeOutMs'>,
  side: FadeSide,
  wantedMs: number,
  sampleRate: number,
): number {
  const clipMs = samplesToFadeMs(clip.len, sampleRate);
  const otherMs = Math.max(0, side === 'in' ? clip.fadeOutMs : clip.fadeInMs);
  const headroom = Math.max(0, clipMs - Math.min(otherMs, clipMs));
  const wanted = Number.isFinite(wantedMs) ? wantedMs : 0;
  return Math.max(0, Math.min(headroom, wanted));
}

/** Preset panjang transisi (detik). Rentang khas DJ: dari cut pendek 1 detik
 *  sampai blend 16 detik yang hampir tidak terdengar sebagai perpindahan. */
export const FADE_PRESET_SEC = [1, 2, 4, 8, 16] as const;

/**
 * Lengkapi clip dari project LAMA yang belum punya `fadeCurve`.
 *
 * Wajib ada tersendiri (bukan sekadar `?? default` di tempat pakai): field yang
 * hilang akan sampai ke store sebagai `undefined` dan ikut tersimpan lagi apa
 * adanya, jadi kalau tidak dinormalkan sekali di pintu masuk, nilai rusaknya
 * bertahan selamanya.
 */
export function normalizeClipFade(clip: StudioClip): StudioClip {
  const curve: FadeCurve = clip.fadeCurve === 'linear' ? 'linear' : DEFAULT_FADE_CURVE;
  const fadeInMs = Number.isFinite(clip.fadeInMs) ? Math.max(0, clip.fadeInMs) : 0;
  const fadeOutMs = Number.isFinite(clip.fadeOutMs) ? Math.max(0, clip.fadeOutMs) : 0;
  if (curve === clip.fadeCurve && fadeInMs === clip.fadeInMs && fadeOutMs === clip.fadeOutMs) {
    return clip;
  }
  return { ...clip, fadeCurve: curve, fadeInMs, fadeOutMs };
}

/**
 * Gradien CSS yang MENGIKUTI kurva sungguhan, untuk overlay fade di timeline.
 * `linear-gradient` dua titik hanya bisa lurus; supaya clip kecil di timeline
 * terbaca sama dengan panel detail, kurvanya disampel jadi beberapa color stop.
 */
export function fadeOverlayGradient(curve: FadeCurve, side: FadeSide, stops = 8): string {
  // Arah gelap-ke-terang: fade-in gelap di kiri, fade-out gelap di kanan.
  const dir = side === 'in' ? 'to right' : 'to left';
  const parts: string[] = [];
  for (let i = 0; i < stops; i++) {
    const t = i / (stops - 1);
    // Overlay menutupi bagian yang DIREDAM, jadi opacity = 1 − gain.
    const alpha = (1 - fadeInGain(curve, t)) * 0.85;
    parts.push(`rgba(0,0,0,${alpha.toFixed(3)}) ${(t * 100).toFixed(1)}%`);
  }
  return `linear-gradient(${dir}, ${parts.join(', ')})`;
}
