/**
 * Transport Bar — `grid-column: span 12` di design.
 *
 * Struktur, ukuran, dan warna disalin dari design file baris per baris:
 * empat tombol 52×44 (play notched + solid aksen, stop/rec/loop surface-2),
 * display bar.beat.tick di kotak hitam min-width 210px, tiga kolom
 * Tempo/Signature/Key, lalu tiga badge di kanan.
 *
 * Playhead label TIDAK memakai React state: ia ditulis langsung ke DOM node
 * lewat ref dari rAF bersama (docs/08 §Ringkasan arus state poin 3). Kalau
 * dipasang lewat setState, transport bar akan me-render 60×/detik dan menyeret
 * seluruh pohon di bawahnya.
 */

import { useRef, useState } from 'react';
import { Badge, Card } from '../cyber';
import {
  useEngineCommands,
  useMeterFrame,
  useUiStore,
  type TransportMeta,
} from '../../state';
import { formatBarBeatTick } from '../lib/time';

const BTN_BASE: React.CSSProperties = {
  width: '52px',
  height: '44px',
  border: '1px solid var(--cy-border-strong)',
  fontFamily: 'var(--cy-font-mono)',
  cursor: 'pointer',
};

const LABEL: React.CSSProperties = {
  fontSize: '10px',
  letterSpacing: '.18em',
  color: 'var(--cy-text-muted)',
  textTransform: 'uppercase',
  marginBottom: '4px',
};

const VALUE: React.CSSProperties = {
  fontFamily: 'var(--cy-font-sans)',
  fontSize: '22px',
  fontWeight: 600,
  color: 'var(--cy-text)',
};

