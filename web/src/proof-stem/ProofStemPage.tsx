import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, ProgressBar } from '../ui/cyber';
import type { ScnetResult, ScnetStem } from './scnet-separate';
import './proof-stem.css';

type StemName = 'VOCALS' | 'DRUMS' | 'BASS' | 'OTHER';

const STEMS: readonly StemName[] = ['VOCALS', 'DRUMS', 'BASS', 'OTHER'];

interface AudioSession {
  readonly context: AudioContext;
  readonly source: AudioBufferSourceNode;
  readonly analyser: AnalyserNode;
  readonly startedAt: number;
  readonly offset: number;
}

interface ProgressiveChunk {
  readonly start: number;
  readonly buffers: Record<ScnetStem, AudioBuffer>;
}

interface ProgressiveSession {
  readonly context: AudioContext;
  readonly analyser: AnalyserNode;
  readonly stems: Set<ScnetStem>;
  readonly startedAt: number;
  readonly scheduled: Record<ScnetStem, number>;
  readonly sources: Array<{ readonly stem: ScnetStem; readonly source: AudioBufferSourceNode }>;
}

export interface ProofStemPageProps {
  readonly onClose: () => void;
}

export function ProofStemPage({ onClose }: ProofStemPageProps): JSX.Element {
  const [fileName, setFileName] = useState('Belum ada track');
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [decoding, setDecoding] = useState(false);
  const [modelState, setModelState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [modelInfo, setModelInfo] = useState('44.5 MB FP32 · NOT LOADED');
  const [separating, setSeparating] = useState(false);
  const [separationProgress, setSeparationProgress] = useState(0);
  const [stemBuffers, setStemBuffers] = useState<Partial<Record<ScnetStem, AudioBuffer>>>({});
  const [activeAudio, setActiveAudio] = useState('MIXTURE');
  const [activeStems, setActiveStems] = useState<readonly ScnetStem[]>([]);
  const [bufferedFrames, setBufferedFrames] = useState(0);
  const session = useRef<AudioSession | null>(null);
  const spectrum = useRef<HTMLCanvasElement | null>(null);
  const raf = useRef(0);
  const worker = useRef<Worker | null>(null);
  const totalFrames = useRef(0);
  const progressiveBuffers = useRef<Partial<Record<ScnetStem, AudioBuffer>>>({});
  const progressiveChunks = useRef<ProgressiveChunk[]>([]);
  const progressiveSession = useRef<ProgressiveSession | null>(null);
  const scheduleProgressive = useRef<() => void>(() => {});
  const duration = buffer?.duration ?? 0;

  const stop = useCallback((rememberPosition = true): void => {
    const active = session.current;
    if (active !== null) {
      if (rememberPosition) {
        setPosition(Math.min(buffer?.duration ?? 0, active.offset + active.context.currentTime - active.startedAt));
      }
      try {
        active.source.stop();
      } catch {
        // Source yang sudah selesai tidak perlu dihentikan lagi.
      }
      void active.context.close();
      session.current = null;
    }
    const stream = progressiveSession.current;
    if (stream !== null) {
      for (const item of stream.sources) {
        try { item.source.stop(); } catch { /* sudah selesai */ }
      }
      void stream.context.close();
      progressiveSession.current = null;
    }
    cancelAnimationFrame(raf.current);
    setPlaying(false);
    setActiveStems([]);
  }, [buffer]);

  scheduleProgressive.current = (): void => {
    const active = progressiveSession.current;
    if (active === null) return;
    for (const stem of active.stems) {
      while (active.scheduled[stem] < progressiveChunks.current.length) {
        const chunk = progressiveChunks.current[active.scheduled[stem]]!;
        const desiredStart = active.startedAt + chunk.start / 44_100;
        const lateness = Math.max(0, active.context.currentTime - desiredStart);
        const source = active.context.createBufferSource();
        source.buffer = chunk.buffers[stem];
        source.connect(active.analyser);
        if (lateness < source.buffer.duration) {
          source.start(Math.max(active.context.currentTime, desiredStart), lateness);
          active.sources.push({ stem, source });
        }
        active.scheduled[stem] += 1;
      }
    }
  };

  useEffect(() => () => stop(false), [stop]);
  // Worker membawa session ONNX mahal. Jangan terminate saat `buffer` berubah;
  // cleanup ini hanya berjalan ketika halaman benar-benar unmount.
  useEffect(() => () => worker.current?.terminate(), []);

  const drawSpectrum = useCallback((analyser: AnalyserNode): void => {
    const canvas = spectrum.current;
    if (canvas === null) return;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    const scale = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(canvas.clientWidth * scale));
    const height = Math.max(1, Math.floor(canvas.clientHeight * scale));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const bins = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(bins);
    ctx.clearRect(0, 0, width, height);
    const gradient = ctx.createLinearGradient(0, height, 0, 0);
    gradient.addColorStop(0, 'rgba(0, 255, 194, .08)');
    gradient.addColorStop(1, 'rgba(0, 255, 194, .9)');
    ctx.fillStyle = gradient;

    const bars = 96;
    const gap = Math.max(1, scale);
    const barWidth = width / bars;
    for (let i = 0; i < bars; i += 1) {
      const t = i / (bars - 1);
      const bin = Math.min(bins.length - 1, Math.floor((Math.pow(10, t * 3) - 1) / 999 * bins.length));
      const normalized = Math.max(0, Math.min(1, (bins[bin]! + 100) / 80));
      const barHeight = Math.max(1, normalized * height);
      ctx.fillRect(i * barWidth, height - barHeight, Math.max(1, barWidth - gap), barHeight);
    }
  }, []);

  const startProgressive = useCallback((initialStems: readonly ScnetStem[]): void => {
    if (progressiveChunks.current.length === 0) return;
    stop(false);
    setPosition(0);
    const context = new AudioContext({ sampleRate: 44_100, latencyHint: 'playback' });
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.72;
    analyser.connect(context.destination);
    const active: ProgressiveSession = {
      context,
      analyser,
      stems: new Set(initialStems),
      startedAt: context.currentTime + 0.05,
      scheduled: { drums: 0, bass: 0, other: 0, vocals: 0 },
      sources: [],
    };
    progressiveSession.current = active;
    setActiveStems(initialStems);
    setActiveAudio(initialStems.map((stem) => stem.toUpperCase()).join(' + '));
    setPlaying(true);
    scheduleProgressive.current();
    const frame = (): void => {
      if (progressiveSession.current !== active) return;
      const played = Math.max(0, context.currentTime - active.startedAt);
      setPosition(Math.min(duration, played));
      drawSpectrum(analyser);
      if (!separating && played >= duration) {
        stop(false);
        return;
      }
      raf.current = requestAnimationFrame(frame);
    };
    frame();
  }, [drawSpectrum, duration, separating, stop]);

  const toggleProgressiveStem = useCallback((stem: ScnetStem): void => {
    const active = progressiveSession.current;
    if (active === null) {
      startProgressive([stem]);
      return;
    }

    if (active.stems.has(stem)) {
      active.stems.delete(stem);
      for (const item of active.sources) {
        if (item.stem !== stem) continue;
        try { item.source.stop(); } catch { /* sudah selesai */ }
      }
      if (active.stems.size === 0) {
        stop(false);
        return;
      }
    } else {
      active.stems.add(stem);
      // Mulai stem baru pada posisi timeline yang sedang berjalan.
      active.scheduled[stem] = 0;
      scheduleProgressive.current();
    }

    const next = [...active.stems];
    setActiveStems(next);
    setActiveAudio(next.map((name) => name.toUpperCase()).join(' + '));
  }, [startProgressive, stop]);

  const enableAllProgressiveStems = useCallback((): void => {
    const all: readonly ScnetStem[] = ['vocals', 'drums', 'bass', 'other'];
    const active = progressiveSession.current;
    if (active === null) {
      startProgressive(all);
      return;
    }
    for (const stem of all) {
      if (active.stems.has(stem)) continue;
      active.stems.add(stem);
      active.scheduled[stem] = 0;
    }
    scheduleProgressive.current();
    setActiveStems(all);
    setActiveAudio('ALL STEMS');
  }, [startProgressive]);

  const playBuffer = useCallback((target: AudioBuffer, label: string, startAt = position): void => {
    if (session.current !== null) return;
    setError(null);
    const context = new AudioContext({ sampleRate: 44_100, latencyHint: 'playback' });
    const source = context.createBufferSource();
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.72;
    analyser.minDecibels = -100;
    analyser.maxDecibels = -20;
    source.buffer = target;
    source.connect(analyser).connect(context.destination);
    const offset = startAt >= target.duration ? 0 : startAt;
    source.start(0, offset);
    const active = { context, source, analyser, startedAt: context.currentTime, offset };
    session.current = active;
    setActiveAudio(label);
    setPlaying(true);
    const frame = (): void => {
      if (session.current !== active) return;
      setPosition(Math.min(target.duration, offset + context.currentTime - active.startedAt));
      drawSpectrum(analyser);
      raf.current = requestAnimationFrame(frame);
    };
    source.onended = () => {
      if (session.current !== active) return;
      session.current = null;
      void context.close();
      cancelAnimationFrame(raf.current);
      setPosition(target.duration);
      setPlaying(false);
    };
    frame();
  }, [drawSpectrum, position]);

  const play = useCallback((): void => {
    if (buffer !== null) playBuffer(buffer, 'MIXTURE');
  }, [buffer, playBuffer]);

  const loadFile = useCallback(async (file: File): Promise<void> => {
    stop(false);
    setDecoding(true);
    setError(null);
    setPosition(0);
    try {
      const context = new AudioContext({ sampleRate: 44_100 });
      const decoded = await context.decodeAudioData(await file.arrayBuffer());
      await context.close();
      setBuffer(decoded);
      setStemBuffers({});
      progressiveBuffers.current = {};
      progressiveChunks.current = [];
      setBufferedFrames(0);
      setActiveStems([]);
      setSeparationProgress(0);
      setFileName(file.name);
    } catch (reason) {
      setBuffer(null);
      setFileName('Gagal membaca track');
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setDecoding(false);
    }
  }, [stop]);

  const isolated = globalThis.crossOriginIsolated === true;
  const hasSab = typeof SharedArrayBuffer !== 'undefined';
  const hasWasm = typeof WebAssembly !== 'undefined';
  const progress = duration > 0 ? position / duration : 0;

  const loadModel = useCallback(async (): Promise<void> => {
    if (modelState === 'ready') return;
    setModelState('loading');
    setError(null);
    if (worker.current === null) {
      const instance = new Worker(new URL('./separate.worker.ts', import.meta.url), { type: 'module' });
      instance.onmessage = (event: MessageEvent<
        | { type: 'ready'; loadMs: number; threads: number; inputs: string[]; outputs: string[] }
        | { type: 'chunk'; start: number; frames: number; done: number; total: number; inferenceMs: number; stems: ScnetResult }
        | { type: 'phase'; phase: 'stft' | 'model' | 'istft'; chunk: number; total: number }
        | { type: 'done' }
        | { type: 'error'; message: string }
      >): void => {
        const message = event.data;
        if (message.type === 'ready') {
          setModelInfo(`${(message.loadMs / 1000).toFixed(2)} S · ${message.threads} THREADS · ${message.inputs.join(',')} → ${message.outputs.join(',')}`);
          setModelState('ready');
          return;
        }
        if (message.type === 'error') {
          setModelState((state) => state === 'loading' ? 'error' : state);
          setSeparating(false);
          setError(message.message);
          return;
        }
        if (message.type === 'done') {
          setSeparating(false);
          setModelInfo('STREAM COMPLETE · 4 STEMS IN MEMORY');
          return;
        }
        if (message.type === 'phase') {
          setModelInfo(`${message.phase.toUpperCase()} · CHUNK ${message.chunk}/${message.total}`);
          return;
        }
        let outputs = progressiveBuffers.current;
        if (Object.keys(outputs).length === 0) {
          outputs = {};
          for (const name of ['drums', 'bass', 'other', 'vocals'] as const) {
            outputs[name] = new AudioBuffer({ length: totalFrames.current, numberOfChannels: 2, sampleRate: 44_100 });
          }
          progressiveBuffers.current = outputs;
          // Kartu langsung hidup sesudah chunk pertama, sementara worker
          // mengisi bagian selanjutnya di belakang playback.
          setStemBuffers({ ...outputs });
        }
        for (const name of ['drums', 'bass', 'other', 'vocals'] as const) {
          outputs[name]!.getChannelData(0).set(message.stems[name].left, message.start);
          outputs[name]!.getChannelData(1).set(message.stems[name].right, message.start);
        }
        const chunkBuffers = {} as Record<ScnetStem, AudioBuffer>;
        for (const name of ['drums', 'bass', 'other', 'vocals'] as const) {
          const chunk = new AudioBuffer({ length: message.frames, numberOfChannels: 2, sampleRate: 44_100 });
          chunk.getChannelData(0).set(message.stems[name].left);
          chunk.getChannelData(1).set(message.stems[name].right);
          chunkBuffers[name] = chunk;
        }
        progressiveChunks.current.push({ start: message.start, buffers: chunkBuffers });
        setBufferedFrames(message.start + message.frames);
        scheduleProgressive.current();
        setSeparationProgress(message.done / message.total);
        setModelInfo(`BUFFERED ${(message.start + message.frames) / 44_100 | 0} S · CHUNK ${message.done}/${message.total} · ${(message.inferenceMs / 1000).toFixed(2)} S`);
      };
      worker.current = instance;
    }
    worker.current.postMessage({ type: 'init' });
  }, [modelState]);

  const runSeparation = useCallback(async (): Promise<void> => {
    if (buffer === null || modelState !== 'ready') return;
    stop(false);
    setSeparating(true);
    setSeparationProgress(0);
    setError(null);
    progressiveBuffers.current = {};
    progressiveChunks.current = [];
    setBufferedFrames(0);
    setActiveStems([]);
    setStemBuffers({});
    totalFrames.current = buffer.length;
    const left = new Float32Array(buffer.getChannelData(0));
    const right = new Float32Array(buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left);
    worker.current?.postMessage({ type: 'separate', left, right }, [left.buffer, right.buffer]);
  }, [buffer, modelState, stop]);

  return (
    <main className="ps-page">
      <header className="ps-header">
        <button className="ps-back" type="button" onClick={onClose} aria-label="kembali ke beranda">←</button>
        <div>
          <div className="ps-kicker">DAWONWEB / EXPERIMENT 01</div>
          <h1>PROOF<span>-STEM</span></h1>
        </div>
        <Badge tone={isolated && hasSab && hasWasm ? 'success' : 'warning'} dot>
          {isolated && hasSab && hasWasm ? 'WASM READY' : 'DEGRADED'}
        </Badge>
      </header>

      <section className="ps-hero">
        <div>
          <span className="ps-overline">SCNET · WASM SIMD · STREAMING AHEAD</span>
          <h2>Empat stem.<br /><em>Tiga detik di depan.</em></h2>
          <p>
            Halaman ini menguji jalur browser sebelum dipasang ke deck: decode track,
            inference di worker, scheduler chunk, playback, dan spectrum per stem.
          </p>
        </div>
        <div className="ps-target">
          <span>TARGET</span>
          <strong>&lt; 3.00<small>s</small></strong>
          <p>P95 inference per langkah</p>
        </div>
      </section>

      <section className="ps-grid">
        <article className="ps-panel ps-source">
          <PanelTitle index="01" title="SOURCE TRACK" status={buffer === null ? 'WAITING' : 'DECODED'} />
          <label className="ps-drop">
            <input
              type="file"
              accept="audio/*"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file !== undefined) void loadFile(file);
              }}
            />
            <span className="ps-drop-icon">＋</span>
            <strong>{decoding ? 'DECODING…' : fileName}</strong>
            <small>{buffer === null ? 'DROP OR SELECT WAV / MP3 / FLAC' : `${formatTime(duration)} · ${buffer.sampleRate / 1000} KHZ · ${buffer.numberOfChannels} CH`}</small>
          </label>
          {error !== null ? <p className="ps-error">{error}</p> : null}
          <div className="ps-transport">
            <Button disabled={buffer === null || decoding} onClick={playing ? () => stop() : play}>
              {playing ? `PAUSE ${activeAudio}` : 'PLAY MIXTURE'}
            </Button>
            <div className="ps-time"><span>{formatTime(position)}</span><span>{formatTime(duration)}</span></div>
          </div>
          <ProgressBar value={progress} />
          <canvas className="ps-spectrum" ref={spectrum} aria-label="mixture spectrum" />
        </article>

        <article className="ps-panel ps-runtime">
          <PanelTitle index="02" title="RUNTIME" status={modelState === 'ready' ? 'MODEL READY' : modelState === 'loading' ? 'LOADING MODEL' : modelState === 'error' ? 'LOAD FAILED' : 'MODEL INSTALLED'} />
          <div className="ps-capabilities">
            <Capability name="WEBASSEMBLY" ok={hasWasm} />
            <Capability name="CROSS-ORIGIN ISOLATED" ok={isolated} />
            <Capability name="SHARED ARRAY BUFFER" ok={hasSab} />
            <Capability name="ONNX SCNET MODEL" ok={modelState === 'ready'} pending={modelState !== 'error'} />
          </div>
          <div className="ps-config">
            <Metric label="CONTEXT" value="11.0 s" />
            <Metric label="STEP" value="3.0 s" accent />
            <Metric label="PREBUFFER" value="6.0 s" />
            <Metric label="THREADS" value={String(Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 2)))} />
          </div>
          <Button disabled={!hasWasm || modelState === 'loading'} onClick={() => void loadModel()} style={{ width: '100%' }}>
            {modelState === 'ready' ? 'MODEL LOADED' : modelState === 'loading' ? 'LOADING 44.5 MB…' : 'LOAD SCNET MODEL'}
          </Button>
          <Button
            disabled={buffer === null || modelState !== 'ready' || separating}
            onClick={() => void runSeparation()}
            variant="outline"
            style={{ width: '100%', marginTop: '8px' }}
          >
            {separating ? `SEPARATING ${Math.round(separationProgress * 100)}%` : 'RUN SEPARATION'}
          </Button>
          {separating ? <ProgressBar value={separationProgress} /> : null}
          <p className="ps-note">{modelInfo}. Chunk pertama langsung membuka playback; chunk berikutnya dijadwalkan saat tiba.</p>
        </article>
      </section>

      <section className="ps-panel ps-stems">
        <PanelTitle
          index="03"
          title="STEM OUTPUTS"
          status={Object.keys(stemBuffers).length === 4 ? '4 PCM READY' : separating ? 'INFERENCE RUNNING' : 'NO PCM YET'}
        />
        <div className="ps-stem-toolbar">
          <div>
            <strong>{bufferedFrames > 0 ? `${formatTime(bufferedFrames / 44_100)} BUFFERED` : 'WAITING FOR FIRST CHUNK'}</strong>
            <span>{activeStems.length === 0 ? 'PILIH STEM UNTUK TEST' : `NOW PLAYING: ${activeStems.map((stem) => stem.toUpperCase()).join(' + ')}`}</span>
          </div>
          <Button
            disabled={progressiveChunks.current.length === 0}
            active={activeStems.length === 4}
            onClick={enableAllProgressiveStems}
          >PLAY ALL STEMS</Button>
          <Button
            variant="outline"
            disabled={!playing || activeStems.length === 0}
            onClick={() => stop()}
          >STOP PLAYBACK</Button>
        </div>
        <div className="ps-stem-grid">
          {STEMS.map((stem, index) => {
            const name = stem.toLowerCase() as ScnetStem;
            const output = stemBuffers[name];
            return (
            <div className="ps-stem" key={stem}>
              <div className="ps-stem-head"><span>0{index + 1}</span><strong>{stem}</strong><i>{output === undefined ? '—∞ DB' : 'PCM READY'}</i></div>
              <div className={['ps-stem-empty', activeStems.includes(name) ? 'ps-stem-active' : ''].filter(Boolean).join(' ')}><span>{stem.slice(0, 1)}</span><small>{output === undefined ? separating ? 'PROCESSING…' : 'WAITING FOR INFERENCE' : `${formatTime(bufferedFrames / 44_100)} BUFFERED`}</small></div>
              <div className="ps-stem-actions">
                <button className={activeStems.includes(name) ? 'is-active' : ''} type="button" disabled={output === undefined} onClick={() => toggleProgressiveStem(name)}>{activeStems.includes(name) ? `ON · ${stem}` : `ADD ${stem}`}</button>
                <button type="button" disabled={output === undefined || !activeStems.includes(name)} onClick={() => toggleProgressiveStem(name)}>MUTE</button>
              </div>
            </div>
          );})}
        </div>
      </section>

      <footer className="ps-footer">
        <span>POC ONLY · PCM STAYS IN MEMORY · NO FILE EXPORT</span>
        <span>SPEC: DOCS/19-SCNET-WASM-STREAMING-EXAMPLE</span>
      </footer>
    </main>
  );
}

function PanelTitle({ index, title, status }: { index: string; title: string; status: string }): JSX.Element {
  return <div className="ps-panel-title"><span>{index}</span><h3>{title}</h3><i>{status}</i></div>;
}

function Capability({ name, ok, pending = false }: { name: string; ok: boolean; pending?: boolean }): JSX.Element {
  return <div><span className={ok ? 'ps-dot ps-dot-ok' : pending ? 'ps-dot ps-dot-pending' : 'ps-dot ps-dot-bad'} />{name}<strong>{ok ? 'READY' : pending ? 'PENDING' : 'UNAVAILABLE'}</strong></div>;
}

function Metric({ label, value, accent = false }: { label: string; value: string; accent?: boolean }): JSX.Element {
  return <div><span>{label}</span><strong className={accent ? 'ps-accent' : undefined}>{value}</strong></div>;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '00:00.0';
  const mins = Math.floor(seconds / 60);
  const secs = seconds - mins * 60;
  return `${String(mins).padStart(2, '0')}:${secs.toFixed(1).padStart(4, '0')}`;
}
