/**
 * Panel FX — insert chain untuk lane terpilih atau untuk master.
 *
 * SELURUH isinya dirakit dari katalog Rust. Tidak ada nama efek, nama
 * parameter, rentang, maupun satuan yang ditulis di sini; semuanya dibaca dari
 * `EffectDesc`. Menambah efek di Rust langsung memunculkannya di menu ini
 * dengan kontrol yang benar — itu satu-satunya alasan katalog ada.
 *
 * Kalau artefak WASM belum dibangun, panel menyebutkannya alih-alih diam:
 * chain tetap ikut ke file hasil export, tapi tidak terdengar saat diputar, dan
 * perbedaan itu harus terlihat.
 */

import { useState } from 'react';

import { Badge, Card } from '../../ui/cyber';
import type { EffectDesc } from '../../audio/fx-catalog';
import { defaultParams } from '../../audio/fx-catalog';
import type { FxInsert } from '../model';
import { studioActions, useStudio } from '../rail/store-adapter';
import { FxParamRow } from './FxParamRow';
import { sortedEffects, useFxCatalog } from './useFxCatalog';

const MONO = 'var(--cy-font-mono)';

type Target = 'lane' | 'master';

function iconButton(label: string, onClick: () => void, disabled = false): JSX.Element {
  return (
    <button
      type="button"
      className="cy-btn-reset"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      style={{
        width: '20px',
        height: '20px',
        border: '1px solid var(--cy-border)',
        background: 'transparent',
        color: disabled ? 'var(--cy-border)' : 'var(--cy-text-dim)',
        fontFamily: MONO,
        fontSize: '10px',
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      {label[0]}
    </button>
  );
}

export function FxCard(): JSX.Element {
  const { catalog, error } = useFxCatalog();
  const [target, setTarget] = useState<Target>('lane');
  const selectedId = useStudio((s) => s.selectedLaneId);
  const lanes = useStudio((s) => s.lanes);
  const masterChain = useStudio((s) => s.masterChain);

  const lane = lanes.find((l) => l.id === selectedId) ?? lanes[0] ?? null;
  const onMaster = target === 'master' || lane === null;
  const laneId = onMaster ? null : lane!.id;
  const chain: readonly FxInsert[] = onMaster ? masterChain : lane!.chain;

  return (
    <Card title="FX" subtitle={onMaster ? 'MASTER' : (lane?.name ?? '')} notched>
      <div style={{ display: 'grid', gap: '10px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px' }}>
          {(['lane', 'master'] as const).map((t) => {
            const active = onMaster ? t === 'master' : t === 'lane';
            return (
              <button
                key={t}
                type="button"
                className="cy-btn-reset"
                aria-pressed={active}
                onClick={() => setTarget(t)}
                disabled={t === 'lane' && lane === null}
                style={{
                  height: '26px',
                  border: `1px solid ${active ? 'var(--cy-accent)' : 'var(--cy-border)'}`,
                  background: active ? 'var(--cy-accent)' : 'transparent',
                  color: active ? 'var(--cy-text-on-accent)' : 'var(--cy-text-dim)',
                  fontFamily: MONO,
                  fontSize: '10px',
                  letterSpacing: '.12em',
                  cursor: 'pointer',
                }}
              >
                {t === 'lane' ? 'LANE' : 'MASTER'}
              </button>
            );
          })}
        </div>

        {error !== null ? (
          <div style={{ fontFamily: MONO, fontSize: '9px', color: 'var(--cy-text-dim)' }}>
            Efek tidak terdengar saat diputar (WASM belum dibangun: {error}). Chain tetap
            ikut ke file hasil COMPILE.
          </div>
        ) : null}

        {catalog === null ? (
          <div style={{ fontFamily: MONO, fontSize: '9px', color: 'var(--cy-text-dim)' }}>
            memuat katalog efek…
          </div>
        ) : (
          <AddPicker
            effects={sortedEffects(catalog)}
            onPick={(id) => studioActions.addFx(laneId, id)}
          />
        )}

        {chain.length === 0 ? (
          <div style={{ fontFamily: MONO, fontSize: '9px', color: 'var(--cy-text-dim)' }}>
            BELUM ADA EFEK
          </div>
        ) : (
          chain.map((fx, i) => (
            <FxSlotRow
              key={`${fx.kind}-${i}`}
              fx={fx}
              index={i}
              last={i === chain.length - 1}
              desc={catalog?.get(fx.kind) ?? null}
              laneId={laneId}
            />
          ))
        )}
      </div>
    </Card>
  );
}

function AddPicker(props: {
  effects: readonly EffectDesc[];
  onPick: (id: string) => void;
}): JSX.Element {
  return (
    <select
      aria-label="Tambah efek"
      value=""
      onChange={(e) => {
        if (e.target.value !== '') props.onPick(e.target.value);
      }}
      style={{
        height: '28px',
        border: '1px solid var(--cy-border)',
        background: 'transparent',
        color: 'var(--cy-text-dim)',
        fontFamily: MONO,
        fontSize: '10px',
        letterSpacing: '.1em',
      }}
    >
      <option value="">+ TAMBAH EFEK</option>
      {props.effects.map((d) => (
        <option key={d.id} value={d.id}>
          {d.name}
        </option>
      ))}
    </select>
  );
}

function FxSlotRow(props: {
  fx: FxInsert;
  index: number;
  last: boolean;
  desc: EffectDesc | null;
  laneId: string | null;
}): JSX.Element {
  const { fx, index, last, desc, laneId } = props;
  // Efek yang tidak dikenal katalog TIDAK disembunyikan: ia ada di project dan
  // akan dilewati engine, jadi user harus bisa melihat dan menghapusnya.
  const values = desc === null ? [] : defaultParams(desc).map((d, i) => {
    const id = desc.params[i]!.id;
    const v = fx.params[id];
    return typeof v === 'number' && Number.isFinite(v) ? v : d;
  });

  return (
    <div style={{ display: 'grid', gap: '6px', border: '1px solid var(--cy-border)', padding: '6px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <Badge>{desc?.name ?? fx.kind.toUpperCase()}</Badge>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="cy-btn-reset"
          aria-label={fx.enabled ? 'Bypass efek' : 'Aktifkan efek'}
          aria-pressed={!fx.enabled}
          onClick={() => studioActions.setFxEnabled(laneId, index, !fx.enabled)}
          style={{
            height: '20px',
            padding: '0 6px',
            border: `1px solid ${fx.enabled ? 'var(--cy-accent)' : 'var(--cy-border)'}`,
            background: 'transparent',
            color: fx.enabled ? 'var(--cy-accent)' : 'var(--cy-text-dim)',
            fontFamily: MONO,
            fontSize: '9px',
            letterSpacing: '.1em',
            cursor: 'pointer',
          }}
        >
          {fx.enabled ? 'ON' : 'BYP'}
        </button>
        {iconButton('Naikkan', () => studioActions.moveFx(laneId, index, index - 1), index === 0)}
        {iconButton('Turunkan', () => studioActions.moveFx(laneId, index, index + 1), last)}
        {iconButton('Hapus', () => studioActions.removeFx(laneId, index))}
      </div>

      {desc === null ? (
        <div style={{ fontFamily: MONO, fontSize: '9px', color: 'var(--cy-text-dim)' }}>
          Efek tidak dikenal engine — akan dilewati.
        </div>
      ) : (
        desc.params.map((p, i) => (
          <FxParamRow
            key={p.id}
            desc={p}
            value={values[i]!}
            onChange={(v) => studioActions.setFxParam(laneId, index, p.id, v)}
          />
        ))
      )}
    </div>
  );
}
