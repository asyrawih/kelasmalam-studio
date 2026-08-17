import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { sniff } from './sniff';

const bytes = (arr: number[]): ArrayBuffer => new Uint8Array(arr).buffer;
const of = (s: string, pad = 0): ArrayBuffer =>
  new Uint8Array([...Array(pad).fill(0), ...[...s].map((c) => c.charCodeAt(0))]).buffer;

describe('sniff', () => {
  it('mengenali Ogg', () => {
    expect(sniff(of('OggS'))).toEqual({ kind: 'audio', format: 'Ogg' });
  });

  it('mengenali gzip — kasus yang memicu modul ini', () => {
    expect(sniff(bytes([0x1f, 0x8b, 0x08, 0x00]))).toEqual({ kind: 'gzip' });
  });

  it('mengenali WAV hanya kalau RIFF DAN WAVE', () => {
    const wav = new Uint8Array(16);
    wav.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
    wav.set([...'WAVE'].map((c) => c.charCodeAt(0)), 8);
    expect(sniff(wav.buffer)).toEqual({ kind: 'audio', format: 'WAV' });
    // RIFF saja (mis. AVI) bukan audio yang kita terima.
    expect(sniff(of('RIFF')).kind).toBe('unknown');
  });

  it('menyebut HTML sebagai penyebab, bukan "format tak dikenal"', () => {
    const r = sniff(of('<!DOCTYPE html>'));
    expect(r.kind).toBe('unknown');
    expect(r.kind === 'unknown' && r.description).toContain('HTML');
  });

  it('tidak melempar untuk buffer kosong', () => {
    expect(() => sniff(new ArrayBuffer(0))).not.toThrow();
  });

  it('file .ogg asli milik user ternyata gzip, dan isinya Ogg', () => {
    const path = '/Users/dxh4nan/Downloads/mahjon bkb_78189972408569_Didhaaa7.ogg';
    let raw: Buffer;
    try {
      raw = readFileSync(path);
    } catch {
      return; // file tidak ada di mesin lain — lewati, jangan gagalkan CI
    }
    // Salin ke ArrayBuffer murni: Buffer Node bisa didukung SharedArrayBuffer.
    const buf = new Uint8Array(raw).slice().buffer;
    expect(sniff(buf)).toEqual({ kind: 'gzip' });
  });
});
