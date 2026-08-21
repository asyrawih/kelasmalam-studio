/**
 * Pemutar satu deck.
 *
 * ## Kenapa `AudioBufferSourceNode`, bukan resampler AudioWorklet sendiri
 *
 * Worklet ber-kursor-float adalah jawaban yang benar untuk scratch, reverse, dan
 * key lock — dan ketiganya memang ditandai TIDAK/MATI di matriks fitur
 * (`recordbox/00-plan.md`). Yang BENAR-BENAR dibutuhkan halaman ini adalah
 * varispeed, loop, dan slip, dan ketiganya sudah ada di node bawaan:
 *
 *  - `playbackRate` memberi varispeed;
 *  - `loop` + `loopStart`/`loopEnd` memberi loop **sample-akurat**, dan ketiganya
 *    bisa diubah SAAT BERBUNYI tanpa menjadwalkan ulang apa pun — itu persis
 *    yang dibutuhkan tombol ÷2/×2 di tengah lagu;
 *  - slip cukup dengan membayangi posisi di JS, karena yang dibutuhkan saat
 *    slip berakhir hanyalah satu lompatan ke posisi bayangan.
 *
 * Harganya kalau memakai worklet: PCM harus DISALIN dan ditransfer ke thread
 * audio, karena mentransfer `AudioBuffer` yang sudah ada akan men-*detach*-nya
 * dan merusak cache bersama di `audio-preview.ts`. Untuk lagu stereo lima menit
 * itu ~115 MB duplikat per deck. Membayar itu untuk fitur yang memang tidak
 * dibangun adalah harga yang salah.
 *
 * ## Posisi datang dari JANGKAR, bukan dari akumulasi
 *
 * `positionAt(now)` dihitung dari satu jangkar `(ctxTime, sourcePos, rate)`.
 * Menjumlahkan delta tiap frame akan menghanyutkan posisi terhadap yang
 * benar-benar terdengar — dan hanyutnya tidak pernah terlihat sampai lagu
 * berjalan lima menit, yaitu tepat saat DJ paling bergantung padanya.
 *
 * Tiap perubahan laju memasang jangkar BARU pada posisi saat itu, jadi
 * matematikanya tetap potongan-lurus dan tidak pernah perlu integrasi.
 *
 * ## SCRUB: source utama DIAM, butir yang berbunyi
 *
 * Selama tangan menarik (jog atau waveform), source utama dimatikan dan yang
 * terdengar datang dari `ScrubVoice`. Itu keputusan, bukan penyederhanaan:
 * kalau source utama dibiarkan hidup, tiap `pointermove` menjadwalkannya ulang
 * di posisi baru — enam puluh potongan 16 ms per detik, yang terdengar sebagai
 * dengung, bukan sebagai lagu (alasan lengkapnya di kepala `scrub-voice.ts`).
 * Membiarkan keduanya berbunyi bersama akan menumpuk dengung itu DI ATAS
 * butir-butirnya.
 *
 * `playing` TIDAK ikut dimatikan selama scrub: ia berarti "PLAY menyala", yaitu
 * niat user, dan tangan yang menyentuh piringan tidak membatalkan niat itu —
 * persis seperti CDJ. Yang membekukan posisi adalah `scrubbing`, dan `endScrub`
 * membaca `playing` untuk tahu apakah lagunya harus lanjut berjalan saat tangan
 * diangkat.
 */

import { ScrubVoice } from './scrub-voice';
import type { AutoStemAudio, AutoStemMask } from '../../stem/auto-stem';
import type { ScnetStem } from '../../proof-stem/scnet-separate';

/** Fade masuk/keluar saat melompat. Cukup untuk membunuh klik, terlalu pendek
 *  untuk terdengar sebagai fade. Sama dengan micro-fade docs/06 §6d. */
const MICRO_FADE_SEC = 0.003;

export interface DeckLoopSpec {
  readonly inAt: number;
  readonly outAt: number;
}

export interface DeckPlayerOptions {
  readonly ctx: BaseAudioContext;
  /** Node tujuan — masukan channel strip deck ini. */
  readonly destination: AudioNode;
}

