/**
 * Daftar shortcut + pengubahnya.
 *
 * Menekan sebuah baris membuatnya MENUNGGU TOMBOL, dan selama itu dispatcher
 * dimatikan — kalau tidak, chord yang sedang ditangkap akan ikut menjalankan
 * command yang sudah memilikinya, dan user tidak pernah bisa merebut tombol
 * yang sudah terpakai.
 *
 * Chord yang direbut dari command lain dilaporkan lewat baris status, bukan
 * ditolak. Menolak dengan "sudah dipakai" memaksa user melepas binding lama di
 * tempat lain lebih dulu — dua langkah untuk satu maksud.
 */

import { useEffect, useMemo, useState } from 'react';

import { Button } from '../ui/cyber';
import { listCommands, subscribeCommands } from './command';
import { bindChord, chordFor, isCustomized, resetKeymap, subscribeKeymap, unbindCommand } from './keymap';
import { chordLabel, chordOf, isReservedChord } from './keys';

export interface KeymapEditorProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Diberi tahu saat penangkapan tombol mulai/berhenti. */
  readonly onCaptureChange: (capturing: boolean) => void;
}

export function KeymapEditor({ open, onClose, onCaptureChange }: KeymapEditorProps): JSX.Element | null {
  const [version, setVersion] = useState(0);
  const [capturing, setCapturing] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const bump = (): void => setVersion((v) => v + 1);
    const a = subscribeCommands(bump);
    const b = subscribeKeymap(bump);
    return () => {
      a();
      b();
    };
  }, []);

  useEffect(() => {
    onCaptureChange(capturing !== null);
  }, [capturing, onCaptureChange]);

  useEffect(() => {
    if (capturing === null) return undefined;
    const onKeyDown = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setCapturing(null);
        return;
      }
      // Modifier SENDIRIAN bukan chord — user masih di tengah menekan.
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
      const chord = chordOf(e);
      if (isReservedChord(chord)) {
        setNotice(`${chordLabel(chord)} milik browser dan tidak bisa diambil alih`);
        return;
      }
      const r = bindChord(capturing, chord);
      setNotice(r.ok ? (r.reason ?? null) : (r.reason ?? 'gagal mengikat'));
      setCapturing(null);
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [capturing]);

  const groups = useMemo(() => {
    void version;
    const out = new Map<string, ReturnType<typeof listCommands>[number][]>();
    for (const c of listCommands()) {
      const list = out.get(c.group) ?? [];
      list.push(c);
      out.set(c.group, list);
    }
    for (const list of out.values()) list.sort((a, b) => a.title.localeCompare(b.title));
    return [...out.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [version]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-label="pintasan keyboard"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        background: 'var(--cy-overlay)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          width: 'min(720px, 94vw)',
          maxHeight: '80vh',
          background: 'var(--cy-surface-1)',
          border: '1px solid var(--cy-border-strong)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '10px 12px',
            borderBottom: '1px solid var(--cy-border)',
          }}
        >
          <span style={{ fontSize: '12px', letterSpacing: '.16em', color: 'var(--cy-accent)' }}>
            PINTASAN KEYBOARD
          </span>
          <span style={{ fontSize: '10px', color: 'var(--cy-text-muted)' }}>
            klik sebuah pintasan lalu tekan tombol barunya · Esc membatalkan
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '6px' }}>
            <Button size="sm" variant="ghost" onClick={() => resetKeymap()}>
              KEMBALIKAN BAWAAN
            </Button>
            <Button size="sm" variant="ghost" onClick={onClose}>
              ✕
            </Button>
          </div>
        </div>

        <div style={{ overflowY: 'auto', minHeight: 0, padding: '4px 0' }}>
          {groups.map(([group, list]) => (
            <div key={group}>
              <div
                style={{
                  fontSize: '9px',
                  letterSpacing: '.18em',
                  color: 'var(--cy-text-muted)',
                  padding: '8px 12px 3px',
                }}
              >
                {group.toUpperCase()}
              </div>
              {list.map((c) => {
                const chord = chordFor(c.id);
                const custom = isCustomized(c.id);
                return (
                  <div
                    key={c.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '3px 12px',
                    }}
                  >
                    <span style={{ fontSize: '11px', color: 'var(--cy-text)', flex: 1 }}>
                      {c.title}
                    </span>
                    {custom && (
                      <span
                        style={{ fontSize: '8px', color: 'var(--cy-text-muted)' }}
                        title="berbeda dari bawaan"
                      >
                        DIUBAH
                      </span>
                    )}
                    <button
                      type="button"
                      className="cy-btn-reset"
                      onClick={() => {
                        setNotice(null);
                        setCapturing(c.id);
                      }}
                      style={{
                        minWidth: '92px',
                        fontSize: '10px',
                        padding: '2px 8px',
                        fontFamily: 'var(--cy-font-mono)',
                        color:
                          capturing === c.id ? 'var(--cy-text-on-accent)' : 'var(--cy-accent)',
                        background: capturing === c.id ? 'var(--cy-accent)' : 'var(--cy-surface-2)',
                        border: '1px solid var(--cy-border-strong)',
                        cursor: 'pointer',
                      }}
                    >
                      {capturing === c.id
                        ? 'TEKAN TOMBOL…'
                        : chord === null
                          ? '—'
                          : chordLabel(chord)}
                    </button>
                    <button
                      type="button"
                      className="cy-btn-reset"
                      disabled={chord === null}
                      onClick={() => unbindCommand(c.id)}
                      title="lepas pintasan — perintahnya tetap ada di command palette"
                      style={{
                        fontSize: '10px',
                        padding: '2px 6px',
                        fontFamily: 'var(--cy-font-mono)',
                        color: 'var(--cy-text-muted)',
                        background: 'transparent',
                        border: '1px solid var(--cy-border)',
                        cursor: chord === null ? 'not-allowed' : 'pointer',
                        opacity: chord === null ? 0.35 : 1,
                      }}
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <div
          style={{
            padding: '6px 12px',
            borderTop: '1px solid var(--cy-border)',
            fontSize: '10px',
            minHeight: '22px',
            color: notice === null ? 'var(--cy-text-muted)' : '#ffb020',
          }}
        >
          {notice ?? 'pintasan disimpan di peramban ini'}
        </div>
      </div>
    </div>
  );
}
