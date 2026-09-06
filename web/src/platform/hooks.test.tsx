/**
 * Dua hook yang membuat komponen import tidak perlu tahu platformnya:
 * `useAudioFilePicker` (input web vs dialog native) dan `useNativeFileDrop`
 * (zona mana yang kena drop OS). Host-nya dipalsukan lewat
 * `setPlatformHostForTests`, jadi jalur desktop bisa diuji di jsdom.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DropPoint, PlatformHost } from './host';
import { getPlatformHost, setPlatformHostForTests } from './index';
import { useAudioFilePicker } from './useAudioFilePicker';
import { hitTest, useNativeFileDrop } from './useNativeFileDrop';
import { createWebHost } from './web';

afterEach(() => {
  cleanup();
  setPlatformHostForTests(null);
});

const wav = (name: string): File => new File([new Uint8Array(4)], name, { type: 'audio/wav' });

function fakeDesktopHost(over: Partial<PlatformHost> = {}): PlatformHost & {
  readonly dropListeners: Set<(files: readonly File[], point: DropPoint) => void>;
} {
  const dropListeners = new Set<(files: readonly File[], point: DropPoint) => void>();
  return {
    ...createWebHost(),
    kind: 'desktop',
    openAudioFiles: async () => [wav('native.wav')],
    onFilesDropped: (cb) => {
      dropListeners.add(cb);
      return () => dropListeners.delete(cb);
    },
    dropListeners,
    ...over,
  };
}

function Picker({ onFiles }: { readonly onFiles: (f: readonly File[]) => void }): JSX.Element {
  const picker = useAudioFilePicker(onFiles, { ariaLabel: 'pilih berkas', dataAttr: 'data-picker' });
  return (
    <div>
      <button type="button" onClick={picker.open}>
        PILIH
      </button>
      {picker.input}
    </div>
  );
}

describe('getPlatformHost', () => {
  it('di luar Tauri memilih host web, dan host tes menggantikannya', () => {
    expect(getPlatformHost().kind).toBe('web');
    const fake = fakeDesktopHost();
    setPlatformHostForTests(fake);
    expect(getPlatformHost()).toBe(fake);
    setPlatformHostForTests(null);
    expect(getPlatformHost().kind).toBe('web');
  });
});

describe('useAudioFilePicker', () => {
  it('web: merender <input type=file> yang di-klik tombol, dan direset sesudah change', () => {
    const got: string[][] = [];
    render(<Picker onFiles={(f) => got.push(f.map((x) => x.name))} />);
    const input = screen.getByLabelText('pilih berkas') as HTMLInputElement;
    expect(input.type).toBe('file');
    expect(input.hasAttribute('data-picker')).toBe(true);
    const click = vi.spyOn(input, 'click');
    fireEvent.click(screen.getByText('PILIH'));
    expect(click).toHaveBeenCalledOnce();

    Object.defineProperty(input, 'files', { value: [wav('a.wav'), wav('b.wav')], configurable: true });
    fireEvent.change(input);
    expect(got).toEqual([['a.wav', 'b.wav']]);
    expect(input.value).toBe('');
  });

  it('desktop: tidak ada input; tombol memanggil dialog native dan hasilnya ke handler terbaru', async () => {
    const openAudioFiles = vi.fn(async () => [wav('native.wav')]);
    setPlatformHostForTests(fakeDesktopHost({ openAudioFiles }));
    const got: string[][] = [];
    render(<Picker onFiles={(f) => got.push(f.map((x) => x.name))} />);
    expect(screen.queryByLabelText('pilih berkas')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByText('PILIH'));
      await Promise.resolve();
    });
    expect(openAudioFiles).toHaveBeenCalledWith({ multiple: true, extensions: undefined });
    expect(got).toEqual([['native.wav']]);
  });

  it('desktop: dialog dibatalkan (kosong) tidak memanggil handler', async () => {
    setPlatformHostForTests(fakeDesktopHost({ openAudioFiles: async () => [] }));
    const onFiles = vi.fn();
    render(<Picker onFiles={onFiles} />);
    await act(async () => {
      fireEvent.click(screen.getByText('PILIH'));
      await Promise.resolve();
    });
    expect(onFiles).not.toHaveBeenCalled();
  });
});

function Zone({
  onDrop,
  enabled = true,
}: {
  readonly onDrop: (f: readonly File[], p: DropPoint) => void;
  readonly enabled?: boolean;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useNativeFileDrop(ref, onDrop, enabled);
  return <div ref={ref} data-testid="zone" />;
}

describe('useNativeFileDrop', () => {
  it('web: tidak berlangganan apa pun', () => {
    const onDrop = vi.fn();
    render(<Zone onDrop={onDrop} />);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('desktop: drop di dalam kotak zona sampai, di luar tidak; lepas saat unmount', () => {
    const host = fakeDesktopHost();
    setPlatformHostForTests(host);
    const onDrop = vi.fn();
    const view = render(<Zone onDrop={onDrop} />);
    expect(host.dropListeners.size).toBe(1);

    // jsdom tidak punya layout: kotak zona dan `elementFromPoint` dipalsukan.
    const zone = screen.getByTestId('zone');
    zone.getBoundingClientRect = () =>
      ({ left: 100, top: 100, right: 300, bottom: 200, width: 200, height: 100 }) as DOMRect;
    const original = document.elementFromPoint;
    (document as { elementFromPoint?: unknown }).elementFromPoint = undefined;
    try {
      const files = [wav('drop.wav')];
      for (const cb of host.dropListeners) cb(files, { x: 150, y: 150 });
      for (const cb of host.dropListeners) cb(files, { x: 50, y: 150 });
      expect(onDrop).toHaveBeenCalledTimes(1);
      expect(onDrop).toHaveBeenCalledWith(files, { x: 150, y: 150 });
    } finally {
      (document as { elementFromPoint?: unknown }).elementFromPoint = original;
    }

    view.unmount();
    expect(host.dropListeners.size).toBe(0);
  });

  it('dimatikan (`enabled=false`) → tidak berlangganan', () => {
    const host = fakeDesktopHost();
    setPlatformHostForTests(host);
    render(<Zone onDrop={vi.fn()} enabled={false} />);
    expect(host.dropListeners.size).toBe(0);
  });

  it('hitTest memakai elementFromPoint kalau ada: yang tertutup elemen lain tidak kena', () => {
    const zone = document.createElement('div');
    const child = document.createElement('span');
    zone.appendChild(child);
    const other = document.createElement('div');
    const original = document.elementFromPoint;
    try {
      (document as { elementFromPoint?: unknown }).elementFromPoint = () => child;
      expect(hitTest(zone, { x: 1, y: 1 })).toBe(true);
      (document as { elementFromPoint?: unknown }).elementFromPoint = () => other;
      expect(hitTest(zone, { x: 1, y: 1 })).toBe(false);
    } finally {
      (document as { elementFromPoint?: unknown }).elementFromPoint = original;
    }
  });
});
