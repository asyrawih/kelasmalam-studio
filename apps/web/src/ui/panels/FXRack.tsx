/**
 * FX Rack — `span 4` di design.
 *
 * Baris: padding 11px 10px, border --cy-border, background surface-1, opacity
 * 0.45 saat efek off, Badge dot (success saat on, default saat off) berisi
 * nama efek, nilai ringkas rata kanan 10px, dan handle `⋮⋮` untuk reorder.
 * Di bawahnya kotak dashed `+ ADD INSERT`.
 *
 * Reorder memicu rebuild ProcessPlan di Rust dan me-reset state DSP efek yang
 * dipindah (docs/08 §FX Rack) — karena itu handle-nya ada tapi perintahnya
 * belum dikirim: `Cmd::ReorderFx` belum punya opcode di `audio/sab-layout.ts`.
 * Menaruh drag-reorder yang hanya mengubah tampilan akan berbohong tentang
 * apa yang didengar user, jadi handle-nya sengaja non-aktif sampai opcode ada.
 */

import { Badge, Card } from '../cyber';
import { useEngineCommands, useUiStore } from '../../state';

export function FXRack(): JSX.Element {
  const cmd = useEngineCommands();
  const focusedTrackId = useUiStore((s) => s.focusedTrackId);
  const tracks = useUiStore((s) => s.project.tracks);
  const track = tracks.find((t) => t.id === focusedTrackId) ?? tracks[0];
  const chain = track?.insertChain ?? [];

  return (
    <Card title="FX Rack" subtitle={`${track?.name ?? '—'} insert chain`} notched>
      <div style={{ display: 'grid', gap: '6px' }}>
        {chain.map((fx) => (
          <div
            key={fx.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              padding: '11px 10px',
              border: '1px solid var(--cy-border)',
              background: 'var(--cy-surface-1)',
              opacity: fx.bypassed ? 0.45 : 1,
            }}
          >
            <button
              type="button"
              className="cy-btn-reset cy-focusable"
              aria-pressed={!fx.bypassed}
              title={fx.bypassed ? 'Enable insert' : 'Bypass insert'}
              onClick={() => {
                if (track !== undefined) cmd.setFxBypass(track.id, fx.id, !fx.bypassed);
              }}
              style={{ cursor: 'pointer' }}
            >
              <Badge tone={fx.bypassed ? 'default' : 'success'} dot height={22}>
                {fx.kind}
              </Badge>
            </button>
            <span
              style={{
                marginLeft: 'auto',
                fontSize: '10px',
                color: 'var(--cy-text-dim)',
                letterSpacing: '.1em',
              }}
            >
              {fx.valueLabel}
            </span>
            <span
              style={{ color: 'var(--cy-text-muted)', fontSize: '12px', cursor: 'not-allowed' }}
              title="Reorder butuh Cmd::ReorderFx di command ring (docs/08 §FX Rack) — belum ada opcode-nya."
            >
              ⋮⋮
            </span>
          </div>
        ))}
        {chain.length === 0 ? (
          <div
            style={{
              padding: '11px 10px',
              border: '1px solid var(--cy-border)',
              background: 'var(--cy-surface-1)',
              fontSize: '10px',
              letterSpacing: '.14em',
              color: 'var(--cy-text-muted)',
            }}
          >
            NO INSERTS ON THIS TRACK
          </div>
        ) : null}
        <div
          className="cy-hover-add"
          title="AddFx butuh Cmd::AddFx + katalog efek (docs/08 §FX Rack)."
          style={{
            padding: '10px',
            border: '1px dashed var(--cy-border-strong)',
            textAlign: 'center',
            fontSize: '10px',
            letterSpacing: '.16em',
            color: 'var(--cy-text-muted)',
            cursor: 'pointer',
          }}
        >
          + ADD INSERT
        </div>
      </div>
    </Card>
  );
}
