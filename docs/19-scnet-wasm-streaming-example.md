# 19 — Example SCNet WASM: stem 3 detik di depan playback

Status: **spesifikasi spike**, belum produksi.

Dokumen ini mendefinisikan contoh terkecil untuk membuktikan SCNet dapat
memisahkan empat stem di browser sambil audio diputar. Targetnya bukan input
mikrofon berlatensi rendah. Seluruh lagu sudah tersedia, lalu inference menjaga
hasil minimal 3 detik di depan playhead.

> Catatan istilah: "WASM" di sini berarti ONNX Runtime Web dengan execution
> provider `wasm`. Model tetap berupa ONNX; model tidak dikompilasi ke crate
> Rust milik DawOnWeb dan tidak pernah dijalankan di `AudioWorklet`.

## Kontrak keberhasilan

Spike dianggap berhasil hanya jika seluruh kondisi berikut terukur:

1. Input stereo 44.1 kHz dapat diputar sebagai empat stem tanpa menulis WAV.
2. Setelah prebuffer, audio berjalan 60 detik tanpa underrun.
3. P95 inference untuk satu langkah lebih kecil dari 3 detik.
4. Seek membatalkan antrean lama dan menghasilkan audio dari posisi baru.
5. Penjumlahan empat stem mendekati mixture; laporkan SNR/null-test.
6. Spectrum masing-masing stem dapat dibaca tanpa menyalin PCM dari worker
   pada setiap animation frame.

Kalau P95 lebih besar dari 3 detik, demo masih boleh bekerja dengan prebuffer
lebih panjang, tetapi klaim "menjaga 3 detik di depan" dinyatakan gagal pada
mesin tersebut.

## Angka awal

```ts
export const SCNET = {
  sampleRate: 44_100,
  channels: 2,
  stems: ['vocals', 'drums', 'bass', 'other'] as const,

  // Model mendapat konteks lebih panjang daripada audio baru yang dipublikasikan.
  contextSeconds: 11,
  stepSeconds: 3,
  leftContextSeconds: 1,

  // Mulai playback hanya setelah dua langkah aman tersedia.
  startBufferSeconds: 6,
  lowWaterSeconds: 3,
  highWaterSeconds: 12,
} as const;
```

`contextSeconds` harus mengikuti shape model hasil export. Angka 11 detik
sesuai keluarga export SCNet browser yang memakai kira-kira 476 frame STFT;
anggap ini parameter model, bukan konstanta universal.

Satu job menerima jendela konteks:

```text
job 0 input   [0 ---------------- 11]
      publish [0 ----- 3]

job 1 input         [2 ---------------- 13]
      publish        [3 ----- 6]

job 2 input               [5 ---------------- 16]
      publish              [6 ----- 9]
```

Worker boleh membaca konteks kiri/kanan, tetapi hanya `stepSeconds` sampel yang
dipublikasikan ke player. Di perbatasan hasil, gunakan equal-power crossfade
50–100 ms atau weighted overlap-add yang sama dengan jalur referensi model.

## Arsitektur thread

```text
main/UI
  ├─ decodeAudioData() sekali
  ├─ scheduler: playhead, seek generation, low/high water
  ├─ menerima statistik inference
  └─ membaca spectrum dari AnalyserNode

separate.worker.ts
  ├─ lazy import onnxruntime-web/wasm
  ├─ satu InferenceSession SCNet sepanjang umur worker
  ├─ normalisasi + layout tensor
  ├─ inference + denormalisasi
  └─ menulis PCM empat stem ke ring buffer

AudioWorklet
  ├─ hanya membaca ring buffer
  ├─ mix gain/mute/solo stem
  ├─ output stereo 128 frame
  └─ tidak melakukan ONNX, FFT besar, alokasi, atau postMessage per quantum

Web Audio graph
  stem ring → gain → AnalyserNode ─┐
  stem ring → gain → AnalyserNode ─┼→ master → destination
  stem ring → gain → AnalyserNode ─┤
  stem ring → gain → AnalyserNode ─┘
```

