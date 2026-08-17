import { beforeEach, describe, expect, it } from 'vitest';

import { studioActions, studioStore } from '../store';
import { deserialize, serialize } from './persistence';

describe('serialisasi project', () => {
  beforeEach(() => studioActions.__resetForTest());

  it('bolak-balik mempertahankan lane dan clip', () => {
    const before = studioStore.getState();
    const back = deserialize(serialize(before));
    expect(back).not.toBeNull();
    expect(back!.lanes).toEqual(before.lanes);
    expect(back!.sampleRate).toBe(before.sampleRate);
  });

  it('TIDAK menyimpan state transien', () => {
    studioActions.togglePlay();
    studioActions.copySelectedClip();
    const json = serialize(studioStore.getState());
    // Kalau "playing" ikut tersimpan, refresh akan membunyikan audio sendiri.
    expect(json).not.toContain('"playing"');
    expect(json).not.toContain('"clipboard"');
    expect(json).not.toContain('"draggingClip"');
    expect(json).not.toContain('"exportProgress"');
  });

  it('menolak data dengan versi berbeda — lebih baik mulai bersih daripada salah baca', () => {
    const json = serialize(studioStore.getState());
    const bumped = json.replace('"version":1', '"version":99');
    expect(deserialize(bumped)).toBeNull();
  });

  it('menolak JSON rusak tanpa melempar', () => {
    expect(deserialize('{bukan json')).toBeNull();
    expect(deserialize('{}')).toBeNull();
    expect(deserialize('{"version":1,"lanes":[]}')).toBeNull();
  });

  it('hydrate memaksa playing=false walau data lama menyatakan sebaliknya', () => {
    studioActions.hydrate({ playing: true, playhead: 1000 });
    expect(studioStore.getState().playing).toBe(false);
    expect(studioStore.getState().playhead).toBe(1000);
  });
});
