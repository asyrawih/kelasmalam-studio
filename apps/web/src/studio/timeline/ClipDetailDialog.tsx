/**
 * Dialog Clip Detail — dibuka dengan DOUBLE-CLICK pada clip di timeline.
 *
 * KENAPA DIALOG, BUKAN KARTU DI BAWAH TIMELINE: Clip Detail memakai tinggi
 * yang tidak sedikit (kotak waveform + aksi + dua baris fade), dan setiap
 * piksel yang dipakainya diambil dari timeline — permukaan tempat pekerjaan
 * sebenarnya terjadi. Sebagai kartu, ia selalu hadir walau sedang tidak
 * dipakai; sebagai dialog, ia hanya muncul saat sebuah clip benar-benar
 * dibuka, lalu mengembalikan seluruh layar ke timeline saat ditutup.
 *
 * KENAPA DOUBLE-CLICK: klik tunggal sudah punya arti yang mahal di timeline
 * (memilih, dan memulai drag clip). Menumpangkan "buka detail" di atasnya akan
 * memunculkan dialog setiap kali user hanya ingin memindahkan clip. Double-
 * click adalah gestur "buka" yang sudah dihafal tangan dari file manager mana
 * pun, dan tidak pernah terjadi tanpa sengaja saat menyeret.
 *
 * ISINYA BUKAN SALINAN. Dialog ini memasang komponen yang SAMA dengan yang
 * dipakai popup menu di toolbar (`ClipHeader`, `ClipWavePanel`,
 * `ClipEditPanel` dari `./ClipPanels`). Dua jalan menuju panel yang sama:
 * toolbar untuk sentuhan cepat, double-click untuk kerja dalam. Kalau isinya
 * disalin, keduanya akan menyimpang pelan-pelan dan tidak ada yang tahu versi
 * mana yang benar.
 *
 * Komponen-komponen itu TIDAK menerima prop clip: mereka membaca clip yang
 * dipajang dari `<BeatProvider>`. Jadi dialog ini wajib berada di dalam
 * provider tersebut (di aplikasi ia terpasang di akar), dan yang perlu
 * dilakukan pemanggil sebelum membuka hanyalah memilih clip-nya.
 */

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';

import { Button } from '../../ui/cyber';
import { ClipEditPanel, ClipHeader, ClipWavePanel } from './ClipPanels';

/** Kontrol yang bisa difokus di dalam dialog. Tidak menyaring visibilitas:
 *  jsdom melaporkan semua elemen 0×0, dan penyaringan itu akan mematikan
 *  jebakan fokus di tes tanpa terlihat. */
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex="0"]';

const NOTCH = '12px';

/**
 * Tinggi kotak waveform = pecahan tinggi badan dialog, bukan angka tetap per
 * mode.
 *
 * Dengan angka tetap ("260 saat jendela, 560 saat fullscreen") setiap ukuran
 * layar di antara keduanya salah: di laptop pendek waveform-nya mendorong
 * tombol fade keluar layar, di monitor tinggi ia menyisakan ruang kosong.
 * Pecahan dari tinggi yang BENAR-BENAR ada membuat fullscreen tidak perlu
 * diperlakukan sebagai kasus khusus sama sekali — ia hanya badan yang lebih
 * tinggi.
 */
const WAVE_FRACTION = 0.46;
const MIN_WAVE_H = 180;
const MAX_WAVE_H = 620;
/** Dipakai sampai badan dialog terukur (dan di lingkungan tanpa ResizeObserver). */
const FALLBACK_WAVE_H = 260;

function clampWave(h: number): number {
  return Math.max(MIN_WAVE_H, Math.min(MAX_WAVE_H, Math.round(h)));
}

export interface ClipDetailDialogProps {
  readonly onClose: () => void;
}

