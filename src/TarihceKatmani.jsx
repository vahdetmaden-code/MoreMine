import { useState, useCallback, useEffect } from 'react';
import { supabase } from './supabaseClient';

/*
 * TARİHSEL BAĞLAM KATMANI
 * -----------------------
 * Taranan bölgenin tarihi ve — asıl önemlisi — bilinen antik madencilik
 * faaliyeti hakkında özet gösterir.
 *
 * Neden değerli: eski madencilik faaliyeti cevherleşmenin en güvenilir
 * göstergelerinden biridir. Antik cüruf yığınları, Roma/Bizans galerileri,
 * Osmanlı maden kayıtları — bunlar cevher olduğu KANITLANMIŞ yerlerdir.
 * Optik anomali böyle bir kaydın üstüne oturuyorsa hedef güçlenir.
 *
 * Bileşen kendi içinde kapalıdır; App.jsx'in analiz akışına dokunmaz.
 */

const GUVEN_ETIKET = {
  yuksek: { ad: 'Bölgeye özgü kayıt bulundu', renk: '#22c55e' },
  orta: { ad: 'Kısmen bölgeye özgü', renk: '#eab308' },
  dusuk: { ad: 'Genel bilgi — bölgeye özgü kayıt zayıf', renk: '#f97316' },
};

export default function TarihceKatmani({ ciziliAlan, taramaId, konumAdi, disTarihce, acik = false, onKapat }) {
  const [tarihce, setTarihce] = useState(null);
  const [yukleniyor, setYukleniyor] = useState(false);
  const [hata, setHata] = useState(null);

  const alanHazir = Array.isArray(ciziliAlan) && ciziliAlan.length >= 3;

  // Geçmişten yüklenen kayıt varsa onu göster — yeniden sorgulamaya gerek yok
  useEffect(() => {
    setTarihce(disTarihce || null);
    setHata(null);
  }, [disTarihce]);

  const getir = useCallback(async () => {
    if (!alanHazir) {
      setHata('Önce haritada bir alan çiz.');
      return;
    }
    setYukleniyor(true);
    setHata(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Oturum bulunamadı.');

      const yanit = await fetch('/api/tarihce', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          koordinatlar: ciziliAlan,
          tarama_id: taramaId || null,
          konum_adi: konumAdi || null,
        }),
      });

      const metin = await yanit.text();
      let gelen;
      try {
        gelen = JSON.parse(metin);
      } catch {
        throw new Error(`Sunucu beklenmeyen yanıt döndü (HTTP ${yanit.status}).`);
      }
      if (!gelen.basarili) throw new Error(gelen.hata || 'Bilinmeyen hata');
      setTarihce(gelen.tarihce);
    } catch (e) {
      setHata(e.message);
    } finally {
      setYukleniyor(false);
    }
  }, [ciziliAlan, alanHazir, taramaId, konumAdi]);

  const guven = GUVEN_ETIKET[tarihce?.guven] || GUVEN_ETIKET.dusuk;

  if (!acik) return null;

  return (
    <div style={{
      position: 'absolute', right: 12, bottom: 62, zIndex: 1000,
      maxHeight: 'calc(100vh - 150px)', overflowY: 'auto',
      WebkitOverflowScrolling: 'touch',
      background: 'rgba(15,23,42,0.94)', color: '#e2e8f0',
      borderRadius: 12, padding: 14,
      width: 'min(300px, calc(100vw - 24px))', fontSize: 13,
      maxHeight: 'calc(100vh - 160px)',
      overflowY: acik ? 'auto' : 'visible',
      boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
      WebkitOverflowScrolling: 'touch',
    }}>
      {
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <b>📜 Tarihsel Bağlam</b>
            <button
              onClick={() => onKapat && onKapat()}
              style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 18 }}
            >×</button>
          </div>

          <button
            onClick={getir}
            disabled={yukleniyor || !alanHazir}
            style={{
              width: '100%', padding: 9, borderRadius: 8, border: 'none',
              background: yukleniyor || !alanHazir ? '#475569' : '#b45309',
              color: '#fff', cursor: yukleniyor || !alanHazir ? 'not-allowed' : 'pointer',
              fontWeight: 600, marginBottom: 10,
            }}
          >
            {yukleniyor ? 'Araştırılıyor…' : tarihce ? 'Yeniden araştır' : 'Bölgeyi araştır'}
          </button>

          {!alanHazir && !hata && (
            <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 10 }}>
              Haritada bir alan çizince aktifleşir.
            </div>
          )}

          {hata && (
            <div style={{ background: '#7f1d1d', padding: 8, borderRadius: 6, marginBottom: 10, fontSize: 11.5, lineHeight: 1.5 }}>
              {hata}
            </div>
          )}

          {tarihce && (
            <>
              {/* MADENCİLİK — en üstte, çünkü en değerli kısım */}
              {tarihce.madencilik && (
                <div style={{
                  background: 'rgba(180,83,9,0.22)', border: '1px solid #b45309',
                  borderRadius: 8, padding: 10, marginBottom: 10,
                }}>
                  <div style={{ fontWeight: 700, marginBottom: 5, color: '#fde68a', fontSize: 12 }}>
                    ⛏️ Tarihi Madencilik
                  </div>
                  <div style={{ fontSize: 12, lineHeight: 1.6 }}>{tarihce.madencilik}</div>
                </div>
              )}

              {tarihce.medeniyetler && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontWeight: 700, marginBottom: 4, fontSize: 12, color: '#cbd5e1' }}>
                    🏛️ Medeniyetler
                  </div>
                  <div style={{ fontSize: 12, lineHeight: 1.6 }}>{tarihce.medeniyetler}</div>
                </div>
              )}

              {tarihce.jeolojik_not && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontWeight: 700, marginBottom: 4, fontSize: 12, color: '#cbd5e1' }}>
                    🪨 Jeolojik Not
                  </div>
                  <div style={{ fontSize: 12, lineHeight: 1.6 }}>{tarihce.jeolojik_not}</div>
                </div>
              )}

              <div style={{
                borderTop: '1px solid #334155', paddingTop: 8, marginBottom: 8,
                fontSize: 11, display: 'flex', alignItems: 'center', gap: 6,
              }}>
                <span style={{
                  display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                  background: guven.renk, flexShrink: 0,
                }} />
                <span style={{ color: '#94a3b8' }}>{guven.ad}</span>
              </div>

              {tarihce.kaynaklar?.length > 0 && (
                <div style={{ fontSize: 10.5, lineHeight: 1.6, marginBottom: 8 }}>
                  <div style={{ color: '#cbd5e1', marginBottom: 3 }}>Kaynaklar</div>
                  {tarihce.kaynaklar.map((k, i) => (
                    <div key={i}>
                      <a
                        href={k.adres}
                        target="_blank"
                        rel="noreferrer"
                        style={{ color: '#7dd3fc', textDecoration: 'none' }}
                      >
                        {i + 1}. {k.baslik}
                      </a>
                    </div>
                  ))}
                </div>
              )}

              <div style={{
                fontSize: 10, color: '#94a3b8', lineHeight: 1.5,
                borderTop: '1px solid #334155', paddingTop: 8,
              }}>
                Yapay zeka ile web araması sonucu derlendi. Kritik bir bulgu
                varsa MTA veya yerel kayıtlardan teyit et.
              </div>
            </>
          )}
        </>
      }
    </div>
  );
}
