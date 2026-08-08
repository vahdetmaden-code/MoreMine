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
 * Süre admin panelinden rol bazlı ayarlanır (Supabase 'ayarlar' tablosu).
 */

const VARSAYILAN = { admin: 60, kullanici: 15 };
const GERI_SAYIM_SANIYE = 8;

export const ANAHTAR = {
  admin: 'guvenlik_dakika_admin',
  kullanici: 'guvenlik_dakika_kullanici',
};
export const OLAY_DEGISTI = 'moremine-guvenlik-degisti';
export const OLAY_TEST = 'moremine-guvenlik-test';

/*
 * Ayarlar Supabase'deki "ayarlar" tablosunda tutuluyor, localStorage'da DEĞİL.
 * Sebep: localStorage tarayıcıya özeldir. Admin kendi tarayıcısında bir süre
 * ayarlasa bile o ayar kullanıcılara hiç ulaşmazdı — rol bazlı ayrım da
 * bu yüzden imkânsızdı.
 */

export async function guvenlikSurelerimiOku() {
  const { data, error } = await supabase
    .from('ayarlar')
    .select('anahtar, deger')
    .in('anahtar', [ANAHTAR.admin, ANAHTAR.kullanici]);

  const sonuc = { admin: VARSAYILAN.admin, kullanici: VARSAYILAN.kullanici };
  if (error || !data) return sonuc;

  for (const satir of data) {
    const sayi = parseInt(satir.deger, 10);
    if (!Number.isFinite(sayi) || sayi <= 0) continue;
    if (satir.anahtar === ANAHTAR.admin) sonuc.admin = sayi;
    if (satir.anahtar === ANAHTAR.kullanici) sonuc.kullanici = sayi;
  }
  return sonuc;
}

export async function guvenlikSuresiniYaz(rolAnahtari, dakika) {
  const sayi = Math.max(1, Math.min(240, parseInt(dakika, 10) || VARSAYILAN.kullanici));
  const { error } = await supabase
    .from('ayarlar')
    .upsert(
      { anahtar: rolAnahtari, deger: String(sayi), guncelleme: new Date().toISOString() },
      { onConflict: 'anahtar' },
    );
  if (error) throw new Error(error.message);
  window.dispatchEvent(new CustomEvent(OLAY_DEGISTI));
  return sayi;
}

/*
 * ALARM SESİ
 * ----------
 * Harici ses dosyası kullanmıyoruz — Web Audio API ile sentezleniyor.
 * Sebep: dosya barındırmak, yüklenme gecikmesi ve deploy'a ek yük yok;
 * ayrıca tarayıcı önbelleğine takılıp sessiz kalma riski ortadan kalkıyor.
 *
 * Ses: iki tonlu siren (yükselen-alçalan), saniyede bir tekrar.
 */
function sirenBaslat() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;

  let ctx;
  try {
    ctx = new AudioCtx();
  } catch {
    return null;
  }

  // Tarayıcılar kullanıcı etkileşimi olmadan sesi askıya alabilir.
  // resume() denenip başarısız olursa sessizce geçiyoruz — alarmın
  // görsel kısmı zaten çalışıyor.
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});

  const anaSes = ctx.createGain();
  anaSes.gain.value = 0.18;          // rahatsız etmeyecek ama fark edilir seviye
  anaSes.connect(ctx.destination);

  let durduruldu = false;
  let zamanlayici = null;

  const birBip = (frekans, baslangic, sure) => {
    const osilator = ctx.createOscillator();
    const kazanc = ctx.createGain();
    osilator.type = 'square';        // keskin, alarm karakteri
    osilator.frequency.setValueAtTime(frekans, baslangic);

    // Ani başlangıç/bitiş "tık" sesi yapar; kısa rampa ile yumuşatıyoruz
    kazanc.gain.setValueAtTime(0, baslangic);
    kazanc.gain.linearRampToValueAtTime(1, baslangic + 0.02);
    kazanc.gain.setValueAtTime(1, baslangic + sure - 0.03);
    kazanc.gain.linearRampToValueAtTime(0, baslangic + sure);

    osilator.connect(kazanc);
    kazanc.connect(anaSes);
    osilator.start(baslangic);
    osilator.stop(baslangic + sure);
  };

  const dongu = () => {
    if (durduruldu) return;
    const simdi = ctx.currentTime;
    birBip(880, simdi, 0.28);           // yüksek ton
    birBip(620, simdi + 0.30, 0.28);    // alçak ton
    zamanlayici = setTimeout(dongu, 720);
  };

  dongu();

  return () => {
    durduruldu = true;
    if (zamanlayici) clearTimeout(zamanlayici);
    try { ctx.close(); } catch { /* zaten kapalı */ }
  };
}

