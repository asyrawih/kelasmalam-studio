/**
 * Landing page — port dari `design/Landing Pages.dc.html`.
 *
 * Susunannya mengikuti design baris per baris:
 *   topbar sticky → hero → 01 FITUR → 02 ALUR → 03 SPEK → 04 HARGA →
 *   05 ENGINE → 06 FAQ → CTA → footer
 *
 * Semua warna, ukuran, dan jarak disalin apa adanya dari atribut `style` di
 * design. Yang TIDAK bisa jadi inline style (keyframe, pseudo-element, media
 * query, :hover) pindah ke `landing.css` dengan nama class yang sama.
 *
 * Halaman ini murni presentasi: ia tidak menyentuh store studio, tidak
 * membuat AudioContext, dan tidak mengimpor apa pun dari `audio/`. Satu-satunya
 * jalan keluarnya adalah `onOpenStudio` — dipanggil dari setiap tombol
 * "BUKA STUDIO"/"MULAI MIXING", dan router yang memutuskan artinya apa.
 */

import { useState, type CSSProperties } from 'react';
import { VersionTag } from '../app-shell/VersionTag';
import { Badge, Button, Card } from '../ui/cyber';
import { HeroShot } from './HeroShot';
import {
  BENCH,
  FAQS,
  FEATURES,
  HERO_STATS,
  PLANS,
  SPECS,
  STEPS,
  WASM_BULLETS,
  WASM_STATS,
  WASM_TAGS,
  type PlanId,
} from './content';
import './landing.css';

export interface LandingPageProps {
  /** Dipanggil oleh setiap CTA yang membuka studio. */
  readonly onOpenStudio: () => void;
  /** Dipanggil oleh CTA yang membuka mixer DJ (`/dj`). */
  readonly onOpenDj?: () => void;
  /** Dipanggil oleh CTA yang membuka unggah asset Roblox (`/roblox`). */
  readonly onOpenRoblox?: () => void;
  /** Tombol menuju aplikasi hanya tampil setelah sesi login terverifikasi. */
  readonly showAppLinks?: boolean;
}

/** Label bernomor di atas tiap judul section ("01 / FITUR"). */
const EYEBROW: CSSProperties = {
  fontSize: '11px',
  letterSpacing: '.22em',
  color: 'var(--cy-accent)',
};

const H2: CSSProperties = {
  fontFamily: 'var(--cy-font-sans)',
  fontWeight: 700,
  letterSpacing: '.03em',
  margin: 0,
};

const SECTION_HEAD: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: '16px',
  flexWrap: 'wrap',
};

const NAV_LINK: CSSProperties = {
  fontSize: '11px',
  letterSpacing: '.16em',
  color: 'var(--cy-text-dim)',
};

const BODY: CSSProperties = {
  fontSize: '12px',
  lineHeight: 1.7,
  color: 'var(--cy-text-dim)',
  margin: 0,
  textWrap: 'pretty',
} as CSSProperties;

/** Bullet "▸" yang dipakai di kartu harga dan panel engine. */
function Bullet({ children }: { children: string }): JSX.Element {
  return (
    <div style={{ display: 'flex', gap: '9px', alignItems: 'baseline' }}>
      <span style={{ color: 'var(--cy-accent)', fontSize: '10px' }}>▸</span>
      <span style={{ fontSize: '12px', color: 'var(--cy-text-dim)', lineHeight: 1.55 }}>
        {children}
      </span>
    </div>
  );
}

