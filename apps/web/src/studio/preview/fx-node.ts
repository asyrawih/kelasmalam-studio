/**
 * Node `daw-fx` di graf preview — jembatan supaya insert chain terdengar saat
 * diputar, bukan hanya di file hasil export.
 *
 * ## Kenapa ini, bukan menulis ulang efeknya di Web Audio
 *
 * Menulis ulang berarti dua implementasi untuk tiap efek, dan keduanya harus
 * dijaga tetap sama selamanya. `graph-builder.ts` sendiri sudah menuliskan
 * peringatannya: "begitu ada dua jalur render, yang terdengar dan yang
 * ter-export bisa berbeda tanpa ada yang menyadarinya" — dan `clip.stem` adalah
 * buktinya, terdengar di preview tapi hilang dari file.
 *
 * Node ini menjalankan `FxRack` Rust yang SAMA dengan export. Divergensi untuk
 * efek karena itu bukan sesuatu yang dijaga disiplin; ia tidak bisa terjadi.
 *
 * ## Kalau WASM belum dibangun
 *
 * Node-nya tidak dipasang dan chain tidak terdengar — TAPI tetap ikut ke file
 * hasil export. Itu perbedaan yang nyata, jadi ia dilaporkan lewat
 * `fxPreviewStatus()` alih-alih didiamkan.
 */

import fxWorkletUrl from '../../audio/fx-worklet.ts?worklet&url';
import { catalogById, parseCatalog, type EffectDesc } from '../../audio/fx-catalog';
import { loadWasm } from '../../audio/wasm-loader';
import { WASM_URLS } from '../../audio/wasm-urls';
import type { FxInsert } from '../model';

/** Modul `st` untuk worklet — lihat catatan varian di `fx-worklet.ts`. */
let fxModule: WebAssembly.Module | null = null;
let catalog: Map<string, EffectDesc> | null = null;
let loadError: string | null = null;
let loading: Promise<boolean> | null = null;
const registered = new WeakSet<BaseAudioContext>();

export interface FxPreviewStatus {
  readonly ready: boolean;
  /** Alasan chain tidak terdengar, kalau ada. */
  readonly error: string | null;
}

/** Katalog yang sudah dimuat, atau null kalau runtime belum siap. */
export function fxCatalog(): Map<string, EffectDesc> | null {
  return catalog;
}

export function fxPreviewStatus(): FxPreviewStatus {
  return { ready: fxModule !== null && catalog !== null, error: loadError };
}

/**
 * Siapkan modul + katalog. Aman dipanggil berkali-kali; hanya sekali bekerja.
 *
 * Artefak `st` di-fetch terpisah dari yang dipakai loader utama: worklet FX
 * selalu memakai varian tanpa atomics (lihat `fx-worklet.ts`), sementara loader
 * utama bisa memilih `mt`. Browser meng-cache-nya, jadi ini bukan unduhan kedua
 * kecuali di muat pertama.
 */
export function ensureFxRuntime(): Promise<boolean> {
  if (fxModule !== null && catalog !== null) return Promise.resolve(true);
  if (loading !== null) return loading;
  loading = (async () => {
    try {
      const res = await fetch(WASM_URLS.st.wasm);
      if (!res.ok) throw new Error(`artefak st ${res.status}`);
      const bytes = await res.arrayBuffer();
      fxModule = await WebAssembly.compile(bytes);
      // Katalog datang dari surface bindgen, yang hanya ada di main thread.
      const wasm = await loadWasm();
      catalog = catalogById(parseCatalog(wasm.exports.fxCatalogJson()));
      loadError = null;
      return true;
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
      fxModule = null;
      catalog = null;
      return false;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** Daftarkan processor sekali per AudioContext. */
export async function registerFxWorklet(audio: BaseAudioContext): Promise<boolean> {
  if (!(await ensureFxRuntime())) return false;
  if (registered.has(audio)) return true;
  try {
    await audio.audioWorklet.addModule(fxWorkletUrl);
    registered.add(audio);
    return true;
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
    return false;
  }
}

/** Efek yang jenisnya tidak dikenal katalog dilewati — sama seperti di Rust. */
function known(chain: readonly FxInsert[]): { fx: FxInsert; desc: EffectDesc }[] {
  const cat = catalog;
  if (cat === null) return [];
  const out: { fx: FxInsert; desc: EffectDesc }[] = [];
  for (const fx of chain) {
    const desc = cat.get(fx.kind);
    if (desc !== undefined) out.push({ fx, desc });
  }
  return out;
}

/**
 * Bangun node untuk satu chain. `null` kalau chain kosong atau runtime belum
 * siap — pemanggil menyambungkan graf tanpa node itu.
 */
export function createFxNode(
  audio: BaseAudioContext,
  chain: readonly FxInsert[],
): AudioWorkletNode | null {
  if (fxModule === null || !registered.has(audio)) return null;
  const slots = known(chain);
  if (slots.length === 0) return null;

  const kinds = new Uint16Array(slots.map((s) => s.desc.kind));
  const bypass = new Uint8Array(slots.map((s) => (s.fx.enabled ? 0 : 1)));
  try {
    const node = new AudioWorkletNode(audio, 'daw-fx', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: {
        module: fxModule,
        kinds,
        bypass,
        sampleRate: audio.sampleRate,
      },
    });
    // Nilai awal dikirim segera: node dibangun dari default katalog, dan apa
    // pun yang sudah diubah user harus berlaku sejak sample pertama.
    pushFxParams(node, chain);
    return node;
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
    return null;
  }
}

/**
 * Kirim seluruh nilai parameter ke node.
 *
 * Dipanggil juga saat user menggeser knob — TIDAK membangun ulang graf.
 * Membangun ulang di tengah drag terdengar sebagai deretan klik, aturan yang
 * sama dengan gain lane dan EQ (lihat `audio-preview.ts::updateLaneParams`).
 */
export function pushFxParams(node: AudioWorkletNode, chain: readonly FxInsert[]): void {
  const slots = known(chain);
  slots.forEach(({ fx, desc }, slot) => {
    node.port.postMessage({ type: 'bypass', slot, on: !fx.enabled });
    for (const [name, value] of Object.entries(fx.params)) {
      const index = desc.params.findIndex((p) => p.id === name);
      if (index >= 0 && Number.isFinite(value)) {
        node.port.postMessage({ type: 'param', slot, index, value });
      }
    }
  });
}

/**
 * Sidik jari BENTUK chain: jenis efek dan bit bypass, tanpa nilai parameter.
 *
 * Aturan yang sama dengan `mixFingerprint` untuk stem — satu BIT, bukan
 * nilainya. Memasukkan nilai parameter akan menjadwalkan ulang seluruh audio
 * tiap knob bergerak satu piksel.
 */
/**
 * Beri tahu node berapa panjang satu ketukan, dalam frame.
 *
 * Dipisah dari `pushFxParams` karena tempo BUKAN parameter efek: ia milik
 * materi yang sedang diproses, dan satu perubahan tempo harus sampai ke
 * seluruh slot sekaligus tanpa menyentuh satu pun nilai knob.
 *
 * Aman dipanggil sering; worklet hanya meneruskannya ke rak, dan rak menolak
 * nilai yang tidak masuk akal.
 */
export function pushFxTempo(node: AudioWorkletNode, framesPerBeat: number): void {
  if (!Number.isFinite(framesPerBeat) || framesPerBeat <= 1) return;
  node.port.postMessage({ type: 'tempo', framesPerBeat });
}

export function chainShape(chain: readonly FxInsert[]): string {
  return chain.map((f) => `${f.kind}${f.enabled ? '' : '!'}`).join('>');
}
