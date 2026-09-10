import { useState } from "react";
import { Button } from "@kelasmalam/ui/cyber";
import "./mixer.css";

type Slot = { effect: string; enabled: boolean; mix: number };
export type Insert = {
  id: string;
  name: string;
  db: number;
  pan: number;
  stereo: number;
  muted: boolean;
  solo: boolean;
  phase: boolean;
  swap: boolean;
  fx: boolean;
  slots: Slot[];
  sends: Record<string, number>;
  eq: number[];
};
export type MixerState = {
  inserts: Insert[];
  assignments: Record<number, string>;
};
function insert(id: string, name: string): Insert {
  return {
    id,
    name,
    db: 0,
    pan: 0,
    stereo: 0,
    muted: false,
    solo: false,
    phase: false,
    swap: false,
    fx: true,
    slots: Array.from({ length: 10 }, () => ({
      effect: "",
      enabled: true,
      mix: 100,
    })),
    sends: id === "master" ? {} : { master: 100 },
    eq: [0, 0, 0],
  };
}
export function createMixer(): MixerState {
  return {
    inserts: [
      insert("master", "Master"),
      ...Array.from({ length: 8 }, (_, i) =>
        insert(
          `insert-${i + 1}`,
          ["Kick", "Snare", "Closed hat", "Bass"][i] ?? `Insert ${i + 1}`,
        ),
      ),
    ],
    assignments: { 0: "insert-1", 1: "insert-2", 2: "insert-3", 3: "insert-4" },
  };
}
export function wouldCycle(
  inserts: Insert[],
  source: string,
  destination: string,
): boolean {
  const pending = [destination];
  const visited = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (id === source) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    pending.push(...Object.keys(inserts.find((i) => i.id === id)?.sends ?? {}));
  }
  return false;
}
const effects = [
  "Parametric EQ",
  "Compressor",
  "Limiter",
  "Filter",
  "Delay",
  "Reverb",
  "Chorus",
  "Distortion",
];
const level = (db: number): string =>
  db <= -60 ? "−∞ dB" : `${db > 0 ? "+" : ""}${db.toFixed(1)} dB`;
