/**
 * Popup konfigurasi SPLIT (docs/26 §3b) — pola dialog studio
 * (`LaneColorModal`/`ClipDetailDialog`): portal ke `body`, backdrop, jebakan
 * fokus, Escape menutup, kelas `cy-*`.
 *
 * Yang diputuskan di sini, bukan di `split-job.ts`:
 *   - sumber = `selectedClipId` di store; tanpa clip terpilih tombol PISAHKAN
 *     mati dengan alasan tertulis;
 *   - UNDUH model adalah tombol SENDIRI (`ensureVocalModel`), bukan bagian
 *     dari PISAHKAN — 66 MB yang turun karena satu klik "pisahkan" adalah
 *     kejutan; di sini barnya kelihatan lebih dulu;
 *   - PISAHKAN menutup dialog lalu memanggil `runVocalSplit`; progresnya
 *     tampil di lane sumber (`LaneImportOverlay`), bukan di dialog ini;
 *   - job ditolak saat export berjalan (docs/26 §2 butir 5) — `exportProgress`
 *     non-null di store berarti export sedang jalan;
 *   - runtime (docs/26 P3b) TIDAK diputuskan di sini: `probeVocalSplitRuntime`
 *     yang membacanya dari kontrak host. Dialog hanya menampilkan badge
 *     (`NATIVE · CPU` / `NATIVE · COREML` / `WASM`), menawarkan akselerasi
 *     kalau host native punya lebih dari satu, dan menyembunyikan THREAD saat
 *     akselerasinya bukan CPU.
 *
 * Galat dari job dilaporkan lewat `alert` (native di WebView desktop): studio
 * belum punya mekanisme notifikasi global, dan dialog ini sudah tertutup saat
 * galatnya datang.
 */

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';

import { findClip } from '@kelasmalam/studio/studio/model';
import { useStudio } from '@kelasmalam/studio/studio/store';
import { Button } from '@kelasmalam/ui/cyber';

import { VOCAL_MODELS, type VocalModelId } from './catalog';
import { cancelVocalSplit, runVocalSplit } from './split-job';
import {
  defaultVocalSplitThreads,
  ensureVocalModel,
  probeVocalSplitRuntime,
  setVocalSplitAccel,
  useVocalSplit,
  type VocalModelStatus,
  type VocalSplitAccel,
  type VocalSplitRuntime,
} from './split-session';

export interface VocalSplitDialogProps {
  readonly onClose: () => void;
}

export type VocalSplitOverlap = 0.25 | 0.5;

const OVERLAPS: readonly VocalSplitOverlap[] = [0.25, 0.5];

const LABEL: CSSProperties = {
  fontSize: '9px',
  letterSpacing: '.18em',
  textTransform: 'uppercase',
  color: 'var(--cy-text-muted)',
  marginBottom: '6px',
};

const ROW: CSSProperties = { marginBottom: '14px' };

const HINT: CSSProperties = { fontSize: '9px', letterSpacing: '.1em', color: 'var(--cy-text-dim)', lineHeight: 1.6 };

const NOTCH = '10px';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex="0"]';

