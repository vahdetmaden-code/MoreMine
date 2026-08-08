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

const SINIF_RENK = { 1: '#22c55e', 2: '#facc15', 3: '#f97316', 4: '#ef4444' };

// Sınıf adları ve her sınıf için önerilen saha adımı.
// v1'deki RENKLER/ETIKETLER ile birebir aynı renk kodları kullanılıyor ki
// iki motorun çıktısı görsel olarak karşılaştırılabilsin.
const SINIF_AD = {
  1: 'Zayıf etki',
  2: 'Orta etki',
  3: 'Güçlü etki',
  4: 'Çok güçlü etki',
};

const SINIF_ONERI = {
  1: 'Kayda değer değil, geçilebilir.',
  2: 'Not al, çevresiyle birlikte değerlendir.',
  3: 'Saha ziyareti planla, yüzey örneği al.',
  4: 'Öncelikli saha kontrolü — altın tanıyan dedektörle incele.',
};

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
    `<span style="color:#7c2d12">${SINIF_ONERI[p.sinif] || ''}</span><br/>` +
    `Skor: ${(p.skor || 0).toFixed(3)}<br/>` +
    `Zamansal kararlılık: %${kararlilikYuzde}<br/>` +
    `Alan: ${Math.round(p.alan_m2 || 0).toLocaleString('tr-TR')} m²<br/>` +
    `<i>${kararlilikYuzde >= 60
      ? 'Farklı tarihlerde ısrarla çıkıyor — jeolojik olma ihtimali yüksek.'
      : 'Az sayıda görüntüde çıkıyor — geçici yüzey etkisi olabilir.'}</i>`
  );
}

