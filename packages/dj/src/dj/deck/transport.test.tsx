/**
 * Tombol PLAY tidak boleh berbohong selama cue preview.
 *
 * Menahan CUE membuat deck berbunyi, tapi bunyinya berakhir begitu tombolnya
 * dilepas. PLAY yang ikut menyala di detik itu membuat satu klik CUE terlihat
 * seperti dua tombol yang tertekan bersamaan — keluhan yang sungguh muncul.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { DeckTransport } from './DeckTransport';
import { emptyDeck, type DeckState } from '../model';

const deckWith = (patch: Partial<DeckState>): DeckState => ({
  ...emptyDeck('A'),
  assetId: 1,
  frames: 48_000,
  ...patch,
});

afterEach(cleanup);

describe('DeckTransport', () => {
  it('CUE ditahan → PLAY tetap berkata PLAY, bukan PAUSE', () => {
    render(
      <DeckTransport deck={deckWith({ playing: true, cueHeld: true })} id="A" accent="#ffd400" />,
    );
    expect(screen.getByRole('button', { name: /PLAY/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /PAUSE/ })).toBeNull();
  });

  it('pemutaran biasa tetap menawarkan PAUSE', () => {
    render(<DeckTransport deck={deckWith({ playing: true })} id="A" accent="#ffd400" />);
    expect(screen.getByRole('button', { name: /PAUSE/ })).toBeTruthy();
  });
});
