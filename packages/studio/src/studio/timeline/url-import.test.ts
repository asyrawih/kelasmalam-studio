import { describe, expect, it } from 'vitest';

import { classifyUrl, nameFromUrl } from './url-import';

describe('classifyUrl', () => {
  it('mengenali layanan yang butuh server, termasuk subdomain & pemendek', () => {
    for (const u of [
      'https://www.youtube.com/watch?v=abc',
      'https://youtu.be/abc',
      'https://music.youtube.com/watch?v=abc',
      'https://soundcloud.com/artist/track',
      'https://m.soundcloud.com/artist/track',
      'https://open.spotify.com/track/xyz',
    ]) {
      const c = classifyUrl(u);
      expect(c.kind, u).toBe('needs-server');
    }
  });

  it('TIDAK salah menandai host yang kebetulan mirip', () => {
    // Ini yang gampang bocor kalau pakai `includes('youtube.com')`.
    const c = classifyUrl('https://notyoutube.com.evil.example/track.mp3');
    expect(c.kind).toBe('fetchable');
  });

  it('URL audio biasa dianggap bisa diambil', () => {
    const c = classifyUrl('https://cdn.example.com/lagu.mp3');
    expect(c.kind).toBe('fetchable');
  });

  it('menolak yang jelas bukan URL', () => {
    for (const t of ['', '   ', 'halo dunia', 'file:///Users/x/a.mp3', 'javascript:alert(1)']) {
      expect(classifyUrl(t).kind, t).toBe('not-a-url');
    }
  });

  it('teks dengan spasi bukan URL — mencegah kalimat ikut terimpor', () => {
    expect(classifyUrl('cek https://a.com/b.mp3 ya').kind).toBe('not-a-url');
  });

  it('nama file diambil dari path dan di-decode', () => {
    expect(nameFromUrl(new URL('https://a.com/x/Lagu%20Baru.mp3'))).toBe('Lagu Baru.mp3');
    expect(nameFromUrl(new URL('https://a.com/'))).toBe('a.com');
  });
});
