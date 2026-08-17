/**
 * Sample Browser — `span 4` di design.
 *
 * Baris: padding 9px 10px, border --cy-border, background surface-1, ikon ▶
 * berwarna aksen, nama 11px dengan ellipsis, meta 9px letterspacing .12em, dan
 * tag kecil berbingkai di kanan. Hover: border aksen + surface-2.
 *
 * Library BUKAN bagian dari project model — ia state aplikasi (docs/08
 * §Sample Browser). Drag item ke arrangement memicu pipeline import
 * (docs/06 §6b); di sini yang ada baru payload drag-nya, karena pipeline
 * import belum ada di lapisan audio.
 */

import { Card } from '../cyber';
import { useUiStore } from '../../state';

export function SampleBrowser(): JSX.Element {
  const library = useUiStore((s) => s.library);

  return (
    <Card title="Sample Browser" subtitle="library" notched>
      <div style={{ display: 'grid', gap: '4px' }}>
        {library.map((item) => (
          <div
            key={item.id}
            className="cy-hover-row"
            draggable
            onDragStart={(e) => {
              // Payload dibaca ArrangementTimeline saat pipeline import siap.
              e.dataTransfer.setData('application/x-daw-library-item', item.id);
              e.dataTransfer.effectAllowed = 'copy';
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              padding: '9px 10px',
              border: '1px solid var(--cy-border)',
              background: 'var(--cy-surface-1)',
              cursor: 'pointer',
            }}
          >
            <span
              style={{ color: 'var(--cy-accent)', fontSize: '11px' }}
              title="Preview butuh Cmd::PreviewAsset (docs/08 §Sample Browser) — belum ada di ring."
            >
              ▶
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: '11px',
                  color: 'var(--cy-text)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {item.name}
              </div>
              <div
                style={{
                  fontSize: '9px',
                  color: 'var(--cy-text-muted)',
                  marginTop: '2px',
                  letterSpacing: '.12em',
                }}
              >
                {item.meta}
              </div>
            </div>
            <span
              style={{
                fontSize: '8px',
                letterSpacing: '.14em',
                color: 'var(--cy-text-dim)',
                border: '1px solid var(--cy-border)',
                padding: '2px 5px',
              }}
            >
              {item.tag}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}
