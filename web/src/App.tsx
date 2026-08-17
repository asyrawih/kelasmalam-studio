/**
 * Susunan halaman — grid 12 kolom yang sama persis dengan design file.
 *
 * Urutan dan span disalin baris per baris dari design:
 *   span 12  Transport Bar
 *   span 8   Waveform Display      | span 4  Clip Thumbnail + Master Meter
 *   span 12  Arrangement / Timeline
 *   span 7   Mixer / Channel Strips| span 5  Parametric EQ + Plugin Knobs
 *   span 7   Piano Roll            | span 5  Step Sequencer
 *   span 4   Sample Browser  | span 4 FX Rack | span 4 Automation + Render
 *
 * Header juga disalin: eyebrow 11px letterspacing .22em warna aksen, judul
 * Rajdhani 38px, paragraf 13px max-width 62ch, dan dua badge di kanan.
 *
 * Engine di-inject lewat prop, bukan dibuat di sini: `AudioContext` hanya boleh
 * lahir di dalam handler gesture user (docs/05 §Safari), dan seluruh UI harus
 * bisa dirender sebelum itu terjadi.
 */

import { useEffect, useState } from 'react';
import {
  EngineProvider,
  attachMeterLoop,
  createDemoProject,
  DESIGN_LIBRARY,
  useUiStore,
  type UiEngine,
} from './state';
import { uiActions } from './state/store';
import { Badge } from './ui/cyber';
import {
  ArrangementTimeline,
  AutomationLane,
  ClipThumbnail,
  FXRack,
  MasterMeter,
  MixerStrips,
  ParametricEQ,
  PianoRoll,
  PluginKnobs,
  RenderBounce,
  SampleBrowser,
  StepSequencer,
  TransportBar,
  WaveformDisplay,
} from './ui/panels';

export interface AppProps {
  /**
   * Dipanggil di dalam handler klik. Mengembalikan engine siap pakai, atau
   * null kalau lapisan audio belum bisa dibangun di lingkungan ini (mis.
   * build WASM belum ada) — UI tetap jalan dalam mode mirror-only.
   */
  readonly createEngine?: () => Promise<UiEngine | null>;
}

export function App({ createEngine }: AppProps): JSX.Element {
  const [engine, setEngine] = useState<UiEngine | null>(null);
  const audioUnlocked = useUiStore((s) => s.audioUnlocked);
  const sampleRate = useUiStore((s) => s.project.sampleRate);
  const engineFault = useUiStore((s) => s.engineFault);

  // Seed sekali: isi design supaya UI bisa dibandingkan dengan design file.
  useEffect(() => {
    uiActions.setProject(createDemoProject(sampleRate));
    uiActions.setLibrary(DESIGN_LIBRARY.map((e) => ({ ...e })));
    uiActions.selectTrack(0);
    uiActions.selectClips([1]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Satu rAF loop untuk seluruh aplikasi, dipasang saat engine hidup.
  useEffect(() => {
    if (engine === null) return;
    return attachMeterLoop(engine);
  }, [engine]);

  const unlock = async (): Promise<void> => {
    if (createEngine === undefined) {
      uiActions.setAudioUnlocked(true);
      return;
    }
    try {
      const client = await createEngine();
      if (client !== null) {
        setEngine(client);
        uiActions.resetForSampleRate(client.sampleRate);
        uiActions.setProject(createDemoProject(client.sampleRate));
      }
      uiActions.setAudioUnlocked(true);
    } catch (err) {
      uiActions.setEngineFault(err instanceof Error ? err.message : String(err));
      uiActions.setAudioUnlocked(true);
    }
  };

  return (
    <EngineProvider client={engine}>
      <div
        style={{
          minHeight: '100vh',
          background: 'var(--cy-bg)',
          padding: '28px 32px 64px',
          fontFamily: 'var(--cy-font-mono)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            gap: '24px',
            borderBottom: '1px solid var(--cy-border)',
            paddingBottom: '18px',
            marginBottom: '26px',
          }}
        >
          <div>
            <div
              style={{
                fontSize: '11px',
                letterSpacing: '.22em',
                textTransform: 'uppercase',
                color: 'var(--cy-accent)',
                marginBottom: '8px',
              }}
            >
              Component Kit / Audio
            </div>
            <h1
              style={{
                fontFamily: 'var(--cy-font-sans)',
                fontSize: '38px',
                fontWeight: 700,
                letterSpacing: '.04em',
                color: 'var(--cy-text)',
                margin: 0,
              }}
            >
              DAW UI COMPONENTS
            </h1>
            <p
              style={{
                color: 'var(--cy-text-dim)',
                fontSize: '13px',
                margin: '8px 0 0',
                maxWidth: '62ch',
                textWrap: 'pretty',
              }}
            >
              Transport, waveform, arrangement, mixer, piano roll, and metering primitives — built on
              the black + yellow cyber theme.
            </p>
          </div>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            {!audioUnlocked ? (
              <button type="button" className="cy-btn-reset cy-focusable" onClick={() => void unlock()}>
                <Badge tone="danger" dot pulse>
                  CLICK TO ENABLE AUDIO
                </Badge>
              </button>
            ) : null}
            {engineFault !== null ? <Badge tone="danger" dot>{engineFault}</Badge> : null}
            <Badge tone="accent" dot pulse>
              {(sampleRate / 1000).toFixed(1)} kHz / 24-bit
            </Badge>
            <Badge tone="default">v0.1</Badge>
          </div>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(12,minmax(0,1fr))',
            gap: '18px',
            alignItems: 'start',
          }}
        >
          <div style={{ gridColumn: 'span 12' }}>
            <TransportBar />
          </div>

          <div style={{ gridColumn: 'span 8' }}>
            <WaveformDisplay />
          </div>
          <div style={{ gridColumn: 'span 4', display: 'grid', gap: '18px' }}>
            <ClipThumbnail />
            <MasterMeter />
          </div>

          <div style={{ gridColumn: 'span 12' }}>
            <ArrangementTimeline />
          </div>

          <div style={{ gridColumn: 'span 7' }}>
            <MixerStrips />
          </div>
          <div style={{ gridColumn: 'span 5', display: 'grid', gap: '18px' }}>
            <ParametricEQ />
            <PluginKnobs />
          </div>

          <div style={{ gridColumn: 'span 7' }}>
            <PianoRoll />
          </div>
          <div style={{ gridColumn: 'span 5' }}>
            <StepSequencer />
          </div>

          <div style={{ gridColumn: 'span 4' }}>
            <SampleBrowser />
          </div>
          <div style={{ gridColumn: 'span 4' }}>
            <FXRack />
          </div>
          <div style={{ gridColumn: 'span 4', display: 'grid', gap: '18px' }}>
            <AutomationLane />
            <RenderBounce />
          </div>
        </div>
      </div>
    </EngineProvider>
  );
}

export default App;
