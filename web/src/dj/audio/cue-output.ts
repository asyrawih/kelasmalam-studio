/**
 * Keluaran CUE ke PERANGKAT KEDUA.
 *
 * ## Kenapa ini tidak bisa "sekadar" jadi bus di dalam graf
 *
 * Monitor headphone hanya berarti kalau ia keluar dari perangkat yang BERBEDA
 * dari master. Web Audio tidak punya konsep dua tujuan fisik dalam satu
 * `AudioContext`: `ctx.destination` cuma satu, dan `AudioContext.setSinkId`
 * memindahkan SELURUH context, bukan satu cabang.
 *
 * Jalan yang ada: `MediaStreamAudioDestinationNode` → `HTMLAudioElement` →
 * `audio.setSinkId(deviceId)`. Elemen audio itulah yang bisa diarahkan sendiri.
 *
 * ## Kenapa CUE diam selama belum ada perangkat yang dipilih
 *
 * Kalau bus CUE ikut tersambung ke keluaran default, menyalakan CUE akan
 * menambahkan lagu yang sama ke speaker utama — kebalikan dari gunanya, dan
 * terdengar seperti kerusakan. Jadi selama belum ada perangkat kedua, tombol
 * CUE tetap bekerja (kirimannya nyata) tapi tidak ada yang memonitornya, dan
 * UI **mengatakan itu** alih-alih diam.
 *
 * `enumerateDevices` hanya mengembalikan label setelah izin mikrofon diberikan.
 * Kita TIDAK meminta izin mikrofon untuk ini: daftar tanpa label tetap bisa
 * dipilih, dan meminta akses mikrofon demi nama perangkat adalah pertukaran
 * yang tidak pantas ditawarkan.
 */

/**
 * `setSinkId` sudah ada di lib DOM proyek ini, tapi TIDAK ada di semua browser
 * saat runtime (Firefox dan Safari belum). Jadi tipenya dipercaya, dan
 * KEBERADAANNYA tetap diperiksa saat dipakai.
 */
function canSetSink(el: HTMLAudioElement): boolean {
  return typeof (el as { setSinkId?: unknown }).setSinkId === 'function';
}

export interface CueDevice {
  readonly deviceId: string;
  readonly label: string;
}

export function isCueRoutingSupported(): boolean {
  if (typeof document === 'undefined') return false;
  return canSetSink(document.createElement('audio'));
}

export async function listOutputDevices(): Promise<readonly CueDevice[]> {
  if (typeof navigator === 'undefined' || navigator.mediaDevices === undefined) return [];
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all
      .filter((d) => d.kind === 'audiooutput')
      .map((d, i) => ({
        deviceId: d.deviceId,
        // Label kosong sampai izin diberikan; nomor urut tetap bisa dipilih.
        label: d.label === '' ? `KELUARAN ${i + 1}` : d.label,
      }));
  } catch {
    return [];
  }
}

/**
 * Elemen audio yang memutar bus CUE. Dibuat sekali, dipakai ulang.
 *
 * Tidak dipasang ke DOM: elemen media tidak perlu terlihat untuk berbunyi, dan
 * menaruhnya di dokumen hanya menambah satu hal yang bisa tersapu oleh render.
 */
export class CueOutput {
  private el: HTMLAudioElement | null = null;
  private deviceId: string | null = null;

  get selectedDeviceId(): string | null {
    return this.deviceId;
  }

  get isMonitoring(): boolean {
    return this.deviceId !== null && this.el !== null;
  }

  attach(stream: MediaStream): void {
    if (this.el !== null) return;
    if (typeof document === 'undefined') return;
    const el = document.createElement('audio');
    el.srcObject = stream;
    el.autoplay = true;
    this.el = el;
  }

  /** `null` mematikan monitoring. Mengembalikan alasan kegagalan, atau null. */
  async select(deviceId: string | null): Promise<string | null> {
    const el = this.el;
    if (el === null) return 'keluaran CUE tidak tersedia di browser ini';
    if (deviceId === null) {
      this.deviceId = null;
      el.pause();
      return null;
    }
    if (!canSetSink(el)) {
      return 'browser ini tidak mendukung pemilihan perangkat keluaran (setSinkId)';
    }
    try {
      await el.setSinkId(deviceId);
      await el.play();
      this.deviceId = deviceId;
      return null;
    } catch (err: unknown) {
      this.deviceId = null;
      return err instanceof Error ? err.message : 'gagal mengarahkan keluaran CUE';
    }
  }

  dispose(): void {
    if (this.el === null) return;
    this.el.pause();
    this.el.srcObject = null;
    this.el = null;
    this.deviceId = null;
  }
}