interface Anchor {
  /** `ctx.currentTime` saat jangkar dipasang. */
  readonly at: number;
  /** Posisi SOURCE (sample) pada saat itu. */
  readonly pos: number;
  /** Laju baca saat itu. */
  readonly rate: number;
}

export class DeckPlayer {
  private readonly ctx: BaseAudioContext;
  private readonly out: AudioNode;

  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  /** Source ke-2..4 saat stem SCNet aktif; `source` tetap memegang yang pertama. */
  private extraSources: AudioBufferSourceNode[] = [];
  private gate: GainNode | null = null;
  private stemAudio: AutoStemAudio | null = null;
  private stemMask: AutoStemMask | null = null;

  private anchor: Anchor = { at: 0, pos: 0, rate: 1 };
  private playing = false;
  private rate = 1;
  private loop: DeckLoopSpec | null = null;

  /**
   * Posisi bayangan untuk SLIP: berjalan seolah tidak ada loop dan tidak ada
   * lompatan. Saat slip dilepas, inilah yang jadi posisi sungguhan.
   */
  private slipArmed = false;
  private slipAnchor: Anchor = { at: 0, pos: 0, rate: 1 };

  /** Butir-butir yang berbunyi selama tangan menarik. Lihat `scrub-voice.ts`. */
  private readonly scrub: ScrubVoice;
  /** true selama tangan menarik. Membekukan posisi; tidak menyentuh `playing`. */
  private scrubbing = false;

  constructor(o: DeckPlayerOptions) {
    this.ctx = o.ctx;
    this.out = o.destination;
    // Tujuan yang SAMA dengan source utama: butir scrub harus lewat TRIM, EQ,
    // fader, dan CUE seperti lagunya sendiri.
    this.scrub = new ScrubVoice({ ctx: o.ctx, destination: o.destination });
  }

  get sampleRate(): number {
    return this.buffer?.sampleRate ?? this.ctx.sampleRate;
  }

  get frames(): number {
    return this.buffer?.length ?? 0;
  }

  get hasBuffer(): boolean {
    return this.buffer !== null;
  }

  /** Laju baca yang sedang berlaku. Dibaca metronom supaya kliknya ikut tempo. */
  get playbackRate(): number {
    return this.rate;
  }

  /** Materi baru. Menghentikan apa pun yang sedang berbunyi. */
  load(buffer: AudioBuffer | null, atSample: number): void {
    this.stopSource(0);
    this.scrub.setBuffer(buffer);
    this.buffer = buffer;
    this.stemAudio = null;
    this.stemMask = null;
    this.playing = false;
    this.scrubbing = false;
    this.anchor = { at: this.ctx.currentTime, pos: atSample, rate: this.rate };
    this.slipAnchor = this.anchor;
  }

  /**
   * Ganti mixture dengan kumpulan stem yang berjalan pada jam dan offset yang
   * sama. `null` kembali ke mixture asli. Pergantiannya memakai micro-fade
   * yang sama dengan seek, jadi mute/solo stem tidak berbunyi klik.
   */
  setStemMix(audio: AutoStemAudio | null, mask: AutoStemMask | null): void {
    const sameMask = this.stemMask !== null && mask !== null &&
      (Object.keys(mask) as ScnetStem[]).every((stem) => this.stemMask?.[stem] === mask[stem]);
    if (this.stemAudio === audio && (this.stemMask === mask || sameMask)) return;
    const now = this.ctx.currentTime;
    const pos = this.positionAt(now);
    this.stemAudio = audio;
    this.stemMask = mask;
    if (this.playing && !this.scrubbing) this.startSource(pos);
  }

  /**
   * Posisi SOURCE yang BENAR-BENAR terdengar sekarang.
   *
   * Loop diterapkan di sini juga, bukan hanya di node: `loopEnd` node membuat
   * kursornya melipat sendiri, dan matematika di sini harus melipat dengan cara
   * yang sama supaya angka di layar tidak menyimpang dari yang terdengar.
   */
  positionAt(now: number): number {
    // Selama scrub, posisi hanya berpindah karena tangan — bukan karena waktu.
    const moving = this.playing && !this.scrubbing;
    const a = moving ? this.anchor : { ...this.anchor, rate: 0 };
    const raw = a.pos + (now - a.at) * a.rate * this.sampleRate;
    return this.foldLoop(raw);
  }

