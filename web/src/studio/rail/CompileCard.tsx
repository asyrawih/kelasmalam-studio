/**
 * Compile — pemilih format, statistik export, progress, dan tombol download.
 *
 * Seluruh statistik dihitung dari state store (design meng-hardcode-nya).
 */

import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import { Card, ProgressBar } from '../../ui/cyber';
import { formatTime, isAudible, type ExportFormat, type StudioState } from '../model';
import { hasRenderableAudio } from '../preview/audio-preview';
import { resolveExportName, runCompile, useExportAvailability } from './export-bridge';
import { studioActions, useStudio } from './store-adapter';

const FORMATS: readonly ExportFormat[] = ['AUTO', 'WAV', 'FLAC', 'MP3', 'OGG'];

/** Format yang benar-benar dieksekusi. AUTO — dan nilai apa pun yang tidak
 *  dikenal, mis. dari project lama — jatuh ke WAV: lossless dan nol dependensi. */
export type ResolvedFormat = 'WAV' | 'FLAC' | 'MP3' | 'OGG';
export const resolveFormat = (f: ExportFormat): ResolvedFormat =>
  f === 'FLAC' || f === 'MP3' || f === 'OGG' ? f : 'WAV';

/** Kedalaman bit WAV yang di-encode Rust (docs/03 §3b). */
const WAV_DEPTHS = [16, 24, 32] as const;
type WavDepth = (typeof WAV_DEPTHS)[number];

/** FLAC tidak punya float32 — formatnya memang hanya integer. */
const FLAC_DEPTHS = [16, 24] as const;

/** WAV 16-bit PCM stereo — kedalaman default export. */
const WAV_BITS: WavDepth = 16;
const MP3_RATES = [128, 192, 320] as const;
const MP3_KBPS = 192;
/**
 * Quality Vorbis (-0.1..1.0) beserta bitrate NOMINAL-nya untuk estimasi ukuran.
 * Vorbis itu VBR: angka kbps di sini adalah rata-rata kasar dari dokumentasi
 * libvorbis, bukan janji.
 */
const OGG_QUALITIES = [
  { q: 0.2, kbps: 96 },
  { q: 0.5, kbps: 160 },
  { q: 0.8, kbps: 256 },
] as const;
const OGG_DEFAULT_Q = 0.5;

/**
 * Rasio ukuran FLAC terhadap PCM yang setara. ESTIMASI, dan tidak bisa lebih
 * dari itu: FLAC lossless, jadi ukurannya bergantung pada isi audionya — musik
 * padat ±0.7, rekaman sunyi bisa 0.3. 0.6 dipilih supaya angka yang ditampilkan
 * cenderung sedikit terlalu besar, bukan terlalu kecil.
 */
const FLAC_RATIO = 0.6;
const CHANNELS = 2;

export interface CompileStats {
  activeLanes: number;
  outputSeconds: number;
  bytes: number;
  label: string;
}

/**
 * Statistik export dari state nyata. Diekspor supaya bisa dites terpisah.
 *
 * `lossyQuality` = kbps untuk MP3, quality (-0.1..1.0) untuk OGG. Dibiarkan
 * opsional supaya pemanggil yang hanya peduli panjang output tidak perlu tahu
 * apa-apa soal encoder.
 */
