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
 * 2. Target drop dihitung dengan HIT-TEST terhadap kotak tiap panel yang diukur
 *    sekali saat drag dimulai. Mengukur ulang tiap gerakan membuat hasilnya
 *    berayun: begitu panel bertukar posisi, rect-nya ikut berubah dan
 *    keputusannya membalik terus-menerus.
 *
 *    Dulu perhitungannya "berapa banyak titik tengah yang sudah dilewati
 *    pointer secara vertikal". Itu hanya benar untuk satu kolom — begitu dua
 *    panel berdampingan, titik tengah mereka sama tingginya dan sumbu Y tidak
 *    lagi bisa membedakan kiri dari kanan. Hit-test per kotak bekerja untuk
 *    keduanya: satu kolom hanyalah kasus di mana tidak ada panel yang
 *    berbagi baris.
 *
 * 3. Perpindahan baru di-commit saat dilepas, bukan tiap pixel — dan sampai itu
 *    terjadi hanya garis penanda yang bergerak. Panel timeline berisi canvas;
 *    memindahkannya di tengah gerakan memaksa layout + redraw berulang.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import {
  DEFAULT_PANEL_ORDER,
  DEFAULT_RAIL_ORDER,
  studioActions,
  useStudio,
  type PanelId,
} from '../store';

/**
 * Panel yang dibentangkan penuh layar.
 *
 * Dua lapis, dan keduanya perlu:
 *   1. overlay `position: fixed` — selalu bekerja, di browser mana pun, dan
 *      inilah yang benar-benar menentukan tata letaknya;
 *   2. Fullscreen API — dicoba di atasnya supaya chrome browser ikut hilang.
 *      Ia bisa ditolak (iframe tanpa izin, gestur tidak dianggap), jadi
 *      kegagalannya diabaikan diam-diam: overlay-nya sudah cukup.
 *
 * Kalau user keluar dari fullscreen lewat Esc bawaan browser, `fullscreenchange`
 * yang menyinkronkan state — tanpa itu, overlay tetap menutupi layar sementara
 * browser sudah keluar, dan tombol keluarnya terasa "tidak berfungsi".
 */
function MaximizedPanel({
  item,
  aside,
}: {
  readonly item: StackItem;
  readonly aside?: ReactNode;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (typeof el?.requestFullscreen === 'function') {
      void el.requestFullscreen().catch(() => undefined);
    }

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        studioActions.clearMaximize();
      }
    };
    const onFsChange = (): void => {
      // `== null` (longgar) DISENGAJA: di lingkungan tanpa Fullscreen API
      // (jsdom, WebView tertentu) properti ini `undefined`, bukan `null`.
      // Dengan `=== null` cabang ini tidak pernah jalan dan overlay-nya
      // tertinggal menutupi layar setelah browser keluar fullscreen.
      if (document.fullscreenElement == null) studioActions.clearMaximize();
    };

    window.addEventListener('keydown', onKey, { capture: true });
    document.addEventListener('fullscreenchange', onFsChange);
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true });
      document.removeEventListener('fullscreenchange', onFsChange);
      // Kalau ditutup lewat tombol (bukan Esc browser), fullscreen-nya masih
      // aktif dan harus dilepas — kalau tidak, layar tetap penuh tanpa isi.
      // Fungsinya BELUM TENTU ADA — Fullscreen API opsional. Memanggilnya
      // tanpa cek melempar TypeError di dalam cleanup effect, yang menjatuhkan
      // seluruh unmount.
      if (document.fullscreenElement != null && typeof document.exitFullscreen === 'function') {
        void document.exitFullscreen().catch(() => undefined);
      }
    };
  }, []);

  return (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        background: 'var(--cy-bg)',
        padding: '16px',
        overflow: 'auto',
      }}
    >
      {aside === undefined ? null : <FloatingAside>{aside}</FloatingAside>}

      <div
        style={{
          position: 'relative',
          minWidth: 0,
          // Di mode penuh layar hanya ada tombol ✕.
          ['--cy-card-header-reserve' as string]: '32px',
        }}
      >
        {item.node}
        <button
          type="button"
          className="cy-btn-reset"
          aria-label="keluar dari mode penuh layar"
          title="Kembalikan (Esc)"
          onClick={() => studioActions.clearMaximize()}
          style={{
            position: 'absolute',
            top: '10px',
            right: '12px',
            zIndex: 2,
            width: '22px',
            height: '22px',
            display: 'grid',
            placeItems: 'center',
            color: 'var(--cy-accent)',
            fontSize: '11px',
            cursor: 'pointer',
            background: 'transparent',
            border: 'none',
          }}
        >
          ✕
        </button>
      </div>
    </div>
  );
}

