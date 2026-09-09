/**
 * Tag versi di topbar. Di vitest tidak ada `define` dari `vite.config.ts`, jadi
 * yang teruji di sini persis jalur terburuknya: identitas build kosong. Tag-nya
 * tetap harus tampil dan tetap harus mengaku `DEV` — bukan hilang, dan bukan
 * memampangkan `v` tanpa angka.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { VersionTag } from './VersionTag';

afterEach(cleanup);

it('menampilkan label versi dengan keterangan build di title', () => {
  render(<VersionTag />);
  const tag = screen.getByText('DEV');
  expect(tag).toBeTruthy();
  expect(tag.getAttribute('title') ?? '').toContain('Build ');
});
