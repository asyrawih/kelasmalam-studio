/**
 * Daftar shortcut.
 *
 * Sumbernya SATU array di sini, dan itu disengaja: kalau daftar ini ditulis
 * terpisah dari implementasinya, ia akan basi diam-diam begitu ada binding yang
 * berubah. Tes di `shortcuts.test.tsx` memakai array ini juga, jadi shortcut
 * yang didokumentasikan tapi tidak berfungsi akan ketahuan.
 *
 * Modifier ditampilkan apa adanya (tanpa Cmd/Ctrl) karena semua binding
 * transport memang tanpa modifier — kombinasi ber-modifier sengaja diteruskan
 * ke browser (lihat useTransportShortcuts).
 */

import { Card } from '../../ui/cyber';

export interface ShortcutDoc {
  readonly keys: readonly string[];
  readonly label: string;
  /** Kelompok, untuk pemisah visual. */
  /**
   * `pointer` = gerakan tetikus, bukan tombol keyboard. Dipisah karena
   * `shortcuts-doc.test.tsx` memverifikasi bahwa setiap shortcut KEYBOARD yang
   * didokumentasikan benar-benar ditangani — gerakan pointer tidak bisa diuji
   * dengan cara itu, dan memaksakannya hanya akan melumpuhkan penjaga yang
   * berguna itu.
   */
  readonly group: 'transport' | 'edit' | 'pointer';
}

export const SHORTCUTS: readonly ShortcutDoc[] = [
  { keys: ['Space'], label: 'Play / pause', group: 'transport' },
  { keys: ['Backspace'], label: 'Kembali ke awal', group: 'transport' },
  { keys: ['Home'], label: 'Ke awal', group: 'transport' },
  { keys: ['End'], label: 'Ke akhir', group: 'transport' },
  { keys: ['←', '→'], label: 'Geser ±5 detik', group: 'transport' },
  { keys: ['Shift', '←', '→'], label: 'Geser ±1 detik', group: 'transport' },
  { keys: ['B'], label: 'Split di playhead', group: 'edit' },
  { keys: ['X'], label: 'Hapus clip terpilih', group: 'edit' },
  { keys: ['C'], label: 'Copy clip', group: 'edit' },
  { keys: ['V'], label: 'Paste clip di playhead', group: 'edit' },
  { keys: ['Drag'], label: 'Kotak seleksi di area kosong', group: 'pointer' },
  { keys: ['Shift', 'Klik'], label: 'Tambah/buang dari seleksi', group: 'pointer' },
  { keys: ['Space', 'Drag'], label: 'Geser tampilan timeline', group: 'pointer' },
];

function Key({ children }: { readonly children: string }): JSX.Element {
  return (
    <kbd
      style={{
        display: 'inline-grid',
        placeItems: 'center',
        minWidth: '18px',
        height: '18px',
        padding: '0 5px',
        border: '1px solid var(--cy-border-strong)',
        background: 'var(--cy-surface-2)',
        color: 'var(--cy-text-dim)',
        fontFamily: 'var(--cy-font-mono)',
        fontSize: '9px',
        letterSpacing: '.06em',
      }}
    >
      {children}
    </kbd>
  );
}

export function ShortcutsCard(): JSX.Element {
  return (
    <Card title="Shortcut" subtitle="berlaku di mana saja kecuali saat mengetik" notched>
      <div style={{ display: 'grid', gap: '6px' }}>
        {SHORTCUTS.map((s, i) => {
          const prev = SHORTCUTS[i - 1];
          const newGroup = prev !== undefined && prev.group !== s.group;
          return (
            <div
              key={s.label}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                paddingTop: newGroup ? '8px' : 0,
                borderTop: newGroup ? '1px solid var(--cy-border)' : 'none',
                marginTop: newGroup ? '2px' : 0,
              }}
            >
              <span style={{ display: 'flex', gap: '3px', flexShrink: 0 }}>
                {s.keys.map((k) => (
                  <Key key={k}>{k}</Key>
                ))}
              </span>
              <span
                style={{
                  fontSize: '10px',
                  color: 'var(--cy-text-dim)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {s.label}
              </span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
