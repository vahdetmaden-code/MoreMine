import { useState, useEffect, useCallback } from 'react';
import { GeoJSON } from 'react-leaflet';
import { supabase } from './supabaseClient';
import { RENKLER as SINIF_RENK, ETIKETLER as SINIF_AD, ONERILER as SINIF_ONERI, MINERAL_ETIKETLERI } from './siniflar';

/*
 * ANALİZ v3 PANELİ — Crósta PCA + demir/kil birlikteliği
 * -------------------------------------------------------
 * v3 poligonları NOKTALI çizgiyle çizilir:
 *   v1 → düz çizgi
 *   v2 → kesikli çizgi
 *   v3 → noktalı çizgi
 * Üçü aynı anda açık olabilir, karışmaz.
 */

const HASSASIYETLER = [
  { deger: 'yuksek', etiket: 'Yüksek', aciklama: 'Bölgenin üst %30\'u' },
  { deger: 'orta', etiket: 'Orta', aciklama: 'Bölgenin üst %15\'i — varsayılan' },
  { deger: 'dusuk', etiket: 'Düşük', aciklama: 'Bölgenin üst %7\'si' },
];


function v3Stil(feature) {
  const sinif = feature.properties.sinif || 1;
  return {
    color: SINIF_RENK[sinif] || '#22c55e',
    weight: 2.5,
    dashArray: '2 4',          // noktalı — v1/v2'den ayırt etmek için
    fillColor: SINIF_RENK[sinif] || '#22c55e',
    fillOpacity: 0.35,
  };
}

function v3Bilgi(feature, layer) {
  const p = feature.properties;
  const demir = p.demir ?? 0;
  const kil = p.kil ?? 0;

  /*
   * YORUM MANTIGI — DENGEYE bakar, mutlak yuksekliğe DEĞİL.
   *
   * Önceki sürümde sabit 0.6 eşiği kullanıyordum ve şöyle bir çelişki
   * çıkıyordu: sınıf "Çok Güçlü Etki" (bölgesel sıralamada en üst dilim)
   * ama yorum "her iki bileşen de zayıf" (0.6 eşiğinin altında).
   *
   * İkisi farklı ölçek:
   *   - SINIF     → bölgesel sıralama (bu bölgede ne kadar sıra dışı)
   *   - YÜZDELER  → mutlak normalize değer (0-1 arası ham güç)
   *
   * Zaten aradığımız şey mutlak yükseklik değil, demirin ve kilin
   * BİRLİKTE bulunmasıydı. Dolayısıyla yorum dengeye bakmalı:
   * %55 demir + %56 kil, %90 demir + %10 kil'den çok daha anlamlıdır.
   */
  const buyuk = Math.max(demir, kil);
  const kucuk = Math.min(demir, kil);
  const denge = buyuk > 0 ? kucuk / buyuk : 0;

  let yorum;
  let yorumRenk;
  if (denge >= 0.7) {
    yorum = 'Demir ve kil dengeli — alterasyon için beklenen birliktelik.';
    yorumRenk = '#166534';
  } else if (denge >= 0.45) {
    yorum = demir > kil
      ? 'Demir bir miktar baskın; kil yine de mevcut.'
      : 'Kil bir miktar baskın; demir yine de mevcut.';
    yorumRenk = '#854d0e';
  } else if (demir > kil) {
    yorum = 'Demir baskın, kil çok geride — demir/toprak/alüvyon ihtimali yüksek.';
    yorumRenk = '#7f1d1d';
  } else {
    yorum = 'Kil baskın, demir çok geride — alterasyonla ilgisiz killeşme olabilir.';
    yorumRenk = '#7f1d1d';
  }

  layer.bindTooltip(
    `<b>v3 — ${SINIF_AD[p.sinif] || p.sinif}</b><br/>` +
    `<span style="color:#475569;font-size:11px">Sınıf, bölgesel sıralamadan gelir</span><br/>` +
    `Demir oksit: ${(demir * 100).toFixed(0)}%<br/>` +
    `Kil (hidroksil): ${(kil * 100).toFixed(0)}%<br/>` +
    `<b>Denge: ${(denge * 100).toFixed(0)}%</b><br/>` +
    `<span style="color:${yorumRenk}"><i>${yorum}</i></span>`
  );
}

