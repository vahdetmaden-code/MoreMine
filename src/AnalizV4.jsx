import { useState, useCallback, useEffect } from 'react';
import { GeoJSON } from 'react-leaflet';
import { supabase } from './supabaseClient';
import { RENKLER, ETIKETLER, ONERILER } from './siniflar';

/*
 * ANALİZ v4 — BİRLEŞİK DOĞRULAMA
 * ------------------------------
 * v2'nin zamansal kararlılık kontrolü ile v3'ün mineral ayrımını TEK
 * motorda, piksel seviyesinde birleştirir. Bir alanın v4'te işaretlenmesi
 * için aynı anda hem demir–kil birlikteliğine sahip olması hem de bunu
 * birden fazla tarihte sürdürmesi gerekir.
 *
 * GÖRSEL EFEKT HAKKINDA DÜRÜST NOT:
 * Aşağıdaki parlama/derinlik efekti bir GÖRSEL STİLDİR. Sistem toprağın
 * altını görmüyor, göremez — optik uydu yüzeyi ölçer. Efekt poligonları
 * belirgin kılmak içindir, bir derinlik ölçümü değildir. Bu yüzden panelde
 * de açıkça yazılı: "yüzey imzası".
 */

const HASSASIYETLER = [
  { deger: 'yuksek', etiket: 'Yüksek', aciklama: 'Bölgenin üst %30\'u' },
  { deger: 'orta', etiket: 'Orta', aciklama: 'Bölgenin üst %15\'i — varsayılan' },
  { deger: 'dusuk', etiket: 'Düşük', aciklama: 'Bölgenin üst %7\'si' },
];

/*
 * DERİN TARAMA GÖRSELİ — JEOLOJİK KESİT
 * -------------------------------------
 * Her hedef, iç içe geçmiş DERİNLİK HALKALARI olarak çizilir: dıştan içe
 * doğru daralan 4 katman, en içteki en parlak. Bu, jeolojik kesit ve
 * sondaj logu haritalarının görsel diliyle aynı — bakan göz doğrudan
 * "aşağı doğru inen bir yapı" olarak okur.
 *
 * Halkalar, poligonun köşelerini kendi ağırlık merkezine doğru
 * ölçekleyerek üretiliyor. Gerçek bir buffer değil ama görsel olarak
 * istenen derinlik hissini veriyor ve her şekilde çalışıyor (gerçek
 * negatif buffer ince poligonları tamamen yok ederdi — v3'te bu sorunu
 * yaşamıştık).
 */

const HALKALAR = [
  { olcek: 1.00, katman: 0, dolguOpaklik: 0.14, cizgi: 2.0, parlaklik: 0.55 },
  { olcek: 0.74, katman: 1, dolguOpaklik: 0.20, cizgi: 1.4, parlaklik: 0.75 },
  { olcek: 0.50, katman: 2, dolguOpaklik: 0.28, cizgi: 1.2, parlaklik: 0.90 },
  { olcek: 0.27, katman: 3, dolguOpaklik: 0.62, cizgi: 1.6, parlaklik: 1.00 },
];

function halkaMerkezi(halka) {
  const n = Math.max(halka.length - 1, 1);
  let x = 0, y = 0;
  for (let i = 0; i < n; i++) { x += halka[i][0]; y += halka[i][1]; }
  return [x / n, y / n];
}

function halkayiKucult(halka, olcek) {
  const [cx, cy] = halkaMerkezi(halka);
  return halka.map(([x, y]) => [cx + (x - cx) * olcek, cy + (y - cy) * olcek]);
}

/*
 * Tek bir GeoJSON'u derinlik katmanlarına ayırır.
 * Dönen her katman ayrı bir GeoJSON; haritaya üst üste çizilince
 * iç içe halkalar oluşuyor.
 */
