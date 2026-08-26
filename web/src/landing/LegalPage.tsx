import type { ReactNode } from 'react';

import './landing.css';

export type LegalPageKind = 'privacy-policy' | 'terms-of-service';

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="km-legal-section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export function LegalPage({ kind }: { readonly kind: LegalPageKind }): JSX.Element {
  const privacy = kind === 'privacy-policy';

  return (
    <main className="km-root km-legal-root">
      <div className="km-wrap km-legal-wrap">
        <a className="km-legal-back" href="/">← KELAS MALAM STUDIO</a>
        <p className="km-legal-eyebrow">LEGAL / KELAS MALAM STUDIO</p>
        <h1>{privacy ? 'PRIVACY POLICY' : 'TERMS OF SERVICE'}</h1>
        <p className="km-legal-updated">Terakhir diperbarui: 26 Agustus 2026</p>

        {privacy ? (
          <>
            <Section title="1. Informasi yang kami proses">
              <p>Audio yang Anda buka untuk mixing diproses secara lokal di browser dan tidak diunggah ke server Kelas Malam Studio. Jika Anda masuk dengan Google, kami dapat menyimpan identitas akun dasar seperti nama, alamat email, dan ID akun untuk menyediakan sesi serta fitur kepustakaan.</p>
            </Section>
            <Section title="2. Data proyek dan integrasi">
              <p>Data proyek hanya dikirim atau disimpan ketika Anda secara aktif memakai fitur cloud atau integrasi pihak ketiga. Layanan pihak ketiga memproses data sesuai kebijakan mereka masing-masing dan hanya setelah Anda memilih untuk memakai integrasi tersebut.</p>
            </Section>
            <Section title="3. Penyimpanan, keamanan, dan penghapusan">
              <p>Kami menyimpan data akun dan data cloud selama diperlukan untuk menyediakan layanan. Anda dapat menghapus data lokal melalui pengaturan browser dan meminta penghapusan data akun melalui kanal kontak resmi Kelas Malam Studio.</p>
            </Section>
            <Section title="4. Perubahan kebijakan">
              <p>Kebijakan ini dapat diperbarui ketika fitur atau cara pemrosesan data berubah. Tanggal pembaruan terbaru selalu ditampilkan di halaman ini.</p>
            </Section>
          </>
        ) : (
          <>
            <Section title="1. Penggunaan layanan">
              <p>Anda boleh memakai Kelas Malam Studio untuk membuat dan mengolah karya yang secara hukum berhak Anda gunakan. Anda bertanggung jawab atas audio, metadata, dan hasil ekspor yang Anda masukkan atau hasilkan melalui layanan.</p>
            </Section>
            <Section title="2. Penggunaan yang dilarang">
              <p>Jangan memakai layanan untuk melanggar hak cipta, hukum yang berlaku, keamanan sistem, atau hak orang lain. Kami dapat membatasi akses yang disalahgunakan atau berisiko merugikan layanan dan penggunanya.</p>
            </Section>
            <Section title="3. Ketersediaan dan hasil">
              <p>Layanan disediakan sebagaimana tersedia. Fitur, kompatibilitas, dan ketersediaan dapat berubah. Simpan cadangan proyek dan hasil penting Anda; kami tidak menjamin layanan akan selalu bebas gangguan atau kehilangan data.</p>
            </Section>
            <Section title="4. Perubahan ketentuan">
              <p>Kami dapat memperbarui ketentuan ini untuk menyesuaikan fitur atau kewajiban hukum. Dengan terus menggunakan layanan setelah pembaruan, Anda menerima ketentuan yang berlaku pada saat itu.</p>
            </Section>
          </>
        )}

        <footer className="km-legal-footer">
          <a href="/privacy-policy">PRIVACY POLICY</a>
          <a href="/terms-of-service">TERMS OF SERVICE</a>
        </footer>
      </div>
    </main>
  );
}
