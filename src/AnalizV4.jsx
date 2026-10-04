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
 * DERİN TARAMA EFEKTİ
 * Leaflet vektörleri SVG olarak çizer, dolayısıyla SVG filtreleriyle
 * parlama verebiliyoruz. Filtre tanımlarını bir kez sayfaya enjekte edip
 * poligonlara className ile bağlıyoruz.
 */
const EFEKT_KIMLIGI = 'mm-v4-efekt';

function efektiEnjekteEt() {
  if (document.getElementById(EFEKT_KIMLIGI)) return;

  const stil = document.createElement('style');
  stil.id = EFEKT_KIMLIGI;
  stil.textContent = `
    @keyframes mm-v4-nabiz {
      0%, 100% { stroke-opacity: 1;    stroke-width: 3; }
      50%      { stroke-opacity: 0.55; stroke-width: 5; }
    }
    @keyframes mm-v4-tarama {
      0%   { stroke-dashoffset: 0; }
      100% { stroke-dashoffset: -36; }
    }
    .mm-v4-poligon {
      filter: url(#mm-v4-parlama);
    }
    .mm-v4-poligon.mm-v4-sinif-4 {
      animation: mm-v4-nabiz 1.8s ease-in-out infinite;
    }
    .mm-v4-poligon.mm-v4-sinif-3 {
      animation: mm-v4-nabiz 2.6s ease-in-out infinite;
    }
  `;
  document.head.appendChild(stil);

  // SVG filtre tanımı — haritanın kendi SVG'sine değil, ayrı gizli bir
  // SVG'ye koyuyoruz ki Leaflet yeniden çizdiğinde silinmesin.
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.style.position = 'absolute';
  svg.innerHTML = `
    <defs>
      <filter id="mm-v4-parlama" x="-60%" y="-60%" width="220%" height="220%">
        <feGaussianBlur in="SourceAlpha" stdDeviation="4" result="bulanik"/>
        <feFlood flood-color="#22d3ee" flood-opacity="0.75" result="renk"/>
        <feComposite in="renk" in2="bulanik" operator="in" result="hale"/>
        <feMerge>
          <feMergeNode in="hale"/>
          <feMergeNode in="SourceGraphic"/>
        </feMerge>
      </filter>
    </defs>`;
  document.body.appendChild(svg);
}

function v4Stil(feature) {
  const sinif = feature.properties.sinif || 1;
  const renk = RENKLER[String(sinif)] || '#22c55e';
  return {
    className: `mm-v4-poligon mm-v4-sinif-${sinif}`,
    color: renk,
    weight: sinif >= 3 ? 3.5 : 2.5,
    opacity: 1,
    fillColor: renk,
    // Güçlü sınıflar daha dolgun: haritada hemen göze çarpsın
    fillOpacity: sinif === 4 ? 0.55 : sinif === 3 ? 0.45 : 0.3,
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
      {gorunur && (filtre?.v4 !== false) && poligonSayisi > 0 && temizSonuc && (
        <GeoJSON
          key={`v4-${hassasiyet}-${poligonSayisi}-${yerlesimMaskesi}-${(filtre?.siniflar || []).join('')}`}
          data={temizSonuc}
          style={v4Stil}
          onEachFeature={v4Bilgi}
        />
      )}

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
                <span style={{ color: '#fbbf24' }}>
                  Parlama efekti görsel bir vurgudur, derinlik ölçümü değildir.
                  Optik uydu yalnızca <b>yüzey</b> imzasını görür; doğrulama
                  sahada yapılır.
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
