/**
 * Lane Mixer — satu baris per lane: chip warna, nama, nilai dB, dan bar level.
 *
 * Design meng-hardcode level & dB. Di sini bar-nya adalah FADER yang bisa
 * diklik/di-drag: posisi bar = travel fader (taper docs/07 §7b), dan yang
 * disimpan ke store selalu dB.
 */

import { Card } from '../../ui/cyber';
import type { StudioLane } from '../model';
import { isAudible } from '../model';
import { dbToFader, faderToDb, formatDb } from './fader';
import { useLaneMeters } from './useLaneMeters';
import { studioActions, useLanes, useSelectedLaneId } from './store-adapter';
import { useDragFraction } from './useDragFraction';

function LaneFader({
  lane,
  lanes,
  meter,
  onGain,
  onSelect,
  selected,
}: {
  lane: StudioLane;
  lanes: readonly StudioLane[];
  meter: number | null;
  onGain: (db: number) => void;
  onSelect: () => void;
  selected: boolean;
}): JSX.Element {
  const travel = dbToFader(lane.gainDb);
  const drag = useDragFraction((f) => onGain(faderToDb(f)));
  // Kalau meter tersedia ia yang digambar; kalau tidak, posisi fader.
  const level = Math.min(100, Math.max(0, (meter ?? travel) * 100));
  const audible = isAudible(lane, lanes as StudioLane[]);

  return (
    <div style={{ opacity: audible ? 1 : 0.45 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '5px' }}>
        <div style={{ width: '3px', height: '11px', background: lane.color }} />
        <span
          onClick={onSelect}
          style={{
            fontSize: '10px',
            color: selected ? 'var(--cy-accent)' : 'var(--cy-text)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            cursor: 'pointer',
          }}
          title={lane.name}
        >
          {lane.name}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: '10px', color: 'var(--cy-accent)' }}>
          {formatDb(lane.gainDb)} dB
        </span>
      </div>
      <div
        role="slider"
        aria-label={`Gain ${lane.name}`}
        aria-valuemin={-96}
        aria-valuemax={6}
        aria-valuenow={Number.isFinite(lane.gainDb) ? Number(lane.gainDb.toFixed(1)) : -96}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') onGain(faderToDb(Math.max(0, travel - 0.01)));
          if (e.key === 'ArrowRight') onGain(faderToDb(Math.min(1, travel + 0.01)));
        }}
        {...drag}
        style={{
          height: '8px',
          background: '#000',
          border: '1px solid var(--cy-border)',
          position: 'relative',
          // `overflow: hidden` DILEPAS: thumb-nya (14px) lebih tinggi dari
          // track (8px) dan setengahnya menonjol di kedua sisi. Dengan clipping,
          // yang terlihat cuma potongan kotak, bukan lingkaran.
          cursor: 'pointer',
          touchAction: 'none',
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: '0 auto 0 0',
            width: `${level}%`,
            background: 'linear-gradient(90deg,#ffd400,#ffb020)',
          }}
        />
        {/*
          Thumb bulat di ujung isian. `pointerEvents: 'none'` supaya seluruh
          gerakan tetap ditangani track — thumb yang ikut menerima pointer akan
          menelan `pointerdown` di titik yang justru paling sering diklik user,
          dan drag-nya terasa mati di posisi itu saja.

          Posisinya memakai `calc` supaya di 0% dan 100% lingkarannya tetap
          utuh di dalam track, bukan setengah menggantung keluar.
        */}
        <div
          aria-hidden
          style={{
            position: 'absolute',
            top: '50%',
            left: `calc(${level}% + ${7 - (level / 100) * 14}px)`,
            width: '14px',
            height: '14px',
            marginTop: '-7px',
            marginLeft: '-7px',
            borderRadius: '50%',
            background: 'var(--cy-accent)',
            border: '1px solid var(--cy-bg)',
            boxShadow: '0 0 0 1px var(--cy-border-strong), 0 0 8px #ffd40066',
            pointerEvents: 'none',
          }}
        />
      </div>
    </div>
  );
}

export function MixerCard(): JSX.Element {
  const lanes = useLanes();
  const selectedLaneId = useSelectedLaneId();
  const meters = useLaneMeters();

  return (
    <Card title="Lane Mixer" subtitle="level per lane" notched>
      <div style={{ display: 'grid', gap: '12px' }}>
        {lanes.length === 0 ? (
          <div style={{ fontSize: '10px', color: 'var(--cy-text-muted)', letterSpacing: '.14em' }}>
            BELUM ADA LANE
          </div>
        ) : (
          lanes.map((lane) => (
            <LaneFader
              key={lane.id}
              lane={lane}
              lanes={lanes}
              meter={meters ? (meters[lane.id] ?? null) : null}
              selected={lane.id === selectedLaneId}
              onSelect={() => studioActions.selectLane(lane.id)}
              onGain={(db) => studioActions.setLaneGain(lane.id, db)}
            />
          ))
        )}
        {meters === null ? (
          <div
            title="Meter realtime butuh engine (SAB meter block). Bar menunjukkan posisi fader, bukan level audio."
            style={{ fontSize: '9px', letterSpacing: '.12em', color: 'var(--cy-text-muted)' }}
          >
            BAR = POSISI FADER · METER REALTIME MENUNGGU ENGINE
          </div>
        ) : null}
      </div>
    </Card>
  );
}