function derinlikKatmanlari(geojson) {
  if (!geojson?.features?.length) return [];

  return HALKALAR.map((h) => ({
    ayar: h,
    veri: {
      type: 'FeatureCollection',
      features: geojson.features.map((o) => {
        const g = o.geometry;
        let yeniGeo;
        if (g.type === 'Polygon') {
          yeniGeo = {
            type: 'Polygon',
            coordinates: [halkayiKucult(g.coordinates[0], h.olcek)],
          };
        } else if (g.type === 'MultiPolygon') {
          yeniGeo = {
            type: 'MultiPolygon',
            coordinates: g.coordinates.map((poly) => [halkayiKucult(poly[0], h.olcek)]),
          };
        } else {
          yeniGeo = g;
        }
        return { ...o, geometry: yeniGeo };
      }),
    },
  }));
}

const EFEKT_KIMLIGI = 'mm-v4-efekt';

function efektiEnjekteEt() {
  if (document.getElementById(EFEKT_KIMLIGI)) return;

  const stil = document.createElement('style');
  stil.id = EFEKT_KIMLIGI;
  stil.textContent = `
    @keyframes mm-v4-derinlik {
      0%, 100% { opacity: 0.80; }
      50%      { opacity: 1; }
    }
    @keyframes mm-v4-cekirdek {
      0%, 100% { opacity: 0.70; stroke-width: 1.4; }
      50%      { opacity: 1;    stroke-width: 2.6; }
    }
    @keyframes mm-v4-sondaj {
      0%   { stroke-dashoffset: 0; }
      100% { stroke-dashoffset: -28; }
    }
    /* Dış halkalar: yüzeye yakın katmanlar, sakin */
    .mm-v4-katman-0 { filter: url(#mm-v4-sis); }
    .mm-v4-katman-1 { filter: url(#mm-v4-sis); }
    /* İç halkalar: derinleştikçe parlar ve nabız atar */
    .mm-v4-katman-2 {
      filter: url(#mm-v4-parlama);
      animation: mm-v4-derinlik 3s ease-in-out infinite;
    }
    .mm-v4-katman-3 {
      filter: url(#mm-v4-cekirdek-parlama);
      animation: mm-v4-cekirdek 2.1s ease-in-out infinite;
    }
    /* Dış kontur: sondaj hattı gibi akan kesikli çizgi */
    .mm-v4-katman-0 path {
      stroke-dasharray: 7 5;
      animation: mm-v4-sondaj 2.6s linear infinite;
    }
  `;
  document.head.appendChild(stil);

  // Filtreler ayrı, gizli bir SVG'de duruyor ki Leaflet yeniden
  // çizdiğinde silinmesinler.
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.cssText = 'position:absolute;pointer-events:none';
  svg.innerHTML = `
    <defs>
      <!-- Jeolojik kesit tarama deseni: eğik çizgiler -->
      <pattern id="mm-v4-tarama-deseni" width="7" height="7"
               patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <line x1="0" y1="0" x2="0" y2="7"
              stroke="rgba(103,232,249,0.45)" stroke-width="1.6"/>
      </pattern>

      <!-- Yüzey katmanları: hafif, dağınık sis -->
      <filter id="mm-v4-sis" x="-40%" y="-40%" width="180%" height="180%">
        <feGaussianBlur in="SourceAlpha" stdDeviation="2.5" result="b"/>
        <feFlood flood-color="#0e7490" flood-opacity="0.5" result="r"/>
        <feComposite in="r" in2="b" operator="in" result="h"/>
        <feMerge><feMergeNode in="h"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>

      <!-- Orta derinlik: belirgin camgöbeği hale -->
      <filter id="mm-v4-parlama" x="-70%" y="-70%" width="240%" height="240%">
        <feGaussianBlur in="SourceAlpha" stdDeviation="5" result="b"/>
        <feFlood flood-color="#22d3ee" flood-opacity="0.85" result="r"/>
        <feComposite in="r" in2="b" operator="in" result="h"/>
        <feMerge><feMergeNode in="h"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>

      <!-- Çekirdek: iki katlı yoğun parlama, "sıcak nokta" hissi -->
      <filter id="mm-v4-cekirdek-parlama" x="-120%" y="-120%" width="340%" height="340%">
        <feGaussianBlur in="SourceAlpha" stdDeviation="10" result="genis"/>
        <feFlood flood-color="#22d3ee" flood-opacity="0.9" result="r1"/>
        <feComposite in="r1" in2="genis" operator="in" result="disHale"/>
        <feGaussianBlur in="SourceAlpha" stdDeviation="3" result="dar"/>
        <feFlood flood-color="#ffffff" flood-opacity="0.85" result="r2"/>
        <feComposite in="r2" in2="dar" operator="in" result="icHale"/>
        <feMerge>
          <feMergeNode in="disHale"/>
          <feMergeNode in="icHale"/>
          <feMergeNode in="SourceGraphic"/>
        </feMerge>
      </filter>
    </defs>`;
  document.body.appendChild(svg);
}

