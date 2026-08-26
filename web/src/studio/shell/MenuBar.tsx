/**
 * TOOLBAR MENU — deret ikon yang menempel di atas, tiap ikon membuka popup.
 *
 * Kenapa bentuknya begini, dan bukan panel-panel yang selalu terlihat:
 *
 * Studio ini tumbuh sampai punya kontrol untuk grid, loop, potong, stem, fade,
 * mixer, EQ, master, dan export. Semuanya terlihat sekaligus berarti permukaan
 * kerja yang sebenarnya — TIMELINE — tinggal sepertiga layar, dan tiap kontrol
 * yang ditambahkan berikutnya memakan bagiannya lagi. Toolbar ikon memutus
 * hubungan itu: tingginya TETAP berapa pun banyaknya menu.
 *
 * ATURAN POPUP:
 *   - hanya SATU terbuka. Beberapa popup sekaligus akan menutupi permukaan
 *     kerja yang justru sedang dilihat;
 *   - klik di luar, Esc, atau menekan ikonnya lagi menutupnya;
 *   - popup berjangkar di bawah ikonnya dan DIJEPIT ke tepi kanan layar, supaya
 *     menu paling kanan tidak terpotong.
 *
 * Transport TIDAK ikut jadi menu-saja: tombol PLAY duduk langsung di toolbar.
 * Perintah yang dipakai setiap beberapa detik tidak boleh butuh dua klik.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { studioActions, useStudio, type MenuId } from '../store';

export interface MenuDef {
  readonly id: MenuId;
  /** Glyph di tombol. Teks, bukan aset — repo ini tidak punya sprite ikon. */
  readonly icon: string;
  readonly label: string;
  readonly title: string;
  /** Lebar maksimum popup. Waveform butuh jauh lebih lebar dari daftar shortcut. */
  readonly width: number;
  readonly render: () => ReactNode;
}

const BTN: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '1px',
  minWidth: '52px',
  height: '40px',
  padding: '0 8px',
  background: 'transparent',
  border: '1px solid transparent',
  color: 'var(--cy-text-dim)',
  fontFamily: 'var(--cy-font-mono)',
  cursor: 'pointer',
};

function MenuButton({
  def,
  open,
  onToggle,
}: {
  readonly def: MenuDef;
  readonly open: boolean;
  readonly onToggle: (el: HTMLButtonElement) => void;
}): JSX.Element {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <button
      ref={ref}
      type="button"
      data-menu-button={def.id}
      aria-expanded={open}
      aria-label={def.label}
      title={def.title}
      className="cy-btn-reset cy-focusable cy-hover-accent-border"
      onClick={() => {
        if (ref.current !== null) onToggle(ref.current);
      }}
      style={{
        ...BTN,
        color: open ? 'var(--cy-accent)' : 'var(--cy-text-dim)',
        borderColor: open ? 'var(--cy-accent)' : 'transparent',
        background: open ? 'var(--cy-surface-2)' : 'transparent',
      }}
    >
      <span aria-hidden style={{ fontSize: '15px', lineHeight: 1 }}>
        {def.icon}
      </span>
      <span style={{ fontSize: '8px', letterSpacing: '.12em' }}>{def.label}</span>
    </button>
  );
}

export function MenuBar({
  menus,
  leading,
  trailing,
}: {
  readonly menus: readonly MenuDef[];
  /** Kontrol yang SELALU terlihat di kiri (transport). */
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;
}): JSX.Element {
  const openMenu = useStudio((s) => s.openMenu);
  const barRef = useRef<HTMLDivElement>(null);
  const [anchorLeft, setAnchorLeft] = useState(0);

  const active = menus.find((m) => m.id === openMenu) ?? null;

  /**
   * Klik di luar + Esc menutup.
   *
   * `pointerdown`, bukan `click`: menekan tombol di dalam timeline sudah memulai
   * gerakannya (drag clip, kotak seleksi) pada pointerdown, jadi menunggu
   * `click` berarti popup masih menutupi tempat yang sedang ditarik.
   */
  useEffect(() => {
    if (openMenu === null) return;
    const onDown = (e: PointerEvent): void => {
      const bar = barRef.current;
      if (bar !== null && e.target instanceof Node && bar.contains(e.target)) return;
      // Dialog milik sebuah menu boleh dirender lewat portal ke document.body
      // agar tidak terpotong overflow popup. Secara DOM ia memang "di luar"
      // bar, tetapi secara interaksi masih anak menu itu. Tanpa pengecualian
      // ini, pointerdown tombol FIX & EXPORT menutup menu EXPORT pada capture
      // phase, meng-unmount CompileCard, lalu ikut melenyapkan dialognya.
      if (e.target instanceof Element && e.target.closest('[data-menu-owned-overlay]') !== null) {
        return;
      }
      studioActions.closeMenu();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') studioActions.closeMenu();
    };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [openMenu]);

  // Jepit ke tepi kanan SETELAH layout: popup menu paling kanan akan menjorok
  // keluar layar kalau posisinya cuma disamakan dengan tombolnya.
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (bar === null || active === null) return;
    const max = Math.max(0, bar.clientWidth - active.width - 8);
    setAnchorLeft((l) => Math.min(l, max));
  }, [active]);

  return (
    <div
      ref={barRef}
      data-menu-bar
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 30,
        // Latar PEKAT: bar ini melintas di atas waveform timeline, dan tombol di
        // atas gelombang kuning tidak terbaca.
        background: 'var(--cy-surface-1)',
        borderBottom: '1px solid var(--cy-border-strong)',
        boxShadow: '0 6px 18px #000000cc',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          padding: '4px 16px',
          flexWrap: 'wrap',
        }}
      >
        {leading}
        {leading === undefined ? null : (
          <span style={{ width: '1px', height: '26px', background: 'var(--cy-border)', margin: '0 6px' }} />
        )}
        {menus.map((m) => (
          <MenuButton
            key={m.id}
            def={m}
            open={openMenu === m.id}
            onToggle={(el) => {
              const bar = barRef.current;
              if (bar !== null) {
                const rect = el.getBoundingClientRect();
                const base = bar.getBoundingClientRect();
                setAnchorLeft(Math.max(0, rect.left - base.left));
              }
              studioActions.toggleMenu(m.id);
            }}
          />
        ))}
        {trailing === undefined ? null : (
          <>
            <span style={{ width: '1px', height: '26px', background: 'var(--cy-border)', margin: '0 6px' }} />
            {trailing}
          </>
        )}
      </div>

      {active === null ? null : (
        <div
          data-menu-popover={active.id}
          role="dialog"
          aria-label={active.label}
          style={{
            position: 'absolute',
            top: '100%',
            left: `${anchorLeft}px`,
            width: `min(${active.width}px, calc(100vw - 32px))`,
            maxHeight: 'calc(100vh - 160px)',
            overflowY: 'auto',
            background: 'var(--cy-surface-1)',
            border: '1px solid var(--cy-accent)',
            boxShadow: '0 10px 30px #000000e6',
            padding: '12px 14px 14px',
            zIndex: 31,
          }}
        >
          {active.render()}
        </div>
      )}
    </div>
  );
}