  /** Posisi bayangan slip — dipakai saat SLIP dilepas. */
  slipPositionAt(now: number): number {
    const raw = this.slipAnchor.pos + (now - this.slipAnchor.at) * this.slipAnchor.rate * this.sampleRate;
    return Math.min(Math.max(0, raw), this.frames);
  }

  private foldLoop(raw: number): number {
    const l = this.loop;
    if (l === null) return Math.min(Math.max(0, raw), this.frames);
    const len = l.outAt - l.inAt;
    if (len <= 0 || raw < l.outAt) return Math.min(Math.max(0, raw), this.frames);
    return l.inAt + ((raw - l.inAt) % len);
  }

  play(fromSample: number): void {
    if (this.buffer === null) return;
    const pos = Math.min(Math.max(0, fromSample), this.frames);
    this.playing = true;
    if (this.scrubbing) {
      // PLAY ditekan saat tangan masih di piringan: niatnya dicatat, tapi yang
      // berbunyi tetap butir scrub sampai tangan diangkat. `endScrub` yang
      // menyalakan source-nya.
      this.anchor = { at: this.ctx.currentTime, pos, rate: this.rate };
      return;
    }
    this.startSource(pos);
  }

  pause(): void {
    if (!this.playing) return;
    const now = this.ctx.currentTime;
    const pos = this.positionAt(now);
    this.stopSource(MICRO_FADE_SEC);
    this.playing = false;
    this.anchor = { at: now, pos, rate: this.rate };
    this.slipAnchor = { at: now, pos, rate: this.rate };
  }

  /**
   * Lompat ke posisi lain.
   *
   * Selalu menjadwalkan source BARU: `AudioBufferSourceNode` tidak bisa
   * dipindahkan posisinya setelah `start()`. Yang lama diredam lewat micro-fade
   * dan yang baru dinaikkan pada waktu yang sama, jadi lompatannya tidak
   * berbunyi klik.
   */
  seek(toSample: number): void {
    const now = this.ctx.currentTime;
    const pos = Math.min(Math.max(0, toSample), this.frames);
    // `!this.scrubbing` WAJIB: menjadwalkan ulang source pada tiap laporan
    // tangan adalah persis dengung yang `ScrubVoice` ada untuk menghindarinya.
    if (this.playing && !this.scrubbing) {
      this.startSource(pos);
    } else {
      this.stopSource(MICRO_FADE_SEC);
      this.anchor = { at: now, pos, rate: this.rate };
    }
    if (!this.slipArmed) this.slipAnchor = { at: now, pos, rate: this.rate };
  }

  /** Laju efektif (tempo fader × bend). Diterapkan tanpa memotong bunyi. */
  setRate(rate: number): void {
    const r = Number.isFinite(rate) && rate > 0 ? rate : 0.0001;
    if (r === this.rate) return;
    const now = this.ctx.currentTime;
    // Jangkar dipasang ULANG di posisi saat ini SEBELUM laju berubah — kalau
    // tidak, seluruh riwayat sejak jangkar terakhir ikut dihitung ulang dengan
    // laju baru dan posisinya melompat.
    const pos = this.positionAt(now);
    this.rate = r;
    this.anchor = { at: now, pos, rate: r };
    if (!this.slipArmed) this.slipAnchor = { at: now, pos, rate: r };
    for (const source of this.liveSources()) {
      // Ramp pendek, bukan lompatan: perubahan playbackRate yang mendadak
      // terdengar sebagai klik pada materi bernada.
      source.playbackRate.cancelScheduledValues(now);
      source.playbackRate.setTargetAtTime(r, now, 0.01);
    }
  }