/** Lebar bibir yang tetap terlihat saat rail melayang tertutup. */
const ASIDE_PEEK_PX = 16;

/**
 * Rail yang melayang di tepi kanan saat sebuah panel dibentangkan.
 *
 * DIRENDER DI DALAM ELEMEN FULLSCREEN, bukan di samping. Fullscreen API hanya
 * menampilkan subtree elemen yang di-fullscreen-kan; rail yang dirender di
 * tempat lain di pohon DOM tidak akan terlihat sama sekali begitu browser
 * masuk fullscreen sungguhan — dan itu terlihat seperti fitur yang rusak, bukan
 * seperti batasan API.
 *
 * Terbuka saat pointer masuk ATAU saat fokus keyboard masuk. Yang kedua bukan
 * pelengkap: tanpa itu, isi rail bisa di-Tab tapi tetap tersembunyi di luar
 * layar, dan fokus seolah menghilang.
 */
function FloatingAside({ children }: { readonly children: ReactNode }): JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <div
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={(e) => {
        // Fokus berpindah KE LUAR rail, bukan antar elemen di dalamnya.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        width: 'min(600px, 46vw)',
        zIndex: 3,
        display: 'flex',
        transform: open ? 'translateX(0)' : `translateX(calc(100% - ${ASIDE_PEEK_PX}px))`,
        transition: 'transform 160ms ease',
      }}
    >
      {/* Bibir yang selalu terlihat — tanpa penanda, tidak ada yang tahu rail
          itu masih ada dan bisa ditarik keluar. */}
      <div
        aria-hidden
        style={{
          width: `${ASIDE_PEEK_PX}px`,
          flex: '0 0 auto',
          background: 'var(--cy-surface-1)',
          borderLeft: '1px solid var(--cy-border)',
          display: 'grid',
          placeItems: 'center',
          color: 'var(--cy-text-muted)',
          fontSize: '10px',
          cursor: 'pointer',
        }}
      >
        ‹
      </div>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          overflow: 'auto',
          padding: '16px',
          background: 'var(--cy-bg)',
          borderLeft: '1px solid var(--cy-border)',
          boxShadow: open ? '-12px 0 32px #000000cc' : 'none',
        }}
      >
        {children}
      </div>
    </div>
  );
}

export interface StackItem {
  readonly id: PanelId;
  readonly node: ReactNode;
  /**
   * Berapa kolom yang ditempati kartu ini saat tumpukan memang dua kolom.
   * Default 1 (setengah lebar); 2 = selebar rail. Diabaikan begitu tata letak
   * jatuh ke satu kolom — di sana semuanya memang selebar rail.
   */
  readonly span?: 1 | 2;
}

// ── Geometri: semua murni, jadi bisa diuji tanpa layout ──────────────────────

