/**
 * Modal pemilih warna lane.
 *
 * Warna lane BUKAN dekorasi: ia dipakai sebagai isi clip (`${color}24`), garis
 * tepi clip, warna teks label clip, dan warna waveform. Karena itu modal ini
 * memperlihatkan pratinjau clip sungguhan, bukan sekadar kotak warna — pilihan
 * harus dinilai dalam bentuk yang nanti benar-benar muncul di arrangement.
 *
 * Modal bekerja pada DRAFT: tidak ada satu pun tulisan ke store sampai APPLY
 * ditekan. Alternatifnya (menulis ke store setiap warna berubah lalu
 * mengembalikan nilai lama saat CANCEL) menaruh warna sementara ke dalam state
 * yang ikut tersimpan, dan setiap kegagalan di tengah jalan meninggalkan lane
 * dengan warna yang tidak pernah dipilih user.
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

import { LANE_COLORS } from '../model';
import { Button } from '../../ui/cyber';

// ── Hex ──────────────────────────────────────────────────────────────────────

/**
 * Normalisasi input hex user menjadi `#rrggbb` huruf kecil, atau `null` kalau
 * tidak sah.
 *
 * Aturannya sengaja ketat pada `#`: sebuah field warna yang diam-diam menerima
 * `abc` juga akan menerima potongan teks nyasar, dan user tidak pernah tahu
 * nilai mana yang sebenarnya terpakai. Huruf besar diterima (hex memang
 * case-insensitive) tapi selalu dikembalikan huruf kecil supaya perbandingan
 * dengan `LANE_COLORS` dan dengan warna lane yang tersimpan cukup `===`.
 */
