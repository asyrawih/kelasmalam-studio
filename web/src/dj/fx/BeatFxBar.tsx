/**
 * Baris Beat FX — dirakit SEPENUHNYA dari katalog efek Rust.
 *
 * Tidak ada satu pun nama efek yang ditulis di berkas ini. Katalognya datang
 * dari `crates/engine/src/fx/registry.rs` lewat `fxCatalogJson`, jadi efek
 * kesembilan yang ditambahkan di Rust muncul di sini tanpa satu baris
 * TypeScript pun — janji yang sama dengan yang sudah dipegang `FxCard` di
 * Studio.
 *
 * ## Dua hal yang dibaca dari katalog, bukan diasumsikan
 *
 * 1. **Knob besar.** `pflag::PRIMARY` di Rust harfiah berbunyi "parameter
 *    'besar' gaya rekordbox — satu knob raksasa di panel FX". Panel ini
 *    mencarinya, bukan menebak parameter pertama.
 * 2. **Pemilih pembagian beat.** Hanya muncul kalau ada parameter ber-flag
 *    `BEAT_SYNC`. Itu penting karena rentangnya BERBEDA per efek di rekordbox —
 *    DELAY/ECHO/SPIRAL 1/16–16, FILTER/FLANGER/PHASER sampai 64 — dan REVERB
 *    serta PITCH **tidak memakai ketukan sama sekali** (persen). Memasang
 *    pemilih beat di semua efek adalah kesalahan yang terlihat benar.
 *
 * ## Tempo
 *
 * Efek ber-`BEAT_SYNC` percuma tanpa tempo, dan sampai `fxchain_set_tempo`
 * ditambahkan ke ABI (`crates/wasm-bridge/src/raw.rs`) satu-satunya nilai yang
 * pernah dipakai `ParamCtx::frames_per_beat` adalah `sample_rate * 0.5` — 120
 * BPM mati. Sekarang panjang ketukan dikirim dari BPM efektif deck target, jadi
 * "1/4 ketukan" berarti 1/4 ketukan LAGU ITU. Lihat `audio/fx-insert.ts`.
 */

import { PFLAG, type EffectDesc } from '../../audio/fx-catalog';
import { Button } from '../../ui/cyber';
import { sortedEffects, useFxCatalog } from '../../studio/fx/useFxCatalog';
import { FX_BEAT_DIVS, type FxTargetDj } from '../model';
import { djActions, useDj } from '../store';
import { Knob } from '../mixer/Knob';

const TARGETS: readonly FxTargetDj[] = ['A', 'B', 'master'];

function hasBeatSync(desc: EffectDesc | undefined): boolean {
  return desc !== undefined && desc.params.some((p) => (p.flags & PFLAG.BEAT_SYNC) !== 0);
}

function primaryName(desc: EffectDesc | undefined): string {
  if (desc === undefined) return 'LEVEL';
  const primary = desc.params.find((p) => (p.flags & PFLAG.PRIMARY) !== 0);
  return primary?.name ?? desc.params[0]?.name ?? 'LEVEL';
}

function beatLabel(b: number): string {
  return b < 1 ? `1/${Math.round(1 / b)}` : String(b);
}