/** Kotak satu panel dalam koordinat viewport. */
export interface ItemRect {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/**
 * Ke mana panel yang sedang diseret akan mendarat: menempel di sisi mana dari
 * panel `index`. `axis` menentukan sumbu yang memutuskan sisinya — dan sekaligus
 * arah garis penandanya, supaya penanda selalu menggambarkan celah yang
 * benar-benar akan ditempati.
 */
export interface DropTarget {
  readonly index: number;
  readonly side: 'before' | 'after';
  readonly axis: 'x' | 'y';
}

/**
 * Lebar minimum sebelum dua kolom boleh dipakai.
 *
 * Di bawah ini satu kolom lebih baik daripada dua. Angkanya berasal dari kontrol
 * paling rewel di rail: dengan gap 14 px dan padding kartu 16 px per sisi, rail
 * 540 px memberi trek slider ~240 px. Detent 0 dB Amplify (±0,4 dB dari rentang
 * 36 dB) masih ~2,7 px di sana, dan lima preset Render Speed masih muat satu
 * baris. Rail 360 px dipaksa dua kolom memberi trek ~140 px — detent-nya tinggal
 * ~1,5 px, artinya kontrolnya rusak, bukan sekadar sempit.
 */
export const MIN_TWO_COLUMN_WIDTH = 540;

/** Jumlah kolom yang benar-benar dipakai. `width` 0 (belum terukur) = 1 kolom:
 *  menebak lebar lalu salah berarti kartu sempit sempat tergambar. */
export function effectiveColumns(requested: 1 | 2, width: number): 1 | 2 {
  return requested === 2 && width >= MIN_TWO_COLUMN_WIDTH ? 2 : 1;
}

/** Jarak kuadrat pointer ke kotak; 0 kalau pointer ada DI DALAM kotak. */
function distanceTo(r: ItemRect, x: number, y: number): number {
  const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
  const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
  return dx * dx + dy * dy;
}

/**
 * Apakah panel `i` berbagi baris dengan panel lain?
 *
 * Ambangnya setengah tinggi terpendek, bukan "bersinggungan sedikit": dua baris
 * yang bersebelahan bisa punya selisih pembulatan sub-pixel, dan itu tidak boleh
 * terbaca sebagai satu baris.
 */
function sharesRow(rects: readonly ItemRect[], i: number): boolean {
  const a = rects[i];
  if (a === undefined) return false;
  const ha = a.bottom - a.top;
  return rects.some((b, j) => {
    if (j === i) return false;
    const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return overlap > 0.5 * Math.min(ha, b.bottom - b.top);
  });
}

/**
 * Panel terdekat dengan pointer, plus sisi mana yang dituju.
 *
 * Terdekat, bukan "yang menutupi pointer": grid meninggalkan celah antar kartu
 * dan baris terakhir bisa setengah kosong. Kalau hanya kotak yang tertutupi yang
 * dihitung, pointer di celah tidak menargetkan apa pun dan penanda berkedip.
 *
 * Sumbu keputusan mengikuti tetangga: panel yang berdampingan dipisah oleh sumbu
 * X (kiri/kanan), panel yang sendirian di barisnya oleh sumbu Y (atas/bawah).
 * Memakai Y untuk panel berdampingan akan membuat kiri dan kanan tidak bisa
 * dibedakan sama sekali.
 */
export function findDropTarget(
  rects: readonly ItemRect[],
  x: number,
  y: number,
): DropTarget | null {
  if (rects.length === 0) return null;
  let index = 0;
  let best = Infinity;
  for (let i = 0; i < rects.length; i += 1) {
    const d = distanceTo(rects[i]!, x, y);
    if (d < best) {
      best = d;
      index = i;
    }
  }
  const r = rects[index]!;
  const axis: 'x' | 'y' = sharesRow(rects, index) ? 'x' : 'y';
  const side =
    axis === 'x'
      ? x < (r.left + r.right) / 2
        ? 'before'
        : 'after'
      : y < (r.top + r.bottom) / 2
        ? 'before'
        : 'after';
  return { index, side, axis };
}

/** Posisi sisip dalam urutan yang MASIH memuat panel yang diseret (0..n). */
export const insertPosition = (t: DropTarget): number => t.index + (t.side === 'after' ? 1 : 0);

/**
 * Terjemahkan posisi sisip ke argumen `movePanel`.
 *
 * `movePanel` mencabut dulu panelnya baru menyisipkan, jadi tiap posisi di
 * KANAN/BAWAH asalnya bergeser satu ke kiri setelah pencabutan. Tanpa koreksi
 * ini panel yang diseret ke bawah selalu mendarat satu slot lebih jauh daripada
 * yang ditunjukkan penanda.
 */
export const toMoveIndex = (insertBefore: number, from: number): number =>
  insertBefore > from ? insertBefore - 1 : insertBefore;

/** Apakah target ini benar-benar memindahkan sesuatu? Sisi kiri dan sisi kanan
 *  dari posisi panel itu sendiri sama-sama berarti "tetap di tempat". */
const isNoop = (insertBefore: number, from: number): boolean =>
  insertBefore === from || insertBefore === from + 1;

// ── Komponen ─────────────────────────────────────────────────────────────────

interface DragState {
  readonly id: PanelId;
  /** Indeks asal panel dalam `sequence`. */
  readonly from: number;
  /** Kotak tiap panel (px, koordinat viewport) saat drag dimulai. */
  readonly rects: readonly ItemRect[];
}

export function ReorderableStack({
  items,
  stack = 'main',
  gap = '16px',
  columns = 1,
  overlayAside,
}: {
  readonly items: readonly StackItem[];
  /** Tumpukan mana yang diurutkan. Dua daftar terpisah di store. */
  readonly stack?: 'main' | 'rail';
  readonly gap?: string;
  /**
   * Jumlah kolom maksimum. Default 1 supaya tumpukan yang sudah ada (kolom
   * kiri: timeline + clip detail) tidak berubah sama sekali — dua kolom adalah
   * sesuatu yang diminta, bukan sesuatu yang terjadi.
   */
  readonly columns?: 1 | 2;
  /**
   * Konten yang ikut ditampilkan sebagai rail melayang saat salah satu panel
   * tumpukan ini dibentangkan. Harus dilewatkan ke sini (bukan dirender di
   * samping) supaya tetap terlihat di fullscreen native.
   */
  readonly overlayAside?: ReactNode;
}): JSX.Element {
  // Fallback: state lama/rusak tidak boleh menjatuhkan seluruh aplikasi.
  const mainOrder = useStudio((s) => s.panelOrder) ?? DEFAULT_PANEL_ORDER;
  const railOrder = useStudio((s) => s.railOrder) ?? DEFAULT_RAIL_ORDER;
  const order = stack === 'rail' ? railOrder : mainOrder;
  const maximized = useStudio((st) => st.maximizedPanel);
  const containerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [target, setTarget] = useState<DropTarget | null>(null);
  const [width, setWidth] = useState(0);

  // Lebar DIUKUR, bukan ditebak dari viewport: rail dibatasi persentase di
  // `StudioLayout`, jadi viewport tidak memberi tahu berapa lebar tumpukan ini
  // sebenarnya. `useLayoutEffect` supaya pengukuran pertama terjadi sebelum
  // paint — kalau tidak, satu frame sempat tergambar dengan kolom yang salah.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (el === null || columns < 2) return;
    const read = (): void => setWidth(el.getBoundingClientRect().width);
    read();
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [columns]);

