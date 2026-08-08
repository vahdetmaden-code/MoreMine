import { useEffect, useRef, useState, useCallback } from 'react';
import { supabase } from './supabaseClient';

/*
 * GÜVENLİK KATMANI
 * ----------------
 * Kendi içinde kapalıdır. App.jsx'in hiçbir mantığına dokunmaz.
 *
 * Sistem belirlenen süre kadar açık kaldığında ekranın tamamını kaplayan
 * kırmızı alarm devreye girer, geri sayım biter ve oturum kapatılır.
 *
 * Süre admin tarafından panelden değiştirilebilir (localStorage'da tutulur).
 */

const VARSAYILAN_DAKIKA = 15;
const GERI_SAYIM_SANIYE = 8;
const AYAR_ANAHTARI = 'moremine_guvenlik_dakika';

// Alarm ekranının CSS animasyonları — bileşen içinde tanımlanıyor ki
// index.css'e dokunmak gerekmesin.
const ANIMASYON_CSS = `
@keyframes mm-alarm-nabiz {
  0%, 100% { background: rgba(120, 0, 0, 0.92); }
  50%      { background: rgba(200, 0, 0, 0.96); }
}
@keyframes mm-alarm-titre {
  0%, 100% { transform: translate(0, 0); }
  20%      { transform: translate(-3px, 2px); }
  40%      { transform: translate(3px, -2px); }
  60%      { transform: translate(-2px, -1px); }
  80%      { transform: translate(2px, 1px); }
}
@keyframes mm-alarm-tarama {
  0%   { top: -10%; }
  100% { top: 110%; }
}
@keyframes mm-alarm-yanip {
  0%, 49%   { opacity: 1; }
  50%, 100% { opacity: 0.25; }
}
@keyframes mm-alarm-genisle {
  0%   { transform: scale(0.7); opacity: 0; }
  100% { transform: scale(1); opacity: 1; }
}
@keyframes mm-alarm-halka {
  0%   { transform: scale(0.8); opacity: 0.9; }
  100% { transform: scale(2.4); opacity: 0; }
}
`;

