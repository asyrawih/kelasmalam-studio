/**
 * SCRUB yang berbunyi untuk satu deck: butir-butir pendek di posisi tangan.
 *
 * ## Kenapa butir, bukan satu source yang dipindah-pindah
 *
 * `AudioBufferSourceNode` tidak bisa dipindahkan posisinya setelah `start()`,
 * jadi "mengikuti tangan" dengan satu source berarti menjadwalkan source BARU
 * pada tiap `pointermove` — 60 kali per detik, masing-masing hidup sampai
 * digantikan ~16 ms kemudian. Yang terdengar dari itu bukan lagu yang dicari,
 * melainkan dengung 60 Hz: potongan 16 ms dengan tepi keras adalah definisi
 * sebuah klik, dan enam puluh klik per detik adalah sebuah nada.
 *
 * Karena itu tarikan dan bunyi DIPISAH. Tangan boleh melapor sesering apa pun;
 * yang berbunyi adalah butir 90 ms yang dijadwalkan paling rapat tiap 45 ms,
 * dengan fade 12 ms di kedua ujung. Butirnya BERTINDIH — 90 ms materi setiap
 * 45 ms — dan tindihan itulah yang membuat deretannya terdengar menyambung
 * alih-alih seperti ketukan. Angkanya sama persis dengan scrub Studio
 * (`studio/preview/audio-preview.ts`), dan disamakan dengan sengaja: keduanya
 * memecahkan masalah yang sama dan tidak ada alasan telinga harus belajar dua
 * karakter yang berbeda di dua halaman aplikasi yang sama.
 *
 * ## Yang SENGAJA tidak dilakukan: mundur
 *
 * Menarik ke belakang tetap membunyikan butir yang berjalan MAJU dari posisi
 * baru. Itu bukan kelalaian melainkan batas jalur ini: `playbackRate` negatif
 * tidak diputar oleh browser mana pun, dan membaca mundur butuh resampler
 * berkursor-float di AudioWorklet — yang harganya menyalin seluruh PCM ke
 * thread audio (~115 MB per deck untuk lagu lima menit), alasan yang sudah
 * ditolak di kepala `deck-player.ts`. Jadi ini SCRUB, bukan scratch: ia
 * menjawab "materi apa yang ada di sini", bukan "seperti apa bunyinya kalau
 * piringannya diputar balik".
 *
 * ## Jalur sinyalnya lewat channel strip, TIDAK dipintas
 *
 * Butir masuk ke node yang sama dengan `DeckPlayer` — masukan channel strip —
 * jadi ia lewat TRIM, EQ, COLOR, channel fader, CUE, dan crossfader. Ini
 * berbeda dari scrub Studio, yang sengaja memintas EQ karena di sana rantainya
 * harus dirakit per butir. Di sini rantainya sudah berdiri permanen, jadi
 * memintasnya justru butuh kerja tambahan untuk hasil yang lebih buruk:
 * seorang DJ mencari titik cue dengan channel fader TURUN dan CUE menyala, dan
 * scrub yang memintas fader akan menyemburkan lagu berikutnya ke ruangan.
 */

/** Panjang satu butir dalam waktu DINDING. Lihat catatan di kepala berkas. */
const GRAIN_SEC = 0.09;
/** Jarak antar butir. Lebih rapat dari `GRAIN_SEC` supaya butirnya bertindih. */
const GRAIN_INTERVAL_SEC = 0.045;
/** Fade di kedua ujung butir. Tanpa ini tiap butir mulai dan berhenti di tengah
 *  gelombang, dan yang terdengar hanya klik. */
const GRAIN_FADE_SEC = 0.012;
/** Jadwalkan sedikit ke depan supaya `start()` tidak jatuh di masa lalu. */
const LOOKAHEAD_SEC = 0.005;
/**
 * Di bawah ini, tangan dianggap DIAM.
 *
 * Tanpa ambang ini, jari yang menempel tanpa bergerak tetap memicu satu butir
 * tiap 45 ms dari posisi yang persis sama — yaitu satu nada 22 Hz yang stabil,
 * bukan materi lagu. Yang diinginkan saat tangan berhenti adalah SENYAP.
 */
const STILL_EPS_SEC = 1e-4;

interface Grain {
  readonly source: AudioBufferSourceNode;
  readonly gain: GainNode;
}

export interface ScrubVoiceOptions {
  readonly ctx: BaseAudioContext;
  /** Node tujuan — masukan channel strip deck ini, sama dengan `DeckPlayer`. */
  readonly destination: AudioNode;
}

