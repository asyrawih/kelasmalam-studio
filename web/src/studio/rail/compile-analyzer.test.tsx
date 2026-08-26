import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AnalyzerDialog } from './CompileCard';
import type { LoudnessAnalysis } from '../export/loudness-analyzer';

afterEach(cleanup);

const report = (over: Partial<LoudnessAnalysis> = {}): LoudnessAnalysis => ({
  integratedLufs: -11.5,
  truePeakDbtp: -0.4,
  samplePeakDbfs: -0.6,
  clippedSamples: 12,
  crestFactorDb: 4.5,
  frames: 96_000,
  durationSec: 2,
  ...over,
});

describe('dialog Roblox Safe', () => {
  it('muncul di tengah sebagai dialog dan menunjukkan empat metrik', () => {
    render(<AnalyzerDialog analysis={report()} onFix={() => undefined} onAnyway={() => undefined} onCancel={() => undefined} />);
    expect(screen.getByRole('dialog', { name: 'Roblox Safe Audio Analyzer' })).toBeTruthy();
    expect(screen.getByText('-11.5 LUFS')).toBeTruthy();
    expect(screen.getByText('-0.4 dBTP')).toBeTruthy();
    expect(screen.getByText('12 sample')).toBeTruthy();
    expect(screen.getByText('4.5 dB')).toBeTruthy();
  });

  it('FIX meneruskan gain aman yang dibatasi true peak', () => {
    const fix = vi.fn();
    render(<AnalyzerDialog analysis={report()} onFix={fix} onAnyway={() => undefined} onCancel={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'FIX & EXPORT' }));
    // Peak -0.4 harus turun ke -2.0: -1.6 dB, meskipun target LUFS meminta -4.5.
    // Yang paling konservatif adalah nilai yang lebih negatif, jadi -4.5 dB.
    expect(fix).toHaveBeenCalledWith(-4.5);
  });

  it('master yang aman cukup menawarkan EXPORT tanpa tombol bypass', () => {
    render(
      <AnalyzerDialog
        analysis={report({ integratedLufs: -16, truePeakDbtp: -3, clippedSamples: 0, crestFactorDb: 9 })}
        onFix={() => undefined}
        onAnyway={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(screen.getByRole('button', { name: 'EXPORT' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'EXPORT ANYWAY' })).toBeNull();
  });

  it('FIX tidak menutup popup: fase export tetap menampilkan dialog dan progress', () => {
    const abort = vi.fn();
    render(
      <AnalyzerDialog
        analysis={report()}
        phase="exporting"
        progress={0.42}
        onFix={() => undefined}
        onAnyway={() => undefined}
        onCancel={() => undefined}
        onAbort={abort}
      />,
    );
    expect(screen.getByRole('dialog', { name: 'Roblox Safe Audio Analyzer' })).toBeTruthy();
    expect(screen.getByText('MEMBUAT FILE FINAL…')).toBeTruthy();
    expect(screen.getByText('RENDER FINAL 42%')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'BATALKAN EXPORT' }));
    expect(abort).toHaveBeenCalledOnce();
  });

  it('sesudah export popup menampilkan hasil final dan baru bisa ditutup', () => {
    const close = vi.fn();
    const final = report({ integratedLufs: -16, truePeakDbtp: -2.4, clippedSamples: 0 });
    render(
      <AnalyzerDialog
        analysis={report()}
        phase="done"
        finalAnalysis={final}
        onFix={() => undefined}
        onAnyway={() => undefined}
        onCancel={close}
      />,
    );
    expect(screen.getByText('EXPORT SELESAI')).toBeTruthy();
    expect(screen.getByText('-16.0 LUFS')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'CLOSE' }));
    expect(close).toHaveBeenCalledOnce();
  });
});
