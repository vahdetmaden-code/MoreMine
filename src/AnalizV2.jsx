import { useState, useCallback } from 'react';
import { GeoJSON } from 'react-leaflet';
import { supabase } from './supabaseClient';

/*
 * ANALİZ v2 PANELİ
 * ----------------
 * Kendi içinde kapalıdır. App.jsx'teki mevcut analiz akışına dokunmaz.
 * v1 ve v2 sonuçlarını AYNI ANDA haritada görebilir, karşılaştırabilirsin.
 *
 * v2 poligonları kesikli çizgiyle çizilir ki v1'inkilerden ayırt edilsin.
 */

const MINERALLER = [
  { deger: 'altin', etiket: 'Altın' },
  { deger: 'bakir', etiket: 'Bakır' },
  { deger: 'demir', etiket: 'Demir' },
  { deger: 'genel', etiket: 'Genel' },
];

const HASSASIYETLER = [
  { deger: 'yuksek', etiket: 'Yüksek', aciklama: 'Bölgenin üst %30\'u — çok sinyal' },
  { deger: 'orta', etiket: 'Orta', aciklama: 'Bölgenin üst %15\'i — varsayılan' },
  { deger: 'dusuk', etiket: 'Düşük', aciklama: 'Bölgenin üst %7\'si — en güçlüler' },
];

const SINIF_RENK = { 1: '#22c55e', 2: '#eab308', 3: '#f97316', 4: '#dc2626' };
const SINIF_AD = { 1: 'Zayıf', 2: 'Orta', 3: 'Güçlü', 4: 'Çok güçlü' };

function v2Stil(feature) {
  const sinif = feature.properties.sinif || 1;
  return {
    color: SINIF_RENK[sinif] || '#22c55e',
    weight: 2.5,
    dashArray: '5 3',        // v1'den ayırt etmek için kesikli
    fillColor: SINIF_RENK[sinif] || '#22c55e',
    fillOpacity: 0.35,
  };
}

function v2Bilgi(feature, layer) {
  const p = feature.properties;
  const kararlilikYuzde = Math.round((p.kararlilik || 0) * 100);
  layer.bindTooltip(
    `<b>v2 — ${SINIF_AD[p.sinif] || p.sinif}</b><br/>` +
    `Skor: ${(p.skor || 0).toFixed(3)}<br/>` +
    `Zamansal kararlılık: %${kararlilikYuzde}<br/>` +
    `Alan: ${Math.round(p.alan_m2 || 0).toLocaleString('tr-TR')} m²<br/>` +
    `<i>${kararlilikYuzde >= 60
      ? 'Farklı tarihlerde ısrarla çıkıyor — jeolojik olma ihtimali yüksek.'
      : 'Az sayıda görüntüde çıkıyor — geçici yüzey etkisi olabilir.'}</i>`
  );
}

