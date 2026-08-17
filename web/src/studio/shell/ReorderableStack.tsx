/**
 * Tumpukan panel yang bisa diurutkan ulang dengan drag pada gagangnya.
 *
 * Keputusan bentuk:
 *
 * 1. Yang bisa di-drag hanya GAGANG (⋮⋮), bukan seluruh kartu. Kartu berisi
 *    canvas timeline, slider, dan tombol yang semuanya sudah memakai pointer;
 *    kalau kartunya sendiri bisa di-drag, tiap gerakan kecil saat men-trim clip
 *    berisiko memindahkan panel.
 *
 * 2. Urutan baru dihitung dari posisi pointer terhadap TITIK TENGAH tiap panel
 *    yang diukur sekali saat drag dimulai. Mengukur ulang tiap gerakan membuat
 *    hasilnya berayun: begitu panel bertukar posisi, rect-nya ikut berubah dan
 *    keputusannya membalik terus-menerus.
 *
 * 3. Perpindahan baru di-commit saat dilepas, bukan tiap pixel — dan sampai itu
 *    terjadi hanya garis penanda yang bergerak. Panel timeline berisi canvas;
 *    memindahkannya di tengah gerakan memaksa layout + redraw berulang.
 */

import { useRef, useState, type ReactNode } from 'react';

import {
  DEFAULT_PANEL_ORDER,
  DEFAULT_RAIL_ORDER,
  studioActions,
  useStudio,
  type PanelId,
} from '../store';

export interface StackItem {
  readonly id: PanelId;
  readonly node: ReactNode;
}

interface DragState {
  readonly id: PanelId;
  /** Titik tengah tiap panel (px, koordinat viewport) saat drag dimulai. */
  readonly midpoints: number[];
}

export function ReorderableStack({
  items,
  stack = 'main',
  gap = '16px',
}: {
  readonly items: readonly StackItem[];
  /** Tumpukan mana yang diurutkan. Dua daftar terpisah di store. */
  readonly stack?: 'main' | 'rail';
  readonly gap?: string;
}): JSX.Element {
  // Fallback: state lama/rusak tidak boleh menjatuhkan seluruh aplikasi.
  const mainOrder = useStudio((s) => s.panelOrder) ?? DEFAULT_PANEL_ORDER;
  const railOrder = useStudio((s) => s.railOrder) ?? DEFAULT_RAIL_ORDER;
  const order = stack === 'rail' ? railOrder : mainOrder;
  const containerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [targetIndex, setTargetIndex] = useState<number | null>(null);

  // Panel yang tidak ada di `order` (mis. baru ditambah di kode) tetap tampil
  // di bawah, daripada hilang diam-diam.
  const known = order.filter((id) => items.some((it) => it.id === id));
  const extra = items.map((it) => it.id).filter((id) => !known.includes(id));
  const sequence = [...known, ...extra];

  const begin = (id: PanelId, e: React.PointerEvent<HTMLElement>): void => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const root = containerRef.current;
    if (root === null) return;
    const mids = Array.from(root.children).map((el) => {
      const r = el.getBoundingClientRect();
      return r.top + r.height / 2;
    });
    setDrag({ id, midpoints: mids });
    setTargetIndex(sequence.indexOf(id));
  };

  const move = (e: React.PointerEvent<HTMLElement>): void => {
    if (drag === null) return;
    const y = e.clientY;
    // Indeks = berapa banyak titik tengah yang sudah dilewati pointer.
    let idx = 0;
    for (const m of drag.midpoints) {
      if (y > m) idx += 1;
    }
    setTargetIndex(Math.max(0, Math.min(sequence.length - 1, idx)));
  };

  const end = (e: React.PointerEvent<HTMLElement>): void => {
    if (drag !== null && targetIndex !== null) {
      studioActions.movePanel(drag.id, targetIndex);
    }
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setDrag(null);
    setTargetIndex(null);
  };

  return (
    <div ref={containerRef} style={{ display: 'grid', gap, minWidth: 0 }}>
      {sequence.map((id, i) => {
        const item = items.find((it) => it.id === id);
        if (item === undefined) return null;
        const dragging = drag?.id === id;
        const showMarker = drag !== null && targetIndex === i && !dragging;

        return (
          <div key={id} style={{ position: 'relative', minWidth: 0 }}>
            {showMarker ? (
              <div
                aria-hidden
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  top: '-9px',
                  height: '2px',
                  background: 'var(--cy-accent)',
                  boxShadow: '0 0 8px var(--cy-accent)',
                }}
              />
            ) : null}

            <div style={{ opacity: dragging ? 0.55 : 1, minWidth: 0 }}>{item.node}</div>

            <span
              role="button"
              tabIndex={0}
              aria-label={`pindahkan panel ${id}`}
              title="Drag untuk memindahkan panel · ↑/↓ juga bisa"
              onPointerDown={(e) => begin(id, e)}
              onPointerMove={move}
              onPointerUp={end}
              onPointerCancel={end}
              onKeyDown={(e) => {
                // Alternatif keyboard: drag bukan satu-satunya jalan.
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  studioActions.movePanel(id, i - 1);
                }
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  studioActions.movePanel(id, i + 1);
                }
              }}
              style={{
                position: 'absolute',
                top: '10px',
                right: '12px',
                zIndex: 2,
                width: '22px',
                height: '22px',
                display: 'grid',
                placeItems: 'center',
                color: dragging ? 'var(--cy-accent)' : 'var(--cy-text-muted)',
                fontSize: '12px',
                cursor: 'grab',
                touchAction: 'none',
                userSelect: 'none',
              }}
            >
              ⋮⋮
            </span>
          </div>
        );
      })}
    </div>
  );
}