  /**
   * Pasang / lepas loop. `null` = tidak ada loop.
   *
   * Diubah LANGSUNG pada node yang sedang berbunyi — itulah yang membuat ÷2 dan
   * ×2 di tengah lagu tidak memotong bunyi sama sekali.
   */
  setLoop(loop: DeckLoopSpec | null): void {
    const now = this.ctx.currentTime;
    // Jangkar dipasang ulang dengan pelipatan LAMA masih berlaku, supaya posisi
    // tidak melompat pada frame pergantian.
    const pos = this.positionAt(now);
    this.loop = loop;
    this.anchor = { at: now, pos, rate: this.rate };

    if (loop === null) {
      for (const source of this.liveSources()) source.loop = false;
      return;
    }

    /*
     * KALAU POSISI SEKARANG DI LUAR LOOP BARU, DECK HARUS DILOMPATKAN KE DALAM.
     *
     * Ini bukan kehalusan. `AudioBufferSourceNode` hanya melipat saat kursornya
     * MENCAPAI `loopEnd` dari arah maju; kalau ia sudah lewat, ia jalan terus
     * sampai ujung buffer dan tidak pernah kembali. Kejadiannya bukan kasus
     * langka melainkan gerakan yang paling sering dilakukan: menekan ÷2 saat
     * playhead ada di paruh KEDUA loop membuat `outAt` baru berada di belakang
     * kursor.
     *
     * Gejalanya jahat karena terbelah: layar menggambar playhead melipat di
     * dalam loop (matematika `foldLoop` di sini benar), sementara yang terdengar
     * berjalan lurus keluar. Dua kebenaran yang berbeda tentang hal yang sama.
     */
    const len = loop.outAt - loop.inAt;
    const outside = len > 0 && (pos < loop.inAt || pos >= loop.outAt);
    if (outside) {
      const folded = loop.inAt + (((pos - loop.inAt) % len) + len) % len;
      this.seek(folded);
      return;
    }

    for (const source of this.liveSources()) {
      source.loopStart = loop.inAt / this.sampleRate;
      source.loopEnd = loop.outAt / this.sampleRate;
      source.loop = true;
    }
  }

  /**
   * SLIP. Saat aktif, posisi bayangan terus berjalan seolah tidak ada loop dan
   * tidak ada lompatan; saat dilepas, deck melompat ke sana.
   */
  setSlip(armed: boolean): number | null {
    if (armed === this.slipArmed) return null;
    const now = this.ctx.currentTime;
    this.slipArmed = armed;
    if (armed) {
      this.slipAnchor = { at: now, pos: this.positionAt(now), rate: this.rate };
      return null;
    }
    const target = this.slipPositionAt(now);
    this.seek(target);
    return target;
  }

  get isSlipArmed(): boolean {
    return this.slipArmed;
  }

  // ── SCRUB ──────────────────────────────────────────────────────────────────

  /**
   * Tangan turun. Source utama diredam; sejak sini yang berbunyi hanya butir.
   *
   * Posisi dibaca SEBELUM `scrubbing` dinyalakan — kalau dibalik, `positionAt`
   * sudah membeku dan yang dijangkarkan adalah posisi lama, sehingga lagunya
   * melompat mundur sejauh waktu sejak jangkar terakhir tepat saat disentuh.
   */
  beginScrub(): void {
    if (this.scrubbing) return;
    const now = this.ctx.currentTime;
    const pos = this.positionAt(now);
    this.scrubbing = true;
    this.stopSource(MICRO_FADE_SEC);
    this.anchor = { at: now, pos, rate: this.rate };
    // SLIP tidak ikut dibekukan: seluruh gunanya adalah bayangan yang terus
    // berjalan di bawah tangan, dan scrub justru saat itu paling berguna.
    if (!this.slipArmed) this.slipAnchor = { at: now, pos, rate: this.rate };
  }

  /**
   * Tangan bergerak ke `toSample`. Memindahkan posisi DAN membunyikan butir.
   *
   * Kalau dipanggil tanpa `beginScrub`, ia hanya melompat — tanpa bunyi, sama
   * seperti sebelumnya. Lebih baik begitu daripada membunyikan butir di atas
   * source utama yang masih berjalan.
   */
  scrubTo(toSample: number): void {
    this.seek(toSample);
    if (!this.scrubbing) return;
    /*
     * Yang dibunyikan adalah posisi SESUDAH pelipatan loop — yaitu angka yang
     * sama dengan yang digambar layar — bukan angka mentah dari tangan.
     *
     * Tanpa ini, menarik ke luar loop yang aktif menampilkan playhead yang
     * melipat kembali ke dalam sementara yang terdengar materi di luarnya. Itu
     * jenis cacat yang sama dengan yang sudah dijaga `setLoop`: dua kebenaran
     * yang berbeda tentang hal yang sama, dan yang satu tidak bisa dilacak dari
     * yang lain.
     */
    this.scrub.emit(this.positionAt(this.ctx.currentTime), this.rate);
  }

