/**
 * Pemilih perangkat keluaran CUE.
 *
 * Monitor headphone hanya berarti kalau ia keluar dari perangkat yang BERBEDA
 * dari master — kalau tidak, menyalakan CUE cuma menggandakan lagu yang sama di
 * speaker. Web Audio tidak bisa membelah `ctx.destination`, jadi jalannya lewat
 * `MediaStreamAudioDestinationNode` + `HTMLAudioElement.setSinkId`, dan itu
 * menuntut user MEMILIH perangkatnya sendiri.
 *
 * Selama belum dipilih, tombol CUE per kanal tetap bekerja (kirimannya nyata,
 * dan meternya ikut) tapi tidak ada yang memonitornya — dan komponen ini
 * mengatakan itu, bukan diam.
 *
 * Daftar perangkat baru punya NAMA setelah izin media diberikan. Kita tidak
 * meminta izin mikrofon hanya demi label: entri tanpa nama tetap bisa dipilih,
 * dan menukar akses mikrofon dengan nama perangkat bukan pertukaran yang pantas
 * ditawarkan.
 */

import { useEffect, useState } from 'react';

import { djAudio } from '../audio/engine';
import { isCueRoutingSupported, listOutputDevices, type CueDevice } from '../audio/cue-output';
import { djActions, djStore } from '../store';

export function CueOutputPicker(): JSX.Element {
  const [devices, setDevices] = useState<readonly CueDevice[]>([]);
  const [selected, setSelected] = useState('');
  const supported = isCueRoutingSupported();

  useEffect(() => {
    if (!supported) return;
    let alive = true;
    void listOutputDevices().then((d) => {
      if (alive) setDevices(d);
    });
    return () => {
      alive = false;
    };
  }, [supported]);

  if (!supported) {
    return (
      <div
        style={{ fontSize: '8px', color: 'var(--cy-text-muted)', textAlign: 'center' }}
        title="browser ini tidak mendukung setSinkId, jadi CUE tidak bisa diarahkan ke perangkat lain"
      >
        CUE: TIDAK DIDUKUNG
      </div>
    );
  }

  return (
    <select
      value={selected}
      aria-label="perangkat keluaran CUE"
      title="pilih perangkat headphone; selama belum dipilih, CUE tidak terdengar di mana pun"
      onChange={(e) => {
        const id = e.target.value;
        setSelected(id);
        const audio = djAudio();
        if (audio === null) {
          djActions.setNotice('audio belum menyala — sentuh salah satu kontrol dulu');
          return;
        }
        void audio.selectCueDevice(id === '' ? null : id, djStore.getState()).then((err) => {
          djActions.setNotice(err);
          if (err !== null) setSelected('');
        });
      }}
      style={{
        background: 'var(--cy-surface-2)',
        color: selected === '' ? 'var(--cy-text-muted)' : 'var(--cy-accent)',
        border: '1px solid var(--cy-border)',
        fontFamily: 'var(--cy-font-mono)',
        fontSize: '8px',
        padding: '2px 3px',
        maxWidth: '110px',
      }}
    >
      <option value="">CUE: TIDAK DIMONITOR</option>
      {devices.map((d) => (
        <option key={d.deviceId} value={d.deviceId}>
          {d.label}
        </option>
      ))}
    </select>
  );
}