export function computeStats(
  state: StudioState,
  wavBits: WavDepth = WAV_BITS,
  lossyQuality?: number,
): CompileStats {
  const activeLanes = state.lanes.filter(
    (l) => l.clips.length > 0 && isAudible(l, state.lanes),
  ).length;

  // Panjang output = ujung clip terjauh pada lane yang terdengar; kalau tidak
  // ada clip sama sekali, 0 (bukan panjang timeline — kita tidak me-render
  // dua menit senyap).
  let endSample = 0;
  for (const lane of state.lanes) {
    if (!isAudible(lane, state.lanes)) continue;
    for (const c of lane.clips) endSample = Math.max(endSample, c.start + c.len);
  }
  const sr = state.sampleRate > 0 ? state.sampleRate : 48_000;
  // Varispeed: memutar 2x lebih cepat menghasilkan file separuh panjangnya.
  // `renderSpeed`, BUKAN `speed` transport — `buildExportPayload` memakai yang
  // ini, dan statistik yang membaca angka lain akan memprediksi panjang serta
  // ukuran file yang tidak pernah ditulis.
  const speed = state.renderSpeed > 0 ? state.renderSpeed : 1;
  const outputSeconds = endSample / sr / speed;

  const fmt = resolveFormat(state.format);
  // FLAC tidak menyimpan float32; 32-bit yang dipilih user turun ke 24.
  const flacBits = wavBits === 32 ? 24 : wavBits;
  const pcmBytes = (bits: number): number => outputSeconds * sr * CHANNELS * (bits / 8);
  const kbpsBytes = (kbps: number): number => (outputSeconds * kbps * 1000) / 8;

  let bytes: number;
  let label: string;
  switch (fmt) {
    case 'WAV':
      bytes = 44 + pcmBytes(wavBits);
      label = `WAV ${wavBits}-bit`;
      break;
    case 'FLAC':
      // "~" bukan basa-basi: ukuran FLAC hanya diketahui setelah di-encode.
      bytes = pcmBytes(flacBits) * FLAC_RATIO;
      label = `FLAC ${flacBits}-bit (~estimasi)`;
      break;
    case 'MP3': {
      const kbps = Math.round(lossyQuality ?? MP3_KBPS);
      bytes = kbpsBytes(kbps);
      label = `MP3 ${kbps} kbps`;
      break;
    }
    case 'OGG': {
      const q = lossyQuality ?? OGG_DEFAULT_Q;
      const nominal =
        OGG_QUALITIES.reduce((best, o) =>
          Math.abs(o.q - q) < Math.abs(best.q - q) ? o : best,
        ).kbps;
      bytes = kbpsBytes(nominal);
      label = `OGG q${q} (~${nominal} kbps)`;
      break;
    }
  }

  return { activeLanes, outputSeconds, bytes, label };
}

function formatSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(0, bytes / 1024).toFixed(0)} KB`;
}

/** Satu baris tombol pilihan (kedalaman bit / bitrate / quality). */
function OptionRow({
  label,
  disabled,
  options,
}: {
  label: string;
  disabled: boolean;
  options: readonly { key: string; text: string; active: boolean; onSelect: () => void }[];
}): JSX.Element {
  return (
    <div
      role="group"
      aria-label={label}
      style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: '4px' }}
    >
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          className="cy-btn-reset cy-hover-accent-border"
          aria-pressed={o.active}
          disabled={disabled}
          onClick={o.onSelect}
          style={{
            height: '24px',
            border: '1px solid var(--cy-border)',
            background: 'transparent',
            color: o.active ? 'var(--cy-accent)' : 'var(--cy-text-muted)',
            fontFamily: 'var(--cy-font-mono)',
            fontSize: '9px',
            cursor: disabled ? 'not-allowed' : 'pointer',
          }}
        >
          {o.text}
        </button>
      ))}
    </div>
  );
}

const fieldLabelStyle = {
  fontSize: '9px',
  letterSpacing: '.18em',
  color: 'var(--cy-text-muted)',
  textTransform: 'uppercase',
} as const;

const fieldBoxStyle = {
  width: '100%',
  height: '26px',
  background: '#000',
  border: '1px solid var(--cy-border)',
  color: 'var(--cy-text)',
  fontFamily: 'var(--cy-font-mono)',
  fontSize: '11px',
  padding: '0 8px',
  outline: 'none',
} as const;

/**
 * Nama berkas hasil export (tanpa ekstensi).
 *
 * Diterapkan saat blur / Enter, bukan tiap ketikan — sama seperti DurationBounds:
 * menulis tiap huruf ke store berarti nama yang tersimpan (dan ikut di-persist)
 * sempat berupa potongan setengah jadi.
 *
 * Nama final DITAMPILKAN lengkap dengan ekstensinya, dan kalau hasil pembersihan
 * berbeda dari yang diketik, itu dikatakan DI SINI — bukan dibiarkan ditemukan
 * user sebagai file bernama aneh di folder Downloads.
 */
function FileNameField({
  raw,
  projectName,
  ext,
  disabled,
}: {
  raw: string;
  projectName: string;
  ext: string;
  disabled: boolean;
}): JSX.Element {
  const [text, setText] = useState(raw);
  // Sinkron kalau nama berubah dari tempat lain (load project, undo).
  useEffect(() => setText(raw), [raw]);

  // Dihitung dari nilai store, bukan `text`: preview nama harus mencerminkan apa
  // yang benar-benar akan dipakai export, bukan ketikan yang belum di-commit.
  const resolved = resolveExportName(raw, projectName);
  // Placeholder = persis nama yang dipakai kalau field dibiarkan kosong.
  const fallback = resolveExportName('', projectName).base;

  const commit = (): void => studioActions.setExportFileName(text.trim());
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.currentTarget.blur();
    }
  };

  return (
    <div style={{ display: 'grid', gap: '5px' }}>
      <label style={{ display: 'grid', gap: '5px' }}>
        <span style={fieldLabelStyle}>Nama berkas</span>
        <input
          aria-label="Nama berkas export (tanpa ekstensi)"
          value={text}
          placeholder={fallback}
          spellCheck={false}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={onKeyDown}
          style={fieldBoxStyle}
        />
      </label>

      <div
        style={{
          fontFamily: 'var(--cy-font-mono)',
          fontSize: '10px',
          color: 'var(--cy-accent)',
          wordBreak: 'break-all',
        }}
      >
        → {resolved.base}.{ext}
      </div>

      {resolved.changed ? (
        <div style={{ fontSize: '9px', lineHeight: 1.5, color: 'var(--cy-text-dim)' }}>
          {resolved.source === 'field'
            ? 'Nama disesuaikan agar aman untuk sistem berkas.'
            : `Nama itu tidak menyisakan karakter yang bisa dipakai — memakai "${resolved.base}".`}
        </div>
      ) : null}
    </div>
  );
}

function StatRow({ k, v, accent }: { k: string; v: string; accent?: boolean }): JSX.Element {
  return (
    <div style={{ display: 'flex' }}>
      <span>{k}</span>
      <span style={{ marginLeft: 'auto', color: accent ? 'var(--cy-accent)' : 'var(--cy-text)' }}>
        {v}
      </span>
    </div>
  );
}

export function CompileCard(): JSX.Element {
  // Stats butuh banyak irisan sekaligus; berlangganan seluruh state di SATU
  // tempat (referensinya stabil — store menyimpan objek itu sendiri).
  const state = useStudio((s) => s);
  const engine = useExportAvailability();
  const [wavBits, setWavBits] = useState<WavDepth>(WAV_BITS);
  const [mp3Kbps, setMp3Kbps] = useState<number>(MP3_KBPS);
  const [oggQ, setOggQ] = useState<number>(OGG_DEFAULT_Q);
  const fmt = resolveFormat(state.format);
  // Satu state per format, bukan satu "quality" bersama: kbps dan quality
  // Vorbis bukan skala yang sama, dan berpindah format tidak boleh diam-diam
  // mengubah setelan format yang lain.
  const lossyQuality = fmt === 'MP3' ? mp3Kbps : fmt === 'OGG' ? oggQ : undefined;
  const stats = computeStats(state, wavBits, lossyQuality);
  // Progress hidup di store (`exportProgress`, null saat idle) — supaya bagian
  // UI lain bisa ikut menampilkannya. Error export lokal saja.
  const [error, setError] = useState<string | null>(null);
  // Selisih antara yang didengar user dan yang akan ditulis ke file. Ditampilkan
  // SELALU kalau ada — export yang diam-diam berbeda dari preview adalah bug
  // yang paling mahal untuk ditemukan user sendiri (docs/03).
  const [warnings, setWarnings] = useState<readonly string[]>([]);
  // Ref, bukan state: pembatalan dibaca dari dalam loop render yang sedang
  // berjalan, dan nilai dari closure state akan selamanya `false` di sana.
  const cancelRef = useRef(false);
  const progress = state.exportProgress;

  const exporting = progress !== null;
  // DUA syarat berbeda, dan alasannya harus dibedakan: timeline boleh penuh
  // clip tapi tidak ada satu pun yang punya PCM (clip demo, atau asset yang
  // belum selesai di-decode). Menyebut keduanya "tidak ada clip" akan membuat
  // user mencari-cari clip yang jelas-jelas ada di layar.
  const noAudibleClip = stats.outputSeconds <= 0;
  const noPcm = !noAudibleClip && !hasRenderableAudio(state);
  const disabled = !engine.ready || exporting || noAudibleClip || noPcm;
  const reason = !engine.ready
    ? engine.reason
    : noAudibleClip
      ? 'Tidak ada clip yang terdengar untuk di-render.'
      : noPcm
        ? 'Clip yang terdengar belum punya audio (PCM belum dimuat).'
        : exporting
          ? 'Export sedang berjalan.'
          : 'Render semua lane jadi satu file dan unduh.';

  return (
    <Card title="Compile" subtitle="semua lane → satu file" notched>
      <div style={{ display: 'grid', gap: '12px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,minmax(0,1fr))', gap: '4px' }}>
          {FORMATS.map((f) => {
            const active = state.format === f;
            return (
              <button
                key={f}
                type="button"
                className="cy-btn-reset cy-hover-accent-border"
                aria-pressed={active}
                onClick={() => studioActions.setFormat(f)}
                style={{
                  height: '30px',
                  border: '1px solid var(--cy-border)',
                  background: active ? 'var(--cy-accent)' : 'transparent',
                  color: active ? 'var(--cy-text-on-accent)' : 'var(--cy-text-dim)',
                  fontFamily: 'var(--cy-font-mono)',
                  fontSize: '10px',
                  cursor: 'pointer',
                }}
              >
                {f}
              </button>
            );
          })}
        </div>

        {/* Baris opsi milik format yang sedang dipilih. Hanya SATU yang tampil:
            dua baris opsi sekaligus membuat user menebak mana yang berlaku. */}
        {fmt === 'WAV' || fmt === 'FLAC' ? (
          <OptionRow
            label={fmt === 'WAV' ? 'Kedalaman bit WAV' : 'Kedalaman bit FLAC'}
            disabled={exporting}
            options={(fmt === 'WAV' ? WAV_DEPTHS : FLAC_DEPTHS).map((d) => ({
              key: String(d),
              text: d === 32 ? 'F32' : `${d}-BIT`,
              // FLAC tidak punya float32, jadi 32 dianggap 24 di sana.
              active: fmt === 'WAV' ? wavBits === d : (wavBits === 32 ? 24 : wavBits) === d,
              onSelect: () => setWavBits(d),
            }))}
          />
        ) : null}

        {fmt === 'MP3' ? (
          <OptionRow
            label="Bitrate MP3"
            disabled={exporting}
            options={MP3_RATES.map((k) => ({
              key: String(k),
              text: `${k}K`,
              active: mp3Kbps === k,
              onSelect: () => setMp3Kbps(k),
            }))}
          />
        ) : null}

        {fmt === 'OGG' ? (
          <OptionRow
            label="Quality OGG Vorbis"
            disabled={exporting}
            options={OGG_QUALITIES.map((o) => ({
              key: String(o.q),
              text: `Q${o.q}`,
              active: oggQ === o.q,
              onSelect: () => setOggQ(o.q),
            }))}
          />
        ) : null}

        <FileNameField
          raw={state.exportFileName}
          projectName={state.projectName}
          ext={fmt.toLowerCase()}
          disabled={exporting}
        />

        <div style={{ display: 'grid', gap: '5px', fontSize: '10px', color: 'var(--cy-text-dim)' }}>
          <StatRow k="lanes aktif" v={String(stats.activeLanes)} />
          <StatRow k="panjang output" v={formatTime(stats.outputSeconds)} />
          <StatRow k="render speed" v={`${state.renderSpeed}x`} />
          <StatRow k="estimasi size" v={`${formatSize(stats.bytes)} · ${stats.label}`} accent />
        </div>

        <ProgressBar label="Mixdown" value={(progress ?? 0) * 100} showValue />

        <button
          type="button"
          className="cy-btn-reset cy-hover-accent-bg"
          disabled={disabled}
          title={reason}
          onClick={() => {
            setError(null);
            setWarnings([]);
            cancelRef.current = false;
            studioActions.setExportProgress(0);
            void runCompile({
              format: fmt.toLowerCase() as 'wav' | 'flac' | 'mp3' | 'ogg',
              // Mentah: pembersihan dan fallback ke nama project dikerjakan
              // `runCompile` supaya nama yang ditawarkan picker sama persis
              // dengan yang ditampilkan kartu ini.
              fileName: state.exportFileName,
              bitDepth: wavBits,
              quality: lossyQuality,
              onProgress: studioActions.setExportProgress,
              onWarnings: setWarnings,
              isCancelled: () => cancelRef.current,
            }).catch((e: unknown) => {
              studioActions.setExportProgress(null);
              setError(e instanceof Error ? e.message : String(e));
            });
          }}
          style={{
            width: '100%',
            height: '40px',
            border: '1px solid var(--cy-accent)',
            background: 'var(--cy-accent)',
            color: 'var(--cy-text-on-accent)',
            fontFamily: 'var(--cy-font-mono)',
            fontSize: '11px',
            letterSpacing: '.16em',
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.4 : 1,
            clipPath:
              'polygon(8px 0,100% 0,100% calc(100% - 8px),calc(100% - 8px) 100%,0 100%,0 8px)',
          }}
        >
          ↓ COMPILE + DOWNLOAD
        </button>

        {exporting ? (
          <button
            type="button"
            className="cy-btn-reset"
            onClick={() => {
              cancelRef.current = true;
            }}
            style={{
              width: '100%',
              height: '26px',
              border: '1px solid var(--cy-border)',
              background: 'transparent',
              color: 'var(--cy-text-dim)',
              fontFamily: 'var(--cy-font-mono)',
              fontSize: '10px',
              letterSpacing: '.14em',
              cursor: 'pointer',
            }}
          >
            BATALKAN
          </button>
        ) : null}

        {warnings.length > 0 ? (
          <div
            role="status"
            style={{
              display: 'grid',
              gap: '3px',
              fontSize: '9px',
              lineHeight: 1.5,
              color: '#ffb020',
              border: '1px solid #ffb02055',
              padding: '6px',
            }}
          >
            <div style={{ letterSpacing: '.12em' }}>FILE AKAN BERBEDA DARI PREVIEW:</div>
            {warnings.map((w) => (
              <div key={w}>· {w}</div>
            ))}
          </div>
        ) : null}

        {!engine.ready ? (
          // Tampilkan ALASAN SEBENARNYA, bukan kalimat tetap. Versi lama selalu
          // menulis "engine belum dibangun" apa pun penyebabnya, dan alasan
          // aslinya hanya ada di tooltip — jadi kegagalan instantiasi, ABI
          // mismatch, atau layout blok kontrol semuanya terbaca sebagai
          // "artefaknya belum di-build", dan orang membangun ulang berkali-kali
          // untuk masalah yang berbeda.
          <div
            title={engine.reason}
            style={{
              fontSize: '9px',
              letterSpacing: '.1em',
              color: 'var(--cy-warning)',
              lineHeight: 1.5,
              wordBreak: 'break-word',
            }}
          >
            EXPORT NONAKTIF — {engine.reason}
          </div>
        ) : null}
        {error !== null ? (
          <div style={{ fontSize: '9px', letterSpacing: '.1em', color: '#ff4d4d' }}>{error}</div>
        ) : null}
      </div>
    </Card>
  );
}