  /**
   * Tangan diangkat. Kalau PLAY menyala, lagunya lanjut dari tempat tangan
   * meninggalkannya.
   */
  endScrub(): void {
    if (!this.scrubbing) return;
    const now = this.ctx.currentTime;
    const pos = this.positionAt(now);
    this.scrubbing = false;
    this.scrub.stop();
    if (this.playing) this.startSource(pos);
    else this.anchor = { at: now, pos, rate: this.rate };
  }

  get isScrubbing(): boolean {
    return this.scrubbing;
  }

  /** true kalau materi sudah habis (dan tidak sedang loop). */
  reachedEnd(now: number): boolean {
    // Selama scrub posisinya beku, jadi "sudah sampai ujung" bukan peristiwa
    // yang boleh mematikan PLAY — tangan masih bisa menariknya balik.
    if (!this.playing || this.scrubbing || this.buffer === null || this.loop !== null) return false;
    return this.positionAt(now) >= this.frames - 1;
  }

  dispose(): void {
    this.stopSource(0);
    this.scrub.stop();
    this.buffer = null;
    this.stemAudio = null;
    this.stemMask = null;
  }

  // ── internal ───────────────────────────────────────────────────────────────

  private startSource(fromSample: number): void {
    const buffer = this.buffer;
    if (buffer === null) return;
    const now = this.ctx.currentTime;

    this.stopSource(MICRO_FADE_SEC);

    const gate = this.ctx.createGain();
    gate.gain.setValueAtTime(0, now);
    gate.gain.linearRampToValueAtTime(1, now + MICRO_FADE_SEC);
    gate.connect(this.out);

    const activeBuffers = this.stemAudio === null || this.stemMask === null
      ? [buffer]
      : (Object.keys(this.stemMask) as ScnetStem[])
          .filter((stem) => this.stemMask?.[stem] === true)
          .map((stem) => this.stemAudio!.stems[stem]);
    const sources = activeBuffers.map((activeBuffer) => {
      const src = this.ctx.createBufferSource();
      src.buffer = activeBuffer;
      src.playbackRate.setValueAtTime(this.rate, now);
      if (this.loop !== null) {
        src.loopStart = this.loop.inAt / this.sampleRate;
        src.loopEnd = this.loop.outAt / this.sampleRate;
        src.loop = true;
      }
      src.connect(gate);
      src.start(now, fromSample / this.sampleRate);
      return src;
    });

    this.source = sources[0] ?? null;
    this.extraSources = sources.slice(1);
    this.gate = gate;
    this.anchor = { at: now, pos: fromSample, rate: this.rate };
    if (!this.slipArmed) this.slipAnchor = this.anchor;
  }

  private stopSource(fadeSec: number): void {
    const sources = this.liveSources();
    const gate = this.gate;
    this.source = null;
    this.extraSources = [];
    this.gate = null;
    if (gate === null) return;
    const now = this.ctx.currentTime;
    const end = now + fadeSec;
    try {
      gate.gain.cancelScheduledValues(now);
      gate.gain.setValueAtTime(gate.gain.value, now);
      gate.gain.linearRampToValueAtTime(0, end);
      for (const source of sources) source.stop(end);
    } catch {
      // Source yang sudah berhenti sendiri (materi habis) melempar di `stop`.
      // Itu keadaan yang sah, bukan kesalahan.
    }
    // Node dilepas setelah fade-nya selesai supaya tidak ada yang terputus di
    // tengah ramp. `onended` tidak dipakai: ia tidak dijamin menyala untuk
    // source yang di-stop di masa depan pada semua browser.
    const cleanup = (): void => {
      try {
        for (const source of sources) source.disconnect();
        gate.disconnect();
      } catch {
        // sudah terlepas
      }
    };
    if (typeof setTimeout === 'function') {
      setTimeout(cleanup, Math.ceil(fadeSec * 1000) + 60);
    } else {
      cleanup();
    }
  }

  private liveSources(): AudioBufferSourceNode[] {
    return this.source === null ? [...this.extraSources] : [this.source, ...this.extraSources];
  }
}
