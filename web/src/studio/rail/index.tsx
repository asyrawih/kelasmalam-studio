/**
 * Rail kanan Audio Studio (kolom 360px di design).
 *
 * Susunan awalnya persis design: Transport → tab bar → salah satu dari
 * Lane Mixer / Equalizer / Compile sesuai `tab` di store, ditambah kartu
 * Shortcut. Urutannya bisa diubah user lewat gagang ⋮⋮ dan ikut tersimpan.
 *
 * Tab bar dan kartu aktifnya dijadikan SATU unit yang dipindahkan bersama —
 * memisahkan tab dari isinya membuat susunan bisa jadi tidak masuk akal
 * (tab di bawah, isinya di atas).
 */

import { CompileCard } from './CompileCard';
import { EqCurveCard } from './EqCurveCard';
import { MixerCard } from './MixerCard';
import { TabBar } from './TabBar';
import { TransportCard } from './TransportCard';
import { ShortcutsCard } from './ShortcutsCard';
import { ReorderableStack } from '../shell/ReorderableStack';
import { useTab } from './store-adapter';

export function StudioRail(): JSX.Element {
  const tab = useTab();

  return (
    <ReorderableStack
      stack="rail"
      gap="14px"
      items={[
        { id: 'transport', node: <TransportCard /> },
        {
          id: 'rail-tabs',
          node: (
            <div style={{ display: 'grid', gap: '14px', minWidth: 0 }}>
              <TabBar />
              {tab === 'mix' ? <MixerCard /> : null}
              {tab === 'eq' ? <EqCurveCard /> : null}
              {tab === 'compile' ? <CompileCard /> : null}
            </div>
          ),
        },
        { id: 'shortcuts', node: <ShortcutsCard /> },
      ]}
    />
  );
}

export default StudioRail;
export { registerExportHost, type ExportHost } from './export-bridge';