export function parseHexColor(input: string): string | null {
  const s = input.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  // Bentuk pendek: setiap digit digandakan — #abc dan #aabbcc adalah warna yang
  // sama persis, jadi keduanya harus menghasilkan nilai tersimpan yang sama.
  if (/^#[0-9a-f]{3}$/.test(s)) return `#${s[1]!}${s[1]!}${s[2]!}${s[2]!}${s[3]!}${s[3]!}`;
  return null;
}

// ── Kontras ──────────────────────────────────────────────────────────────────

/** Latar tempat clip dan label-nya digambar (`--cy-bg`, dan gradien label di
 *  `ClipArea` juga #050505). Ini pembanding kontras yang benar. */
export const APP_BG = '#050505';

/**
 * Ambang peringatan. 3:1 adalah batas WCAG 1.4.11 untuk komponen non-teks —
 * dan waveform + garis tepi clip memang grafis, bukan paragraf. Ambang teks
 * (4.5:1) TIDAK dipakai karena `#6f6a5e` dari palet design sendiri berada di
 * 3.78:1: memakai 4.5 berarti memperingatkan user atas pilihan yang disediakan
 * aplikasi ini sendiri, dan peringatan yang selalu menyala berhenti dibaca.
 */
export const MIN_CONTRAST = 3;

/** Relative luminance WCAG 2.x. */
export function relativeLuminance(hex: string): number {
  const h = parseHexColor(hex);
  if (h === null) return 0;
  const chan = (i: number): number => {
    const v = Number.parseInt(h.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * chan(0) + 0.7152 * chan(1) + 0.0722 * chan(2);
}

/** Rasio kontras WCAG (1..21). Urutan argumen tidak berpengaruh. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** true kalau warna nyaris tak terlihat di atas latar aplikasi. */
export function isLowContrast(hex: string): boolean {
  return contrastRatio(hex, APP_BG) < MIN_CONTRAST;
}

// ── Komponen ─────────────────────────────────────────────────────────────────

export interface LaneColorModalProps {
  readonly laneName: string;
  /** Warna lane saat modal dibuka — nilai yang dipertahankan kalau CANCEL. */
  readonly initialColor: string;
  readonly onCancel: () => void;
  readonly onApply: (color: string) => void;
}

const LABEL: CSSProperties = {
  fontSize: '9px',
  letterSpacing: '.18em',
  textTransform: 'uppercase',
  color: 'var(--cy-text-muted)',
  marginBottom: '8px',
};

const NOTCH = '10px';

/** Selector kontrol yang bisa difokus di dalam dialog. Tidak menyaring
 *  visibilitas: jsdom melaporkan semua elemen 0×0, dan penyaringan itu akan
 *  mematikan jebakan fokus di tes tanpa terlihat. */
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex="0"]';

export function LaneColorModal({
  laneName,
  initialColor,
  onCancel,
  onApply,
}: LaneColorModalProps): JSX.Element {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(() => parseHexColor(initialColor) ?? '#ffd400');
  // Teks hex dipegang terpisah dari `draft`: saat user mengetik sesuatu yang
  // belum/tidak sah, yang diketiknya harus tetap ada di layar. Menyalin balik
  // dari `draft` akan menghapus ketikannya di tengah kalimat.
  const [hexText, setHexText] = useState(draft);

  const hexValid = parseHexColor(hexText) !== null;
  const lowContrast = isLowContrast(draft);

  /**
   * Fokus masuk ke dialog begitu ia muncul, dan kembali ke elemen pemanggil
   * (bar warna) saat ditutup — lewat cara apa pun modal ditutup, jadi
   * pemulihannya ada di cleanup, bukan di masing-masing tombol.
   *
   * `useLayoutEffect` supaya perpindahan fokus terjadi sebelum browser sempat
   * melukis: dengan `useEffect` ada satu frame di mana fokus masih di belakang
   * modal dan Tab pertama bisa lolos dari jebakan.
   */
  useLayoutEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => opener?.focus?.();
  }, []);

  /** Halaman di belakang tidak boleh ikut ter-scroll. Nilai lama dikembalikan
   *  apa adanya — bukan dipaksa jadi '' — supaya modal lain/CSS tidak rusak. */
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
      onCancel();
      return;
    }
    if (e.key !== 'Tab') return;

    // Jebakan fokus: Tab dari elemen terakhir kembali ke yang pertama, dan
    // sebaliknya. Tanpa ini fokus keluar ke timeline di belakang backdrop —
    // terlihat "hilang" karena elemen di belakang tidak bisa diklik.
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

  const body = (
    <div
      data-lane-color-backdrop
      // `mousedown`, bukan `click`: drag yang dimulai di dalam dialog dan
      // berakhir di luar tetap melahirkan `click` di backdrop, dan modal akan
      // tertutup saat user cuma menyeret melewati tepi field.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
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
          width: 'min(360px, 100%)',
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
            Warna Lane
          </h2>
          <span
            style={{
              fontSize: '10px',
              letterSpacing: '.12em',
              color: 'var(--cy-text-muted)',
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {laneName}
          </span>
        </header>

        <div style={LABEL}>Palet</div>
        <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
          {LANE_COLORS.map((c) => {
            const active = c === draft;
            return (
              <button
                key={c}
                type="button"
                className="cy-btn-reset cy-focusable"
                aria-label={`warna ${c}`}
                // `aria-pressed` (bukan sekadar cincin visual) supaya pembaca
                // layar juga tahu mana yang sedang terpilih.
                aria-pressed={active}
                onClick={() => {
                  setDraft(c);
                  setHexText(c);
                }}
                style={{
                  flex: 1,
                  height: '34px',
                  background: c,
                  cursor: 'pointer',
                  border: active ? '2px solid var(--cy-text)' : '1px solid var(--cy-border-strong)',
                  boxShadow: active ? 'var(--cy-glow-lime)' : 'none',
                }}
              />
            );
          })}
        </div>

        <div style={LABEL}>Warna bebas</div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '6px' }}>
          {/*
            `input type="color"` sengaja dipakai: pemilih warna native sudah
            punya eyedropper, riwayat, dan aksesibilitas OS. Menulis sendiri
            roda HSV berarti canvas + drag + keyboard sendiri — banyak kode
            untuk hasil yang lebih buruk dari yang sudah ada di setiap browser.
          */}
          <input
            type="color"
            aria-label="pemilih warna"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value.toLowerCase());
              setHexText(e.target.value.toLowerCase());
            }}
            style={{
              width: '44px',
              height: '30px',
              padding: 0,
              background: 'var(--cy-surface-2)',
              border: '1px solid var(--cy-border-strong)',
              cursor: 'pointer',
            }}
          />
          <input
            aria-label="kode hex"
            aria-invalid={!hexValid}
            value={hexText}
            spellCheck={false}
            placeholder="#rrggbb"
            onChange={(e) => {
              const raw = e.target.value;
              setHexText(raw);
              // Draft hanya bergerak untuk nilai yang sah; ketikan setengah
              // jadi ("#ff") tidak boleh membuat pratinjau berkedip hitam.
              const parsed = parseHexColor(raw);
              if (parsed !== null) setDraft(parsed);
            }}
            style={{
              flex: 1,
              minWidth: 0,
              height: '30px',
              padding: '0 8px',
              background: 'var(--cy-surface-2)',
              color: hexValid ? 'var(--cy-text)' : '#ff4d4d',
              border: `1px solid ${hexValid ? 'var(--cy-border-strong)' : '#ff4d4d'}`,
              fontFamily: 'var(--cy-font-mono)',
              fontSize: '11px',
              letterSpacing: '.1em',
            }}
          />
        </div>
        <div
          role="status"
          style={{
            fontSize: '9px',
            letterSpacing: '.12em',
            color: hexValid ? 'var(--cy-text-muted)' : '#ff4d4d',
            marginBottom: '14px',
            minHeight: '12px',
          }}
        >
          {hexValid ? 'FORMAT #RGB ATAU #RRGGBB' : 'HEX TIDAK VALID — CONTOH #FFD400'}
        </div>

        <div style={LABEL}>Pratinjau clip</div>
        {/*
          Persis seperti `ClipArea` menggambarnya: isi `${color}24`, tepi 1px
          warna penuh, label memakai warna itu juga. Pratinjau yang cuma kotak
          penuh akan terlihat jauh lebih terang daripada clip sungguhan.
        */}
        <div
          data-color-preview
          style={{
            background: APP_BG,
            border: '1px solid var(--cy-border)',
            padding: '8px',
            marginBottom: lowContrast ? '8px' : '16px',
          }}
        >
          <div
            style={{
              height: '36px',
              background: `${draft}24`,
              border: `1px solid ${draft}`,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                fontSize: '9px',
                letterSpacing: '.1em',
                color: draft,
                padding: '3px 6px',
                whiteSpace: 'nowrap',
              }}
            >
              {laneName}
            </div>
          </div>
        </div>

        {lowContrast ? (
          // Peringatan, BUKAN larangan: warna gelap kadang memang disengaja
          // untuk lane pendamping. Yang tidak boleh adalah user menemukannya
          // sendiri setelah label clip-nya lenyap di arrangement.
          <div
            role="status"
            style={{
              fontSize: '9px',
              letterSpacing: '.12em',
              lineHeight: 1.6,
              color: 'var(--cy-warning)',
              border: '1px solid var(--cy-border-strong)',
              padding: '6px 8px',
              marginBottom: '16px',
            }}
          >
            WARNA INI NYARIS TAK TERLIHAT DI LATAR GELAP — LABEL CLIP DAN WAVEFORM AKAN SULIT
            DIBACA. TETAP BISA DIPAKAI.
          </div>
        ) : null}

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onCancel}>
            Batal
          </Button>
          <Button
            // Menerapkan hex yang tidak sah berarti diam-diam memakai warna
            // lain dari yang tertulis di field — lebih baik tombolnya mati.
            disabled={!hexValid}
            onClick={() => onApply(draft)}
          >
            Terapkan
          </Button>
        </div>
      </div>
    </div>
  );

  return createPortal(body, document.body);
}