export function ClipDetailDialog({ onClose }: ClipDetailDialogProps): JSX.Element {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [waveH, setWaveH] = useState(FALLBACK_WAVE_H);

  /**
   * Fokus masuk ke dialog begitu ia muncul, dan kembali ke elemen pemanggil
   * (clip di timeline) saat ditutup — lewat cara apa pun ia ditutup, jadi
   * pemulihannya ada di cleanup, bukan di masing-masing tombol.
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

  /** Tinggi waveform mengikuti tinggi badan yang sebenarnya (lihat WAVE_FRACTION). */
  useEffect(() => {
    const el = bodyRef.current;
    if (el === null || typeof ResizeObserver === 'undefined') return;
    const measure = (): void => {
      const h = el.clientHeight;
      if (h > 0) setWaveH((cur) => (Math.abs(cur - clampWave(h * WAVE_FRACTION)) < 2 ? cur : clampWave(h * WAVE_FRACTION)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /**
   * Keluar dari fullscreen BAWAAN BROWSER harus mengembalikan dialog ke ukuran
   * jendela.
   *
   * User bisa keluar lewat Esc bawaan browser atau tombol OS, dan itu tidak
   * melewati tombol kita sama sekali. Tanpa sinkronisasi ini, dialog tetap
   * digambar seukuran layar penuh sementara browser sudah kembali normal —
   * yang terlihat sebagai tombol fullscreen yang "tidak berfungsi".
   *
   * `== null` (longgar) DISENGAJA: di lingkungan tanpa Fullscreen API (jsdom,
   * WebView tertentu) properti ini `undefined`, bukan `null`.
   */
  useEffect(() => {
    const onFsChange = (): void => {
      if (document.fullscreenElement == null) setFullscreen(false);
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  /** Dialog hilang (unmount) sementara browser masih fullscreen = layar penuh
   *  berisi halaman di belakangnya. Selalu dikembalikan. */
  useEffect(
    () => () => {
      if (document.fullscreenElement != null && typeof document.exitFullscreen === 'function') {
        void document.exitFullscreen().catch(() => undefined);
      }
    },
    [],
  );

  /**
   * Fullscreen dua lapis, dan keduanya perlu:
   *   1. tata letak `position: fixed` yang mengisi viewport — selalu bekerja,
   *      di browser mana pun, dan inilah yang benar-benar menentukan ukurannya;
   *   2. Fullscreen API di atasnya, supaya chrome browser ikut hilang. Ia bisa
   *      ditolak (iframe tanpa izin, gestur tidak dianggap), jadi kegagalannya
   *      diabaikan diam-diam — lapisan pertama sudah cukup.
   *
   * Permintaannya dikirim DI DALAM handler klik, bukan dari effect: Fullscreen
   * API hanya menerima permintaan yang lahir dari gestur user, dan effect yang
   * jalan setelah render sudah kehilangan status itu di sebagian browser.
   */
  const toggleFullscreen = useCallback((): void => {
    const el = dialogRef.current;
    const next = !fullscreen;
    setFullscreen(next);
    if (next) {
      if (typeof el?.requestFullscreen === 'function') {
        void el.requestFullscreen().catch(() => undefined);
      }
      return;
    }
    if (document.fullscreenElement != null && typeof document.exitFullscreen === 'function') {
      void document.exitFullscreen().catch(() => undefined);
    }
  }, [fullscreen]);

  const close = useCallback((): void => {
    if (document.fullscreenElement != null && typeof document.exitFullscreen === 'function') {
      void document.exitFullscreen().catch(() => undefined);
    }
    onClose();
  }, [onClose]);

  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>): void {
    if (e.key === 'Escape') {
      // Esc pertama MENGECILKAN, bukan menutup: kehilangan seluruh dialog
      // hanya karena ingin keluar dari layar penuh adalah dua langkah mundur
      // untuk satu langkah yang diminta.
      e.stopPropagation();
      if (fullscreen) {
        toggleFullscreen();
        return;
      }
      close();
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
      data-clip-detail-backdrop
      // `mousedown`, bukan `click`: drag yang dimulai di dalam dialog dan
      // berakhir di luar tetap melahirkan `click` di backdrop, dan dialog akan
      // tertutup saat user cuma menyeret handle fade melewati tepi.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      onKeyDown={onKeyDown}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'var(--cy-overlay)',
        display: 'grid',
        placeItems: 'center',
        padding: fullscreen ? 0 : '16px',
      }}
    >
      <div
        ref={dialogRef}
        data-clip-detail-dialog
        data-fullscreen={fullscreen ? 'true' : 'false'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="cy-focusable"
        style={{
          // Sengaja BESAR: yang dinilai di sini adalah bentuk gelombang, dan
          // fade 8 detik pada kotak selebar 400 px hanyalah beberapa piksel
          // kemiringan — tidak ada yang bisa disetel dari situ.
          width: fullscreen ? '100vw' : 'min(1180px, 94vw)',
          height: fullscreen ? '100vh' : 'min(820px, 88vh)',
          background: 'var(--cy-surface-1)',
          border: fullscreen ? 'none' : '1px solid var(--cy-border)',
          boxShadow: fullscreen ? 'none' : 'var(--cy-glow-lime)',
          fontFamily: 'var(--cy-font-mono)',
          color: 'var(--cy-text)',
          display: 'grid',
          // Kepala tetap, badan yang menggulir: tombol tutup & fullscreen tidak
          // boleh ikut hanyut ke atas saat isinya panjang.
          gridTemplateRows: 'auto minmax(0,1fr)',
          minHeight: 0,
          clipPath: fullscreen
            ? undefined
            : `polygon(${NOTCH} 0, 100% 0, 100% calc(100% - ${NOTCH}), calc(100% - ${NOTCH}) 100%, 0 100%, 0 ${NOTCH})`,
        }}
      >
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            borderBottom: '1px solid var(--cy-border)',
            padding: '12px 16px',
            minWidth: 0,
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
              whiteSpace: 'nowrap',
            }}
          >
            Clip Detail
          </h2>
          {/* Identitas clip ada DI KEPALA, bukan di dalam badan yang menggulir:
              begitu badan digulir ke bawah, nama clip yang sedang diubah harus
              tetap terbaca — itu satu-satunya penjaga dari mengedit clip yang
              salah. */}
          <div style={{ minWidth: 0, flex: 1 }}>
            <ClipHeader />
          </div>
          <Button
            size="sm"
            variant="outline"
            aria-pressed={fullscreen}
            title={fullscreen ? 'kembali ke ukuran jendela (Esc)' : 'bentangkan ke seluruh layar'}
            onClick={toggleFullscreen}
          >
            {fullscreen ? '⤡ WINDOW' : '⤢ FULLSCREEN'}
          </Button>
          <button
            type="button"
            aria-label="tutup clip detail"
            title="tutup (Esc)"
            className="cy-btn-reset cy-focusable"
            onClick={close}
            style={{
              width: '26px',
              height: '26px',
              display: 'grid',
              placeItems: 'center',
              background: 'transparent',
              border: 'none',
              color: 'var(--cy-accent)',
              fontSize: '12px',
              cursor: 'pointer',
            }}
          >
            ✕
          </button>
        </header>

        <div
          ref={bodyRef}
          style={{
            minHeight: 0,
            overflow: 'auto',
            padding: '14px 16px 18px',
            display: 'flex',
            flexDirection: 'column',
            gap: '14px',
          }}
        >
          <ClipWavePanel height={waveH} />
          <ClipEditPanel />
        </div>
      </div>
    </div>
  );

  return createPortal(body, document.body);
}