export default function AnalizV3({
  ciziliAlan,
  filtre = null,
  tetikleyici = 0,
  onDurum = null,
  taramaId = null,        // sonuç BU taramanın sonuc_v3 sütununa yazılır
  disSonuc = null,        // geçmişten yüklenen v3 GeoJSON'u
  onKaydedildi = null,
  acik = false,
  onKapat,
}) {
  const [hassasiyet, setHassasiyet] = useState('orta');
  const [yerlesimMaskesi, setYerlesimMaskesi] = useState(true);
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
    if (onDurum) onDurum({ durum: 'calisiyor' });
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Oturum bulunamadı.');

      const yanit = await fetch('/api/analyze_v3', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          koordinatlar: ciziliAlan,
          hassasiyet,
          yerlesim_maskesi: yerlesimMaskesi,
        }),
      });

      const metin = await yanit.text();
      let gelen;
      try {
        gelen = JSON.parse(metin);
      } catch {
        throw new Error(
          yanit.status === 504
            ? 'Analiz zaman aşımına uğradı. Daha küçük bir alan dene.'
            : `Sunucu beklenmeyen yanıt döndü (HTTP ${yanit.status}).`
        );
      }
      if (!gelen.basarili) throw new Error(gelen.hata || 'Bilinmeyen hata');
      setSonuc(gelen);
      if (onDurum) onDurum({
        durum: 'tamam',
        ozellikler: gelen.sonuc?.features || [],
        ayrim: gelen.ayrim,
        crosta: gelen.crosta,
        esikler: gelen.esikler,
      });

      /*
       * Sonucu mevcut taramanın sonuc_v3 sütununa yaz.
       * Ayrı tarama kaydı AÇILMAZ — tek tarama, üç sonuç (sonuc / sonuc_v2 / sonuc_v3).
       */
      if (!taramaId) {
        setKayitNotu('Sonuç ekranda, ancak kaydedilmedi: önce normal (v1) taramayı çalıştır.');
      } else {
        const { error: kayitHatasi } = await supabase
          .from('taramalar')
          .update({ sonuc_v3: gelen.sonuc })
          .eq('id', taramaId);
        if (kayitHatasi) {
          setKayitNotu('Analiz tamam, kaydedilemedi: ' + kayitHatasi.message);
        } else {
          setKayitNotu('Bu taramaya kaydedildi.');
          if (onKaydedildi) onKaydedildi();
          setTimeout(() => setKayitNotu(null), 4000);
        }
      }
    } catch (e) {
      setHata(e.message);
      setSonuc(null);
      if (onDurum) onDurum({ durum: 'hata', mesaj: e.message });
    } finally {
      setYukleniyor(false);
    }
  }, [ciziliAlan, alanHazir, hassasiyet, yerlesimMaskesi, onDurum, taramaId, onKaydedildi]);

  /*
   * OTOMATİK TETİKLEME
   * App.jsx "Taramayı Başlat" akışında v1 bittiğinde tetikleyiciyi artırır;
   * bu efekt onu görüp analizi kendiliğinden başlatır. Kullanıcı üç motoru
   * tek tuşla çalıştırabilsin diye.
   */
  useEffect(() => {
    if (tetikleyici > 0 && alanHazir) analizEt();
    // analizEt bilerek bağımlılıkta değil: ayar değişince yeniden tetiklenmesin
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tetikleyici]);

  const temizSonuc = (() => {
    const ham = sonuc?.sonuc || disSonuc;
    if (!ham?.features) return null;
    const noktaGecerli = (n) =>
      Array.isArray(n) && n.length >= 2
      && Number.isFinite(n[0]) && Number.isFinite(n[1])
      && n[0] >= -180 && n[0] <= 180 && n[1] >= -90 && n[1] <= 90;

    const gecerli = ham.features.filter((o) => {
      const g = o?.geometry;
      if (!g?.coordinates?.length) return false;
      if (g.type === 'Polygon') {
        const h = g.coordinates[0];
        return Array.isArray(h) && h.length >= 4 && h.every(noktaGecerli);
      }
      if (g.type === 'MultiPolygon') {
        return g.coordinates.some((p) =>
          Array.isArray(p?.[0]) && p[0].length >= 4 && p[0].every(noktaGecerli));
      }
      return false;
    });

    const siniflar = filtre?.siniflar;
    const suzulmus = Array.isArray(siniflar)
      ? gecerli.filter((o) => siniflar.includes(Number(o.properties?.sinif)))
      : gecerli;

    return { type: 'FeatureCollection', features: suzulmus };
  })();

  const poligonSayisi = temizSonuc?.features?.length ?? 0;
  const ayrim = sonuc?.ayrim;
  const toplamIsaretli = ayrim
    ? ayrim.demir_ve_kil + ayrim.sadece_demir + ayrim.sadece_kil
    : 0;

  return (
    <>
      {gorunur && (filtre?.v3 !== false) && poligonSayisi > 0 && temizSonuc && (
        <GeoJSON
          key={`v3-${hassasiyet}-${poligonSayisi}-${yerlesimMaskesi}-${(filtre?.siniflar || []).join('')}`}
          data={temizSonuc}
          style={v3Stil}
          onEachFeature={v3Bilgi}
        />
      )}

      {acik && (
        <div style={{
          position: 'absolute', right: 12, bottom: 62, zIndex: 1000,
          maxHeight: 'calc(100vh - 150px)', overflowY: 'auto',
          WebkitOverflowScrolling: 'touch',
          background: 'rgba(15,23,42,0.94)', color: '#e2e8f0',
          borderRadius: 12, padding: 14,
          width: 'min(300px, calc(100vw - 24px))', fontSize: 13,
          boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <b>⚗️ Mineral Ayrımı (v3)</b>
            <button
              onClick={() => onKapat && onKapat()}
              style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 18 }}
            >×</button>
          </div>
          <div style={{ fontSize: 11, color: '#64748b', marginBottom: 10, lineHeight: 1.5 }}>
            Crósta PCA ile demir oksit ve kil sinyalleri ayrı çıkarılır,
            sonra birlikteliğe bakılır.
          </div>

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

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={yerlesimMaskesi}
              onChange={(e) => setYerlesimMaskesi(e.target.checked)}
              style={{ width: 17, height: 17 }}
            />
            <span>Yapılaşmayı ele</span>
          </label>

          <button
            onClick={analizEt}
            disabled={yukleniyor || !alanHazir}
            style={{
              width: '100%', padding: 9, borderRadius: 8, border: 'none',
              background: yukleniyor || !alanHazir ? '#475569' : '#059669',
              color: '#fff', cursor: yukleniyor || !alanHazir ? 'not-allowed' : 'pointer',
              fontWeight: 600, marginBottom: 10,
            }}
          >
            {yukleniyor ? 'Analiz ediliyor… (1-3 dk)' : 'v3 Analiz Yap'}
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
              background: kayitNotu.startsWith('Bu taramaya') ? '#14532d' : '#78350f',
              padding: 8, borderRadius: 6, marginBottom: 10,
              fontSize: 11.5, lineHeight: 1.5,
            }}>
              {kayitNotu}
            </div>
          )}

          {(sonuc || disSonuc) && (
            <>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 10 }}>
                <input
                  type="checkbox"
                  checked={gorunur}
                  onChange={(e) => setGorunur(e.target.checked)}
                  style={{ width: 17, height: 17 }}
                />
                <span>v3 sonucunu göster</span>
              </label>

              {/* Bileşen seçimi şüpheliyse uyar */}
              {sonuc.crosta?.supheli && (
                <div style={{
                  background: '#78350f', padding: 9, borderRadius: 6,
                  marginBottom: 10, fontSize: 11.5, lineHeight: 1.55,
                }}>
                  <b>Bileşen seçimi zayıf.</b><br />
                  Bu alanda demir/kil sinyalleri birbirinden net ayrışmadı
                  (kil güven {sonuc.crosta.kil_guven}, demir güven {sonuc.crosta.demir_guven}).
                  Sonuçlara temkinli yaklaş; daha geniş veya daha çıplak bir
                  alan denemek ayrımı güçlendirebilir.
                </div>
              )}

              {/* AYRIM TABLOSU — v3'ün asıl cevabı */}
              {ayrim && toplamIsaretli > 0 && (
                <div style={{
                  borderTop: '1px solid #334155', paddingTop: 10, marginBottom: 10,
                  fontSize: 11.5, lineHeight: 1.8,
                }}>
                  <b style={{ color: '#cbd5e1' }}>Mineral ayrımı</b>
                  {[
                    { ad: 'Demir + kil (altın adayı)', deger: ayrim.demir_ve_kil, renk: '#22c55e' },
                    { ad: 'Sadece demir (elendi)', deger: ayrim.sadece_demir, renk: '#dc2626' },
                    { ad: 'Sadece kil (elendi)', deger: ayrim.sadece_kil, renk: '#f59e0b' },
                  ].map((s) => (
                    <div key={s.ad} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <span>
                        <span style={{
                          display: 'inline-block', width: 9, height: 9, borderRadius: 2,
                          background: s.renk, marginRight: 6,
                        }} />
                        {s.ad}
                      </span>
                      <b>%{Math.round((s.deger / toplamIsaretli) * 100)}</b>
                    </div>
                  ))}
                  <div style={{ color: '#94a3b8', marginTop: 6, fontSize: 10.5, lineHeight: 1.5 }}>
                    "Sadece demir" olan yerler v1/v2'de anomali çıkarırdı.
                    v3 onları eliyor — dere yatağı alüvyonu ve kırmızı toprak
                    tipik olarak buraya düşer.
                  </div>
                </div>
              )}

              <div style={{
                borderTop: '1px solid #334155', paddingTop: 8, marginBottom: 8,
                fontSize: 11.5, lineHeight: 1.8,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>Poligon</span><b>{poligonSayisi}</b>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>Analiz edilen zemin</span>
                  <b>{(ayrim?.gecerli_zemin ?? 0).toLocaleString('tr-TR')}</b>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>Kullanılan görüntü</span><b>{sonuc.goruntu_sayisi}</b>
                </div>
                {sonuc.crosta && (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', color: '#94a3b8' }}>
                      <span>Kil bileşeni</span>
                      <span>{sonuc.crosta.kil_bileseni} · varyans %{Math.round((sonuc.crosta.kil_varyans || 0) * 100)}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', color: '#94a3b8' }}>
                      <span>Demir bileşeni</span>
                      <span>{sonuc.crosta.demir_bileseni} · varyans %{Math.round((sonuc.crosta.demir_varyans || 0) * 100)}</span>
                    </div>
                  </>
                )}
              </div>

              <div style={{
                fontSize: 10.5, color: '#94a3b8', lineHeight: 1.6,
                borderTop: '1px solid #334155', paddingTop: 8,
              }}>
                v3 poligonları <b>noktalı çizgi</b> ile çizilir
                (v1 düz, v2 kesikli).<br /><br />
                <span style={{ color: '#cbd5e1' }}>
                  v3 zamansal kararlılık kontrolü YAPMAZ — o v2'nin işi.
                  En güçlü hedef, v2 ve v3'ün aynı yeri işaretlediği yerdir.
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
