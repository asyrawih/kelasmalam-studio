/**
 * Registry pemakaian aset (docs/25 P4): core tidak tahu lane, jadi jawabannya
 * dijumlahkan dari penyedia yang mendaftar. Yang dijaga: penjumlahan lintas
 * penyedia, pelepasan pendaftaran, dan penyedia yang rusak tidak membekukan
 * tombol hapus di `/dj`.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { __clearAssetUsageForTest, assetUsage, registerAssetUsage } from './usage';

beforeEach(() => __clearAssetUsageForTest());

describe('assetUsage', () => {
  it('tanpa penyedia: tidak dipakai', () => {
    expect(assetUsage(7)).toEqual({ count: 0, where: [] });
  });

  it('menjumlahkan jawaban semua penyedia, urut pendaftaran', () => {
    registerAssetUsage((id) => ({ count: id === 7 ? 2 : 0, where: id === 7 ? ['LANE A'] : [] }));
    registerAssetUsage(() => ({ count: 1, where: ['POLA 3'] }));
    expect(assetUsage(7)).toEqual({ count: 3, where: ['LANE A', 'POLA 3'] });
    expect(assetUsage(8)).toEqual({ count: 1, where: ['POLA 3'] });
  });

  it('pendaftaran bisa dilepas', () => {
    const off = registerAssetUsage(() => ({ count: 1, where: ['X'] }));
    expect(assetUsage(1).count).toBe(1);
    off();
    expect(assetUsage(1).count).toBe(0);
  });

  it('penyedia yang melempar diabaikan — yang lain tetap dihitung', () => {
    registerAssetUsage(() => {
      throw new Error('rusak');
    });
    registerAssetUsage(() => ({ count: 1, where: ['Y'] }));
    expect(assetUsage(1)).toEqual({ count: 1, where: ['Y'] });
  });
});
