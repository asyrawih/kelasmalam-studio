/**
 * Penjaga stabilitas referensi.
 *
 * Kelas bug yang dijaga: `getSnapshot` yang mengembalikan objek baru tiap
 * panggilan membuat React me-render tanpa henti, dan gejalanya bukan "lambat"
 * melainkan "Maximum update depth exceeded" — atau, yang lebih buruk, frame
 * drop yang tidak bisa dilacak karena dua waveform rAF ikut bangun tiap kali
 * crossfader digeser sepiksel.
 *
 * Di halaman dua-deck ini taruhannya berlipat: satu gerakan fader = puluhan
 * `set` per detik, dan tiap render yang tidak perlu adalah satu canvas yang
 * digambar ulang percuma.
 */

import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { djActions, selectChannel, selectDeck, useDj } from './store';

let renders = 0;

function DeckAProbe(): JSX.Element {
  const deck = useDj(selectDeck('A'));
  renders += 1;
  return <div data-testid="probe">{deck.playhead}</div>;
}

function ChannelAProbe(): JSX.Element {
  const ch = useDj(selectChannel('A'));
  renders += 1;
  return <div>{ch.fader}</div>;
}

beforeEach(() => {
  djActions.__resetForTest();
  renders = 0;
});

afterEach(cleanup);

describe('stabilitas selector', () => {
  it('deck A tidak ikut render saat deck B dan crossfader bergerak', () => {
    djActions.loadDeck('A', { assetId: 1, frames: 48_000, name: 'A', sampleRate: 48_000 });
    djActions.loadDeck('B', { assetId: 2, frames: 48_000, name: 'B', sampleRate: 48_000 });
    render(<DeckAProbe />);
    const base = renders;

    for (let i = 0; i < 50; i += 1) {
      djActions.setCrossfader(i / 50);
      djActions.setTempoFader('B', i / 100);
      djActions.setChannelFader('B', i / 50);
      djActions.seek('B', i * 100);
    }

    expect(renders).toBe(base);
  });

  it('channel A tidak ikut render saat playhead deck A berjalan', () => {
    djActions.loadDeck('A', { assetId: 1, frames: 48_000 * 100, name: 'A', sampleRate: 48_000 });
    render(<ChannelAProbe />);
    const base = renders;

    djActions.play('A');
    for (let i = 0; i < 30; i += 1) djActions.tick(16);

    expect(renders).toBe(base);
  });

  it('menulis nilai yang SAMA tidak memicu render sama sekali', () => {
    djActions.loadDeck('A', { assetId: 1, frames: 48_000, name: 'A', sampleRate: 48_000 });
    render(<DeckAProbe />);
    const base = renders;

    for (let i = 0; i < 20; i += 1) {
      djActions.setTempoFader('A', 0);
      djActions.setChannelFader('A', 1);
      djActions.seek('A', 0);
    }

    expect(renders).toBe(base);
  });

  it('tick hanya membangunkan deck yang benar-benar berjalan', () => {
    djActions.loadDeck('A', { assetId: 1, frames: 48_000 * 100, name: 'A', sampleRate: 48_000 });
    djActions.loadDeck('B', { assetId: 2, frames: 48_000 * 100, name: 'B', sampleRate: 48_000 });
    render(<DeckAProbe />);
    const base = renders;

    djActions.play('B');
    for (let i = 0; i < 30; i += 1) djActions.tick(16);

    expect(renders).toBe(base);
  });
});
