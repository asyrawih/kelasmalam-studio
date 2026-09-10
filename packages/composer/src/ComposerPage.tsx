import { useState, type CSSProperties } from "react";
import { useCommands } from "@kelasmalam/shell/useCommands";
import { Badge, Button } from "@kelasmalam/ui/cyber";
import { MixerPanel, createMixer } from "./MixerPanel";
import "./composer.css";

type Note = { step: number; key: number };
type Channel = { name: string; color: string; muted: boolean; gain: number };
type Pattern = { name: string; notes: Note[][] };
type Clip = { track: number; bar: number; pattern: number };
const colors = [
  "var(--cy-accent)",
  "var(--cy-accent-alt)",
  "var(--cy-text-dim)",
  "var(--cy-text)",
];
const presets = [
  "Kick · Analog",
  "Snare · Dust",
  "Closed hat · Silk",
  "Bass · Sub",
  "Keys · Velvet",
  "Pad · Haze",
];
const seed = {
  mixer: createMixer(),
  name: "Midnight sketches",
  bpm: 120,
  mode: "PAT",
  channels: ["Kick", "Snare", "Closed hat", "Bass"].map((name, i): Channel => ({
    name,
    color: colors[i]!,
    muted: false,
    gain: 75,
  })),
  patterns: [
    {
      name: "Main groove",
      notes: [
        [0, 4, 8, 12].map((step) => ({ step, key: 0 })),
        [4, 12].map((step) => ({ step, key: 0 })),
        [0, 2, 4, 6, 8, 10, 12, 14].map((step) => ({ step, key: 0 })),
        [0, 6, 10].map((step, i) => ({ step, key: i * 2 })),
      ],
    },
  ] as Pattern[],
  clips: [0, 1, 2, 3].map((bar) => ({ track: 0, bar, pattern: 0 })) as Clip[],
};
// UI draft survives page navigation, but is intentionally not a saved audio project.
let draft = seed;
export function ComposerPage({
  onOpenStudio,
  onOpenDj,
}: {
  onOpenStudio: () => void;
  onOpenDj: () => void;
}): JSX.Element {
  const [data, setData] = useState(draft);
  const [channel, setChannel] = useState(0);
  const [pattern, setPattern] = useState(0);
  const [tab, setTab] = useState<"piano" | "mixer">("piano");
  const [mixerFocus, setMixerFocus] = useState(false);
  const [search, setSearch] = useState("");
  const [tool, setTool] = useState<"draw" | "erase">("draw");
  const [browser, setBrowser] = useState(true);
  const [rack, setRack] = useState(true);
  const [playlist, setPlaylist] = useState(true);
  const [history, setHistory] = useState<(typeof seed)[]>([]);
  const update = (next: typeof seed): void => {
    setHistory((h) => [...h.slice(-49), data]);
    draft = next;
    setData(next);
  };
  const undo = (): void => {
    const prev = history.at(-1);
    if (prev) {
      draft = prev;
      setData(prev);
      setHistory((h) => h.slice(0, -1));
      setPattern((p) => Math.min(p, prev.patterns.length - 1));
      setChannel((c) => Math.min(c, prev.channels.length - 1));
    }
  };
  const mixer = data.mixer ?? createMixer();
  const active = data.patterns[pattern]!;
  const selected = data.channels[channel]!;
  const notes = active.notes[channel] ?? [];
  const toggleNote = (step: number, key: number): void => {
    const exists = notes.some((n) => n.step === step && n.key === key);
    const next = exists
      ? notes.filter((n) => n.step !== step || n.key !== key)
      : [...notes, { step, key }];
    update({
      ...data,
      patterns: data.patterns.map((p, i) =>
        i === pattern
          ? { ...p, notes: p.notes.map((n, c) => (c === channel ? next : n)) }
          : p,
      ),
    });
  };
  const addChannel = (name: string): void => {
    update({
      ...data,
      channels: [
        ...data.channels,
        {
          name,
          color: colors[data.channels.length % 4]!,
          muted: false,
          gain: 75,
        },
      ],
      patterns: data.patterns.map((p) => ({ ...p, notes: [...p.notes, []] })),
    });
    setChannel(data.channels.length);
  };
  useCommands(
    [
      {
        id: "composer.browser",
        title: "Composer: toggle Browser",
        group: "Composer",
        defaultChord: "F8",
        run: () => setBrowser((v) => !v),
      },
      {
        id: "composer.rack",
        title: "Composer: toggle Channel Rack",
        group: "Composer",
        defaultChord: "F6",
        run: () => setRack((v) => !v),
      },
      {
        id: "composer.playlist",
        title: "Composer: toggle Playlist",
        group: "Composer",
        defaultChord: "F5",
        run: () => setPlaylist((v) => !v),
      },
      {
        id: "composer.piano",
        title: "Composer: Piano Roll",
        group: "Composer",
        defaultChord: "F7",
        run: () => setTab("piano"),
      },
      {
        id: "composer.mixer",
        title: "Composer: Mixer",
        group: "Composer",
        defaultChord: "F9",
        run: () => setTab("mixer"),
      },
      {
        id: "composer.undo",
        title: "Composer: undo edit",
        group: "Composer",
        defaultChord: "mod+KeyZ",
        enabled: () => history.length > 0,
        run: undo,
      },
    ],
    [data, history],
  );
  return (
    <main className="composer">
      <header className="cp-header">
        <div className="cp-brand">
          <span className="cp-logo">▥</span>
          <div>
            <h1>Composer</h1>
            <small>KELASMALAM / WORKSPACE</small>
          </div>
        </div>
        <nav aria-label="Workspace">
          <Button variant="outline" onClick={onOpenStudio}>
            Studio
          </Button>
          <Button variant="outline" active aria-current="page">
            Composer
          </Button>
          <Button variant="outline" onClick={onOpenDj}>
            DJ mixer
          </Button>
        </nav>
        <span className="cp-badge">
          <Badge dot>UI PREVIEW</Badge>
        </span>
      </header>
      <section className="cp-transport" aria-label="Transport">
        <div className="cp-project">
          <small>PROJECT / SESSION DRAFT</small>
          <input
            aria-label="Project name"
            value={data.name}
            onChange={(e) => update({ ...data, name: e.target.value })}
          />
        </div>
        <div className="cp-segment">
          {["PAT", "SONG"].map((mode) => (
            <button
              key={mode}
              className={data.mode === mode ? "active" : ""}
              onClick={() => update({ ...data, mode })}
            >
              {mode}
            </button>
          ))}
        </div>
        <button
          disabled
          title="Audio engine belum terhubung"
          aria-label="Play unavailable"
        >
          ▶
        </button>
        <button disabled aria-label="Stop unavailable">
          ■
        </button>
        <button disabled aria-label="Record unavailable">
          ●
        </button>
        <label className="cp-tempo">
          <input
            aria-label="Tempo"
            type="number"
            min={20}
            max={300}
            value={data.bpm}
            onChange={(e) => {
              const bpm = Number(e.target.value);
              if (bpm >= 20 && bpm <= 300) update({ ...data, bpm });
            }}
          />
          <small>BPM</small>
        </label>
        <div className="cp-position">
          001<span> : </span>01<span> : </span>000
          <small>BAR / BEAT / TICK</small>
        </div>
        <span className="cp-signature">4/4</span>
        <button onClick={undo} disabled={!history.length}>
          ↶ Undo
        </button>
      </section>
      <div
        className="cp-workspace"
        style={{
          gridTemplateColumns: browser
            ? "220px minmax(0, 1fr)"
            : "minmax(0, 1fr)",
        }}
      >
        {browser && (
          <aside className="cp-browser">
            <div className="cp-panel-title">
              <h2>Browser</h2>
              <kbd>F8</kbd>
            </div>
            <input
              className="cp-search"
              aria-label="Search sounds"
              placeholder="Search sounds…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="cp-library-title">
              BUILT-IN PALETTE <span>06</span>
            </div>
            <p className="cp-hint">
              Add a placeholder channel to sketch your ideas.
            </p>
            {presets
              .filter((p) => p.toLowerCase().includes(search.toLowerCase()))
              .map((name, i) => (
                <button
                  className="cp-preset"
                  key={name}
                  onClick={() => addChannel(name.split(" · ")[0]!)}
                >
                  <span style={{ color: colors[i % 4] }}>▧</span>
                  <span>
                    {name}
                    <small>INSTRUMENT PLACEHOLDER</small>
                  </span>
                  <span>+</span>
                </button>
              ))}
            {!presets.some((p) =>
              p.toLowerCase().includes(search.toLowerCase()),
            ) && <p className="cp-hint">No sounds match “{search}”.</p>}
            <div className="cp-browser-foot">
              <span>
                YOUR NEXT IDEA
                <br />
                STARTS HERE.
              </span>
              <p>
                Arrange first.
                <br />
                Make it yours.
              </p>
            </div>
          </aside>
        )}
        <div className="cp-editors">
          <div className="cp-viewbar">
            <span>
              WORKSPACE <span className="cp-dot">/</span> {data.name}
            </span>
            <div>
              <button
                aria-pressed={browser}
                onClick={() => setBrowser((v) => !v)}
              >
                Browser
              </button>
              <button
                aria-pressed={playlist}
                onClick={() => setPlaylist((v) => !v)}
              >
                Playlist
              </button>
              <button aria-pressed={rack} onClick={() => setRack((v) => !v)}>
                Rack
              </button>
            </div>
          </div>
          {playlist && !(tab === "mixer" && mixerFocus) && (
            <section className="cp-panel cp-playlist">
              <div className="cp-panel-title">
                <h2>
                  01 <span>Playlist</span>
                </h2>
                <div className="cp-tools">
                  <button
                    aria-pressed={tool === "draw"}
                    onClick={() => setTool("draw")}
                  >
                    ✎ Draw
                  </button>
                  <button
                    aria-pressed={tool === "erase"}
                    onClick={() => setTool("erase")}
                  >
                    Erase
                  </button>
                  <span>SNAP: BAR</span>
                  <kbd>F5</kbd>
                </div>
              </div>
              <div className="cp-timeline">
                <div className="cp-ruler">
                  <span>PATTERNS</span>
                  {Array.from({ length: 8 }, (_, bar) => (
                    <span key={bar}>{String(bar + 1).padStart(2, "0")}</span>
                  ))}
                </div>
                {Array.from({ length: 4 }, (_, track) => (
                  <div className="cp-track" key={track}>
                    <div className="cp-track-name">
                      <small>{String(track + 1).padStart(2, "0")}</small>
                      {
                        ["Main arrangement", "Variation", "Melody", "Texture"][
                          track
                        ]
                      }
                    </div>
                    {Array.from({ length: 8 }, (_, bar) => {
                      const clip = data.clips.find(
                        (c) => c.track === track && c.bar === bar,
                      );
                      return (
                        <button
                          key={bar}
                          aria-label={`${tool === "draw" ? "Place" : "Erase"} pattern track ${track + 1} bar ${bar + 1}`}
                          className="cp-cell"
                          onClick={() =>
                            update({
                              ...data,
                              clips: [
                                ...data.clips.filter(
                                  (c) => c.track !== track || c.bar !== bar,
                                ),
                                ...(tool === "draw"
                                  ? [{ track, bar, pattern }]
                                  : []),
                              ],
                            })
                          }
                        >
                          {clip && (
                            <span className="cp-clip">
                              <strong>
                                {data.patterns[clip.pattern]!.name}
                              </strong>
                              <span className="cp-mini-notes">
                                {data.patterns[clip.pattern]!.notes[0]?.map(
                                  (n) => (
                                    <i
                                      key={`${n.step}-${n.key}`}
                                      style={{
                                        left: `${(n.step / 16) * 100}%`,
                                        top: `${(n.key * 3) % 20}px`,
                                      }}
                                    />
                                  ),
                                )}
                              </span>
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
              <div className="cp-panel-foot">
                Click a bar to place the selected pattern. Shared copies update
                together.<span>8 BARS</span>
              </div>
            </section>
          )}
          {rack && !(tab === "mixer" && mixerFocus) && (
            <section className="cp-panel cp-rack">
              <div className="cp-panel-title">
                <h2>
                  02 <span>Channel Rack</span>
                </h2>
                <div className="cp-tools">
                  <select
                    aria-label="Pattern"
                    value={pattern}
                    onChange={(e) => setPattern(Number(e.target.value))}
                  >
                    {data.patterns.map((p, i) => (
                      <option key={i} value={i}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => {
                      update({
                        ...data,
                        patterns: [
                          ...data.patterns,
                          {
                            name: `Pattern ${data.patterns.length + 1}`,
                            notes: data.channels.map(() => []),
                          },
                        ],
                      });
                      setPattern(data.patterns.length);
                    }}
                  >
                    + Pattern
                  </button>
                  <kbd>F6</kbd>
                </div>
              </div>
              <div className="cp-rack-scroll">
                {data.channels.map((c, ci) => (
                  <div
                    className={`cp-channel ${channel === ci ? "selected" : ""}`}
                    key={ci}
                    style={
                      {
                        "--channel": colors[ci % colors.length],
                      } as CSSProperties
                    }
                  >
                    <button
                      className="cp-mute"
                      aria-label={`${c.muted ? "Unmute" : "Mute"} ${c.name}`}
                      aria-pressed={c.muted}
                      onClick={() =>
                        update({
                          ...data,
                          channels: data.channels.map((v, i) =>
                            i === ci ? { ...v, muted: !v.muted } : v,
                          ),
                        })
                      }
                    >
                      {c.muted ? "○" : "●"}
                    </button>
                    <button
                      className="cp-channel-name"
                      onClick={() => setChannel(ci)}
                    >
                      {c.name}
                      <small>
                        {mixer.inserts.find(
                          (i) =>
                            i.id === (mixer.assignments[ci] ?? "master"),
                        )?.name ?? "Master"}
                      </small>
                    </button>
                    <div className="cp-steps">
                      {Array.from({ length: 16 }, (_, step) => {
                        const on = active.notes[ci]?.some(
                          (n) => n.step === step && n.key === 0,
                        );
                        return (
                          <button
                            key={step}
                            aria-label={`${c.name} step ${step + 1}`}
                            aria-pressed={!!on}
                            className={`${on ? "on" : ""} ${Math.floor(step / 4) % 2 ? "alt" : ""}`}
                            onClick={() => {
                              const current = active.notes[ci] ?? [];
                              update({
                                ...data,
                                patterns: data.patterns.map((p, i) =>
                                  i === pattern
                                    ? {
                                        ...p,
                                        notes: p.notes.map((ns, j) =>
                                          j === ci
                                            ? on
                                              ? ns.filter(
                                                  (n) =>
                                                    n.step !== step ||
                                                    n.key !== 0,
                                                )
                                              : [...current, { step, key: 0 }]
                                            : ns,
                                        ),
                                      }
                                    : p,
                                ),
                              });
                            }}
                          />
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
              <div className="cp-panel-foot">
                <button
                  onClick={() =>
                    addChannel(`Channel ${data.channels.length + 1}`)
                  }
                >
                  + Add channel
                </button>
                <span>16 STEPS / 1 BAR</span>
              </div>
            </section>
          )}
          <section className="cp-panel cp-detail">
            <div className="cp-panel-title">
              <div className="cp-tabs">
                <button
                  className={tab === "piano" ? "active" : ""}
                  onClick={() => setTab("piano")}
                >
                  03 Piano Roll
                </button>
                <button
                  className={tab === "mixer" ? "active" : ""}
                  onClick={() => setTab("mixer")}
                >
                  04 Mixer
                </button>
              </div>
              <span>
                {tab === "piano"
                  ? `${selected.name} / ${active.name}`
                  : "CHANNEL → INSERT → MASTER"}{" "}
                <kbd>{tab === "piano" ? "F7" : "F9"}</kbd>
              </span>
            </div>
            {tab === "piano" ? (
              <div
                className="cp-piano"
                style={
                  {
                    "--channel": colors[channel % colors.length],
                  } as CSSProperties
                }
              >
                {Array.from({ length: 12 }, (_, row) => {
                  const key = 11 - row;
                  return (
                    <div className="cp-keyrow" key={key}>
                      <span
                        className={
                          [1, 3, 6, 8, 10].includes(key) ? "black" : ""
                        }
                      >
                        {
                          [
                            "C",
                            "C♯",
                            "D",
                            "D♯",
                            "E",
                            "F",
                            "F♯",
                            "G",
                            "G♯",
                            "A",
                            "A♯",
                            "B",
                          ][key]
                        }
                        5
                      </span>
                      {Array.from({ length: 16 }, (_, step) => (
                        <button
                          key={step}
                          aria-label={`Note ${key} step ${step + 1}`}
                          aria-pressed={notes.some(
                            (n) => n.step === step && n.key === key,
                          )}
                          onClick={() => toggleNote(step, key)}
                        />
                      ))}
                    </div>
                  );
                })}
              </div>
            ) : (
              <MixerPanel
                focused={mixerFocus}
                onToggleFocus={() => setMixerFocus(v => !v)}
                value={mixer}
                channels={data.channels}
                onChange={(mixer) => update({ ...data, mixer })}
              />
            )}
            <div className="cp-panel-foot">
              {tab === "piano"
                ? "Click to draw or remove notes. Root notes also appear in the step sequencer."
                : "Levels are editable UI values. Routing, meters and effects await the audio engine."}
            </div>
          </section>
        </div>
      </div>
      <footer className="cp-status">
        <span>
          <i /> UI ONLY · Audio, recording & export belum tersedia
        </span>
        <span>
          Draft sesi · hilang saat reload <span className="cp-dot">/</span> ⌘K
          Commands
        </span>
      </footer>
    </main>
  );
}