export function TransportBar(): JSX.Element {
  const cmd = useEngineCommands();
  const transport = useUiStore((s) => s.transport);
  const sampleRate = useUiStore((s) => s.project.sampleRate);
  const latencyMs = useUiStore((s) => s.latencyMs);
  const posRef = useRef<HTMLSpanElement>(null);

  useMeterFrame((frame) => {
    const node = posRef.current;
    if (node === null) return;
    const text = formatBarBeatTick(frame.transport.playhead, {
      bpm: transport.bpm,
      sampleRate,
      beatsPerBar: transport.timeSignature[0],
    });
    // Tulis hanya kalau berubah — menghindari layout thrash 60×/detik.
    if (node.textContent !== text) node.textContent = text;
  });

  return (
    <Card title="Transport Bar" notched glow>
    <div style={{ display: 'flex', alignItems: 'center', gap: '22px', flexWrap: 'wrap', paddingTop: '4px' }}>
      <div style={{ display: 'flex', gap: '8px' }}>
        <button
          type="button"
          aria-label={transport.playing ? 'Pause' : 'Play'}
          className="cy-btn-reset cy-focusable cy-hover-accent-bg"
          onClick={() => (transport.playing ? cmd.pause() : cmd.play())}
          style={{
            ...BTN_BASE,
            background: 'var(--cy-accent)',
            color: 'var(--cy-text-on-accent)',
            fontSize: '14px',
            clipPath:
              'polygon(8px 0,100% 0,100% calc(100% - 8px),calc(100% - 8px) 100%,0 100%,0 8px)',
            filter: 'var(--cy-glow-filter-soft)',
          }}
        >
          {transport.playing ? '❚❚' : '▶'}
        </button>
        <button
          type="button"
          aria-label="Stop"
          className="cy-btn-reset cy-focusable cy-hover-accent-border"
          onClick={() => cmd.stop()}
          style={{ ...BTN_BASE, background: 'var(--cy-surface-2)', color: 'var(--cy-text)', fontSize: '13px' }}
        >
          ■
        </button>
        <button
          type="button"
          aria-label="Record arm"
          aria-pressed={transport.recordArmed}
          className="cy-btn-reset cy-focusable cy-hover-rec"
          onClick={() => cmd.toggleRecordArm()}
          style={{ ...BTN_BASE, background: 'var(--cy-surface-2)', color: '#ff4d4d', fontSize: '18px' }}
        >
          ●
        </button>
        <button
          type="button"
          aria-label="Loop"
          aria-pressed={transport.loopEnabled}
          className="cy-btn-reset cy-focusable cy-hover-accent-border"
          onClick={() => cmd.setLoopEnabled(!transport.loopEnabled)}
          style={{
            ...BTN_BASE,
            background: 'var(--cy-surface-2)',
            color: transport.loopEnabled ? 'var(--cy-accent)' : 'var(--cy-text-dim)',
            fontSize: '14px',
          }}
        >
          ⟲
        </button>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: '10px',
          padding: '8px 18px',
          border: '1px solid var(--cy-border)',
          background: '#000',
          minWidth: '210px',
        }}
      >
        <span
          ref={posRef}
          style={{
            fontFamily: 'var(--cy-font-sans)',
            fontSize: '34px',
            fontWeight: 700,
            color: 'var(--cy-accent)',
            letterSpacing: '.06em',
            textShadow: 'var(--cy-text-glow)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          001.1.00
        </span>
        <span
          style={{
            fontSize: '10px',
            letterSpacing: '.18em',
            color: 'var(--cy-text-muted)',
            textTransform: 'uppercase',
          }}
        >
          bar.beat.tick
        </span>
      </div>

      <div style={{ display: 'flex', gap: '26px' }}>
        <div>
          <div style={LABEL}>Tempo</div>
          <div style={VALUE}>
            <TempoField transport={transport} onCommit={(bpm) => cmd.setTempo(bpm)} />
            <span style={{ fontSize: '11px', color: 'var(--cy-text-muted)', marginLeft: '4px' }}>BPM</span>
          </div>
        </div>
        <div>
          <div style={LABEL}>Signature</div>
          <div style={VALUE}>
            {transport.timeSignature[0]} / {transport.timeSignature[1]}
          </div>
        </div>
        <div>
          <div style={LABEL}>Key</div>
          <div style={VALUE}>{transport.key}</div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '10px', marginLeft: 'auto', alignItems: 'center' }}>
        <Badge tone={transport.recordArmed ? 'danger' : 'default'} dot>
          REC ARM
        </Badge>
        <Badge tone={transport.metronome ? 'accent' : 'default'}>METRONOME</Badge>
        <Badge tone="default">LATENCY {latencyMs.toFixed(1)} ms</Badge>
      </div>
    </div>
    </Card>
  );
}

/** Angka BPM yang bisa diedit. Design menampilkannya sebagai teks; membuatnya
 *  editable adalah satu-satunya penambahan interaksi di panel ini, dan
 *  tampilannya tidak berubah sedikit pun saat tidak difokus. */
function TempoField({
  transport,
  onCommit,
}: {
  readonly transport: TransportMeta;
  readonly onCommit: (bpm: number) => void;
}): JSX.Element {
  // Input terkontrol yang HANYA menerima nilai valid tidak bisa diketik: untuk
  // sampai ke "90" user harus melewati "9", yang ditolak, jadi field langsung
  // kembali ke nilai lama dan angka kedua tidak pernah bisa diketik. Karena itu
  // teks mentah disimpan sebagai draft; store hanya di-commit saat draft-nya
  // benar-benar sebuah BPM yang sah.
  const [draft, setDraft] = useState<string | null>(null);

  return (
    <input
      aria-label="Tempo BPM"
      value={draft ?? String(transport.bpm)}
      inputMode="numeric"
      onChange={(e) => {
        const raw = e.target.value;
        setDraft(raw);
        const v = Number.parseFloat(raw);
        if (Number.isFinite(v) && v >= 20 && v <= 300) onCommit(v);
      }}
      onBlur={() => setDraft(null)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          setDraft(null);
          e.currentTarget.blur();
        }
      }}
      style={{
        width: '3.2ch',
        background: 'transparent',
        border: 'none',
        outline: 'none',
        padding: 0,
        font: 'inherit',
        color: 'inherit',
        fontVariantNumeric: 'tabular-nums',
      }}
    />
  );
}
