/**
 * Rail kanan Audio Studio.
 *
 * Susunan awalnya persis design: Transport → tab bar → salah satu dari
 * Lane Mixer / Equalizer / Compile sesuai `tab` di store, ditambah kartu
 * Shortcut. Urutannya bisa diubah user lewat gagang ⋮⋮ dan ikut tersimpan.
 *
 * Tab bar dan kartu aktifnya dijadikan SATU unit yang dipindahkan bersama —
 * memisahkan tab dari isinya membuat susunan bisa jadi tidak masuk akal
 * (tab di bawah, isinya di atas).
 *
 * SPAN per kartu, bukan setengah lebar untuk semua. Yang menentukan bukan
 * "seberapa penting" tapi apakah isinya masih terbaca di setengah rail:
 *
 * - `transport` (2): satu baris berisi -5s / PLAY / +5s / loop DITAMBAH lima
 *   tombol speed. Di setengah rail tombol PLAY menyusut sampai labelnya nyaris
 *   sama lebar dengan tombol skip di sebelahnya, dan hirarki transport hilang.
 * - `rail-tabs` (2): Lane Mixer menaruh nama lane, nilai dB, dan bar level di
 *   satu baris (nama lane langsung ter-ellipsis kalau sempit), dan kurva EQ
 *   adalah grafik — memampatkannya secara horizontal mengubah bentuk yang
 *   justru jadi alasan grafik itu ada.
 * - `amplify`, `render-speed`, `shortcuts` (1): keduanya yang pertama memang
 *   kehilangan presisi slider, tapi masih di atas ambang `MIN_TWO_COLUMN_WIDTH`;
 *   Shortcut isinya daftar baris pendek yang malah lebih enak dibaca sempit
 *   daripada melebar penuh dengan lautan ruang kosong di kanan label.
 */

import { CompileCard } from './CompileCard';
import { EqCurveCard } from './EqCurveCard';
import { MixerCard } from './MixerCard';
import { TabBar } from './TabBar';
import { TransportCard } from './TransportCard';
import { AmplifyCard } from './AmplifyCard';
import { RenderSpeedCard } from './RenderSpeedCard';
import { ShortcutsCard } from './ShortcutsCard';
import { ReorderableStack } from '../shell/ReorderableStack';
import { useTab } from './store-adapter';

export function StudioRail(): JSX.Element {
  const tab = useTab();

  return (
    <ReorderableStack
      stack="rail"
      gap="14px"
      columns={2}
      items={[
        { id: 'transport', node: <TransportCard />, span: 2 },
        {
          id: 'rail-tabs',
          span: 2,
          node: (
            <div style={{ display: 'grid', gap: '14px', minWidth: 0 }}>
              <TabBar />
              {tab === 'mix' ? <MixerCard /> : null}
              {tab === 'eq' ? <EqCurveCard /> : null}
              {tab === 'compile' ? <CompileCard /> : null}
            </div>
          ),
        },
        { id: 'amplify', node: <AmplifyCard />, span: 1 },
        { id: 'render-speed', node: <RenderSpeedCard />, span: 1 },
        { id: 'shortcuts', node: <ShortcutsCard />, span: 1 },
      ]}
    />
  );
}

export default StudioRail;
export { registerExportHost, type ExportHost } from './export-bridge';
