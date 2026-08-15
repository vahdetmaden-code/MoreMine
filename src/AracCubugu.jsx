import { useState } from 'react';

/*
 * ARAÇ ÇUBUĞU
 * -----------
 * Haritanın sağ altındaki tüm panellerin AÇMA/KAPAMA sorumluluğu burada.
 *
 * Önceden her panel kendi butonunu çiziyordu ve dördü sağ altta üst üste
 * biniyordu — özellikle iPad'de okunamaz hale geliyordu. Şimdi tek bir
 * çubuk var ve aynı anda YALNIZCA BİR panel açık olabiliyor, dolayısıyla
 * çakışma matematiksel olarak imkânsız.
 *
 * Kullanım:
 *   const [acikPanel, setAcikPanel] = useState(null);
 *   <AracCubugu acik={acikPanel} onDegis={setAcikPanel} />
 *   <KatmanKontrol acik={acikPanel === 'katman'} onKapat={() => setAcikPanel(null)} ... />
 */

export const PANELLER = [
  { id: 'rapor', ikon: '📊', ad: 'Rapor', renk: '#1d4ed8' },
  { id: 'katman', ikon: '🎚️', ad: 'Katmanlar', renk: '#334155' },
  { id: 'v2', ikon: '🔬', ad: 'v2 Analiz', renk: '#0891b2' },
  { id: 'v3', ikon: '⚗️', ad: 'v3 Mineral', renk: '#059669' },
  { id: 'manyetik', ikon: '🧲', ad: 'Manyetik', renk: '#7c3aed' },
  { id: 'tarihce', ikon: '📜', ad: 'Tarihçe', renk: '#b45309' },
];

export default function AracCubugu({ acik, onDegis, durumlar = {} }) {
  const [genis, setGenis] = useState(false);

  return (
    <>
    <style>{`@keyframes mm-rozet-nabiz { 0%,100%{opacity:1} 50%{opacity:0.3} }`}</style>
    <div style={{
      position: 'absolute', right: 12, bottom: 12, zIndex: 1001,
      display: 'flex', gap: 6, alignItems: 'center',
      maxWidth: 'calc(100vw - 24px)',
    }}>
      {/* Dar ekranlarda etiketleri gizleyip sadece ikon göster;
          kullanıcı isterse genişletebilir. */}
      <button
        onClick={() => setGenis((g) => !g)}
        title={genis ? 'Etiketleri gizle' : 'Etiketleri göster'}
        style={{
          background: 'rgba(15,23,42,0.94)', color: '#94a3b8',
          border: 'none', borderRadius: 10, padding: '10px 10px',
          cursor: 'pointer', fontSize: 13, lineHeight: 1,
          boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
        }}
      >
        {genis ? '›' : '‹'}
      </button>

      {PANELLER.map((p) => {
        const secili = acik === p.id;
        // İlgili motor çalışıyorsa/bittiyse butonda küçük bir nokta göster.
        // Böylece panel kapalıyken de analizin durumu görünür.
        const motorDurum = durumlar[p.id]?.durum;
        const rozetRenk = p.id === 'rapor'
          ? (Object.values(durumlar).some((x) => x?.durum === 'calisiyor') ? '#f59e0b' : null)
          : (motorDurum === 'calisiyor' ? '#f59e0b'
            : motorDurum === 'tamam' ? '#22c55e'
            : motorDurum === 'hata' ? '#dc2626' : null);
        return (
          <button
            key={p.id}
            onClick={() => onDegis(secili ? null : p.id)}
            title={p.ad}
            style={{
              background: secili ? p.renk : 'rgba(15,23,42,0.94)',
              color: secili ? '#fff' : '#cbd5e1',
              border: secili ? 'none' : '1px solid rgba(148,163,184,0.25)',
              borderRadius: 10,
              padding: genis ? '10px 13px' : '10px 11px',
              cursor: 'pointer', fontSize: 13, fontWeight: 600,
              whiteSpace: 'nowrap', lineHeight: 1,
              boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            <span style={{ position: 'relative', fontSize: 15, lineHeight: 1 }}>
              {p.ikon}
              {rozetRenk && (
                <span style={{
                  position: 'absolute', top: -3, right: -5,
                  width: 8, height: 8, borderRadius: '50%',
                  background: rozetRenk,
                  border: '1.5px solid rgba(15,23,42,0.94)',
                  animation: rozetRenk === '#f59e0b' ? 'mm-rozet-nabiz 1s infinite' : 'none',
                }} />
              )}
            </span>
            {genis && <span>{p.ad}</span>}
          </button>
        );
      })}
    </div>
    </>
  );
}