export function MixerPanel({
  value,
  onChange,
  channels,
  focused = false,
  onToggleFocus,
}: {
  focused?: boolean;
  onToggleFocus?: () => void;
  value: MixerState;
  onChange: (value: MixerState) => void;
  channels: readonly { name: string }[];
}): JSX.Element {
  const [selectedId, select] = useState("insert-1");
  const [wide, setWide] = useState(false);
  const [inspector, showInspector] = useState(true);
  const selected =
    value.inserts.find((i) => i.id === selectedId) ?? value.inserts[0]!;
  const patch = (id: string, change: Partial<Insert>): void =>
    onChange({
      ...value,
      inserts: value.inserts.map((i) =>
        i.id === id ? { ...i, ...change } : i,
      ),
    });
  const slotPatch = (index: number, change: Partial<Slot>): void =>
    patch(selected.id, {
      slots: selected.slots.map((s, i) =>
        i === index ? { ...s, ...change } : s,
      ),
    });
  const send = (destination: string): void => {
    const sends = { ...selected.sends };
    if (destination in sends) delete sends[destination];
    else sends[destination] = 100;
    patch(selected.id, { sends });
  };
  const strip = (track: Insert, index: number): JSX.Element => {
    const active = track.id === selected.id;
    const linked = track.id in selected.sends;
    const blocked =
      selected.id === "master" ||
      wouldCycle(value.inserts, selected.id, track.id);
    return (
      <div
        key={track.id}
        className={`cm-strip ${active ? "is-selected" : ""} ${track.muted ? "is-muted" : ""}`}
      >
        <button
          className="cm-label"
          aria-label={`Select ${track.name}`}
          aria-pressed={active}
          onClick={() => select(track.id)}
        >
          <small>{index === 0 ? "M" : String(index).padStart(2, "0")}</small>
          <strong>{track.name}</strong>
        </button>
        <div className="cm-switches">
          <button
            title="Mute"
            aria-label={`Mute insert ${track.name}`}
            aria-pressed={track.muted}
            onClick={() => patch(track.id, { muted: !track.muted })}
          >
            M
          </button>
          <button
            title="Solo"
            aria-label={`Solo insert ${track.name}`}
            aria-pressed={track.solo}
            onClick={() => patch(track.id, { solo: !track.solo })}
          >
            S
          </button>
        </div>
        <label className="cm-pan">
          <span>PAN</span>
          <input
            aria-label={`${track.name} pan`}
            type="range"
            min={-100}
            max={100}
            value={track.pan}
            onFocus={() => select(track.id)}
            onChange={(e) => patch(track.id, { pan: Number(e.target.value) })}
            onDoubleClick={() => patch(track.id, { pan: 0 })}
          />
          <output>
            {track.pan === 0
              ? "C"
              : `${Math.abs(track.pan)}${track.pan < 0 ? "L" : "R"}`}
          </output>
        </label>
        <div className="cm-level">
          <div className="cm-db-scale" aria-hidden="true">
            <span>+6</span>
            <span>0</span>
            <span>−12</span>
            <span>−24</span>
            <span>−∞</span>
          </div>
          <input
            aria-label={`${track.name} volume`}
            type="range"
            min={-60}
            max={6}
            step={0.1}
            value={track.db}
            aria-valuetext={level(track.db)}
            onFocus={() => select(track.id)}
            onChange={(e) => patch(track.id, { db: Number(e.target.value) })}
            onDoubleClick={() => patch(track.id, { db: 0 })}
          />
          <div
            className="cm-stereo-meter"
            aria-label={`${track.name} meter: no signal`}
          >
            <i />
            <i />
          </div>
        </div>
        <output className="cm-db">{level(track.db)}</output>
        <small className="cm-silence">−∞ / −∞</small>
        <label className="cm-stereo">
          <span>STEREO</span>
          <input
            aria-label={`${track.name} stereo separation`}
            type="range"
            min={-100}
            max={100}
            value={track.stereo}
            onChange={(e) =>
              patch(track.id, { stereo: Number(e.target.value) })
            }
          />
          <output>
            {track.stereo === 0
              ? "ORIGINAL"
              : track.stereo === 100
                ? "MONO"
                : `${Math.abs(track.stereo)}% ${track.stereo < 0 ? "WIDE" : "MERGE"}`}
          </output>
        </label>
        <div className="cm-switches">
          <button
            aria-label={`${track.name} invert phase`}
            aria-pressed={track.phase}
            onClick={() => patch(track.id, { phase: !track.phase })}
          >
            Ø
          </button>
          <button
            aria-label={`${track.name} swap stereo`}
            aria-pressed={track.swap}
            onClick={() => patch(track.id, { swap: !track.swap })}
          >
            ⇄
          </button>
          <button
            aria-label={`${track.name} effects enabled`}
            aria-pressed={track.fx}
            onClick={() => patch(track.id, { fx: !track.fx })}
          >
            FX
          </button>
        </div>
        <button
          disabled
          title="Recording belum terhubung"
          aria-label={`Arm ${track.name} unavailable`}
        >
          ● REC
        </button>
        <div className="cm-routing">
          {active ? (
            <span className="cm-source">↓ SOURCE</span>
          ) : (
            <>
              <button
                aria-label={`Send ${selected.name} to ${track.name}`}
                aria-pressed={linked}
                disabled={blocked && !linked}
                onClick={() => send(track.id)}
                title={
                  blocked && !linked
                    ? "Route tidak tersedia: master atau feedback loop"
                    : "Toggle post-fader send"
                }
              >
                ↑ {linked ? "ROUTED" : "SEND"}
              </button>
              {linked && (
                <input
                  aria-label={`Send level to ${track.name}`}
                  title="0% = sidechain only"
                  type="range"
                  min={0}
                  max={100}
                  value={selected.sends[track.id]}
                  onChange={(e) =>
                    patch(selected.id, {
                      sends: {
                        ...selected.sends,
                        [track.id]: Number(e.target.value),
                      },
                    })
                  }
                />
              )}
            </>
          )}
        </div>
      </div>
    );
  };
  return (
    <div className={`cm-mixer ${wide ? "cm-wide" : ""}`}>
      <div className="cm-toolbar">
        <strong>
          MIXER <span>/ {selected.name}</span>
        </strong>
        <div>
          <Button
            variant="ghost"
            active={wide}
            onClick={() => setWide((v) => !v)}
          >
            {wide ? "Wide" : "Compact"}
          </Button>
          <Button
            variant="ghost"
            active={inspector}
            onClick={() => showInspector((v) => !v)}
          >
            Inspector / FX
          </Button>
          {onToggleFocus && <Button variant="ghost" active={focused} onClick={onToggleFocus}>{focused ? "Restore workspace" : "Expand mixer"}</Button>}
          <Button
            variant="outline"
            onClick={() => {
              const id = `insert-${value.inserts.length}`;
              onChange({
                ...value,
                inserts: [
                  ...value.inserts,
                  insert(id, `Insert ${value.inserts.length}`),
                ],
              });
              select(id);
            }}
          >
            + Insert
          </Button>
        </div>
      </div>
      <div className={`cm-body ${inspector ? "" : "no-inspector"}`}>
        <div className="cm-master-dock">{strip(value.inserts[0]!, 0)}</div>
        <div className="cm-track-dock">
          {value.inserts.slice(1).map((track, i) => strip(track, i + 1))}
        </div>
        {inspector && (
          <aside className="cm-inspector">
            <label className="cm-track-title">
              SELECTED INSERT
              <input
                aria-label="Insert name"
                value={selected.name}
                onChange={(e) => patch(selected.id, { name: e.target.value })}
              />
            </label>
            <label className="cm-io">
              IN
              <select aria-label="Audio input" disabled>
                <option>(none) · audio unavailable</option>
              </select>
            </label>
            <div className="cm-fx-title">
              <span>EFFECT SLOTS</span>
              <small>UI DRAFT · 10 SLOTS</small>
            </div>
            <div className="cm-slots">
              {selected.slots.map((slot, index) => (
                <div className="cm-slot" key={index}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <select
                    aria-label={`Effect slot ${index + 1}`}
                    value={slot.effect}
                    onChange={(e) =>
                      slotPatch(index, { effect: e.target.value })
                    }
                  >
                    <option value="">Slot {index + 1} · empty</option>
                    {effects.map((effect) => (
                      <option key={effect}>{effect}</option>
                    ))}
                  </select>
                  <input
                    aria-label={`Effect ${index + 1} mix`}
                    type="range"
                    min={0}
                    max={100}
                    value={slot.mix}
                    disabled={!slot.effect}
                    onChange={(e) =>
                      slotPatch(index, { mix: Number(e.target.value) })
                    }
                  />
                  <button
                    aria-label={`Effect ${index + 1} enabled`}
                    aria-pressed={slot.enabled && !!slot.effect}
                    disabled={!slot.effect}
                    onClick={() => slotPatch(index, { enabled: !slot.enabled })}
                  >
                    ●
                  </button>
                </div>
              ))}
            </div>
            <div className="cm-eq">
              <div>
                <span>EQUALIZER</span>
                <small>3 BANDS · UI</small>
              </div>
              <svg
                viewBox="0 0 260 44"
                role="img"
                aria-label="EQ gain sketch, not a DSP response"
              >
                <path
                  d="M0 22H260 M65 0V44 M130 0V44 M195 0V44"
                  className="cm-eq-grid"
                />
                <polyline
                  points={`0,${22 - selected.eq[0]!} 65,${22 - selected.eq[0]!} 130,${22 - selected.eq[1]!} 195,${22 - selected.eq[2]!} 260,${22 - selected.eq[2]!}`}
                />
              </svg>
              <div className="cm-eq-controls">
                {selected.eq.map((gain, i) => (
                  <label key={i}>
                    {["LOW", "MID", "HIGH"][i]}
                    <input
                      aria-label={`${["Low", "Mid", "High"][i]} EQ gain`}
                      type="range"
                      min={-18}
                      max={18}
                      step={0.5}
                      value={gain}
                      onChange={(e) =>
                        patch(selected.id, {
                          eq: selected.eq.map((v, j) =>
                            j === i ? Number(e.target.value) : v,
                          ),
                        })
                      }
                    />
                    <output>
                      {gain > 0 ? "+" : ""}
                      {gain} dB
                    </output>
                  </label>
                ))}
              </div>
            </div>
            <label className="cm-io">
              OUT
              <select aria-label="Audio output" disabled>
                <option>(none) · audio unavailable</option>
              </select>
            </label>
          </aside>
        )}
      </div>
      <div className="cm-route-summary">
        <strong>ROUTING / {selected.name}</strong>
        <span>
          {Object.entries(selected.sends)
            .map(
              ([id, amount]) =>
                `${value.inserts.find((i) => i.id === id)?.name ?? id}: ${amount === 0 ? "sidechain only" : `${amount}%`}`,
            )
            .join(" · ") ||
            (selected.id === "master"
              ? "Master → hardware output (unavailable)"
              : "No sends")}
        </span>
      </div>
      <details className="cm-assignments">
        <summary>Channel routing · {channels.length} channels</summary>
        <div>
          {channels.map((channel, index) => (
            <label key={index}>
              {channel.name}
              <select
                aria-label={`Route ${channel.name} to insert`}
                value={value.assignments[index] ?? "master"}
                onChange={(e) =>
                  onChange({
                    ...value,
                    assignments: {
                      ...value.assignments,
                      [index]: e.target.value,
                    },
                  })
                }
              >
                {value.inserts.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </details>
      <p className="cm-disclaimer">
        UI preview · fader, pan, FX & routing hanya mengubah draft. Meter tidak
        menerima audio; recording dan output belum tersedia.
      </p>
    </div>
  );
}