export function BeatFxBar(): JSX.Element {
  const fx = useDj((s) => s.fx);
  const notice = useDj((s) => s.notice);
  const { catalog, error } = useFxCatalog();

  const effects = catalog === null ? [] : sortedEffects(catalog);
  const active = catalog?.get(fx.kind);
  const beatSync = hasBeatSync(active);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '6px 10px',
        background: 'var(--cy-surface-1)',
        minWidth: 0,
        overflowX: 'auto',
      }}
    >
      <span style={{ fontSize: '10px', letterSpacing: '.16em', color: 'var(--cy-text-dim)' }}>
        BEAT FX
      </span>

      <select
        value={fx.kind}
        onChange={(e) => djActions.setFxKind(e.target.value)}
        aria-label="efek"
        style={{
          background: 'var(--cy-surface-2)',
          color: 'var(--cy-accent)',
          border: '1px solid var(--cy-border-strong)',
          fontFamily: 'var(--cy-font-mono)',
          fontSize: '10px',
          padding: '3px 6px',
        }}
      >
        <option value="">{catalog === null ? '— MEMUAT —' : '— PILIH —'}</option>
        {effects.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
      </select>

      <div style={{ display: 'flex', gap: '2px' }}>
        {TARGETS.map((t) => (
          <button
            key={t}
            type="button"
            className="cy-btn-reset"
            onClick={() => djActions.setFxTarget(t)}
            style={{
              fontSize: '9px',
              letterSpacing: '.12em',
              padding: '3px 8px',
              fontFamily: 'var(--cy-font-mono)',
              color: fx.target === t ? 'var(--cy-text-on-accent)' : 'var(--cy-text-dim)',
              background: fx.target === t ? 'var(--cy-accent)' : 'var(--cy-surface-2)',
              border: '1px solid var(--cy-border)',
              cursor: 'pointer',
            }}
          >
            {t === 'master' ? 'MASTER' : `CH ${t}`}
          </button>
        ))}
      </div>

      {/*
        Pemilih pembagian beat hanya muncul untuk efek yang PUNYA parameter
        ber-`BEAT_SYNC`. Itu dibaca dari katalog, bukan diasumsikan: di
        rekordbox rentangnya berbeda per efek, dan REVERB serta PITCH tidak
        memakai ketukan sama sekali. Memasangnya di semua efek adalah kesalahan
        yang terlihat benar.
      */}
      {beatSync ? (
        <div
          style={{ display: 'flex', gap: '2px', alignItems: 'center' }}
          title="panjang efek dalam ketukan LAGU target — dikirim ke engine lewat fxchain_set_tempo"
        >
          {FX_BEAT_DIVS.map((b) => (
            <button
              key={b}
              type="button"
              className="cy-btn-reset"
              onClick={() => djActions.setFxBeats(b)}
              style={{
                fontSize: '9px',
                padding: '3px 5px',
                fontFamily: 'var(--cy-font-mono)',
                color: fx.beats === b ? 'var(--cy-text-on-accent)' : 'var(--cy-text-muted)',
                background: fx.beats === b ? 'var(--cy-accent)' : 'var(--cy-surface-2)',
                border: '1px solid var(--cy-border)',
                cursor: 'pointer',
              }}
            >
              {beatLabel(b)}
            </button>
          ))}
        </div>
      ) : null}

      <Knob
        label={primaryName(active)}
        value={fx.level}
        min={0}
        max={1}
        center={0.5}
        size={34}
        format={(v) => `${Math.round(v * 100)}%`}
        onChange={(v) => djActions.setFxLevel(v)}
      />

      <Button
        size="sm"
        variant={fx.on ? 'solid' : 'outline'}
        onClick={() => djActions.toggleFx()}
        disabled={fx.kind === ''}
        title="efek disisipkan (insert) pada kanal target — LEVEL adalah dry/wet, bukan kirim"
        style={{ height: '26px', padding: '0 14px', fontSize: '10px' }}
      >
        {fx.on ? 'ON' : 'OFF'}
      </Button>

      {/*
        Satu baris status untuk kegagalan yang HARUS dibaca user: SYNC yang
        ditolak, import yang gagal, katalog yang tidak bisa dimuat. Ditaruh di
        sini karena inilah baris yang selalu terlihat tanpa menutupi apa pun.
      */}
      <div
        style={{
          marginLeft: 'auto',
          fontSize: '10px',
          color: notice === null ? 'var(--cy-text-muted)' : '#ffb020',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          minWidth: 0,
        }}
        title={notice ?? undefined}
      >
        {notice ?? (error !== null ? `KATALOG FX: ${error}` : '')}
      </div>
    </div>
  );
}