  const cols = effectiveColumns(columns, width);

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
    const rects = Array.from(root.children).map((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    });
    setDrag({ id, from: sequence.indexOf(id), rects });
    setTarget(null);
  };

  const move = (e: React.PointerEvent<HTMLElement>): void => {
    if (drag === null) return;
    setTarget(findDropTarget(drag.rects, e.clientX, e.clientY));
  };

  const end = (e: React.PointerEvent<HTMLElement>): void => {
    if (drag !== null && target !== null) {
      const at = insertPosition(target);
      if (!isNoop(at, drag.from)) studioActions.movePanel(drag.id, toMoveIndex(at, drag.from));
    }
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setDrag(null);
    setTarget(null);
  };

  // Penanda duduk TEPAT di tengah celah antar kartu, jadi ia membaca sebagai
  // "di sini panelnya masuk" dan bukan sebagai garis milik salah satu kartu.
  const edge = `calc(${gap} / -2 - 1px)`;
  const markerShown = drag !== null && target !== null && !isNoop(insertPosition(target), drag.from);

  // Panel yang dibentangkan dirender SENDIRIAN, dan tumpukan aslinya tidak
  // dirender sama sekali. Alternatifnya — tumpukan tetap ada lalu satu kartu
  // dinaikkan z-index-nya — membuat canvas timeline hidup dua kali: keduanya
  // punya ResizeObserver dan keduanya menggambar ulang tiap frame.
  const maximizedItem = items.find((it) => it.id === maximized);
  if (maximizedItem !== undefined) {
    return <MaximizedPanel item={maximizedItem} aside={overlayAside} />;
  }

  return (
    <div
      ref={containerRef}
      style={{
        display: 'grid',
        gridTemplateColumns: cols === 2 ? 'repeat(2,minmax(0,1fr))' : 'minmax(0,1fr)',
        gap,
        minWidth: 0,
        alignItems: 'start',
      }}
    >
      {sequence.map((id, i) => {
        const item = items.find((it) => it.id === id);
        if (item === undefined) return null;
        const dragging = drag?.id === id;
        const showMarker = markerShown && target!.index === i;
        // Span hanya berlaku saat kolomnya memang dua; di satu kolom `span 2`
        // pada grid satu kolom adalah error yang diam-diam bikin baris kosong.
        const span = cols === 2 ? Math.min(item.span ?? 1, cols) : 1;

        return (
          <div key={id} style={{ position: 'relative', minWidth: 0, gridColumn: `span ${span}` }}>
            {showMarker ? (
              <div
                aria-hidden
                data-testid={`drop-marker-${target!.axis}`}
                style={{
                  position: 'absolute',
                  background: 'var(--cy-accent)',
                  boxShadow: '0 0 8px var(--cy-accent)',
                  // Sumbu X → batang TEGAK di antara dua kolom; sumbu Y → garis
                  // mendatar di antara dua baris. Arah garis tegak lurus arah
                  // perpindahan, jadi bentuknya sendiri sudah memberi tahu
                  // panelnya akan bergeser ke samping atau ke bawah.
                  ...(target!.axis === 'x'
                    ? {
                        top: 0,
                        bottom: 0,
                        width: '2px',
                        ...(target!.side === 'before' ? { left: edge } : { right: edge }),
                      }
                    : {
                        left: 0,
                        right: 0,
                        height: '2px',
                        ...(target!.side === 'before' ? { top: edge } : { bottom: edge }),
                      }),
                }}
              />
            ) : null}

            <div
              style={{
                opacity: dragging ? 0.55 : 1,
                minWidth: 0,
                // Beri tahu Card berapa ruang yang harus ia sisakan di kanan
                // header untuk ⛶ + ⋮⋮ di bawah ini (22+22 px + jarak + margin).
                ['--cy-card-header-reserve' as string]: '58px',
              }}
            >
              {item.node}
            </div>

            <button
              type="button"
              aria-label={`bentangkan panel ${id}`}
              title="Bentangkan penuh layar (Esc untuk keluar)"
              onClick={() => studioActions.toggleMaximize(id)}
              className="cy-btn-reset"
              style={{
                position: 'absolute',
                top: '10px',
                right: '38px',
                zIndex: 2,
                width: '22px',
                height: '22px',
                display: 'grid',
                placeItems: 'center',
                color: 'var(--cy-text-muted)',
                fontSize: '11px',
                cursor: 'pointer',
                background: 'transparent',
                border: 'none',
              }}
            >
              ⛶
            </button>

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
                // Alternatif keyboard: drag bukan satu-satunya jalan. Tetap
                // satu langkah dalam URUTAN LINEAR, bukan "pindah satu baris" —
                // urutan linear itulah yang disimpan dan yang dibaca ulang.
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
