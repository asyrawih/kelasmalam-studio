/**
 * Sisipan Beat FX pada graf DJ.
 *
 * ## Insert, bukan send
 *
 * DJM punya keduanya; `createFxNode` menghasilkan satu node rantai yang alami
 * dipasang sebagai INSERT. Send butuh percabangan dan bus kembali, dan itu
 * menuntut keputusan tentang berapa bus yang ada — celah yang `docs/08 §8e`
 * sendiri belum tutup. Jadi: insert, dan UI mengatakan bahwa LEVEL adalah
 * dry/wet, bukan besarnya kiriman.
 *
 * ## Di mana ia disisipkan
 *
 * Untuk kanal: antara channel fader dan gain crossfader — **post-fader**, sesuai
 * perilaku DJM yang dicatat manualnya sendiri ("menurunkan channel fader
 * menyisakan ekor delay"). Untuk master: antara titik jumlah kanal dan gain
 * master.
 *
 * Menyisipkan berarti memutus SATU sambungan dan menaruh node di antaranya.
 * `disconnect(target)` dengan argumen hanya melepas sambungan itu, jadi cabang
 * ke analyser dan ke bus CUE tetap utuh — dan itu memang yang benar: meter dan
 * headphone harus tetap mendengar kanalnya.
 *
 * ## Tempo
 *
 * Efek ber-`BEAT_SYNC` percuma tanpa tempo. Sejak `fxchain_set_tempo` ada di
 * ABI, panjang ketukan dikirim tiap kali BPM efektif deck target berubah —
 * itulah yang membuat "1/4 ketukan" berarti 1/4 ketukan LAGU ITU, bukan 1/4
 * ketukan pada 120 BPM.
 */

import { PFLAG, fromNorm, type EffectDesc } from '../../audio/fx-catalog';
import { createFxNode, pushFxParams, pushFxTempo } from '../../studio/preview/fx-node';
import type { FxInsert } from '../../studio/model';
import type { FxState, FxTargetDj } from '../model';
import type { DjGraph } from './dj-graph';

interface Attachment {
  readonly node: AudioWorkletNode;
  readonly target: FxTargetDj;
  readonly kind: string;
  readonly from: AudioNode;
  readonly to: AudioNode;
}

/** Titik potong untuk tiap target. */
function seamFor(g: DjGraph, target: FxTargetDj): { from: AudioNode; to: AudioNode } {
  if (target === 'master') return { from: g.masterFxIn, to: g.master };
  const ch = g.channels[target];
  return { from: ch.fader, to: ch.cross };
}

/** Parameter "besar" gaya rekordbox — satu knob raksasa di panel. */
function primaryIndex(desc: EffectDesc): number {
  const i = desc.params.findIndex((p) => (p.flags & PFLAG.PRIMARY) !== 0);
  return i >= 0 ? i : 0;
}

function beatIndex(desc: EffectDesc): number {
  return desc.params.findIndex((p) => (p.flags & PFLAG.BEAT_SYNC) !== 0);
}

/**
 * Bangun `FxInsert` dari state UI.
 *
 * Nilai knob UI adalah 0..1; katalog yang menentukan artinya. `fromNorm`
 * dipakai di sini persis seperti di panel FX Studio, jadi angka yang dikirim ke
 * engine SELALU sama dengan angka yang dipajang di layar.
 */
function insertOf(fx: FxState, desc: EffectDesc): FxInsert {
  const params: Record<string, number> = {};
  const pi = primaryIndex(desc);
  const primary = desc.params[pi];
  if (primary !== undefined) params[primary.id] = fromNorm(primary, fx.level);

  const bi = beatIndex(desc);
  const beatParam = bi >= 0 ? desc.params[bi] : undefined;
  if (beatParam !== undefined) {
    // Parameter beat memakai satuannya sendiri (`Unit::Beats`), jadi nilainya
    // dikirim APA ADANYA — bukan lewat `fromNorm`, yang mengharap 0..1.
    params[beatParam.id] = fx.beats;
  }
  return { kind: desc.id, enabled: fx.on, params };
}

export class FxInsertSlot {
  private attached: Attachment | null = null;
  /**
   * Sidik jari nilai yang terakhir DIKIRIM.
   *
   * `sync()` dipanggil pada SETIAP perubahan state — termasuk tiap piksel
   * gerakan crossfader, yang tidak ada hubungannya dengan FX. Tanpa penjaga
   * ini, satu tarikan crossfader mengirim puluhan `postMessage` per detik ke
   * thread audio untuk nilai yang sama persis.
   */
  private lastPush = '';

  /**
   * Selaraskan sisipan dengan state.
   *
   * Node dibangun ulang hanya kalau JENIS atau TARGET berubah — mengubah level
   * atau on/off cukup lewat pesan, dan membangun ulang node untuk itu akan
   * memotong bunyi tiap kali knob digerakkan.
   */
  sync(g: DjGraph, fx: FxState, catalog: Map<string, EffectDesc> | null, framesPerBeat: number | null): void {
    const desc = catalog?.get(fx.kind);
    if (desc === undefined) {
      this.detach();
      return;
    }

    const cur = this.attached;
    if (cur !== null && (cur.kind !== fx.kind || cur.target !== fx.target)) {
      this.detach();
    }

    if (this.attached === null) {
      const node = createFxNode(g.ctx, [insertOf(fx, desc)]);
      if (node === null) return;
      const { from, to } = seamFor(g, fx.target);
      try {
        from.disconnect(to);
      } catch {
        // Sambungan sudah tidak ada — keadaan sah saat graf baru dibangun.
      }
      from.connect(node);
      node.connect(to);
      this.attached = { node, target: fx.target, kind: fx.kind, from, to };
    }

    const a = this.attached;
    if (a === null) return;

    const fingerprint = `${fx.kind}|${fx.on ? 1 : 0}|${fx.level}|${fx.beats}|${framesPerBeat ?? ''}`;
    if (fingerprint === this.lastPush) return;
    this.lastPush = fingerprint;

    pushFxParams(a.node, [insertOf(fx, desc)]);
    if (framesPerBeat !== null) pushFxTempo(a.node, framesPerBeat);
  }

  detach(): void {
    const a = this.attached;
    this.attached = null;
    this.lastPush = '';
    if (a === null) return;
    try {
      a.from.disconnect(a.node);
      a.node.disconnect();
      a.node.port.postMessage({ type: 'dispose' });
    } catch {
      // sudah terlepas
    }
    // Sambungan langsung dipasang kembali supaya jalur sinyalnya utuh lagi.
    try {
      a.from.connect(a.to);
    } catch {
      // sudah tersambung
    }
  }
}