export class ScrubVoice {
  private readonly ctx: BaseAudioContext;
  private readonly out: AudioNode;

  private buffer: AudioBuffer | null = null;
  private grains: Grain[] = [];

  /** Waktu konteks butir terakhir, −1 kalau belum ada. */
  private lastAt = -1;
  /** Posisi SOURCE (detik) butir terakhir — dipakai mengenali tangan yang diam. */
  private lastPosSec = Number.NaN;

  constructor(o: ScrubVoiceOptions) {
    this.ctx = o.ctx;
    this.out = o.destination;
  }

  setBuffer(buffer: AudioBuffer | null): void {
    this.stop();
    this.buffer = buffer;
  }

  /** Jumlah butir yang masih hidup. Dipakai tes; tidak dipakai produksi. */
  get liveGrains(): number {
    return this.grains.length;
  }

  /**
   * Bunyikan satu butir di `atSample`, kalau memang waktunya.
   *
   * Boleh dipanggil sesering `pointermove` — PEMBATASANNYA ADA DI SINI, bukan
   * di pemanggil. Menaruhnya di pemanggil berarti tiap tempat baru yang ingin
   * men-scrub (jog, waveform, kelak MIDI) harus mengingat aturan yang sama, dan
   * satu yang lupa cukup untuk mengembalikan dengung 60 Hz.
   */
  emit(atSample: number, rate: number): void {
    const buffer = this.buffer;
    if (buffer === null) return;

    // Panjang dihitung dari `length/sampleRate`, bukan dari `buffer.duration`:
    // keduanya sama menurut spec, tapi yang pertama sudah dipakai `DeckPlayer`
    // untuk seluruh matematika posisinya. Satu sumber angka, satu pembulatan.
    const sr = buffer.sampleRate;
    const totalSec = sr > 0 ? buffer.length / sr : 0;
    const posSec = atSample / (sr > 0 ? sr : 1);
    if (!(posSec >= 0) || posSec >= totalSec) return;

    const now = this.ctx.currentTime;
    const still = Number.isFinite(this.lastPosSec)
      ? Math.abs(posSec - this.lastPosSec) < STILL_EPS_SEC
      : false;
    if (this.lastAt >= 0 && (still || now - this.lastAt < GRAIN_INTERVAL_SEC)) return;
    this.lastAt = now;
    this.lastPosSec = posSec;

    const r = Number.isFinite(rate) && rate > 0 ? rate : 1;
    // Panjang SOURCE diskalakan oleh laju supaya panjang DINDING-nya tetap
    // `GRAIN_SEC`. Kalau yang dijaga tetap panjang source-nya, butir pada deck
    // yang dipercepat jadi lebih pendek dari fade-nya sendiri.
    const srcDur = Math.min(GRAIN_SEC * r, totalSec - posSec);
    if (!(srcDur > 0)) return;
    const wallSec = srcDur / r;
    const fade = Math.min(GRAIN_FADE_SEC, wallSec / 2);
    const startAt = now + LOOKAHEAD_SEC;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, startAt);
    gain.gain.linearRampToValueAtTime(1, startAt + fade);
    gain.gain.setValueAtTime(1, startAt + wallSec - fade);
    gain.gain.linearRampToValueAtTime(0, startAt + wallSec);
    gain.connect(this.out);

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.setValueAtTime(r, startAt);
    source.connect(gain);
    try {
      source.start(startAt, posSec, srcDur);
    } catch {
      // Offset di luar buffer karena pembulatan di tepi. Bukan kesalahan yang
      // perlu dilaporkan — butir berikutnya datang 45 ms lagi.
      gain.disconnect();
      return;
    }

    const grain: Grain = { source, gain };
    this.grains = [...this.grains, grain];
    source.onended = () => {
      this.grains = this.grains.filter((g) => g !== grain);
      source.disconnect();
      gain.disconnect();
    };
  }

  /**
   * Hentikan dan bongkar semua butir. Aman dipanggil berkali-kali.
   *
   * Butir dimatikan TANPA fade tambahan: masing-masing sudah punya fade turun
   * di ujungnya sendiri, dan yang paling lama pun tinggal 90 ms lagi.
   */
  stop(): void {
    for (const g of this.grains) {
      g.source.onended = null;
      try {
        g.source.stop();
      } catch {
        // Sudah berhenti sendiri — keadaan yang sah, bukan kesalahan.
      }
      g.source.disconnect();
      g.gain.disconnect();
    }
    this.grains = [];
    this.lastAt = -1;
    this.lastPosSec = Number.NaN;
  }
}