export function LandingPage({
  onOpenStudio,
  onOpenDj,
  onOpenRoblox,
  showAppLinks = true,
}: LandingPageProps): JSX.Element {
  // Paket yang sedang disorot. Belum ada checkout — memilih hanya mengubah
  // sorotan kartunya, sama seperti di design.
  const [plan, setPlan] = useState<PlanId>('d7');
  // Indeks FAQ yang terbuka; -1 berarti semuanya tertutup.
  const [faq, setFaq] = useState(0);

  return (
    <div
      className="km-root"
      style={{
        background: 'var(--cy-bg)',
        fontFamily: 'var(--cy-font-mono)',
        color: 'var(--cy-text)',
        minHeight: '100vh',
      }}
    >
      {/* ── Topbar ───────────────────────────────────────────────────────── */}
      <div
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 20,
          borderBottom: '1px solid var(--cy-border)',
          background: '#050505ee',
          backdropFilter: 'blur(6px)',
        }}
      >
        <div
          className="km-wrap"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '16px',
            paddingTop: '14px',
            paddingBottom: '14px',
            flexWrap: 'wrap',
          }}
        >
          <span
            style={{
              fontFamily: 'var(--cy-font-sans)',
              fontSize: '20px',
              fontWeight: 700,
              letterSpacing: '.06em',
            }}
          >
            KELAS MALAM STUDIO
          </span>
          <span style={{ fontSize: '11px', letterSpacing: '.18em', color: 'var(--cy-accent)' }}>
            // TIMELINE MIX
          </span>
          <VersionTag height={20} />
          <div className="km-nav">
            <a href="#fitur" style={NAV_LINK}>
              FITUR
            </a>
            <a href="#alur" style={NAV_LINK}>
              ALUR
            </a>
            <a href="#spek" style={NAV_LINK}>
              SPEK
            </a>
            <a href="#harga" style={NAV_LINK}>
              HARGA
            </a>
            {showAppLinks && onOpenDj !== undefined && (
              <Button
                size="sm"
                variant="outline"
                style={{ height: '34px' }}
                onClick={onOpenDj}
              >
                MODE DJ
              </Button>
            )}
            {showAppLinks && onOpenRoblox !== undefined && (
              <Button
                size="sm"
                variant="outline"
                style={{ height: '34px' }}
                onClick={onOpenRoblox}
              >
                ROBLOX
              </Button>
            )}
            {showAppLinks ? (
              <Button size="sm" style={{ height: '34px' }} onClick={onOpenStudio}>
                BUKA STUDIO
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <div className="km-hero-bg">
        <div
          className="km-wrap"
          style={{ paddingTop: '64px', paddingBottom: '76px', position: 'relative', zIndex: 1 }}
        >
          <div className="km-hero">
            <div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  marginBottom: '22px',
                  flexWrap: 'wrap',
                }}
              >
                <Badge tone="accent" dot pulse>
                  BROWSER-BASED · TANPA INSTALL
                </Badge>
                <span
                  style={{ fontSize: '10px', letterSpacing: '.2em', color: 'var(--cy-text-muted)' }}
                >
                  48 kHz · 24-BIT
                </span>
              </div>
              <h1
                className="km-h1"
                style={{
                  fontFamily: 'var(--cy-font-sans)',
                  lineHeight: 1.02,
                  fontWeight: 700,
                  letterSpacing: '.01em',
                  margin: '0 0 20px',
                  textWrap: 'balance',
                } as CSSProperties}
              >
                TUMPUK AUDIO DI TIMELINE.
                <br />
                <span style={{ color: 'var(--cy-accent)' }}>COMPILE JADI SATU.</span>
              </h1>
              <p
                style={{
                  fontSize: '15px',
                  lineHeight: 1.7,
                  color: 'var(--cy-text-dim)',
                  maxWidth: '54ch',
                  margin: '0 0 30px',
                  textWrap: 'pretty',
                } as CSSProperties}
              >
                Editor multi-lane untuk mixtape, podcast, dan set DJ. Taruh file di lane, geser di
                timeline, atur fade dan gain, lalu render semuanya jadi satu WAV atau MP3 — semua
                di browser, tanpa upload ke server.
              </p>
              <div
                style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '34px' }}
              >
                <Button size="md" style={{ height: '46px' }} onClick={onOpenStudio}>
                  MULAI MIXING GRATIS
                </Button>
                <Button
                  size="md"
                  variant="outline"
                  style={{ height: '46px' }}
                  onClick={onOpenStudio}
                >
                  ▶ LIHAT DEMO 90 DETIK
                </Button>
              </div>
              <div style={{ display: 'flex', gap: '34px', flexWrap: 'wrap' }}>
                {HERO_STATS.map((st) => (
                  <div key={st.label}>
                    <div
                      style={{
                        fontFamily: 'var(--cy-font-sans)',
                        fontSize: '26px',
                        fontWeight: 700,
                        color: 'var(--cy-accent)',
                      }}
                    >
                      {st.val}
                    </div>
                    <div
                      style={{
                        fontSize: '10px',
                        letterSpacing: '.18em',
                        color: 'var(--cy-text-muted)',
                        marginTop: '3px',
                      }}
                    >
                      {st.label}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <HeroShot />
          </div>
        </div>
      </div>

      <div className="km-wrap">
        {/* ── 01 / FITUR ─────────────────────────────────────────────────── */}
        <div className="km-sec">
          <div id="fitur" className="km-panel">
            <div style={{ ...SECTION_HEAD, marginBottom: '28px' }}>
              <span style={EYEBROW}>01 / FITUR</span>
              <h2 className="km-h2" style={H2}>
                SEMUA YANG DIBUTUHKAN UNTUK SATU RILISAN
              </h2>
            </div>
            <div className="km-3">
              {FEATURES.map((ft) => (
                <Card key={ft.title} notched>
                  <span
                    style={{
                      fontSize: '9px',
                      letterSpacing: '.18em',
                      color: 'var(--cy-accent)',
                      border: '1px solid var(--cy-border-strong)',
                      padding: '3px 7px',
                    }}
                  >
                    {ft.tag}
                  </span>
                  <div
                    style={{
                      fontFamily: 'var(--cy-font-sans)',
                      fontSize: '19px',
                      fontWeight: 600,
                      letterSpacing: '.04em',
                      color: 'var(--cy-text)',
                      margin: '14px 0 10px',
                    }}
                  >
                    {ft.title}
                  </div>
                  <p style={BODY}>{ft.body}</p>
                </Card>
              ))}
            </div>
          </div>
        </div>

        {/* ── 02 / ALUR KERJA ────────────────────────────────────────────── */}
        <div className="km-sec">
          <div id="alur" className="km-panel">
            <div style={{ ...SECTION_HEAD, marginBottom: '28px' }}>
              <span style={EYEBROW}>02 / ALUR KERJA</span>
              <h2 className="km-h2" style={H2}>
                DARI FILE MENTAH KE SATU MASTER
              </h2>
            </div>
            <div
              className="km-4"
              style={{ border: '1px solid var(--cy-border)', background: 'var(--cy-surface-1)' }}
            >
              {STEPS.map((sp) => (
                <div
                  key={sp.n}
                  style={{ padding: '26px 22px', borderRight: '1px solid var(--cy-border)' }}
                >
                  <div
                    style={{
                      fontFamily: 'var(--cy-font-sans)',
                      fontSize: '38px',
                      fontWeight: 700,
                      color: 'var(--cy-accent)',
                      lineHeight: 1,
                      marginBottom: '14px',
                    }}
                  >
                    {sp.n}
                  </div>
                  <div
                    style={{
                      fontSize: '13px',
                      letterSpacing: '.12em',
                      color: 'var(--cy-text)',
                      marginBottom: '9px',
                    }}
                  >
                    {sp.title}
                  </div>
                  <p style={BODY}>{sp.body}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── 03 / SPESIFIKASI ───────────────────────────────────────────── */}
        <div className="km-sec">
          <div id="spek" className="km-panel km-2">
            <div>
              <span style={EYEBROW}>03 / SPESIFIKASI</span>
              <h2 className="km-h2" style={{ ...H2, margin: '14px 0 16px' }}>
                ANGKA YANG DIPEGANG ENGINE
              </h2>
              <p
                style={{
                  fontSize: '13px',
                  lineHeight: 1.75,
                  color: 'var(--cy-text-dim)',
                  maxWidth: '46ch',
                  margin: '0 0 24px',
                  textWrap: 'pretty',
                } as CSSProperties}
              >
                Tidak ada pemrosesan tersembunyi. Yang terdengar di preview persis yang keluar saat
                compile — termasuk peak yang kelewat panas.
              </p>
              <Button
                size="md"
                variant="outline"
                style={{ height: '44px' }}
                onClick={() => {
                  window.open('https://github.com/asyrawih/DawOnWeb#readme', '_blank', 'noopener');
                }}
              >
                BACA CATATAN TEKNIS
              </Button>
            </div>
            <div style={{ display: 'grid', gap: '2px' }}>
              {SPECS.map((sc) => (
                <div
                  key={sc.label}
                  style={{
                    display: 'flex',
                    gap: '14px',
                    alignItems: 'center',
                    padding: '12px 14px',
                    border: '1px solid var(--cy-border)',
                    background: 'var(--cy-surface-1)',
                  }}
                >
                  <span
                    style={{
                      fontSize: '11px',
                      color: 'var(--cy-text-dim)',
                      letterSpacing: '.06em',
                    }}
                  >
                    {sc.label}
                  </span>
                  <span
                    style={{
                      marginLeft: 'auto',
                      fontSize: '12px',
                      color: 'var(--cy-accent)',
                      textAlign: 'right',
                    }}
                  >
                    {sc.val}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── 04 / HARGA ─────────────────────────────────────────────────── */}
        <div className="km-sec">
          <div id="harga" className="km-panel">
            <div style={{ ...SECTION_HEAD, marginBottom: '10px' }}>
              <span style={EYEBROW}>04 / HARGA</span>
              <h2 className="km-h2" style={H2}>
                BAYAR SEKALI PAKAI, ATAU SEKALI SEUMUR HIDUP
              </h2>
            </div>
            <p style={{ fontSize: '12px', color: 'var(--cy-text-dim)', margin: '0 0 26px' }}>
              Semua paket membuka fitur yang sama. Yang berbeda hanya durasi akses — dan satu hal
              ekstra di Lifetime.
            </p>
            <div
              style={{
                border: '1px solid var(--cy-accent)',
                background: '#ffd4000a',
                padding: '16px 18px',
                marginBottom: '18px',
                display: 'flex',
                alignItems: 'center',
                gap: '14px',
                flexWrap: 'wrap',
              }}
            >
              <span
                style={{
                  fontFamily: 'var(--cy-font-sans)',
                  fontSize: '18px',
                  fontWeight: 700,
                  letterSpacing: '.06em',
                  color: 'var(--cy-accent)',
                }}
              >
                GRATIS SAMPAI 30 SEPTEMBER
              </span>
              <span style={{ fontSize: '12px', lineHeight: 1.6, color: 'var(--cy-text-dim)' }}>
                Coba semua fitur tanpa bayar. Pilih paket nanti setelah masa gratis berakhir.
              </span>
            </div>
            <div className="km-3" style={{ alignItems: 'stretch' }}>
              {PLANS.map((pl) => {
                const active = plan === pl.id;
                return (
                  <div
                    key={pl.id}
                    className="km-hover-accent"
                    onClick={() => setPlan(pl.id)}
                    style={{
                      border: `1px solid ${active ? 'var(--cy-accent)' : 'var(--cy-border)'}`,
                      background: active ? '#0f0d05' : 'var(--cy-surface-1)',
                      padding: '26px 24px',
                      cursor: 'pointer',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '14px',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '10px',
                        flexWrap: 'wrap',
                      }}
                    >
                      <span
                        style={{
                          fontSize: '13px',
                          letterSpacing: '.2em',
                          color: 'var(--cy-text)',
                        }}
                      >
                        {pl.name}
                      </span>
                      <Badge tone={pl.id === 'life' ? 'warning' : 'accent'} height={22}>
                        {pl.badge}
                      </Badge>
                    </div>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
                        <span
                          style={{
                            fontFamily: 'var(--cy-font-sans)',
                            fontSize: '40px',
                            fontWeight: 700,
                            color: 'var(--cy-accent)',
                            lineHeight: 1,
                          }}
                        >
                          {pl.price}
                        </span>
                        <span style={{ fontSize: '11px', color: 'var(--cy-text-muted)' }}>
                          {pl.unit}
                        </span>
                      </div>
                      <div
                        style={{
                          fontSize: '10px',
                          letterSpacing: '.12em',
                          color: 'var(--cy-text-muted)',
                          marginTop: '6px',
                        }}
                      >
                        {pl.per}
                      </div>
                    </div>
                    <p
                      style={{
                        fontSize: '12px',
                        lineHeight: 1.6,
                        color: 'var(--cy-text-dim)',
                        margin: 0,
                      }}
                    >
                      {pl.desc}
                    </p>
                    <div style={{ display: 'grid', gap: '8px' }}>
                      {pl.items.map((it) => (
                        <Bullet key={it}>{it}</Bullet>
                      ))}
                    </div>
                    {pl.id === 'life' ? (
                      <div
                        style={{
                          border: '1px dashed var(--cy-accent)',
                          background: '#ffd4000a',
                          padding: '12px 13px',
                        }}
                      >
                        <div
                          style={{
                            fontSize: '10px',
                            letterSpacing: '.18em',
                            color: 'var(--cy-accent)',
                            marginBottom: '6px',
                          }}
                        >
                          REQUEST FITUR
                        </div>
                        <p
                          style={{
                            fontSize: '11px',
                            lineHeight: 1.6,
                            color: 'var(--cy-text-dim)',
                            margin: 0,
                          }}
                        >
                          Khusus pemegang Lifetime: ajukan fitur yang kamu butuhkan lewat papan
                          request, dan ikut memilih apa yang dikerjakan duluan.
                        </p>
                      </div>
                    ) : null}
                    <div style={{ marginTop: 'auto', paddingTop: '14px' }}>
                      {/* Tombol ini juga yang membuat kartu bisa dipilih lewat
                          keyboard — div pembungkusnya sengaja tidak dijadikan
                          kontrol supaya tidak ada button di dalam button. */}
                      <Button
                        size="sm"
                        variant="outline"
                        active={active}
                        style={{ width: '100%', height: '38px' }}
                        onClick={() => setPlan(pl.id)}
                      >
                        {`AMBIL ${pl.name}`}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
            <div
              style={{
                display: 'flex',
                gap: '20px',
                flexWrap: 'wrap',
                marginTop: '14px',
                fontSize: '10px',
                letterSpacing: '.14em',
                color: 'var(--cy-text-muted)',
              }}
            >
              <span>PEMBAYARAN QRIS · TRANSFER · E-WALLET</span>
              <span>·</span>
              <span>AKSES AKTIF SEGERA SETELAH BAYAR</span>
              <span>·</span>
              <span>TIDAK ADA PERPANJANGAN OTOMATIS</span>
            </div>
          </div>
        </div>

        {/* ── 05 / ENGINE ────────────────────────────────────────────────── */}
        <div className="km-sec">
          <div className="km-panel km-wasm">
            <div style={{ ...SECTION_HEAD, marginBottom: '10px', position: 'relative', zIndex: 1 }}>
              <span style={EYEBROW}>05 / PERFORMA</span>
              <h2 className="km-h2" style={H2}>
                EDIT AUDIO PANJANG, TETAP NGEBUT TANPA DRAMA
              </h2>
            </div>
            <p
              style={{
                fontSize: '13px',
                lineHeight: 1.75,
                color: 'var(--cy-text-dim)',
                margin: '0 0 26px',
                maxWidth: '74ch',
                textWrap: 'pretty',
                position: 'relative',
                zIndex: 1,
              } as CSSProperties}
            >
              Tumpuk banyak lane, geser timeline, dan dengarkan hasilnya tanpa jeda yang mengganggu.
              Bahkan project berdurasi satu jam bisa selesai diproses hanya dalam hitungan detik.
            </p>
            <div className="km-3" style={{ position: 'relative', zIndex: 1 }}>
              {WASM_STATS.map((ws) => (
                <div
                  key={ws.label}
                  style={{
                    border: '1px solid var(--cy-border)',
                    background: '#000',
                    padding: '20px 18px',
                  }}
                >
                  <div
                    style={{
                      fontFamily: 'var(--cy-font-sans)',
                      fontSize: '34px',
                      fontWeight: 700,
                      color: 'var(--cy-accent)',
                      lineHeight: 1,
                    }}
                  >
                    {ws.val}
                    <span
                      style={{
                        fontSize: '13px',
                        color: 'var(--cy-text-muted)',
                        marginLeft: '5px',
                      }}
                    >
                      {ws.unit}
                    </span>
                  </div>
                  <div
                    style={{
                      fontSize: '11px',
                      letterSpacing: '.14em',
                      color: 'var(--cy-text)',
                      marginTop: '10px',
                    }}
                  >
                    {ws.label}
                  </div>
                  <div
                    style={{
                      fontSize: '11px',
                      lineHeight: 1.6,
                      color: 'var(--cy-text-dim)',
                      marginTop: '6px',
                    }}
                  >
                    {ws.note}
                  </div>
                </div>
              ))}
            </div>
            <div
              className="km-2"
              style={{ gap: '16px', marginTop: '16px', position: 'relative', zIndex: 1 }}
            >
              <div
                style={{ border: '1px solid var(--cy-border)', background: '#000', padding: '18px' }}
              >
                <div
                  style={{
                    fontSize: '10px',
                    letterSpacing: '.2em',
                    color: 'var(--cy-text-muted)',
                    marginBottom: '12px',
                  }}
                >
                  RENDER 60 MENIT AUDIO · 4 LANE
                </div>
                <div style={{ display: 'grid', gap: '12px' }}>
                  {BENCH.map((bn) => (
                    <div key={bn.name}>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'baseline',
                          gap: '8px',
                          marginBottom: '6px',
                        }}
                      >
                        <span
                          style={{ fontSize: '11px', color: bn.color, letterSpacing: '.1em' }}
                        >
                          {bn.name}
                        </span>
                        <span
                          style={{
                            marginLeft: 'auto',
                            fontFamily: 'var(--cy-font-sans)',
                            fontSize: '16px',
                            fontWeight: 600,
                            color: bn.color,
                          }}
                        >
                          {bn.time}
                        </span>
                      </div>
                      <div
                        style={{
                          height: '10px',
                          background: '#0b0b0a',
                          border: '1px solid var(--cy-border)',
                          position: 'relative',
                          overflow: 'hidden',
                        }}
                      >
                        <div
                          style={{
                            position: 'absolute',
                            inset: '0 auto 0 0',
                            width: `${bn.w}%`,
                            background: bn.fill,
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
                <div
                  style={{
                    fontSize: '10px',
                    color: 'var(--cy-text-muted)',
                    marginTop: '12px',
                    letterSpacing: '.1em',
                  }}
                >
                  Hasil pengujian project 60 menit dengan 4 lane
                </div>
              </div>
              <div
                style={{ border: '1px solid var(--cy-border)', background: '#000', padding: '18px' }}
              >
                <div
                  style={{
                    fontSize: '10px',
                    letterSpacing: '.2em',
                    color: 'var(--cy-text-muted)',
                    marginBottom: '12px',
                  }}
                >
                  YANG KAMU RASAKAN
                </div>
                <div style={{ display: 'grid', gap: '9px' }}>
                  {WASM_BULLETS.map((wb) => (
                    <Bullet key={wb}>{wb}</Bullet>
                  ))}
                </div>
              </div>
            </div>
            <div
              style={{
                display: 'flex',
                gap: '8px',
                flexWrap: 'wrap',
                marginTop: '16px',
                position: 'relative',
                zIndex: 1,
              }}
            >
              {WASM_TAGS.map((tg) => (
                <span
                  key={tg}
                  style={{
                    fontSize: '9px',
                    letterSpacing: '.18em',
                    color: 'var(--cy-text-dim)',
                    border: '1px solid var(--cy-border-strong)',
                    padding: '5px 9px',
                  }}
                >
                  {tg}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* ── 06 / FAQ ───────────────────────────────────────────────────── */}
        <div className="km-sec km-faq">
          <div>
            <span style={EYEBROW}>06 / FAQ</span>
            <h2 className="km-h2 km-h2-sm" style={{ ...H2, margin: '14px 0 0' }}>
              PERTANYAAN YANG SERING MASUK
            </h2>
          </div>
          <div style={{ display: 'grid', gap: '2px' }}>
            {FAQS.map((fq, i) => {
              const open = faq === i;
              return (
                <button
                  key={fq.q}
                  type="button"
                  aria-expanded={open}
                  className="cy-btn-reset cy-focusable km-hover-border"
                  onClick={() => setFaq(open ? -1 : i)}
                  style={{
                    border: '1px solid var(--cy-border)',
                    background: 'var(--cy-surface-1)',
                    padding: '16px 18px',
                    cursor: 'pointer',
                    textAlign: 'left',
                    display: 'block',
                    width: '100%',
                  }}
                >
                  <div style={{ display: 'flex', gap: '14px', alignItems: 'center' }}>
                    <span
                      style={{
                        fontSize: '13px',
                        color: open ? 'var(--cy-accent)' : 'var(--cy-text)',
                        letterSpacing: '.04em',
                      }}
                    >
                      {fq.q}
                    </span>
                    <span
                      style={{ marginLeft: 'auto', fontSize: '15px', color: 'var(--cy-accent)' }}
                    >
                      {open ? '−' : '+'}
                    </span>
                  </div>
                  {open ? (
                    <p
                      style={{
                        fontSize: '12px',
                        lineHeight: 1.75,
                        color: 'var(--cy-text-dim)',
                        margin: '12px 0 0',
                        maxWidth: '70ch',
                        textWrap: 'pretty',
                      } as CSSProperties}
                    >
                      {fq.a}
                    </p>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>

        {/* ── CTA penutup ────────────────────────────────────────────────── */}
        <div
          className="km-cta"
          style={{
            margin: '96px 0 0',
            border: '1px solid var(--cy-accent)',
            background: '#0b0904',
            display: 'flex',
            alignItems: 'center',
            gap: '36px',
            flexWrap: 'wrap',
            filter: 'var(--cy-glow-filter-soft)',
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <h2 className="km-h2" style={{ ...H2, margin: '0 0 10px' }}>
              BUKA STUDIO, TARUH LAGU PERTAMA
            </h2>
            <p
              style={{
                fontSize: '13px',
                color: 'var(--cy-text-dim)',
                margin: 0,
                maxWidth: '60ch',
                textWrap: 'pretty',
              } as CSSProperties}
            >
              Tidak perlu akun untuk mencoba timeline. Bayar hanya ketika mau meng-compile hasilnya.
            </p>
          </div>
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            <Button size="md" style={{ height: '46px' }} onClick={onOpenStudio}>
              BUKA STUDIO
            </Button>
            <Button
              size="md"
              variant="ghost"
              style={{ height: '46px' }}
              onClick={() => {
                document.getElementById('harga')?.scrollIntoView({ behavior: 'smooth' });
              }}
            >
              LIHAT HARGA
            </Button>
          </div>
        </div>

        {/* ── Footer ─────────────────────────────────────────────────────── */}
        <div
          style={{
            marginTop: '56px',
            padding: '26px 0 48px',
            borderTop: '1px solid var(--cy-border)',
            display: 'flex',
            gap: '20px',
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          <span
            style={{
              fontFamily: 'var(--cy-font-sans)',
              fontSize: '15px',
              fontWeight: 700,
              letterSpacing: '.06em',
            }}
          >
            KELAS MALAM STUDIO
          </span>
          <span
            style={{ fontSize: '10px', letterSpacing: '.16em', color: 'var(--cy-text-muted)' }}
          >
            © 2026 · DIBUAT UNTUK YANG MIXING JAM 2 PAGI
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '22px' }}>
            <a href="#fitur" style={{ fontSize: '10px', letterSpacing: '.16em' }}>
              FITUR
            </a>
            <a href="#harga" style={{ fontSize: '10px', letterSpacing: '.16em' }}>
              HARGA
            </a>
            <a href="#spek" style={{ fontSize: '10px', letterSpacing: '.16em' }}>
              SPEK
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