export function guvenlikAlarmiTestEt() {
  window.dispatchEvent(new CustomEvent(OLAY_TEST));
}

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

export default function GuvenlikKatmani({ rol = 'kullanici' }) {
  const adminMi = rol === 'admin';
  // null = henüz okunmadı; okunmadan sayaç başlatmıyoruz ki yanlış süreyle
  // erken alarm çalmasın.
  const [dakika, setDakika] = useState(null);
  const [alarm, setAlarm] = useState(false);
  // Ses tercihi cihaz bazlı: kullanıcı sessize almak isteyebilir.
  const [sesAcik, setSesAcik] = useState(
    () => localStorage.getItem('moremine_alarm_sesi') !== 'kapali',
  );
  const [kalan, setKalan] = useState(GERI_SAYIM_SANIYE);
  const sayacRef = useRef(null);

  // --- Süreyi Supabase'den oku (rol'e göre) ---
  const sureyiYukle = useCallback(async () => {
    const sureler = await guvenlikSurelerimiOku();
    setDakika(adminMi ? sureler.admin : sureler.kullanici);
  }, [adminMi]);

  useEffect(() => { sureyiYukle(); }, [sureyiYukle]);

  // --- Admin panelinden gelen değişiklikleri dinle ---
  // Sayfayı yenilemeden süre değişikliği ve test tetiklemesi çalışsın diye.
  useEffect(() => {
    const sureDegisti = () => { sureyiYukle(); };
    const testIste = () => setAlarm(true);

    window.addEventListener(OLAY_DEGISTI, sureDegisti);
    window.addEventListener(OLAY_TEST, testIste);
    return () => {
      window.removeEventListener(OLAY_DEGISTI, sureDegisti);
      window.removeEventListener(OLAY_TEST, testIste);
    };
  }, [sureyiYukle]);

  // --- Ana süre sayacı ---
  useEffect(() => {
    if (alarm || dakika == null) return;
    const zamanlayici = setTimeout(() => setAlarm(true), dakika * 60 * 1000);
    return () => clearTimeout(zamanlayici);
  }, [dakika, alarm]);

  // --- Alarm geri sayımı ve çıkış ---
  useEffect(() => {
    if (!alarm) return;

    const sesiDurdur = sesAcik ? sirenBaslat() : null;

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

    return () => {
      clearInterval(sayacRef.current);
      if (sesiDurdur) sesiDurdur();
    };
  }, [alarm, sesAcik]);

  return (
    <>
      <style>{ANIMASYON_CSS}</style>

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

            <button
              onClick={() => {
                const yeni = !sesAcik;
                setSesAcik(yeni);
                localStorage.setItem('moremine_alarm_sesi', yeni ? 'acik' : 'kapali');
              }}
              style={{
                marginTop: 20, padding: '7px 16px', borderRadius: 20,
                border: '1px solid rgba(255,255,255,0.35)',
                background: 'rgba(0,0,0,0.3)', color: '#fff',
                cursor: 'pointer', fontSize: 12,
              }}
            >
              {sesAcik ? '🔊 Sesi kapat' : '🔇 Sesi aç'}
            </button>

            <div style={{
              marginTop: 16, color: 'rgba(255,255,255,0.6)',
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