export default function AnalizV2({
  ciziliAlan,
  onKaydedildi = null,
  filtre = null,          // { v2: bool, siniflar: number[] } — KatmanKontrol'den gelir
  taramaId = null,        // v2 sonucu BU taramanın içine yazılır, ayrı kayıt açılmaz
  disSonuc = null,        // geçmişten yüklenen v2 GeoJSON'u
}) {
  const [acik, setAcik] = useState(false);
  const [mineral, setMineral] = useState('altin');
  const [yerlesimMaskesi, setYerlesimMaskesi] = useState(true);
  const [hassasiyet, setHassasiyet] = useState('orta');
  const [gorunur, setGorunur] = useState(true);
  const [sonuc, setSonuc] = useState(null);
  const [yukleniyor, setYukleniyor] = useState(false);
  const [hata, setHata] = useState(null);
  const [kayitNotu, setKayitNotu] = useState(null);

  const alanHazir = Array.isArray(ciziliAlan) && ciziliAlan.length >= 3;

  const analizEt = useCallback(async () => {
    if (!alanHazir) {
      setHata('Önce haritada bir alan çiz.');
      return;
    }
    setYukleniyor(true);
    setHata(null);
    setKayitNotu(null);
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
          tarim_maskesi: false,
          yerlesim_maskesi: yerlesimMaskesi,
          hassasiyet: hassasiyet,
        }),
      });

      // Vercel, fonksiyon zaman aşımına uğradığında JSON değil düz metin
      // hata sayfası döndürüyor. Doğrudan .json() çağırmak o durumda
      // "Unexpected token 'A'" gibi anlamsız bir hata veriyordu.
      // --- Taramayı geçmişe kaydet ---
      // v1'le aynı tabloya (taramalar) yazıyoruz ki tek bir geçmiş listesi olsun.
      // Ayırt etmek için "motor" sütunu kullanılıyor ('v1' / 'v2').
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

      /*
       * KAYIT — ayrı bir tarama satırı AÇMIYORUZ.
       *
       * Önceki sürümde v2, taramalar tablosuna kendi satırını ekliyordu.
       * Sonuç: aynı alan geçmişte iki kez görünüyordu ve o kaydı açınca
       * App onu v1 sonucu sanıp v1 katmanına yüklüyordu — "v1'i işaretleyince
       * v2 verisi geliyor" sorununun sebebi buydu.
       *
       * Doğrusu: tek tarama, iki sonuç. v2 çıktısı mevcut taramanın
       * sonuc_v2 sütununa yazılıyor.
       */
      if (!taramaId) {
        setKayitNotu('Sonuç ekranda, ancak kaydedilmedi: önce normal (v1) taramayı çalıştır.');
      } else {
        try {
          const { error: kayitHatasi } = await supabase
            .from('taramalar')
            .update({ sonuc_v2: gelen.sonuc })
            .eq('id', taramaId);

          if (kayitHatasi) {
            setKayitNotu('Analiz tamam, ancak kaydedilemedi: ' + kayitHatasi.message);
          } else {
            setKayitNotu('Bu taramaya kaydedildi.');
            if (onKaydedildi) onKaydedildi();
            setTimeout(() => setKayitNotu(null), 4000);
          }
        } catch (kayitIstisna) {
          setKayitNotu('Analiz tamam, kayıt sırasında hata: ' + kayitIstisna.message);
        }
      }
    } catch (e) {
      setHata(e.message);
      setSonuc(null);
    } finally {
      setYukleniyor(false);
    }
  }, [ciziliAlan, alanHazir, mineral, yerlesimMaskesi, hassasiyet, taramaId, onKaydedildi]);

  /*
   * Leaflet'e verilmeden önce geometriyi TEMİZLE.
   *
   * Sunucu tarafında simplify() bazı ince poligonları boş/geçersiz
   * geometriye düşürebiliyor. Leaflet böyle bir şey görünce render
   * sırasında hata fırlatıyor ve React yakalanmamış hatada TÜM ağacı
   * söküyor — ekran bembeyaz kalıyor. Bu yüzden bozuk kayıtları
   * haritaya hiç göndermiyoruz.
   */
  const temizSonuc = (() => {
    // Yerel analiz sonucu varsa onu, yoksa geçmişten yüklenen v2 verisini göster.
    const ham = sonuc?.sonuc || disSonuc;
    if (!ham || !Array.isArray(ham.features)) return null;

    const gecerli = ham.features.filter((o) => {
      const g = o?.geometry;
      if (!g || !g.type || !Array.isArray(g.coordinates)) return false;
      if (g.coordinates.length === 0) return false;
      // Polygon: dış halka en az 4 nokta olmalı (kapalı halka)
      // Koordinat ARALIĞI da kontrol ediliyor, sadece "sayı mı" diye değil.
      // Bir poligonun koordinatı derece yerine metre cinsinden gelirse
      // (ör. EPSG:3857 değerleri) Leaflet onu dünya ölçeğinde devasa çizer
      // ve tüm harita o poligonun rengiyle kaplanır — "zemin sarı oldu"
      // sorununun sebebi buydu.
      const noktaGecerli = (n) =>
        Array.isArray(n) && n.length >= 2
        && Number.isFinite(n[0]) && Number.isFinite(n[1])
        && n[0] >= -180 && n[0] <= 180      // boylam
        && n[1] >= -90 && n[1] <= 90;       // enlem

      if (g.type === 'Polygon') {
        const halka = g.coordinates[0];
        return Array.isArray(halka) && halka.length >= 4 && halka.every(noktaGecerli);
      }
      if (g.type === 'MultiPolygon') {
        return g.coordinates.some((poly) =>
          Array.isArray(poly) && Array.isArray(poly[0])
          && poly[0].length >= 4 && poly[0].every(noktaGecerli));
      }
      return false;
    });

    // Katman kontrolünden gelen sınıf filtresini uygula
    const siniflar = filtre?.siniflar;
    const suzulmus = Array.isArray(siniflar)
      ? gecerli.filter((o) => siniflar.includes(Number(o.properties?.sinif)))
      : gecerli;

    return { type: 'FeatureCollection', features: suzulmus };
  })();

  const poligonSayisi = temizSonuc?.features?.length ?? 0;
  const elenenPoligon = (sonuc?.sonuc?.features?.length ?? 0) - poligonSayisi;

  return (
    <>
      {gorunur && (filtre?.v2 !== false) && poligonSayisi > 0 && temizSonuc && (
        <GeoJSON
          key={`v2-${mineral}-${hassasiyet}-${poligonSayisi}-${yerlesimMaskesi}-${(filtre?.siniflar || []).join('')}`}
          data={temizSonuc}
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

            {kayitNotu && (
              <div style={{
                background: kayitNotu.startsWith('Geçmişe') ? '#14532d' : '#78350f',
                padding: 8, borderRadius: 6, marginBottom: 10,
                fontSize: 11.5, lineHeight: 1.5,
              }}>
                {kayitNotu}
              </div>
            )}

            {(sonuc || disSonuc) && (
              <>
                <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', marginBottom: 8 }}>
                  <input type="checkbox" checked={gorunur} onChange={(e) => setGorunur(e.target.checked)} />
                  <span>v2 sonucunu göster</span>
                </label>

                <div style={{
                  borderTop: '1px solid #334155', paddingTop: 8,
                  marginBottom: 8, fontSize: 11, lineHeight: 1.6,
                }}>
                  <b style={{ color: '#cbd5e1' }}>Renk anlamları</b>
                  {[4, 3, 2, 1].map((sinif) => (
                    <div key={sinif} style={{ display: 'flex', gap: 7, alignItems: 'flex-start', marginTop: 4 }}>
                      <span style={{
                        display: 'inline-block', width: 12, height: 12, flexShrink: 0,
                        borderRadius: 3, marginTop: 2, background: SINIF_RENK[sinif],
                      }} />
                      <span>
                        <b style={{ color: sinif === 4 ? '#fca5a5' : '#e2e8f0' }}>{SINIF_AD[sinif]}</b>
                        <span style={{ color: '#94a3b8' }}> — {SINIF_ONERI[sinif]}</span>
                      </span>
                    </div>
                  ))}
                  <div style={{ display: 'flex', gap: 7, alignItems: 'center', marginTop: 4, color: '#94a3b8' }}>
                    <span style={{
                      display: 'inline-block', width: 12, height: 12, flexShrink: 0,
                      borderRadius: 3, background: '#1e3a8a',
                    }} />
                    <span>Anomali yok (yalnız v1 çizer)</span>
                  </div>
                </div>

                {sonuc.skor_dagilimi && (
                  <div style={{
                    borderTop: '1px solid #334155', paddingTop: 8, marginBottom: 8,
                    fontSize: 11, lineHeight: 1.7,
                  }}>
                    <b style={{ color: '#cbd5e1' }}>Teşhis</b>
                    {sonuc.ham_zemin > 0 && sonuc.gecerli_piksel / sonuc.ham_zemin < 0.25 && (
                      <div style={{
                        background: '#78350f', padding: 7, borderRadius: 5,
                        margin: '5px 0', lineHeight: 1.5,
                      }}>
                        <b>Maskeler alanın %{Math.round(100 - 100 * sonuc.gecerli_piksel / sonuc.ham_zemin)}'ini sildi.</b><br />
                        Çıplak zemin {sonuc.ham_zemin.toLocaleString('tr-TR')} pikseldi,
                        analiz {sonuc.gecerli_piksel.toLocaleString('tr-TR')} piksele düştü.
                        Sonuçlar bu küçük kalıntıya ait — v1 ile karşılaştırmak
                        anlamlı olmaz. Maskeleri kapatıp tekrar dene.
                      </div>
                    )}
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
                      <span>Analiz edilen zemin</span>
                      <b>
                        {(sonuc.gecerli_piksel || 0).toLocaleString('tr-TR')}
                        {sonuc.ham_zemin > 0 && (
                          <span style={{ color: '#94a3b8', fontWeight: 400 }}>
                            {' '}/ {sonuc.ham_zemin.toLocaleString('tr-TR')}
                          </span>
                        )}
                      </b>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span>Kullanılan görüntü</span><b>{sonuc.goruntu_sayisi}</b>
                    </div>
                    {elenenPoligon > 0 && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', color: '#f59e0b' }}>
                        <span>Bozuk geometri (atlandı)</span><b>{elenenPoligon}</b>
                      </div>
                    )}
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