Spectrum UI memakai `AnalyserNode` pada cabang stem. Ini terpisah dari STFT
yang dibutuhkan SCNet. Baca `getFloatFrequencyData()` paling cepat 30–60 Hz;
jangan kirim spektrum dari worker inference.

## Layout ring buffer

Untuk example pertama, buat satu `SharedArrayBuffer` per stem dengan PCM stereo
planar. Kapasitas 16 detik pada 44.1 kHz:

```ts
const capacityFrames = 1 << 20; // 1,048,576 frame, sekitar 23.8 detik
const headerBytes = 4 * Int32Array.BYTES_PER_ELEMENT;
const pcmBytes = 2 * capacityFrames * Float32Array.BYTES_PER_ELEMENT;

// Header Int32:
// 0 writeFrame monotonik
// 1 readFrame monotonik
// 2 generation seek
// 3 underrunCount
const sab = new SharedArrayBuffer(headerBytes + pcmBytes);
```

Indeks fisik adalah `absoluteFrame & (capacityFrames - 1)`. `writeFrame` hanya
ditulis worker separation dan `readFrame` hanya ditulis AudioWorklet. Publikasi
data dilakukan setelah PCM selesai ditulis:

```ts
writePlanar(left, right, writeFrame);
Atomics.store(header, WRITE_FRAME, writeFrame + left.length);
Atomics.notify(header, WRITE_FRAME);
```

AudioWorklet tidak boleh menunggu dengan `Atomics.wait()`. Jika data belum ada,
ia menulis nol, menaikkan `underrunCount`, dan tetap mengembalikan `true`.

Untuk spike yang lebih mudah, output worker boleh dikirim sebagai transferable
`ArrayBuffer` lalu dijadwalkan sebagai `AudioBufferSourceNode`. Itu membuktikan
model dan kualitas, tetapi **belum membuktikan** player streaming/seek. Ring
buffer tetap merupakan gerbang akhir.

## Protokol worker

```ts
type StemName = 'vocals' | 'drums' | 'bass' | 'other';

type ToWorker =
  | {
      type: 'init';
      modelUrl: string;
      ortWasmBaseUrl: string;
      threads: number;
      rings: Record<StemName, SharedArrayBuffer>;
    }
  | {
      type: 'load';
      generation: number;
      sampleRate: 44_100;
      left: Float32Array;
      right: Float32Array;
    }
  | {
      type: 'fill';
      generation: number;
      fromFrame: number;
      untilFrame: number;
    }
  | { type: 'seek'; generation: number; frame: number }
  | { type: 'dispose' };

type FromWorker =
  | { type: 'ready'; loadMs: number }
  | {
      type: 'chunk';
      generation: number;
      fromFrame: number;
      frames: number;
      inferenceMs: number;
      bufferedUntilFrame: number;
    }
  | { type: 'error'; generation?: number; message: string };
```

`generation` adalah cancellation token murah. Setiap seek menaikkannya. Worker
tidak dapat menghentikan `session.run()` yang sudah berada di native WASM, tetapi
hasil job lama harus dibuang jika generation-nya tidak lagi aktif.

## Bootstrap ONNX Runtime WASM

Paket harus di-lazy-load dari worker supaya nol byte masuk jalur startup utama.
Artefak ORT wajib di-host same-origin karena aplikasi memakai COEP.

```ts
async function createSession(modelUrl: string, wasmBase: string, threads: number) {
  const ort = await import('onnxruntime-web/wasm');

  ort.env.wasm.wasmPaths = wasmBase; // contoh: '/vendor/ort/'
  ort.env.wasm.numThreads = Math.max(1, threads);
  ort.env.wasm.simd = true;

  const session = await ort.InferenceSession.create(modelUrl, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
    executionMode: 'sequential',
  });

  return { ort, session };
}
```

Host minimum file berikut di `web/public/vendor/ort/` dengan nama yang sama
dengan versi `onnxruntime-web` yang dikunci di `package.json`:

```text
ort-wasm-simd-threaded.wasm
```

Jangan menyalin nama file dari versi ORT lain. Tambahkan smoke test yang memuat
URL produksi, karena salah pasangan JS/WASM sering baru terlihat saat runtime.

