/**
 * Model kepustakaan sisi web — tipe + yang bisa dijawab tanpa React dan tanpa
 * jaringan.
 *
 * Bentuknya mengikuti balasan Worker kepustakaan (`backend/src/library`), bukan
 * bentuk internal store Studio. Yang menyeberangi jaringan dan yang hidup di
 * memori sengaja dibedakan: `hash` adalah identitas yang bertahan selamanya,
 * `assetId` numerik hanya berlaku satu sesi (docs/16 §2). Peta di antara
 * keduanya dibangun ulang tiap sesi — dan `LibraryState.loaded` adalah peta itu.
 */

/** Satu lagu di kepustakaan, apa adanya dari `GET /tracks`. */
export interface LibraryTrack {
  readonly hash: string;
  readonly name: string;
  readonly bytes: number;
  readonly mime: string;
  /** 0 kalau server tidak tahu — lagu yang di-commit sebelum durasinya diukur. */
  readonly frames: number;
  readonly sampleRate: number;
  /** Cue DJ + grid. Bentuknya milik pemakainya; kepustakaan tidak menafsirkan. */
  readonly marks: unknown;
}

export interface LibraryUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
}

/**
 * Keadaan sambungan, dan kenapa ada EMPAT.
 *
 * Menggabungkan "belum tahu" dengan "belum login" adalah cara tercepat membuat
 * dock berkedip: sepersekian detik pertama tiap muat halaman akan menampilkan
 * ajakan login kepada user yang sebetulnya sudah login. Dan menggabungkan
 * "tidak dikonfigurasi" dengan "gagal" menyembunyikan bedanya antara build yang
 * memang tanpa backend dan Worker yang sedang mati.
 */
export type LibraryStatus =
  | 'tidak-dikonfigurasi'
  | 'memeriksa'
  | 'anonim'
  | 'masuk'
  | 'gagal';

export interface LibraryState {
  readonly status: LibraryStatus;
  readonly user: LibraryUser | null;
  readonly tracks: readonly LibraryTrack[];
  /** Pesan galat terakhir, apa adanya. `null` kalau tidak ada. */
  readonly error: string | null;
  /** Dock terlipat jadi satu strip. */
  readonly collapsed: boolean;
  /** Sedang mengambil daftar. */
  readonly listing: boolean;
  /**
   * `hash → assetId` untuk lagu yang SUDAH mendarat di sesi ini.
   *
   * Inilah peta yang docs/16 §2 sebut "dibangun ulang tiap sesi". Ia juga yang
   * membuat klik kedua pada lagu yang sama tidak mengunduh 25 MB lagi.
   */
  readonly loaded: Readonly<Record<string, number>>;
  /** `hash → 0..100` untuk yang sedang diunduh. */
  readonly loading: Readonly<Record<string, number>>;
}

export function createInitialLibrary(): LibraryState {
  return {
    status: 'tidak-dikonfigurasi',
    user: null,
    tracks: [],
    error: null,
    // Terlipat saat pertama muncul: ini permukaan kerja DAW, dan panel yang
    // memakan sepertiga layar sebelum diminta adalah panel yang salah.
    collapsed: true,
    listing: false,
    loaded: {},
    loading: {},
  };
}

/** `4.7 MB`. Basis 1024, sama dengan angka batas yang dipakai server. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/**
 * `3:07` dari frames + sampleRate. `—` kalau server tidak tahu.
 *
 * Nol diperlakukan sebagai tidak tahu, BUKAN sebagai nol detik: lagu berdurasi
 * nol tidak ada, dan menampilkan `0:00` untuk metadata yang hilang membuat
 * daftar terlihat seperti berisi berkas rusak.
 */
export function formatDuration(frames: number, sampleRate: number): string {
  if (frames <= 0 || sampleRate <= 0) return '—';
  const total = Math.round(frames / sampleRate);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Ringkasan untuk strip terlipat: "12 LAGU · 340.2 MB". */
export function summarize(tracks: readonly LibraryTrack[]): string {
  if (tracks.length === 0) return 'KOSONG';
  const bytes = tracks.reduce((sum, t) => sum + t.bytes, 0);
  return `${tracks.length} LAGU · ${formatBytes(bytes)}`;
}
