/**
 * Header bar — baris paling atas design: judul + subjudul, pemisah, ringkasan
 * project yang memotong dirinya sendiri kalau sempit, lalu badge status dan
 * tombol CLOSE di kanan.
 *
 * Penanda versi build menempel pada judul, bukan pada kelompok kanan: kelompok
 * kanan yang menyusut lebih dulu saat layar sempit, dan justru di situlah
 * pertanyaan "produksi lagi jalan versi apa" paling sering muncul.
 */

// Diimpor dari modulnya langsung, bukan dari barrel `../../app-shell`: barrel
// itu ikut memuat `AppShell` → `App`/`DjPage`, dan header tidak perlu menyeret
// seluruh aplikasi hanya untuk menampilkan nomor versi.
import { VersionTag } from '../../app-shell/VersionTag';
import { Badge, Button } from '../../ui/cyber';
import { useStudio } from '../store';
import { AutoStemToggle } from '../../stem/AutoStemToggle';

export interface StudioHeaderProps {
  readonly onClose?: () => void;
  /** Buka mixer DJ. Opsional supaya pemanggil lama (dan tes) tidak perlu ikut berubah. */
  readonly onOpenDj?: () => void;
}

export function StudioHeader({ onClose, onOpenDj }: StudioHeaderProps): JSX.Element {
  const laneCount = useStudio((s) => s.lanes.length);
  const sampleRate = useStudio((s) => s.sampleRate);
  const engineReady = useStudio((s) => s.engineReady);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '16px',
        padding: '14px 24px',
        borderBottom: '1px solid var(--cy-border)',
        background: 'var(--cy-surface-1)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px' }}>
        <span
          style={{
            fontFamily: 'var(--cy-font-sans)',
            fontSize: '22px',
            fontWeight: 700,
            letterSpacing: '.06em',
            color: 'var(--cy-text)',
          }}
        >
          KELAS MALAM STUDIO
        </span>
        <span style={{ fontSize: '11px', letterSpacing: '.16em', color: 'var(--cy-accent)' }}>
          // TIMELINE MIX
        </span>
        <VersionTag />
      </div>
      <div style={{ height: '22px', width: '1px', background: 'var(--cy-border)' }} />
      <div
        style={{
          minWidth: 0,
          fontSize: '11px',
          color: 'var(--cy-text-dim)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {`${laneCount} LANES · ${Math.round(sampleRate / 1000)} kHz · STEREO`}
      </div>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '10px' }}>
        <AutoStemToggle />
        {/* Design menulis READY tanpa syarat. Kita tidak boleh mengklaim siap
            kalau engine belum ada — badge-nya berubah, bukan berbohong. */}
        <Badge tone={engineReady ? 'success' : 'default'} dot>
          {engineReady ? 'READY' : 'UI ONLY'}
        </Badge>
        {onOpenDj !== undefined && (
          <Button size="sm" variant="outline" onClick={onOpenDj}>
            MODE DJ
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onClose}>
          ✕ CLOSE
        </Button>
      </div>
    </div>
  );
}