/** `66759214` → `66,8 MB` (koma desimal, Bahasa Indonesia). */
export function formatModelSize(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1).replace('.', ',')} MB`;
}

/** Teks status model di baris MODEL (docs/26 §3b). */
export function modelStatusText(status: VocalModelStatus, bytes: number): string {
  switch (status.kind) {
    case 'idle':
      return `belum diunduh (${formatModelSize(bytes)})`;
    case 'loading':
      return status.ratio === null ? 'mengunduh …' : `mengunduh ${Math.round(status.ratio * 100)}%`;
    case 'ready':
      return 'siap';
    case 'error':
      return `gagal: ${status.message}`;
  }
}

const ACCEL_LABEL: Record<VocalSplitAccel, string> = { cpu: 'CPU', coreml: 'COREML' };

/** Teks badge runtime di header; kosong selama runtime belum diketahui. */
export function runtimeBadgeText(runtime: VocalSplitRuntime | null, accel: VocalSplitAccel): string {
  if (runtime === null) return '';
  return runtime === 'native' ? `NATIVE · ${ACCEL_LABEL[accel]}` : 'WASM';
}

function reportSplitError(err: unknown): void {
  const message = `Vocal split gagal: ${err instanceof Error ? err.message : String(err)}`;
  if (typeof alert === 'function') alert(message);
  else console.error(message);
}

export function VocalSplitDialog({ onClose }: VocalSplitDialogProps): JSX.Element {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  // Dua selector primitif/stabil, lalu `findClip` di render: selector yang
  // mengembalikan objek baru tiap panggilan membuat `useSyncExternalStore`
  // merender ulang tanpa henti.
  const lanes = useStudio((s) => s.lanes);
  const selectedClipId = useStudio((s) => s.selectedClipId);
  const selected = findClip(lanes, selectedClipId);
  const exporting = useStudio((s) => s.exportProgress !== null);
  const split = useVocalSplit();

  const [modelId] = useState<VocalModelId>('kim-vocal-2');
  const [overlap, setOverlap] = useState<VocalSplitOverlap>(0.25);
  const [denoise, setDenoise] = useState(false);
  const [threads, setThreads] = useState(() => defaultVocalSplitThreads());
  const [muteSource, setMuteSource] = useState(true);

  const model = VOCAL_MODELS[modelId];
  // Status hanya berlaku untuk model yang sesi-nya sedang dimuat; model lain
  // (kalau nanti ada) dianggap belum dimuat.
  const status: VocalModelStatus = split.modelId === modelId ? split.model : { kind: 'idle' };
  const running = split.job !== null;
  const maxThreads = Math.max(1, (typeof navigator === 'undefined' ? 2 : navigator.hardwareConcurrency) || 2);
  const native = split.runtime === 'native';
  // Pilihan akselerasi hanya kalau ada yang bisa dipilih; thread hanya berarti
  // untuk WASM dan CPU native.
  const showAccel = native && split.accels.length > 1;
  const showThreads = !native || split.accel === 'cpu';

  useEffect(() => {
    void probeVocalSplitRuntime();
  }, []);

  const blocker =
    selected === null
      ? 'pilih satu clip dulu'
      : running
        ? 'job split sedang berjalan — tunggu selesai atau hentikan'
        : exporting
          ? 'menunggu export selesai'
          : null;

  useLayoutEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => opener?.focus?.();
  }, []);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>): void {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const root = dialogRef.current;
    if (root === null) return;
    const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === root)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function download(): void {
    // Galatnya sudah masuk snapshot (`status.kind === 'error'`) dan tampil di
    // baris MODEL; tidak perlu dilaporkan dua kali.
    void ensureVocalModel(modelId, { maxThreads: threads }).catch(() => {});
  }

  function start(): void {
    if (selected === null || blocker !== null) return;
    const clipId = selected.clip.id;
    onClose();
    void runVocalSplit({ clipId, modelId, overlap, denoise, muteSource, maxThreads: threads }).catch(reportSplitError);
  }

  const body = (
    <div
      data-vocal-split-backdrop
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={onKeyDown}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'var(--cy-overlay)',
        display: 'grid',
        placeItems: 'center',
        padding: '16px',
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="cy-focusable"
        style={{
          width: 'min(420px, 100%)',
          background: 'var(--cy-surface-1)',
          border: '1px solid var(--cy-border)',
          boxShadow: 'var(--cy-glow-lime)',
          fontFamily: 'var(--cy-font-mono)',
          color: 'var(--cy-text)',
          padding: '14px 16px 16px',
          clipPath: `polygon(${NOTCH} 0, 100% 0, 100% calc(100% - ${NOTCH}), calc(100% - ${NOTCH}) 100%, 0 100%, 0 ${NOTCH})`,
        }}
      >
        <header
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: '10px',
            borderBottom: '1px solid var(--cy-border)',
            paddingBottom: '10px',
            marginBottom: '12px',
          }}
        >
          <h2
            id={titleId}
            style={{
              margin: 0,
              fontSize: '11px',
              fontWeight: 500,
              letterSpacing: '.22em',
              textTransform: 'uppercase',
              color: 'var(--cy-accent)',
            }}
          >
            Pisahkan Vokal
          </h2>
          <span style={{ fontSize: '9px', letterSpacing: '.12em', color: 'var(--cy-text-muted)' }}>MDX-NET</span>
          <span
            data-split-runtime
            title={native ? 'Inferensi di luar WebView (ort native)' : 'Inferensi ORT-web WASM di Web Worker'}
            style={{
              marginLeft: 'auto',
              fontSize: '9px',
              letterSpacing: '.14em',
              padding: '1px 6px',
              border: '1px solid var(--cy-border)',
              color: native ? 'var(--cy-accent)' : 'var(--cy-text-muted)',
              visibility: split.runtime === null ? 'hidden' : 'visible',
            }}
          >
            {runtimeBadgeText(split.runtime, split.accel)}
          </span>
        </header>

        {/* Sumber */}
        <div style={ROW}>
          <div style={LABEL}>Sumber</div>
          <div
            data-split-source
            style={{
              fontSize: '11px',
              letterSpacing: '.1em',
              color: selected === null ? 'var(--cy-text-dim)' : 'var(--cy-text)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {selected === null ? 'pilih satu clip dulu' : `${selected.clip.label} — ${selected.lane.name}`}
          </div>
        </div>

        {/* Model */}
        <div style={ROW}>
          <div style={LABEL}>Model</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '11px', letterSpacing: '.1em' }}>{model.label}</div>
              <div role="status" data-split-model-status style={{ ...HINT, color: status.kind === 'error' ? '#ff4d4d' : HINT.color }}>
                {modelStatusText(status, model.bytes)}
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={status.kind === 'loading' || status.kind === 'ready'}
              title="Unduh dan muat model ke perangkat ini — terpisah dari PISAHKAN"
              onClick={download}
            >
              {status.kind === 'ready' ? 'SIAP' : status.kind === 'loading' ? 'MENGUNDUH…' : 'UNDUH'}
            </Button>
          </div>
          {status.kind === 'loading' ? (
            <div style={{ height: '3px', marginTop: '6px', background: '#000', border: '1px solid var(--cy-border)' }}>
              <div
                style={{
                  height: '100%',
                  width: `${Math.round((status.ratio ?? 1) * 100)}%`,
                  background: 'linear-gradient(90deg,#ffd400,#ffb020 78%,#ff4d4d)',
                  opacity: status.ratio === null ? 0.35 : 1,
                }}
              />
            </div>
          ) : null}
        </div>

        {/* Overlap */}
        <div style={ROW}>
          <div style={LABEL}>Overlap</div>
          <div style={{ display: 'flex', gap: '8px' }}>
            {OVERLAPS.map((o) => (
              <Button
                key={o}
                size="sm"
                variant={overlap === o ? 'solid' : 'ghost'}
                aria-pressed={overlap === o}
                onClick={() => setOverlap(o)}
              >
                {o.toString().replace('.', ',')}
              </Button>
            ))}
          </div>
          <div style={{ ...HINT, marginTop: '4px' }}>makin besar makin halus dan makin lama</div>
        </div>

        {/* Denoise + mute */}
        <div style={{ ...ROW, display: 'grid', gap: '6px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '10px', letterSpacing: '.12em' }}>
            <input type="checkbox" checked={denoise} onChange={(e) => setDenoise(e.target.checked)} />
            DENOISE
            <span style={HINT}>(2× waktu)</span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '10px', letterSpacing: '.12em' }}>
            <input type="checkbox" checked={muteSource} onChange={(e) => setMuteSource(e.target.checked)} />
            MUTE LANE SUMBER
          </label>
        </div>

        {/* Akselerasi (hanya host native dengan lebih dari satu pilihan) */}
        {showAccel ? (
          <div style={ROW} data-split-accel>
            <div style={LABEL}>Akselerasi</div>
            <div style={{ display: 'flex', gap: '8px' }}>
              {split.accels.map((a) => (
                <Button
                  key={a}
                  size="sm"
                  variant={split.accel === a ? 'solid' : 'ghost'}
                  aria-pressed={split.accel === a}
                  onClick={() => setVocalSplitAccel(a)}
                >
                  {ACCEL_LABEL[a]}
                </Button>
              ))}
            </div>
            <div style={{ ...HINT, marginTop: '4px' }}>CoreML paling cepat; CPU kalau hasilnya aneh</div>
          </div>
        ) : null}

        {/* Thread */}
        {showThreads ? (
          <div style={ROW}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ ...LABEL, marginBottom: 0 }}>Thread</span>
              <input
                type="number"
                aria-label="thread"
                min={1}
                max={maxThreads}
                value={threads}
                onChange={(e) => {
                  const n = Number.parseInt(e.target.value, 10);
                  if (Number.isFinite(n)) setThreads(Math.max(1, Math.min(maxThreads, n)));
                }}
                style={{
                  width: '56px',
                  height: '28px',
                  padding: '0 6px',
                  background: 'var(--cy-surface-2)',
                  color: 'var(--cy-text)',
                  border: '1px solid var(--cy-border-strong)',
                  fontFamily: 'var(--cy-font-mono)',
                  fontSize: '11px',
                }}
              />
              <span style={HINT}>dari {maxThreads} core</span>
            </label>
          </div>
        ) : null}

        <div style={{ ...HINT, fontSize: '8px', marginBottom: '12px' }}>{model.attribution}</div>

        <div
          role="status"
          data-split-blocker
          style={{ fontSize: '9px', letterSpacing: '.12em', color: 'var(--cy-warning)', minHeight: '12px', marginBottom: '8px' }}
        >
          {blocker ?? ''}
        </div>

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          {running ? (
            <Button variant="ghost" onClick={() => cancelVocalSplit()}>
              Hentikan
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            Batal
          </Button>
          <Button disabled={blocker !== null} title={blocker ?? 'Pisahkan vokal dan instrumen jadi dua lane baru'} onClick={start}>
            Pisahkan
          </Button>
        </div>
      </div>
    </div>
  );

  return createPortal(body, document.body);
}
