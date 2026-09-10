/**
 * Tombol SPLIT (docs/26 §3a): tanda galat job (`lastError` di sesi) saat
 * dialog sudah tertutup — label `SPLIT !` + pesan di `title` — sampai dialog
 * dibuka; job baru mengosongkan `lastError` dan tanda ikut hilang. Dialognya
 * dipalsukan: yang diuji hanya tombol dan sesi.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SplitToolbarButton } from '../SplitToolbarButton';
import { __resetVocalSplitSessionForTest, markVocalSplitJob, setVocalSplitError } from '../split-session';

vi.mock('../VocalSplitDialog', () => ({
  VocalSplitDialog: ({ onClose }: { onClose: () => void }) => (
    <div data-fake-dialog>
      <button type="button" onClick={onClose}>
        tutup dialog
      </button>
    </div>
  ),
}));

const button = (): HTMLButtonElement => screen.getByRole('button', { name: /SPLIT/ }) as HTMLButtonElement;

beforeEach(() => {
  __resetVocalSplitSessionForTest();
});

afterEach(() => {
  cleanup();
  __resetVocalSplitSessionForTest();
});

describe('SplitToolbarButton · tanda galat', () => {
  it('tanpa galat → label SPLIT, title biasa', () => {
    render(<SplitToolbarButton />);
    expect(button().getAttribute('aria-label')).toBe('SPLIT');
    expect(button().title).toBe('Pisahkan vokal & instrumen (Kim_Vocal_2)');
  });

  it('galat datang saat dialog tertutup → SPLIT ! dan pesan di title', () => {
    render(<SplitToolbarButton />);
    act(() => setVocalSplitError('MODEL_MISSING: model belum diunduh'));
    expect(button().getAttribute('aria-label')).toBe('SPLIT !');
    expect(button().title).toContain('GAGAL: MODEL_MISSING: model belum diunduh');
  });

  it('membuka dialog menghapus tanda; menutup dengan BATAL tidak menyalakannya lagi untuk galat yang sama', () => {
    render(<SplitToolbarButton />);
    act(() => setVocalSplitError('worker mati'));
    expect(button().getAttribute('aria-label')).toBe('SPLIT !');

    fireEvent.click(button());
    expect(document.querySelector('[data-fake-dialog]')).not.toBeNull();
    expect(button().getAttribute('aria-label')).toBe('SPLIT');
    expect(button().getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'tutup dialog' }));
    expect(document.querySelector('[data-fake-dialog]')).toBeNull();
    // Sudah dilihat; pesannya sendiri masih di sesi untuk dialog berikutnya.
    expect(button().getAttribute('aria-label')).toBe('SPLIT');
    expect(button().title).not.toContain('GAGAL');
  });

  it('job baru mengosongkan lastError → galat berikutnya menyalakan tanda lagi, meski pesannya sama', () => {
    render(<SplitToolbarButton />);
    act(() => setVocalSplitError('worker mati'));
    fireEvent.click(button());
    fireEvent.click(screen.getByRole('button', { name: 'tutup dialog' }));
    expect(button().getAttribute('aria-label')).toBe('SPLIT');

    act(() => {
      setVocalSplitError(null);
      markVocalSplitJob({ id: 'import-1', clipId: 'c', laneId: 'l' });
    });
    expect(button().getAttribute('aria-label')).toBe('SPLIT');
    act(() => {
      markVocalSplitJob(null);
      setVocalSplitError('worker mati');
    });
    expect(button().getAttribute('aria-label')).toBe('SPLIT !');
  });

  it('active saat job berjalan meski dialog tertutup', () => {
    render(<SplitToolbarButton />);
    expect(button().style.color).toBe('var(--cy-text-dim)');
    act(() => markVocalSplitJob({ id: 'import-1', clipId: 'c', laneId: 'l' }));
    expect(button().style.color).toBe('var(--cy-accent)');
  });
});