/*
 * Katman bazlı stil. Sınıf rengi KORUNUR — kullanıcının istediği gibi
 * renk kırılımı v1/v2/v3 ile aynı kalıyor; derinlik hissi opaklık,
 * parlama ve halka daralmasıyla veriliyor.
 */
function v4KatmanStili(ayar) {
  return (feature) => {
    const sinif = feature.properties.sinif || 1;
    const renk = RENKLER[String(sinif)] || '#22c55e';
    const guclu = sinif >= 3;

    return {
      className: `mm-v4-katman-${ayar.katman}`,
      color: ayar.katman === 3 ? '#e0f2fe' : renk,
      weight: ayar.cizgi * (guclu ? 1.25 : 1),
      opacity: ayar.parlaklik,
      // En dış halka: jeolojik kesit dokusu (eğik tarama çizgileri).
      // İç halkalar sınıf rengini taşır, böylece renk kırılımı korunur.
      fillColor: ayar.katman === 0 ? 'url(#mm-v4-tarama-deseni)' : renk,
      fillOpacity: ayar.katman === 0
        ? 0.5
        : ayar.dolguOpaklik * (guclu ? 1.15 : 0.8),
      // Tıklama/ipucu yalnızca en dış halkada olsun; iç halkalar
      // fare olaylarını yutmasın.
      interactive: ayar.katman === 0,
    };
  };
}

function alanYazi(m2) {
  if (!m2) return '—';
  if (m2 >= 1e6) return `${(m2 / 1e6).toFixed(2)} km²`;
  if (m2 >= 1e4) return `${(m2 / 1e4).toFixed(2)} ha`;
  return `${Math.round(m2).toLocaleString('tr-TR')} m²`;
}

function dengeHesapla(demir, kil) {
  const buyuk = Math.max(demir, kil);
  const kucuk = Math.min(demir, kil);
  return buyuk > 0 ? kucuk / buyuk : 0;
}

function v4Bilgi(feature, layer) {
  const p = feature.properties;
  const demir = p.demir ?? 0;
  const kil = p.kil ?? 0;
  const kararlilik = p.kararlilik ?? 0;
  const denge = dengeHesapla(demir, kil);

  // Yorum DENGEYE ve KARARLILIĞA bakar, mutlak yüksekliğe değil.
  // Sınıf bölgesel sıralamadan gelir; ikisi farklı ölçektir.
  let yorum;
  if (denge >= 0.7 && kararlilik >= 0.6) {
    yorum = 'Mineral birlikteliği dengeli ve zamanla kararlı — en güçlü hedef türü.';
  } else if (denge >= 0.7) {
    yorum = 'Mineral birlikteliği iyi, ancak az sayıda tarihte görünüyor.';
  } else if (kararlilik >= 0.6) {
    yorum = demir > kil
      ? 'Kalıcı sinyal ama demir baskın — alüvyon/toprak ihtimali var.'
      : 'Kalıcı sinyal ama kil baskın — alterasyonla ilgisiz killeşme olabilir.';
  } else {
    yorum = 'Hem denge hem kararlılık zayıf.';
  }

  layer.bindTooltip(
    `<b>v4 — ${ETIKETLER[String(p.sinif)] || p.sinif}</b><br/>` +
    `<span style="color:#475569;font-size:11px">Sınıf bölgesel sıralamadan gelir</span><br/>` +
    `<b>Alan: ${alanYazi(p.alan_m2)}</b><br/>` +
    `Demir oksit: ${(demir * 100).toFixed(0)}%<br/>` +
    `Kil (hidroksil): ${(kil * 100).toFixed(0)}%<br/>` +
    `Denge: ${(denge * 100).toFixed(0)}%<br/>` +
    `Zamansal kararlılık: ${(kararlilik * 100).toFixed(0)}%<br/>` +
    `<i>${yorum}</i>`
  );
}