Jumlah thread awal:

```ts
const threads = Math.max(1, Math.min(8, navigator.hardwareConcurrency - 2));
```

Dua core disisakan untuk main/audio. Benchmark 1, 2, 4, dan 8; lebih banyak
thread tidak selalu lebih cepat karena bandwidth memori dan audio contention.

## Adapter model: bagian yang tidak boleh ditebak

Nama input/output dan shape harus dibaca dari model ONNX yang benar:

```ts
console.table(session.inputNames);
console.table(session.outputNames);
console.log(session.inputMetadata, session.outputMetadata);
```

Implementasi adapter menyimpan kontrak hasil inspeksi tersebut secara eksplisit:

```ts
interface ScnetAdapter {
  readonly inputFrames: number;
  makeFeeds(ort: typeof import('onnxruntime-web'), left: Float32Array,
            right: Float32Array): Record<string, unknown>;
  readStems(outputs: Record<string, unknown>): Record<StemName, {
    left: Float32Array;
    right: Float32Array;
  }>;
}
```

Jangan menulis contoh palsu seperti `input: [1, 2, samples]` sampai metadata
model diverifikasi. Sebagian export menerima waveform, sebagian menerima
representasi STFT, dan urutan stem dapat berbeda. Kesalahan urutan output dapat
terdengar "masuk akal" sehingga wajib ada fixture numerik dari implementasi
PyTorch referensi.

Normalisasi mixture juga merupakan bagian kontrak checkpoint. Simpan mean/std
per chunk dan lakukan inverse transform pada semua stem sesuai kode referensi.

## Scheduler 3 detik di depan

```ts
function tick() {
  const played = Atomics.load(masterHeader, READ_FRAME);
  const written = Atomics.load(masterHeader, WRITE_FRAME);
  const buffered = written - played;

  if (buffered < secondsToFrames(SCNET.lowWaterSeconds) && !jobInFlight) {
    worker.postMessage({
      type: 'fill',
      generation,
      fromFrame: written,
      untilFrame: played + secondsToFrames(SCNET.highWaterSeconds),
    });
    jobInFlight = true;
  }
}
```

Worker mengerjakan satu window per `fill`, mengirim statistik, lalu scheduler
meminta lagi sampai high-water terpenuhi. Hanya satu `session.run()` boleh aktif
agar memori sementara dan urutan publikasi tetap terkendali.

Saat seek:

1. Pause/mute output sebentar.
2. Tambah `generation`.
3. Set semua `readFrame` dan `writeFrame` ke target yang sama.
4. Kirim `seek` lalu `fill` dari target.
5. Resume setelah `startBufferSeconds` tersedia.

Untuk scratch/hot-cue tanpa jeda, simpan cache chunk berdasarkan
`trackId:generation-independent-stepIndex`. Generation membatalkan antrean,
bukan membuat PCM cache menjadi tidak valid.

## AudioWorklet minimum

```ts
class StemPlayerProcessor extends AudioWorkletProcessor {
  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]!;
    const left = out[0]!;
    const right = out[1] ?? out[0]!;
    const available = Atomics.load(this.header, WRITE_FRAME) - this.readFrame;

    if (available < left.length) {
      left.fill(0);
      right.fill(0);
      Atomics.add(this.header, UNDERRUN_COUNT, 1);
      return true;
    }

    this.copyFromRing(left, right, this.readFrame);
    this.readFrame += left.length;
    Atomics.store(this.header, READ_FRAME, this.readFrame);
    return true;
  }
}
```

Example produksi sebaiknya memakai satu processor dengan empat ring input dan
empat output stereo supaya setiap stem dapat melewati `GainNode` dan
`AnalyserNode` sendiri. Muting dilakukan dengan gain, bukan menghapus stem dari
ring, agar posisi semuanya tetap sample-aligned.

## Spectrum per stem

```ts
function makeSpectrumTap(ctx: AudioContext, input: AudioNode) {
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.72;
  analyser.minDecibels = -100;
  analyser.maxDecibels = -20;
  input.connect(analyser);

  const db = new Float32Array(analyser.frequencyBinCount);
  return {
    analyser,
    read() {
      analyser.getFloatFrequencyData(db);
      return db;
    },
  };
}
```

