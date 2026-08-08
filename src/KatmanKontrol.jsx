import { useState } from 'react';

/*
 * KATMAN KONTROL
 * --------------
 * v1 ve v2 sonuçlarını ve her anomali sınıfını tek yerden aç/kapa.
 *
 * Durumu App.jsx tutar; bu bileşen sadece arayüzü çizer ve değişikliği
 * yukarı bildirir. Böylece hem v1'in GeoJSON'u hem AnalizV2 aynı
 * filtreyi kullanır.
 *
 * Filtre biçimi:
 *   { v1: true, v2: true, siniflar: [0, 1, 2, 3, 4] }
 */

export const VARSAYILAN_FILTRE = { v1: true, v2: true, siniflar: [0, 1, 2, 3, 4] };

const SINIFLAR = [
  { deger: 4, ad: 'Çok güçlü', renk: '#ef4444' },
  { deger: 3, ad: 'Güçlü', renk: '#f97316' },
  { deger: 2, ad: 'Orta', renk: '#facc15' },
  { deger: 1, ad: 'Zayıf', renk: '#22c55e' },
  { deger: 0, ad: 'Anomali yok', renk: '#1e3a8a' },
];

export default function KatmanKontrol({ deger, onChange }) {
  const [acik, setAcik] = useState(false);
  const filtre = deger || VARSAYILAN_FILTRE;

  const motorDegistir = (motor) =>
    onChange({ ...filtre, [motor]: !filtre[motor] });

  const sinifDegistir = (sinif) => {
    const mevcut = filtre.siniflar || [];
    onChange({
      ...filtre,
      siniflar: mevcut.includes(sinif)
        ? mevcut.filter((s) => s !== sinif)
        : [...mevcut, sinif],
    });
  };

  const hepsi = (durum) =>
    onChange({ ...filtre, siniflar: durum ? [0, 1, 2, 3, 4] : [] });

  const sadeceGuclu = () => onChange({ ...filtre, siniflar: [3, 4] });

  return (
    <div style={{
      position: 'absolute', right: 12, top: 12, zIndex: 1000,
      background: 'rgba(15,23,42,0.94)', color: '#e2e8f0',
      borderRadius: 12, padding: acik ? 14 : 0,
      width: acik ? 236 : 'auto', fontSize: 13,
      boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
    }}>
      {!acik ? (
        <button
          onClick={() => setAcik(true)}
          style={{
            background: '#334155', color: '#e2e8f0', border: 'none',
            borderRadius: 12, padding: '10px 16px', cursor: 'pointer',
            fontSize: 13, fontWeight: 600,
          }}
        >
          🎚️ Katmanlar
        </button>
      ) : (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <b>🎚️ Katmanlar</b>
            <button
              onClick={() => setAcik(false)}
              style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 18 }}
            >×</button>
          </div>

          {/* --- MOTOR SEÇİMİ --- */}
          <div style={{ marginBottom: 10 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={filtre.v1 !== false} onChange={() => motorDegistir('v1')} />
              <span>v1 <span style={{ color: '#64748b', fontSize: 11 }}>(düz çizgi)</span></span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer' }}>
              <input type="checkbox" checked={filtre.v2 !== false} onChange={() => motorDegistir('v2')} />
              <span>v2 <span style={{ color: '#64748b', fontSize: 11 }}>(kesikli çizgi)</span></span>
            </label>
          </div>

          {/* --- SINIF SEÇİMİ --- */}
          <div style={{ borderTop: '1px solid #334155', paddingTop: 10, marginBottom: 8 }}>
            <div style={{ color: '#94a3b8', fontSize: 11, marginBottom: 6 }}>
              Gösterilecek sınıflar
            </div>
            {SINIFLAR.map((s) => (
              <label
                key={s.deger}
                style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5, cursor: 'pointer' }}
              >
                <input
                  type="checkbox"
                  checked={(filtre.siniflar || []).includes(s.deger)}
                  onChange={() => sinifDegistir(s.deger)}
                />
                <span style={{
                  display: 'inline-block', width: 12, height: 12,
                  borderRadius: 3, background: s.renk, flexShrink: 0,
                }} />
                <span>{s.ad}</span>
              </label>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={sadeceGuclu}
              style={{
                flex: 1, padding: '6px 4px', borderRadius: 6,
                border: '1px solid #334155', background: 'transparent',
                color: '#cbd5e1', cursor: 'pointer', fontSize: 11,
              }}
            >
              Sadece güçlü
            </button>
            <button
              onClick={() => hepsi(true)}
              style={{
                flex: 1, padding: '6px 4px', borderRadius: 6,
                border: '1px solid #334155', background: 'transparent',
                color: '#cbd5e1', cursor: 'pointer', fontSize: 11,
              }}
            >
              Hepsi
            </button>
            <button
              onClick={() => hepsi(false)}
              style={{
                flex: 1, padding: '6px 4px', borderRadius: 6,
                border: '1px solid #334155', background: 'transparent',
                color: '#cbd5e1', cursor: 'pointer', fontSize: 11,
              }}
            >
              Hiçbiri
            </button>
          </div>
        </>
      )}
    </div>
  );
}
