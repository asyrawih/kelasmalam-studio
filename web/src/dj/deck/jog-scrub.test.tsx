/**
 * Jog wheel, lewat jalur pointer sungguhan.
 *
 * Yang dikunci di sini bukan matematika tarikannya melainkan SATU tanda:
 * `deck.scrubbing`. Ia yang memberi tahu lapisan audio untuk meredam source
 * utama dan menyerahkan bunyinya ke butir scrub, dan ia juga yang menahan
 * `startSyncFollow` supaya deck sebelahnya tidak difase ulang pada tiap
 * `pointermove`.
 *
 * Tanda yang tidak pernah dipasang tidak menghasilkan error apa pun — jog-nya
 * tetap memindahkan posisi, hanya saja bisu, persis seperti sebelum fitur ini
 * ada. Tanda yang tidak pernah DILEPAS jauh lebih buruk: deck-nya berhenti
 * berbunyi selamanya dan tidak ada satu pun tombol yang bisa memulihkannya.
 * Keduanya hanya terlihat dari tes seperti ini.
 *
 * `web/src/__tests__/setup.ts` men-stub Pointer Capture API; tanpa stub itu tes
 * ini akan TAMPAK lulus padahal `pointerdown`-nya tidak pernah sampai.
 */

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Jog } from './Jog';
import { djActions, djStore } from '../store';
import { emptyDeck, type DeckState } from '../model';
import type { DeckView } from '../deck-view';

const SR = 48_000;
const RECT = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 200,
  bottom: 200,
  width: 200,
  height: 200,
  toJSON: () => ({}),
};

const viewOf = (deck: DeckState): DeckView =>
  ({
    deck,
    asset: undefined,
    grid: null,
    baseBpm: 128,
    effBpm: 128,
    tempoPct: 0,
    positionSec: 0,
    remainingSec: 0,
    durationSec: 120,
    loopBeats: null,
    loopSamples: null,
    missing: false,
  }) as unknown as DeckView;

const deckA = (): DeckState => djStore.getState().decks.A;

beforeEach(() => {
  Element.prototype.getBoundingClientRect = () => RECT as DOMRect;
  djActions.__resetForTest();
  djActions.loadDeck('A', { assetId: 1, frames: SR * 120, name: 'LAGU', sampleRate: SR });
});

afterEach(cleanup);

/** Satu tarikan lengkap pada piringan; `dx` dalam piksel CSS. */
function drag(el: HTMLElement, dx: number, release = true): void {
  act(() => {
    fireEvent.pointerDown(el, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
  });
  act(() => {
    fireEvent.pointerMove(el, { clientX: 100 + dx, clientY: 100, pointerId: 1 });
  });
  if (release) {
    act(() => {
      fireEvent.pointerUp(el, { clientX: 100 + dx, clientY: 100, pointerId: 1 });
    });
  }
}

const renderJog = (deck: DeckState = deckA()): HTMLElement => {
  const { container } = render(<Jog view={viewOf(deck)} id="A" accent="#ffd400" size={160} />);
  return container.firstElementChild as HTMLElement;
};

describe('Jog', () => {
  it('menandai scrub selama ditarik, dan melepasnya saat dilepas', () => {
    const el = renderJog();

    act(() => {
      fireEvent.pointerDown(el, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    });
    expect(deckA().scrubbing).toBe(true);

    act(() => {
      fireEvent.pointerUp(el, { clientX: 100, clientY: 100, pointerId: 1 });
    });
    expect(deckA().scrubbing).toBe(false);
  });

  it('tarikan yang lengkap tetap memindahkan posisi', () => {
    const el = renderJog();
    drag(el, 50);
    expect(deckA().playhead).toBeGreaterThan(0);
    expect(deckA().scrubbing).toBe(false);
  });

  it('tarikan yang DIBATALKAN tetap melepas tandanya', () => {
    // `pointercancel` datang dari gestur browser (swipe, tab berpindah). Tanpa
    // pelepasan di sini, deck-nya bisu selamanya dan tidak ada tombol yang
    // memulihkannya.
    const el = renderJog();
    act(() => {
      fireEvent.pointerDown(el, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    });
    act(() => {
      fireEvent.pointerCancel(el, { clientX: 120, clientY: 100, pointerId: 1 });
    });
    expect(deckA().scrubbing).toBe(false);
  });

  it('deck KOSONG tidak menandai apa pun', () => {
    const empty = emptyDeck('A');
    const { container } = render(
      <Jog view={viewOf(empty)} id="A" accent="#ffd400" size={160} />,
    );
    drag(container.firstElementChild as HTMLElement, 50);
    expect(deckA().scrubbing).toBe(false);
  });
});