export default function GuvenlikKatmani({ admin = false }) {
  const [dakika, setDakika] = useState(() => {
    const kayitli = parseInt(localStorage.getItem(AYAR_ANAHTARI), 10);
    return Number.isFinite(kayitli) && kayitli > 0 ? kayitli : VARSAYILAN_DAKIKA;
  });
  const [alarm, setAlarm] = useState(false);
  const [kalan, setKalan] = useState(GERI_SAYIM_SANIYE);
  const [ayarAcik, setAyarAcik] = useState(false);
  const sayacRef = useRef(null);

  // --- Ana süre sayacı ---
  useEffect(() => {
    if (alarm) return;
    const zamanlayici = setTimeout(() => setAlarm(true), dakika * 60 * 1000);
    return () => clearTimeout(zamanlayici);
  }, [dakika, alarm]);

  // --- Alarm geri sayımı ve çıkış ---
  useEffect(() => {
    if (!alarm) return;

    setKalan(GERI_SAYIM_SANIYE);
    sayacRef.current = setInterval(() => {
      setKalan((onceki) => {
        if (onceki <= 1) {
          clearInterval(sayacRef.current);
          supabase.auth.signOut().finally(() => window.location.reload());
          return 0;
        }
        return onceki - 1;
      });
    }, 1000);

    return () => clearInterval(sayacRef.current);
  }, [alarm]);

  const sureyiKaydet = useCallback((yeni) => {
    const sayi = Math.max(1, Math.min(240, parseInt(yeni, 10) || VARSAYILAN_DAKIKA));
    localStorage.setItem(AYAR_ANAHTARI, String(sayi));
    setDakika(sayi);
  }, []);

  return (
    <>
      <style>{ANIMASYON_CSS}</style>

      {/* --- ADMIN AYARI --- */}
      {admin && !alarm && (
        <div style={{
          position: 'absolute', left: 12, bottom: 12, zIndex: 1500,
          background: 'rgba(15,23,42,0.92)', color: '#e2e8f0',
          borderRadius: 10, padding: ayarAcik ? 12 : 0, fontSize: 12,
          boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
        }}>
          {!ayarAcik ? (
            <button
              onClick={() => setAyarAcik(true)}
              title="Güvenlik oturum süresi"
              style={{
                background: '#334155', color: '#cbd5e1', border: 'none',
                borderRadius: 10, padding: '7px 11px', cursor: 'pointer', fontSize: 12,
              }}
            >
              🛡️ {dakika} dk
            </button>
          ) : (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <b>🛡️ Güvenlik Süresi</b>
                <button
                  onClick={() => setAyarAcik(false)}
                  style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 16 }}
                >×</button>
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  type="number"
                  min="1"
                  max="240"
                  defaultValue={dakika}
                  onBlur={(e) => sureyiKaydet(e.target.value)}
                  style={{
                    width: 70, padding: 6, borderRadius: 6,
                    background: '#1e293b', color: '#e2e8f0', border: '1px solid #334155',
                  }}
                />
                <span style={{ color: '#94a3b8' }}>dakika</span>
              </div>
              <div style={{ fontSize: 10.5, color: '#64748b', marginTop: 6, lineHeight: 1.5 }}>
                Bu süre dolduğunda güvenlik katmanı devreye girer
                ve oturum kapatılır.
              </div>
              <button
                onClick={() => setAlarm(true)}
                style={{
                  width: '100%', marginTop: 8, padding: 6, borderRadius: 6,
                  background: '#7f1d1d', color: '#fecaca', border: 'none',
                  cursor: 'pointer', fontSize: 11,
                }}
              >
                Şimdi test et
              </button>
            </>
          )}
        </div>
      )}

      {/* --- ALARM EKRANI --- */}
      {alarm && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 99999,
          animation: 'mm-alarm-nabiz 0.8s infinite',
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          overflow: 'hidden', cursor: 'not-allowed',
        }}>
          {/* tarama çizgisi */}
          <div style={{
            position: 'absolute', left: 0, width: '100%', height: 3,
            background: 'linear-gradient(90deg, transparent, #fff, transparent)',
            boxShadow: '0 0 24px 6px rgba(255,255,255,0.7)',
            animation: 'mm-alarm-tarama 1.6s linear infinite',
          }} />

          {/* yatay tarama deseni */}
          <div style={{
            position: 'absolute', inset: 0, pointerEvents: 'none',
            backgroundImage: 'repeating-linear-gradient(0deg, rgba(0,0,0,0.28) 0px, rgba(0,0,0,0.28) 1px, transparent 1px, transparent 4px)',
          }} />

          {/* genişleyen halkalar */}
          {[0, 0.6, 1.2].map((gecikme) => (
            <div key={gecikme} style={{
              position: 'absolute', width: 260, height: 260,
              border: '3px solid rgba(255,255,255,0.55)', borderRadius: '50%',
              animation: `mm-alarm-halka 1.8s ${gecikme}s ease-out infinite`,
            }} />
          ))}

          <div style={{
            position: 'relative', textAlign: 'center', padding: 24,
            animation: 'mm-alarm-genisle 0.35s ease-out',
          }}>
            <div style={{
              fontSize: 72, marginBottom: 8,
              animation: 'mm-alarm-yanip 0.55s infinite',
            }}>⚠️</div>

            <div style={{
              color: '#fff', fontSize: 'clamp(22px, 5vw, 44px)', fontWeight: 900,
              letterSpacing: '2px', textShadow: '0 0 20px rgba(0,0,0,0.7)',
              animation: 'mm-alarm-titre 0.32s infinite',
              lineHeight: 1.25,
            }}>
              KARŞI TARAMA<br />TESPİT EDİLDİ
            </div>

            <div style={{
              marginTop: 18, color: '#fee2e2', fontSize: 'clamp(13px, 2.2vw, 17px)',
              fontWeight: 600, letterSpacing: '0.5px',
            }}>
              Güvenlik katmanı devreye giriyor
            </div>

            <div style={{
              marginTop: 6, color: 'rgba(255,255,255,0.75)',
              fontSize: 12, fontFamily: 'monospace', letterSpacing: '1px',
            }}>
              OTURUM SONLANDIRILIYOR
            </div>

            <div style={{
              marginTop: 22,
              width: 96, height: 96, margin: '22px auto 0',
              border: '4px solid rgba(255,255,255,0.35)', borderRadius: '50%',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 42, fontWeight: 900, color: '#fff',
              textShadow: '0 0 16px rgba(0,0,0,0.6)',
              background: 'rgba(0,0,0,0.25)',
            }}>
              {kalan}
            </div>

            <div style={{
              marginTop: 20, color: 'rgba(255,255,255,0.6)',
              fontSize: 11, fontFamily: 'monospace',
            }}>
              MoreMine · Güvenlik Protokolü
            </div>
          </div>
        </div>
      )}
    </>
  );
}
