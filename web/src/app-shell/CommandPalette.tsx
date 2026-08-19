/**
 * Command palette — pintu KEDUA ke registry, dan buktinya bahwa registry itu
 * berguna.
 *
 * Ia tidak tahu satu pun nama aksi. Yang ditampilkannya adalah apa pun yang
 * sedang terdaftar, jadi halaman baru yang mendaftarkan command-nya langsung
 * muncul di sini tanpa satu baris pun perubahan di berkas ini.
 *
 * Command yang sedang TIDAK bisa dijalankan tetap ditampilkan, dalam keadaan
 * redup. Menyembunyikannya akan membuat user mengira aksinya tidak ada, lalu
 * mencarinya di tempat lain.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { isCommandEnabled, listCommands, runCommand, subscribeCommands } from './command';
import { chordFor, subscribeKeymap } from './keymap';
import { chordLabel } from './keys';

/**
 * Skor kecocokan. `null` = tidak cocok. Makin BESAR makin relevan.
 *
 * Subsekuens murni tidak cukup, dan itu ketahuan dari tes: untuk query "putar",
 * "**A**pl**i**kasi B**u**ka daf**t**ar perint**a**h" ikut cocok — dan karena
 * urutannya alfabetis, ia mendarat di ATAS "Putar / jeda". Palette yang
 * meranking omong kosong di baris pertama lebih buruk daripada tidak ada
 * palette: Enter jadi tombol yang hasilnya harus dibaca dulu.
 *
 * Tiga bonus, dan ketiganya menjawab hal yang berbeda:
 *
 *  - **beruntun** — huruf yang berdempetan hampir selalu yang dimaksud user;
 *  - **awal kata** — "pj" untuk "Putar / jeda" harus mengalahkan huruf yang
 *    kebetulan tersebar di tengah kata lain;
 *  - **posisi awal** — kecocokan di judul lebih berarti daripada di nama grup,
 *    dan judul ditaruh lebih dulu saat menyusun teksnya.
 */
function score(text: string, query: string): number | null {
  if (query === '') return 0;
  const t = text.toLowerCase();
  const q = query.toLowerCase();

  let i = 0;
  let total = 0;
  let previous = -2;
  for (let at = 0; at < t.length && i < q.length; at += 1) {
    if (t[at] !== q[i]) continue;
    let bonus = 1;
    if (at === previous + 1) bonus += 6;
    const before = at === 0 ? ' ' : (t[at - 1] ?? ' ');
    if (before === ' ' || before === '·' || before === '/') bonus += 4;
    // Kecocokan lebih awal sedikit lebih berharga, tapi tidak sampai
    // mengalahkan kecocokan beruntun di belakang.
    bonus += Math.max(0, 3 - Math.floor(at / 12));
    total += bonus;
    previous = at;
    i += 1;
  }
  return i === q.length ? total : null;
}

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

export function CommandPalette({ open, onClose }: CommandPaletteProps): JSX.Element | null {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [version, setVersion] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Daftar command dan keymap sama-sama bisa berubah saat palette terbuka
  // (halaman berpindah di belakangnya); keduanya memicu hitung ulang.
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
    if (!open) return;
    setQuery('');
    setCursor(0);
    inputRef.current?.focus();
  }, [open]);

  const rows = useMemo(() => {
    void version;
    // JUDUL lebih dulu, baru grup: kecocokan di nama aksi harus menang atas
    // kecocokan di nama kelompoknya.
    const scored = listCommands()
      .map((c) => ({ c, s: score(`${c.title} ${c.group}`, query) }))
      .filter((x): x is { c: (typeof x)['c']; s: number } => x.s !== null);

    scored.sort(
      (a, b) =>
        b.s - a.s ||
        a.c.group.localeCompare(b.c.group) ||
        a.c.title.localeCompare(b.c.title),
    );
    return scored.map((x) => x.c);
  }, [query, version]);

  if (!open) return null;

  const pick = (i: number): void => {
    const c = rows[i];
    if (c === undefined) return;
    onClose();
    runCommand(c.id);
  };

  return (
    <div
      role="dialog"
      aria-label="daftar perintah"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        background: 'var(--cy-overlay)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '12vh',
      }}
    >
      <div
        style={{
          width: 'min(560px, 92vw)',
          background: 'var(--cy-surface-1)',
          border: '1px solid var(--cy-border-strong)',
          boxShadow: 'var(--cy-glow-soft)',
          display: 'flex',
          flexDirection: 'column',
          maxHeight: '64vh',
        }}
      >
        <input
          ref={inputRef}
          value={query}
          placeholder="KETIK UNTUK MENCARI PERINTAH"
          aria-label="cari perintah"
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setCursor((c) => Math.min(rows.length - 1, c + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setCursor((c) => Math.max(0, c - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              pick(cursor);
            }
          }}
          style={{
            background: 'var(--cy-surface-2)',
            border: 'none',
            borderBottom: '1px solid var(--cy-border)',
            color: 'var(--cy-text)',
            fontFamily: 'var(--cy-font-mono)',
            fontSize: '13px',
            padding: '10px 12px',
            outline: 'none',
          }}
        />
        <div style={{ overflowY: 'auto', minHeight: 0 }}>
          {rows.length === 0 ? (
            <div style={{ padding: '14px', fontSize: '11px', color: 'var(--cy-text-muted)' }}>
              TIDAK ADA PERINTAH YANG COCOK
            </div>
          ) : (
            rows.map((c, i) => {
              const usable = isCommandEnabled(c);
              const chord = chordFor(c.id);
              return (
                <button
                  key={c.id}
                  type="button"
                  className="cy-btn-reset"
                  onPointerEnter={() => setCursor(i)}
                  onClick={() => pick(i)}
                  style={{
                    display: 'flex',
                    width: '100%',
                    alignItems: 'center',
                    gap: '10px',
                    padding: '6px 12px',
                    textAlign: 'left',
                    fontFamily: 'var(--cy-font-mono)',
                    background: i === cursor ? '#ffd4001a' : 'transparent',
                    borderLeft:
                      i === cursor ? '2px solid var(--cy-accent)' : '2px solid transparent',
                    cursor: 'pointer',
                    // Redup, bukan hilang: aksi yang sedang tidak bisa dipakai
                    // tetap harus bisa DITEMUKAN.
                    opacity: usable ? 1 : 0.4,
                  }}
                >
                  <span style={{ fontSize: '9px', color: 'var(--cy-text-muted)', width: '74px' }}>
                    {c.group.toUpperCase()}
                  </span>
                  <span style={{ fontSize: '12px', color: 'var(--cy-text)', flex: 1 }}>
                    {c.title}
                  </span>
                  {chord !== null && (
                    <span style={{ fontSize: '10px', color: 'var(--cy-accent)' }}>
                      {chordLabel(chord)}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
