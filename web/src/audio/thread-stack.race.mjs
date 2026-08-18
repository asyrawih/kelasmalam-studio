/**
 * Pekerja untuk `thread-stack.test.ts`. Berkas .mjs terpisah karena isinya
 * MEMBUAT worker lagi (dua tingkat), dan worker_threads butuh berkas nyata di
 * disk — bukan modul yang sudah ditransformasi Vitest.
 *
 * Tingkat 1 (berkas ini)  : "main thread" — bindgen, render + encode berulang.
 * Tingkat 2 (di bawah)    : "AudioWorklet" — surface raw, engine_process nonstop.
 * Keduanya berbagi SATU WebAssembly.Memory, persis seperti di browser.
 */
import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ROUNDS = 12;
const SR = 48_000;
const CLIP_FRAMES = SR * 8;

if (!isMainThread && workerData?.role === 'worklet') {
  // ---- sisi worklet: instance kedua di atas memory yang sama --------------
  const { module: mod, memory, stackTop } = workerData;
  const stubs = Object.fromEntries(
    [...new Set(WebAssembly.Module.imports(mod).map((i) => i.module))].map((m) => [
      m,
      new Proxy({}, { get: (_t, name) => (name === 'memory' ? memory : () => 0) }),
    ]),
  );
  const e = new WebAssembly.Instance(mod, stubs).exports;
  // Ini baris yang diuji: stack sendiri SEBELUM fungsi ber-bingkai dipanggil.
  if (stackTop > 0 && e.__stack_pointer && !process.env.BREAK_STACK) e.__stack_pointer.value = stackTop;
  const eng = e.engine_new(SR, e.control_block_alloc(), 128);
  parentPort.postMessage('ready');
  for (;;) e.engine_process(eng, 128);
}

// ---- sisi main thread ------------------------------------------------------
const wasmPath = workerData.wasm;
const mod = await WebAssembly.compile(readFileSync(wasmPath));
const memory = new WebAssembly.Memory({ initial: 256, maximum: 32768, shared: true });
const glueUrl = pathToFileURL(wasmPath.replace(/engine_bg\.wasm$/, 'engine.js')).href;
const g = await import(glueUrl);
const inst = g.initSync({ module: mod, memory });
const MEM = inst?.memory ?? memory;
g.initNonRealtime();

// Stack worklet dialokasi DI SINI, selagi belum ada thread lain yang menjalankan
// wasm — mengalokasinya dari dalam worklet berarti malloc sudah berjalan di atas
// stack yang bertabrakan.
const STACK = 1 << 20;
const stackPtr = inst.scratch_alloc(STACK + 16);
const stackTop = (stackPtr + STACK) & ~15;

const worker = new Worker(new URL(import.meta.url), {
  workerData: { role: 'worklet', module: mod, memory, stackTop },
});
await new Promise((r) => worker.once('message', r));

const bands = [
  { kind: 'lowshelf', freq: 90, q: 0.7, gainDb: 0 },
  { kind: 'peaking', freq: 620, q: 1.0, gainDb: 0 },
  { kind: 'peaking', freq: 3800, q: 1.2, gainDb: 0 },
  { kind: 'highshelf', freq: 11000, q: 0.7, gainDb: 0 },
];
const json = JSON.stringify({
  sampleRate: SR, speed: 1, masterGainDb: 0,
  lanes: [{
    id: 'l1', mute: false, solo: false, gainDb: 0, speedRatio: 1, eq: { bands },
    clips: [{ id: 'c0', assetId: 0, start: 0, len: CLIP_FRAMES, sourceStart: 0,
              gainDb: 0, fadeInMs: 20, fadeOutMs: 20, fadeCurve: 'equalPower' }],
  }],
});

let rounds = 0;
let error = '';
try {
  for (let i = 0; i < ROUNDS; i++) {
    const h = g.snapshotFromStudioJson(json);
    const snap = h.bytes(); h.warnings(); h.clipCount(); h.free();
    const render = new g.OfflineRender(snap, SR, 0, CLIP_FRAMES, 100);
    const enc = new g.WavEncoderHandle(SR, 2, g.WavBits.Pcm16, 0x5eed1234);
    const pcm = new Float32Array(2 * CLIP_FRAMES);
    for (let n = 0; n < CLIP_FRAMES; n += 97) { pcm[n] = 0.4; pcm[CLIP_FRAMES + n] = 0.4; }
    render.registerAsset(0, pcm, 2, CLIP_FRAMES, SR);
    enc.header();
    for (;;) {
      const n = render.render(100);
      if (n === 0) break;
      enc.encode(new Float32Array(MEM.buffer, render.outLPtr(), n),
                 new Float32Array(MEM.buffer, render.outRPtr(), n));
    }
    enc.flush(); enc.patchHeader(); enc.free();
    render.free();
    rounds++;
  }
} catch (e) {
  error = e instanceof Error ? e.message : String(e);
}
await worker.terminate();
parentPort.postMessage({ ok: error === '', error, rounds });