Frekuensi bin `i` adalah `i * sampleRate / fftSize`. Untuk visual 64 bar, map
bin ke skala log lalu ambil maksimum atau RMS per kelompok; jangan menganggap
64 elemen pertama mewakili seluruh spektrum.

## Urutan implementasi example

### E0 — model smoke test

- Tambah dependency `onnxruntime-web` yang versinya dikunci.
- Self-host WASM runtime dan model.
- Load satu fixture 11 detik, jalankan satu inference, tampilkan waktu dan shape.
- Bandingkan output dengan fixture PyTorch, korelasi > 0.999.

### E1 — offline PCM tanpa export file

- Decode satu lagu ke stereo 44.1 kHz.
- Proses seluruh lagu per window.
- Simpan output hanya sebagai `Float32Array` di RAM.
- Mainkan empat stem dengan `AudioBufferSourceNode`.
- Buktikan sum/null-test dan spectrum.

### E2 — streaming-ahead

- Ganti array penuh dengan empat ring buffer SAB.
- Tambahkan scheduler low/high-water dan AudioWorklet.
- Prebuffer enam detik, lalu inference per langkah tiga detik.
- Catat underrun dan P50/P95 inference.

### E3 — seek dan fallback

- Tambahkan generation cancellation dan cache chunk.
- Jika inference kalah dari playback, naikkan prebuffer; jika tetap kalah,
  nonaktifkan mode runtime dan tawarkan separation offline.
- Fallback tanpa `crossOriginIsolated`: transferable chunks untuk demo offline,
  bukan klaim streaming realtime.

## Telemetri benchmark lokal

Setiap run harus menghasilkan JSON agar keputusan tidak berdasarkan perasaan:

```json
{
  "model": "scnet-base-fp32",
  "backend": "wasm-simd-threads",
  "threads": 6,
  "chunkAudioMs": 11000,
  "publishedAudioMs": 3000,
  "sessionLoadMs": 0,
  "inferenceP50Ms": 0,
  "inferenceP95Ms": 0,
  "maxBufferedMs": 0,
  "underruns": 0,
  "realtimeFactorPublished": 0
}
```

Rumus yang relevan untuk mode ini adalah:

```text
RTF-published = publishedAudioMs / inferenceMs
```

Bukan panjang konteks dibagi inference. Walaupun model membaca 11 detik, jika
setiap job hanya menambah 3 detik audio yang aman diputar, inference harus lebih
cepat dari 3 detik untuk mempertahankan antrean.

## Batas yang sengaja diterima

- Example desktop Chrome/Edge lebih dulu; iOS tidak menjadi target awal.
- Input selalu di-resample ke 44.1 kHz sebelum worker.
- Maksimal satu track dipisahkan pada satu waktu.
- Empat stem tetap sample-aligned dan selalu bergerak bersama.
- Tidak ada file export; PCM hidup di RAM/cache sesi.
- SCNet base biasa bukan model causal. Latensi awal 6–12 detik diterima.
- Jika target akhirnya live microphone berlatensi sub-detik, gunakan model
  causal seperti Band-SCNet/RT-STT; arsitektur ini bukan jawabannya.

## File example yang akan dibuat setelah model dipilih

```text
web/src/experiments/scnet-runtime/
  index.tsx
  protocol.ts
  scheduler.ts
  ring-buffer.ts
  separate.worker.ts
  stem-player.worklet.ts
  scnet-adapter.ts
  spectrum.ts
  benchmark.ts

web/public/models/scnet/
  scnet-base.onnx
  fixture-input.f32
  fixture-output-*.f32

web/public/vendor/ort/
  ort-wasm-simd-threaded.wasm
```

Model dan fixture sengaja belum ditambahkan oleh dokumen ini. Checkpoint harus
dipilih setelah lisensi bobot jelas, kemudian adapter dikunci terhadap metadata
dan output numerik checkpoint tersebut.
