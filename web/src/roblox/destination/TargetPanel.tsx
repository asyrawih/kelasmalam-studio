/**
 * Kartu TUJUAN — ke akun/grup mana asset ini diunggah, dan dengan kunci apa.
 *
 * Foldernya `destination`, BUKAN `target`: `.gitignore` repo ini mengabaikan
 * setiap direktori bernama `target` (folder build Cargo), jadi berkas di sana
 * tidak akan pernah ikut ter-commit — dan kegagalannya senyap.
 *
 * ## API key ditampilkan sebagai `type="password"`, dan itu bukan teater
 *
 * Halaman ini dipakai sambil merekam layar dan sambil berbagi layar, dan API
 * key Open Cloud bisa membuat asset atas nama pemiliknya tanpa batas. Kolomnya
 * punya tombol LIHAT supaya user tetap bisa memeriksa apa yang ia tempel —
 * menyembunyikan tanpa jalan keluar hanya memindahkan salahnya ke tempat lain.
 *
 * Yang TIDAK dilakukan halaman ini: menyimpan kunci itu. Lihat catatan di
 * `store.ts`.
 */

import { useState } from 'react';

import { Badge, Button, Card } from '../../ui/cyber';
import { targetProblems, type CreatorKind, type RobloxTarget } from '../model';

export interface TargetPanelProps {
  readonly target: RobloxTarget;
  readonly onCreatorKind: (kind: CreatorKind) => void;
  readonly onCreatorId: (id: string) => void;
  readonly onApiKey: (key: string) => void;
  /** Dikunci selama ada baris yang sedang berjalan. */
  readonly locked: boolean;
}

const LABEL = {
  fontSize: '9px',
  letterSpacing: '.18em',
  color: 'var(--cy-text-muted)',
  textTransform: 'uppercase',
} as const;

const FIELD = {
  width: '100%',
  background: 'var(--cy-surface-2)',
  color: 'var(--cy-text)',
  border: '1px solid var(--cy-border)',
  fontFamily: 'var(--cy-font-mono)',
  fontSize: '11px',
  padding: '7px 9px',
} as const;

const KINDS: readonly { readonly id: CreatorKind; readonly label: string }[] = [
  { id: 'user', label: 'AKUN SAYA' },
  { id: 'group', label: 'GRUP' },
];

export function TargetPanel({
  target,
  onCreatorKind,
  onCreatorId,
  onApiKey,
  locked,
}: TargetPanelProps): JSX.Element {
  const [reveal, setReveal] = useState(false);
  const problems = targetProblems(target);

  return (
    <Card
      title="Tujuan"
      subtitle="pemilik asset"
      notched
      actions={
        problems.length === 0 ? (
          <Badge tone="success" height={22} dot>
            LENGKAP
          </Badge>
        ) : (
          <Badge tone="warning" height={22}>
            {problems.length} BELUM
          </Badge>
        )
      }
      style={{ display: 'grid', gap: '12px' }}
    >
      <div style={{ display: 'grid', gap: '5px' }}>
        <span style={LABEL}>Diunggah sebagai</span>
        <div role="group" aria-label="pemilik asset" style={{ display: 'flex', gap: '6px' }}>
          {KINDS.map((k) => (
            <Button
              key={k.id}
              size="sm"
              variant="outline"
              disabled={locked}
              active={target.creatorKind === k.id}
              aria-pressed={target.creatorKind === k.id}
              onClick={() => onCreatorKind(k.id)}
            >
              {k.label}
            </Button>
          ))}
        </div>
      </div>

      <div style={{ display: 'grid', gap: '5px' }}>
        <label htmlFor="rbx-creator" style={LABEL}>
          {target.creatorKind === 'group' ? 'ID grup' : 'ID user'}
        </label>
        <input
          id="rbx-creator"
          className="cy-focusable"
          // `inputMode` numerik, tapi `type="text"`: `type="number"` di kolom
          // identitas membawa panah naik-turun dan roda tetikus yang bisa
          // MENGUBAH id tanpa disadari saat halaman digulir.
          inputMode="numeric"
          placeholder="123456789"
          value={target.creatorId}
          disabled={locked}
          onChange={(e) => onCreatorId(e.target.value)}
          style={FIELD}
        />
      </div>

      <div style={{ display: 'grid', gap: '5px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <label htmlFor="rbx-key" style={LABEL}>
            API key Open Cloud
          </label>
          <button
            type="button"
            className="cy-btn-reset cy-focusable"
            onClick={() => setReveal((v) => !v)}
            style={{ fontSize: '9px', letterSpacing: '.14em', color: 'var(--cy-accent)', cursor: 'pointer' }}
          >
            {reveal ? 'SEMBUNYIKAN' : 'LIHAT'}
          </button>
        </div>
        <input
          id="rbx-key"
          className="cy-focusable"
          type={reveal ? 'text' : 'password'}
          autoComplete="off"
          spellCheck={false}
          placeholder="tempel kunci dari create.roblox.com"
          value={target.apiKey}
          disabled={locked}
          onChange={(e) => onApiKey(e.target.value)}
          style={FIELD}
        />
        <span style={{ fontSize: '9px', lineHeight: 1.7, color: 'var(--cy-text-muted)' }}>
          Kunci hanya disimpan di memori tab ini dan hilang saat halaman dimuat ulang.
        </span>
      </div>

      {problems.length > 0 ? (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: '3px' }}>
          {problems.map((p) => (
            <li key={p} style={{ fontSize: '9px', letterSpacing: '.06em', color: 'var(--cy-warning)' }}>
              ! {p}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}