export default function AnalizV2({ ciziliAlan }) {
  const [acik, setAcik] = useState(false);
  const [mineral, setMineral] = useState('altin');
  const [tarimMaskesi, setTarimMaskesi] = useState(true);
  const [yerlesimMaskesi, setYerlesimMaskesi] = useState(true);
  const [hassasiyet, setHassasiyet] = useState('orta');
  const [gorunur, setGorunur] = useState(true);
  const [sonuc, setSonuc] = useState(null);
  const [yukleniyor, setYukleniyor] = useState(false);
  const [hata, setHata] = useState(null);

  const alanHazir = Array.isArray(ciziliAlan) && ciziliAlan.length >= 3;

  const analizEt = useCallback(async () => {
    if (!alanHazir) {
      setHata('Önce haritada bir alan çiz.');
      return;
    }
    setYukleniyor(true);
    setHata(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Oturum bulunamadı, tekrar giriş yap.');

      const yanit = await fetch('/api/analyze_v2', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          koordinatlar: ciziliAlan,
          hedef_mineral: mineral,
          tarim_maskesi: tarimMaskesi,
          yerlesim_maskesi: yerlesimMaskesi,
          hassasiyet: hassasiyet,
        }),
      });

      // Vercel, fonksiyon zaman aşımına uğradığında JSON değil düz metin
      // hata sayfası döndürüyor. Doğrudan .json() çağırmak o durumda
      // "Unexpected token 'A'" gibi anlamsız bir hata veriyordu.
      const metin = await yanit.text();
      let gelen;
      try {
        gelen = JSON.parse(metin);
      } catch {
        if (yanit.status === 504 || /timeout|timed out/i.test(metin)) {
          throw new Error(
            'Analiz zaman aşımına uğradı. Çizdiğin alan çok büyük olabilir — ' +
            'daha küçük bir alan deneyebilirsin.'
          );
        }
        throw new Error(
          `Sunucu beklenmeyen bir yanıt döndü (HTTP ${yanit.status}). ` +
          'Alanı küçültüp tekrar dene.'
        );
      }
      if (!gelen.basarili) throw new Error(gelen.hata || 'Bilinmeyen hata');
      setSonuc(gelen);
    } catch (e) {
      setHata(e.message);
      setSonuc(null);
    } finally {
      setYukleniyor(false);
    }
  }, [ciziliAlan, alanHazir, mineral, tarimMaskesi, yerlesimMaskesi, hassasiyet]);

  const poligonSayisi = sonuc?.sonuc?.features?.length ?? 0;

  return (
    <>
      {sonuc && gorunur && poligonSayisi > 0 && (
        <GeoJSON
          key={`v2-${mineral}-${hassasiyet}-${poligonSayisi}-${tarimMaskesi}-${yerlesimMaskesi}`}
          data={sonuc.sonuc}
          style={v2Stil}
          onEachFeature={v2Bilgi}
        />
      )}

      <div style={{
        position: 'absolute', right: 12, bottom: 70, zIndex: 1000,
        background: 'rgba(15,23,42,0.94)', color: '#e2e8f0',
        borderRadius: 12, padding: acik ? 14 : 0,
        width: acik ? 290 : 'auto', fontSize: 13,
        boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
      }}>
        {!acik ? (
          <button
            onClick={() => setAcik(true)}
            style={{
              background: '#0891b2', color: '#fff', border: 'none',
              borderRadius: 12, padding: '10px 16px', cursor: 'pointer',
              fontSize: 13, fontWeight: 600,
            }}
          >
            🔬 Gelişmiş Analiz (v2)
          </button>
        ) : (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <b>🔬 Gelişmiş Analiz (v2)</b>
              <button
                onClick={() => setAcik(false)}
                style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 18 }}
              >×</button>
            </div>

            <label style={{ display: 'block', marginBottom: 4, color: '#94a3b8' }}>Hedef mineral</label>
            <select
              value={mineral}
              onChange={(e) => setMineral(e.target.value)}
              style={{
                width: '100%', padding: 7, borderRadius: 6, marginBottom: 10,
                background: '#1e293b', color: '#e2e8f0', border: '1px solid #334155',
              }}
            >
              {MINERALLER.map((m) => (
                <option key={m.deger} value={m.deger}>{m.etiket}</option>
              ))}
            </select>

            <label style={{ display: 'block', marginBottom: 4, color: '#94a3b8' }}>Hassasiyet</label>
            <select
              value={hassasiyet}
              onChange={(e) => setHassasiyet(e.target.value)}
              style={{
                width: '100%', padding: 7, borderRadius: 6, marginBottom: 4,
                background: '#1e293b', color: '#e2e8f0', border: '1px solid #334155',
              }}
            >
              {HASSASIYETLER.map((h) => (
                <option key={h.deger} value={h.deger}>{h.etiket}</option>
              ))}
            </select>
            <div style={{ fontSize: 11, color: '#64748b', marginBottom: 10 }}>
              {HASSASIYETLER.find((h) => h.deger === hassasiyet)?.aciklama}
            </div>

            <div style={{ marginBottom: 10 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5, cursor: 'pointer' }}>
                <input type="checkbox" checked={tarimMaskesi} onChange={(e) => setTarimMaskesi(e.target.checked)} />
                <span>Ekili tarım alanını ele</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer' }}>
                <input type="checkbox" checked={yerlesimMaskesi} onChange={(e) => setYerlesimMaskesi(e.target.checked)} />
                <span>Yapılaşmayı ele</span>
              </label>
            </div>

            <button
              onClick={analizEt}
              disabled={yukleniyor || !alanHazir}
              style={{
                width: '100%', padding: 9, borderRadius: 8, border: 'none',
                background: yukleniyor || !alanHazir ? '#475569' : '#0891b2',
                color: '#fff', cursor: yukleniyor || !alanHazir ? 'not-allowed' : 'pointer',
                fontWeight: 600, marginBottom: 10,
              }}
            >
              {yukleniyor ? 'Analiz ediliyor… (1-2 dk)' : 'v2 Analiz Yap'}
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

            {sonuc && (
              <>
                <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', marginBottom: 8 }}>
                  <input type="checkbox" checked={gorunur} onChange={(e) => setGorunur(e.target.checked)} />
                  <span>v2 sonucunu göster</span>
                </label>

                {sonuc.skor_dagilimi && (
                  <div style={{
                    borderTop: '1px solid #334155', paddingTop: 8, marginBottom: 8,
                    fontSize: 11, lineHeight: 1.7,
                  }}>
                    <b style={{ color: '#cbd5e1' }}>Teşhis</b>
                    <div style={{ color: '#64748b', marginBottom: 3 }}>
                      Eşikler çevredeki 25 km'lik bölgenin
                      %{sonuc.yuzdelikler?.[0]} diliminden alındı
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span>1. sınıf eşiği</span>
                      <b style={{ color: '#f59e0b' }}>{sonuc.esikler?.['1'] ?? '—'}</b>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span>Alandaki en yüksek</span>
                      <b style={{
                        color: (sonuc.skor_dagilimi.max ?? 0) >= (sonuc.esikler?.['1'] ?? 1)
                          ? '#22c55e' : '#dc2626',
                      }}>{sonuc.skor_dagilimi.max ?? '—'}</b>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', color: '#94a3b8' }}>
                      <span>Alan p99 / p90 / p50</span>
                      <span>
                        {sonuc.skor_dagilimi.p99 ?? '—'} / {sonuc.skor_dagilimi.p90 ?? '—'} / {sonuc.skor_dagilimi.p50 ?? '—'}
                      </span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', color: '#94a3b8' }}>
                      <span>Kararlılık (en yüksek)</span>
                      <span>%{Math.round((sonuc.kararlilik_dagilimi?.max ?? 0) * 100)}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span>Eşiği geçen piksel</span>
                      <b style={{ color: (sonuc.anomali_piksel ?? 0) > 0 ? '#22c55e' : '#dc2626' }}>
                        {(sonuc.anomali_piksel ?? 0).toLocaleString('tr-TR')}
                      </b>
                    </div>
                  </div>
                )}

                {poligonSayisi === 0 ? (
                  <div style={{
                    background: '#1e3a5f', padding: 9, borderRadius: 6,
                    fontSize: 11.5, lineHeight: 1.6, marginBottom: 8,
                  }}>
                    <b>Anomali bulunamadı.</b><br />
                    {sonuc.bos_sonuc_aciklamasi}
                  </div>
                ) : (
                  <div style={{
                    borderTop: '1px solid #334155', paddingTop: 8,
                    marginBottom: 8, fontSize: 11.5, lineHeight: 1.8,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span>Poligon</span><b>{poligonSayisi}</b>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span>Anomali pikseli</span><b>{(sonuc.anomali_piksel || 0).toLocaleString('tr-TR')}</b>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span>Analiz edilen zemin</span><b>{(sonuc.gecerli_piksel || 0).toLocaleString('tr-TR')}</b>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span>Kullanılan görüntü</span><b>{sonuc.goruntu_sayisi}</b>
                    </div>
                  </div>
                )}

                <div style={{
                  fontSize: 10.5, color: '#94a3b8', lineHeight: 1.6,
                  borderTop: '1px solid #334155', paddingTop: 8,
                }}>
                  v2 poligonları <b>kesikli çizgi</b> ile çizilir, v1'inkiler düz.
                  İkisini aynı anda açıp karşılaştırabilirsin.<br /><br />
                  <span style={{ color: '#cbd5e1' }}>
                    v2, çizilen alanı çevresindeki ~25 km'lik bölgeyle
                    karşılaştırır ve her görüntüyü ayrı kontrol eder. Bu yüzden
                    v1'den <b>çok daha az</b> poligon üretmesi beklenir —
                    elenenler çoğunlukla tarla sınırı ve geçici yüzey etkisidir.
                  </span>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}
