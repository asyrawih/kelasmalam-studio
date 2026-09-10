import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { createMixer, MixerPanel, wouldCycle } from './MixerPanel';
afterEach(cleanup);
function Harness(): JSX.Element { const [value, onChange] = useState(createMixer); return <MixerPanel value={value} onChange={onChange} channels={[{ name: 'Kick' }]} />; }
it('keeps ten FX slots per insert, independently from other inserts', () => {
  render(<Harness />);
  fireEvent.change(screen.getByLabelText('Effect slot 1'), { target: { value: 'Compressor' } });
  expect(screen.getByLabelText('Effect slot 10')).toBeTruthy();
  fireEvent.click(screen.getByLabelText('Select Snare'));
  expect((screen.getByLabelText('Effect slot 1') as HTMLSelectElement).value).toBe('');
  fireEvent.click(screen.getByLabelText('Select Kick'));
  expect((screen.getByLabelText('Effect slot 1') as HTMLSelectElement).value).toBe('Compressor');
});
it('creates a zero-level sidechain without removing the source master send', () => {
  render(<Harness />);
  fireEvent.click(screen.getByLabelText('Send Kick to Snare'));
  fireEvent.change(screen.getByLabelText('Send level to Snare'), { target: { value: '0' } });
  expect(screen.getByText('Master: 100% · Snare: sidechain only')).toBeTruthy();
  fireEvent.click(screen.getByLabelText('Select Snare'));
  expect((screen.getByLabelText('Send Snare to Kick') as HTMLButtonElement).disabled).toBe(true);
});
it('edits Master volume and changes channel assignment independently', () => {
  render(<Harness />);
  fireEvent.change(screen.getByLabelText('Master volume'), { target: { value: '-6' } });
  expect((screen.getByLabelText('Master volume') as HTMLInputElement).value).toBe('-6');
  expect((screen.getByLabelText('Kick volume') as HTMLInputElement).value).toBe('0');
  fireEvent.click(screen.getByText('Channel routing · 1 channels'));
  fireEvent.change(screen.getByLabelText('Route Kick to insert'), { target: { value: 'master' } });
  expect((screen.getByLabelText('Route Kick to insert') as HTMLSelectElement).value).toBe('master');
});
it('rejects transitive feedback including sidechain-only links', () => {
  const { inserts } = createMixer();
  inserts[1]!.sends['insert-2'] = 0;
  inserts[2]!.sends['insert-3'] = 100;
  expect(wouldCycle(inserts, 'insert-3', 'insert-1')).toBe(true);
  expect(wouldCycle(inserts, 'insert-1', 'insert-4')).toBe(false);
});
