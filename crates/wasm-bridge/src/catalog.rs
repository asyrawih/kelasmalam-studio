//! Serialisasi katalog efek ke JSON untuk UI.
//!
//! Berada di sini, bukan di `bindgen.rs`, karena berkas itu diawali
//! `#![cfg(target_arch = "wasm32")]` — seluruh isinya tidak pernah dikompilasi
//! oleh `cargo test` native, jadi logika apa pun yang ditaruh di sana otomatis
//! tak teruji. `studio.rs` sudah memakai pemisahan yang sama: semantiknya di
//! modul biasa, `bindgen.rs` hanya pembungkus tipis.
//!
//! Itu bukan detail administratif. Atribut serde yang salah pada `Taper` atau
//! `Smoothing` (keduanya enum bertag) menghasilkan bentuk JSON yang berbeda
//! **tanpa error apa pun**; UI lalu gagal merakit knob dan penyebabnya tidak
//! terlihat di sisi mana pun.

/// Seluruh katalog efek sebagai JSON — sumber tunggal knob di UI.
pub fn fx_catalog_json() -> String {
    // `unwrap` dihindari supaya artefak wasm tidak punya jalur panic sama
    // sekali; katalognya statis dan sudah divalidasi tes konformans, jadi
    // cabang gagalnya memang tidak terjangkau.
    serde_json::to_string(daw_engine::fx::CATALOG).unwrap_or_else(|_| "[]".into())
}

/// Peta slot blok parameter, untuk dibandingkan dengan `web/src/audio/param-map.ts`.
pub fn param_map_json() -> &'static str {
    daw_engine::fx::params::param_map_json()
}

/// Posisi knob yang dipetakan Rust, untuk dibandingkan sisi TypeScript.
///
/// UI harus bisa mengubah posisi knob ↔ nilai parameter, jadi matematika taper
/// mau tidak mau ada di kedua sisi. Kalau keduanya menyimpang, knob menunjuk
/// angka yang berbeda dari yang benar-benar dipakai engine — dan tidak ada
/// error di mana pun, cuma nilai yang "terasa meleset". Fixture ini yang
/// membuat penyimpangan itu jadi tes gagal.
pub fn taper_fixture_json() -> String {
    let mut rows: Vec<serde_json::Value> = Vec::new();
    for d in daw_engine::fx::CATALOG {
        for p in d.params {
            let values: Vec<f32> = (0..=4).map(|i| p.from_norm(i as f32 / 4.0)).collect();
            rows.push(serde_json::json!({
                "effect": d.id,
                "param": p.id,
                "values": values,
            }));
        }
    }
    serde_json::to_string(&rows).unwrap_or_else(|_| "[]".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Bentuk JSON-nya adalah kontrak dengan UI: kalau berubah, panel FX
    /// berhenti bisa merakit knob.
    #[test]
    fn catalog_json_is_wellformed_and_complete() {
        let json = fx_catalog_json();
        let v: serde_json::Value = serde_json::from_str(&json).expect("katalog JSON sah");
        let arr = v.as_array().expect("katalog berupa array");
        assert_eq!(arr.len(), daw_engine::fx::CATALOG.len());
        assert!(!arr.is_empty(), "katalog kosong");

        for (entry, desc) in arr.iter().zip(daw_engine::fx::CATALOG.iter()) {
            assert_eq!(entry["id"], desc.id);
            assert_eq!(entry["kind"], desc.kind);
            assert!(entry["name"].is_string());
            assert!(entry["category"].is_string());

            let params = entry["params"].as_array().expect("params berupa array");
            assert_eq!(params.len(), desc.params.len(), "{}", desc.id);
            for p in params {
                assert!(p["id"].is_string(), "param tanpa id: {p}");
                assert!(p["name"].is_string());
                assert!(p["unit"].is_string());
                assert!(p["min"].is_number() && p["max"].is_number());
                assert!(p["default"].is_number());
                assert!(p["flags"].is_number());
                // Enum bertag: UI membaca `.kind` untuk memilih pemetaan knob.
                assert!(p["taper"]["kind"].is_string(), "taper tidak bertag: {p}");
                assert!(
                    p["smoothing"]["kind"].is_string(),
                    "smoothing tidak bertag: {p}"
                );
            }
        }
    }

    /// Parameter `Choice` tanpa label tidak bisa digambar UI sebagai apa pun.
    #[test]
    fn choice_params_carry_their_labels() {
        let json = fx_catalog_json();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        for entry in v.as_array().unwrap() {
            for p in entry["params"].as_array().unwrap() {
                if p["unit"] == "choice" {
                    let c = p["choices"].as_array().expect("choices berupa array");
                    assert!(!c.is_empty(), "Choice tanpa label: {}", p["id"]);
                }
            }
        }
    }

    #[test]
    fn param_map_json_matches_engine() {
        assert_eq!(param_map_json(), daw_engine::fx::params::param_map_json());
    }

    /// Dicetak supaya bentuknya bisa diperiksa tanpa menjalankan browser.
    #[test]
    fn print_fx_catalog_json() {
        println!("{}", fx_catalog_json());
    }

    /// Dibaca `fx-catalog.test.ts`.
    #[test]
    fn print_taper_fixture_json() {
        println!("{}", taper_fixture_json());
    }

    #[test]
    fn taper_fixture_covers_every_param() {
        let v: serde_json::Value = serde_json::from_str(&taper_fixture_json()).unwrap();
        let total: usize = daw_engine::fx::CATALOG.iter().map(|d| d.params.len()).sum();
        assert_eq!(v.as_array().unwrap().len(), total);
    }
}