export default function AnalizV4({
  ciziliAlan,
  filtre = null,
  tetikleyici = 0,
  onDurum = null,
  taramaId = null,
  disSonuc = null,
  onKaydedildi = null,
  onHedefeGit = null,
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

  useEffect(() => { efektiEnjekteEt(); }, []);
  useEffect(() => { if (disSonuc) setSonuc({ sonuc: disSonuc }); }, [disSonuc]);

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

      const yanit = await fetch('/api/analyze_v4', {
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
        toplam_alan_m2: gelen.toplam_alan_m2,
        sinif_alanlari: gelen.sinif_alanlari,
        ayrim: gelen.ayrim,
        crosta: gelen.crosta,
        esikler: gelen.esikler,
      });

      if (!taramaId) {
        setKayitNotu('Sonuç ekranda, ancak kaydedilmedi: önce normal (v1) taramayı çalıştır.');
      } else {
        const { error: kayitHatasi } = await supabase
          .from('taramalar')
          .update({ sonuc_v4: gelen.sonuc })
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

  useEffect(() => {
    if (tetikleyici > 0 && alanHazir) analizEt();
    // analizEt bilerek bağımlılıkta değil: ayar değişince yeniden tetiklenmesin
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tetikleyici]);

  const temizSonuc = (() => {
    const ham = sonuc?.sonuc;
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
  // Sunucu zaten sıralı gönderiyor; yine de güvenceye alalım
  const hedefler = (temizSonuc?.features || [])
    .slice()
    .sort((a, b) =>
      (b.properties.sinif - a.properties.sinif)
      || (b.properties.alan_m2 - a.properties.alan_m2));

  const toplamAlan = hedefler.reduce((t, o) => t + (o.properties.alan_m2 || 0), 0);

  return (
    <>
      {/*
        * Derinlik katmanları: dıştan içe 4 halka, üst üste çizilir.
        * Sıra önemli — dıştaki önce, çekirdek en son (en üstte).
        */}
      {gorunur && (filtre?.v4 !== false) && poligonSayisi > 0 && temizSonuc
        && derinlikKatmanlari(temizSonuc).map(({ ayar, veri }) => (
          <GeoJSON
            key={`v4-k${ayar.katman}-${hassasiyet}-${poligonSayisi}-${yerlesimMaskesi}-${(filtre?.siniflar || []).join('')}`}
            data={veri}
            style={v4KatmanStili(ayar)}
            onEachFeature={ayar.katman === 0 ? v4Bilgi : undefined}
          />
        ))}

      {acik && (
        <div style={{
          position: 'absolute', right: 12, bottom: 62, zIndex: 1000,
          maxHeight: 'calc(100vh - 150px)', overflowY: 'auto',
          WebkitOverflowScrolling: 'touch',
          background: 'rgba(8,15,30,0.96)', color: '#e2e8f0',
          border: '1px solid rgba(34,211,238,0.3)',
          borderRadius: 12, padding: 14,
          width: 'min(330px, calc(100vw - 24px))', fontSize: 13,
          boxShadow: '0 4px 24px rgba(0,0,0,0.5), 0 0 40px rgba(34,211,238,0.08)',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <b style={{ color: '#67e8f9' }}>◎ Derin Tarama (v4)</b>
            <button
              onClick={() => onKapat && onKapat()}
              style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 18 }}
            >×</button>
          </div>
          <div style={{ fontSize: 11, color: '#64748b', marginBottom: 10, lineHeight: 1.5 }}>
            Mineral birlikteliği <b>ve</b> zamansal kararlılık aynı anda aranır.
            İkisini birden geçen alanlar listelenir.
          </div>

          <label style={{ display: 'block', marginBottom: 4, color: '#94a3b8' }}>Hassasiyet</label>
          <select
            value={hassasiyet}
            onChange={(e) => setHassasiyet(e.target.value)}
            style={{
              width: '100%', padding: 7, borderRadius: 6, marginBottom: 4,
              background: '#0f1e33', color: '#e2e8f0', border: '1px solid #164e63',
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
              width: '100%', padding: 10, borderRadius: 8, border: 'none',
              background: yukleniyor || !alanHazir
                ? '#334155'
                : 'linear-gradient(135deg, #0891b2, #0e7490)',
              color: '#fff', cursor: yukleniyor || !alanHazir ? 'not-allowed' : 'pointer',
              fontWeight: 700, marginBottom: 10, letterSpacing: '0.3px',
              boxShadow: yukleniyor || !alanHazir ? 'none' : '0 0 20px rgba(34,211,238,0.25)',
            }}
          >
            {yukleniyor ? 'Derin tarama yapılıyor… (2-4 dk)' : '◎ Derin Taramayı Başlat'}
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

          {sonuc && (
            <>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 10 }}>
                <input
                  type="checkbox"
                  checked={gorunur}
                  onChange={(e) => setGorunur(e.target.checked)}
                  style={{ width: 17, height: 17 }}
                />
                <span>v4 sonucunu göster</span>
              </label>

              {sonuc.crosta?.supheli && (
                <div style={{
                  background: '#78350f', padding: 9, borderRadius: 6,
                  marginBottom: 10, fontSize: 11.5, lineHeight: 1.55,
                }}>
                  <b>Bileşen seçimi zayıf.</b><br />
                  Demir/kil sinyalleri net ayrışmadı (kil {sonuc.crosta.kil_guven},
                  demir {sonuc.crosta.demir_guven}). Sonuçlara temkinli yaklaş.
                </div>
              )}

              {/* ÖZET */}
              <div style={{
                background: 'rgba(8,51,68,0.5)', border: '1px solid #155e75',
                borderRadius: 8, padding: 10, marginBottom: 10,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
                  <span style={{ color: '#94a3b8' }}>Doğrulanmış hedef</span>
                  <b style={{ color: '#67e8f9', fontSize: 14 }}>{poligonSayisi}</b>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                  <span style={{ color: '#94a3b8' }}>Toplam alan</span>
                  <b style={{ color: '#67e8f9', fontSize: 14 }}>{alanYazi(toplamAlan)}</b>
                </div>
              </div>

              {/* SINIF BAZLI ALAN DAĞILIMI */}
              {sonuc.sinif_alanlari && Object.keys(sonuc.sinif_alanlari).length > 0 && (
                <div style={{ marginBottom: 10, fontSize: 11.5, lineHeight: 1.8 }}>
                  <b style={{ color: '#cbd5e1' }}>Sınıfa göre alan</b>
                  {[4, 3, 2, 1].map((s) => {
                    const m2 = sonuc.sinif_alanlari[String(s)];
                    if (!m2) return null;
                    return (
                      <div key={s} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                        <span>
                          <span style={{
                            display: 'inline-block', width: 10, height: 10, borderRadius: 2,
                            background: RENKLER[String(s)], marginRight: 6,
                          }} />
                          {ETIKETLER[String(s)]}
                        </span>
                        <b>{alanYazi(m2)}</b>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* HEDEF LİSTESİ — en güçlüden zayıfa */}
              {hedefler.length > 0 && (
                <div style={{ borderTop: '1px solid #164e63', paddingTop: 10, marginBottom: 10 }}>
                  <b style={{ color: '#cbd5e1', fontSize: 12 }}>
                    Hedefler ({Math.min(hedefler.length, 12)}
                    {hedefler.length > 12 ? ` / ${hedefler.length}` : ''})
                  </b>
                  <div style={{ marginTop: 6 }}>
                    {hedefler.slice(0, 12).map((o, i) => {
                      const p = o.properties;
                      const demir = p.demir ?? 0;
                      const kil = p.kil ?? 0;
                      const denge = dengeHesapla(demir, kil);
                      const toplam = demir + kil || 1;
                      return (
                        <div
                          key={i}
                          onClick={() => onHedefeGit && p.merkez_lat && onHedefeGit({
                            lat: p.merkez_lat, lng: p.merkez_lon,
                          })}
                          style={{
                            background: 'rgba(15,30,51,0.8)',
                            borderLeft: `3px solid ${RENKLER[String(p.sinif)]}`,
                            borderRadius: 6, padding: '7px 9px', marginBottom: 6,
                            cursor: onHedefeGit && p.merkez_lat ? 'pointer' : 'default',
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 6 }}>
                            <b style={{ fontSize: 11.5 }}>
                              {i + 1}. {ETIKETLER[String(p.sinif)]}
                            </b>
                            <b style={{ fontSize: 12, color: '#67e8f9' }}>{alanYazi(p.alan_m2)}</b>
                          </div>

                          {/* Demir / kil oranı — tek bakışta dengeyi göster */}
                          <div style={{ display: 'flex', height: 6, borderRadius: 3, overflow: 'hidden', margin: '5px 0 3px' }}>
                            <div style={{ width: `${(demir / toplam) * 100}%`, background: '#dc2626' }} />
                            <div style={{ width: `${(kil / toplam) * 100}%`, background: '#f59e0b' }} />
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: '#94a3b8' }}>
                            <span>Demir %{(demir * 100).toFixed(0)}</span>
                            <span>Kil %{(kil * 100).toFixed(0)}</span>
                            <span style={{ color: denge >= 0.7 ? '#4ade80' : '#94a3b8' }}>
                              Denge %{(denge * 100).toFixed(0)}
                            </span>
                          </div>
                          <div style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 2 }}>
                            Kararlılık %{((p.kararlilik ?? 0) * 100).toFixed(0)}
                            {p.merkez_lat && (
                              <span style={{ color: '#475569' }}>
                                {' · '}{p.merkez_lat.toFixed(4)}, {p.merkez_lon.toFixed(4)}
                              </span>
                            )}
                          </div>
                          {p.sinif >= 3 && (
                            <div style={{ fontSize: 10.5, color: '#fca5a5', marginTop: 3, lineHeight: 1.4 }}>
                              {ONERILER[String(p.sinif)]}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {onHedefeGit && (
                    <div style={{ fontSize: 10, color: '#475569' }}>
                      Hedefe tıklayınca harita oraya gider.
                    </div>
                  )}
                </div>
              )}

              {poligonSayisi === 0 && (
                <div style={{
                  background: '#1e3a5f', padding: 9, borderRadius: 6,
                  fontSize: 11.5, lineHeight: 1.6, marginBottom: 8,
                }}>
                  <b>Doğrulanmış hedef bulunamadı.</b><br />
                  Bu alanda hem mineral birlikteliği hem zamansal kararlılık
                  gösteren bir yer yok. v4'ün en katı motor olması beklenen
                  davranıştır — v2 veya v3 tek başına bir şey bulmuş olabilir.
                </div>
              )}

              <div style={{
                fontSize: 10.5, color: '#94a3b8', lineHeight: 1.6,
                borderTop: '1px solid #164e63', paddingTop: 8,
              }}>
                Kullanılan görüntü: {sonuc.goruntu_sayisi} ·
                Eşik: {sonuc.esikler?.['1']}<br /><br />
                <span style={{ color: '#64748b' }}>
                  İç içe halkalar hedefin <b>sinyal yoğunluğunu</b> gösterir:
                  çekirdek, imzanın en güçlü olduğu kısımdır. Ölçüm yüzeyden
                  yapılır; saha kontrolü kesin sonucu verir.
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
