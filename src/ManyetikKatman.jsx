import { useState, useCallback } from 'react';
import { GeoJSON } from 'react-leaflet';
import { supabase } from './supabaseClient';

/*
 * MANYETIK KATMAN
 * ---------------
 * Bu bileşen kendi içinde kapalıdır. App.jsx'teki mevcut optik analiz
 * akışının hiçbir parçasına dokunmaz; sadece haritanın üstüne kendi
 * katmanlarını ekler.
 *
 * İKİ AYRI KATMAN:
 *
 *   1) ÇERÇEVE KATMANI  — optik poligonların etrafına manyetik bağlamı
 *      gösteren bir kenar çizgisi çizer. Poligonun ŞEKLİ değişmez, dolgusu
 *      değişmez (o hâlâ optik veriden geliyor). Sadece kenarı manyetik
 *      bağlamı anlatır.
 *
 *   2) GRID KATMANI — gerçek manyetik hücreler, olduğu gibi, kare kare.
 *      Yumuşatma ve interpolasyon YOK. 3.7 km'lik kareler görünür kalır ki
 *      optik veriyle arasındaki ölçek farkı gözle anlaşılsın.
 */

// Manyetik bağlama göre kenar rengi
const BAGLAM_RENK = {
  'gradyan kusagi': '#a855f7',   // mor — yapısal sınır, altın/bakır için en ilginç
  'manyetik yuksek': '#0ea5e9',  // mavi — manyetit zengini
  'manyetik dusuk': '#64748b',   // gri-mavi — manyetit kaybı olabilir
  'notr': '#94a3b8',             // açık gri — kayda değer bir şey yok
  'veri yok': '#dc2626',         // kırmızı — o konumda manyetik veri yok
};

const BAGLAM_ETIKET = {
  'gradyan kusagi': 'Gradyan kuşağı (yapısal sınır)',
  'manyetik yuksek': 'Manyetik yüksek (manyetit zengini)',
  'manyetik dusuk': 'Manyetik düşük',
  'notr': 'Nötr',
  'veri yok': 'Manyetik veri yok',
};

const PROFILLER = [
  { deger: 'altin', etiket: 'Altın', aciklama: 'Gradyan ağırlıklı — fay ve kırık kuşakları' },
  { deger: 'bakir', etiket: 'Bakır', aciklama: 'Gradyan + manyetit çekirdeği dengeli' },
  { deger: 'demir', etiket: 'Demir', aciklama: 'Analitik sinyal ağırlıklı — kaynağın konumu' },
  { deger: 'krom', etiket: 'Krom', aciklama: 'Ultramafik kayaç imzası' },
  { deger: 'genel', etiket: 'Genel', aciklama: 'Dengeli tarama' },
];

// Skora göre grid hücresi rengi (düşük → yüksek)
function skorRengi(skor) {
  if (skor == null) return '#334155';
  if (skor >= 0.85) return '#7c3aed';
  if (skor >= 0.70) return '#a855f7';
  if (skor >= 0.55) return '#c084fc';
  if (skor >= 0.40) return '#ddd6fe';
  return '#e2e8f0';
}

function gridStil(feature) {
  return {
    color: '#475569',
    weight: 0.5,
    fillColor: skorRengi(feature.properties.skor),
    fillOpacity: 0.4,
  };
}

function gridBilgi(feature, layer) {
  const p = feature.properties;
  layer.bindTooltip(
    `<b>Manyetik hücre</b> (~3.7 km)<br/>` +
    `Anomali: ${p.anomali_nt} nT<br/>` +
    `Gradyan sırası: %${Math.round((p.gradyan_p || 0) * 100)}<br/>` +
    `Tilt: ${p.tilt_derece}°<br/>` +
    `Bağlam: ${BAGLAM_ETIKET[p.baglam] || p.baglam}<br/>` +
    `Skor: ${p.skor}`
  );
}

function cerceveStil(feature) {
  const baglam = feature.properties.manyetik_baglam;
  const belirgin = baglam === 'gradyan kusagi' || baglam === 'manyetik yuksek';
  // Kayda deger olmayan poligonlara da INCE bir cerceve ciziyoruz.
  // Aksi halde "manyetik olarak ilginc bir sey yok" ile "katman calismiyor"
  // birbirinden ayirt edilemiyor.
  return {
    color: BAGLAM_RENK[baglam] || '#94a3b8',
    weight: belirgin ? 4 : 1.5,
    opacity: belirgin ? 0.95 : 0.5,
    fill: false,           // dolgu YOK — dolgu optik katmanın işi
    dashArray: baglam === 'manyetik yuksek' ? '6 4' : null,
  };
}

function cerceveBilgi(feature, layer) {
  const p = feature.properties;
  if (!p.manyetik_baglam) return;
  layer.bindTooltip(
    `<b>${BAGLAM_ETIKET[p.manyetik_baglam] || p.manyetik_baglam}</b><br/>` +
    `Manyetik: ${p.manyetik_deger ?? '—'} nT<br/>` +
    `Birleşik skor: ${p.birlesik_skor ?? '—'}<br/>` +
    `<i>${p.yorum || ''}</i>`
  );
}

export default function ManyetikKatman({ ciziliAlan, optikSonuc, taramaId, acik = false, onKapat }) {
  const [profil, setProfil] = useState('altin');
  const [gridGorunur, setGridGorunur] = useState(true);
  const [cerceveGorunur, setCerceveGorunur] = useState(true);
  const [sonuc, setSonuc] = useState(null);
  const [yukleniyor, setYukleniyor] = useState(false);
  const [hata, setHata] = useState(null);

  // App.jsx'te ciziliAlan zaten [{lat, lng}, ...] dizisi olarak tutuluyor
  // (CizimAraci -> alanCizildi). API'nin beklediği biçim de bu, dönüşüm gerekmiyor.
  const alanHazir = Array.isArray(ciziliAlan) && ciziliAlan.length >= 3;

  const analizEt = useCallback(async () => {
    if (!alanHazir) {
      setHata('Önce haritada bir alan çiz (en az 3 köşe).');
      return;
    }
    setYukleniyor(true);
    setHata(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Oturum bulunamadı, tekrar giriş yap.');

      const yanit = await fetch('/api/analyze_manyetik', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          koordinatlar: ciziliAlan,
          tarama_id: taramaId || null,
          optik_sonuc: optikSonuc || null,
          hedef_profil: profil,
        }),
      });

      const gelen = await yanit.json();
      if (!gelen.basarili) throw new Error(gelen.hata || 'Bilinmeyen hata');
      setSonuc(gelen);
    } catch (e) {
      setHata(e.message);
      setSonuc(null);
    } finally {
      setYukleniyor(false);
    }
  }, [ciziliAlan, alanHazir, optikSonuc, taramaId, profil]);

  // Poligonların bağlam dağılımını say (panelde özet olarak gösterilir)
  const dagilim = (() => {
    const ozellikler = sonuc?.poligonlar?.features;
    if (!ozellikler || !ozellikler.length) return null;
    const sayilar = {};
    for (const o of ozellikler) {
      const ad = o.properties?.manyetik_baglam || 'bilinmiyor';
      sayilar[ad] = (sayilar[ad] || 0) + 1;
    }
    return { toplam: ozellikler.length, sayilar };
  })();

  return (
    <>
      {/* --- HARİTA KATMANLARI --- */}
      {sonuc && gridGorunur && sonuc.grid && (
        <GeoJSON
          key={`grid-${profil}-${sonuc.hucre_sayisi}`}
          data={sonuc.grid}
          style={gridStil}
          onEachFeature={gridBilgi}
        />
      )}
      {sonuc && cerceveGorunur && sonuc.poligonlar && (
        <GeoJSON
          key={`cerceve-${profil}-${sonuc.hucre_sayisi}`}
          data={sonuc.poligonlar}
          style={cerceveStil}
          onEachFeature={cerceveBilgi}
        />
      )}

      {/* --- KONTROL PANELİ --- */}
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
        {
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <b>🧲 Manyetik Analiz</b>
              <button
                onClick={() => onKapat && onKapat()}
                style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 18 }}
              >×</button>
            </div>

            <label style={{ display: 'block', marginBottom: 4, color: '#94a3b8' }}>Hedef profil</label>
            <select
              value={profil}
              onChange={(e) => setProfil(e.target.value)}
              style={{
                width: '100%', padding: 7, borderRadius: 6, marginBottom: 4,
                background: '#1e293b', color: '#e2e8f0', border: '1px solid #334155',
              }}
            >
              {PROFILLER.map((p) => (
                <option key={p.deger} value={p.deger}>{p.etiket}</option>
              ))}
            </select>
            <div style={{ fontSize: 11, color: '#64748b', marginBottom: 10 }}>
              {PROFILLER.find((p) => p.deger === profil)?.aciklama}
            </div>

            <button
              onClick={analizEt}
              disabled={yukleniyor || !alanHazir}
              style={{
                width: '100%', padding: 9, borderRadius: 8, border: 'none',
                background: yukleniyor || !alanHazir ? '#475569' : '#7c3aed',
                color: '#fff', cursor: yukleniyor || !alanHazir ? 'not-allowed' : 'pointer',
                fontWeight: 600, marginBottom: 10,
              }}
            >
              {yukleniyor ? 'Analiz ediliyor…' : 'Manyetik Analiz Yap'}
            </button>

            {!alanHazir && !hata && (
              <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 10 }}>
                Haritada bir alan çizince aktifleşir.
              </div>
            )}

            {hata && (
              <div style={{ background: '#7f1d1d', padding: 8, borderRadius: 6, marginBottom: 10, fontSize: 12 }}>
                {hata}
              </div>
            )}

            {sonuc && (
              <>
                <div style={{ borderTop: '1px solid #334155', paddingTop: 10, marginBottom: 8 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6, cursor: 'pointer' }}>
                    <input type="checkbox" checked={cerceveGorunur} onChange={(e) => setCerceveGorunur(e.target.checked)} />
                    <span>Optik poligon çerçeveleri</span>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer' }}>
                    <input type="checkbox" checked={gridGorunur} onChange={(e) => setGridGorunur(e.target.checked)} />
                    <span>Manyetik grid (gerçek boyut)</span>
                  </label>
                </div>

                {/* Poligonların hangi bağlama düştüğünü SAYI olarak göster.
                    Böylece "hiçbir şey vurgulanmadı" ile "katman çalışmadı"
                    birbirine karışmaz. */}
                {!optikSonuc ? (
                  <div style={{
                    background: '#78350f', padding: 8, borderRadius: 6,
                    marginBottom: 8, fontSize: 11.5, lineHeight: 1.5,
                  }}>
                    Optik tarama sonucu yok, bu yüzden çerçeve çizilemiyor.
                    Önce normal taramayı çalıştır, sonra manyetik analizi tekrarla.
                  </div>
                ) : dagilim && (
                  <div style={{
                    borderTop: '1px solid #334155', paddingTop: 8,
                    marginBottom: 8, fontSize: 11.5, lineHeight: 1.8,
                  }}>
                    <b style={{ color: '#cbd5e1' }}>Poligon dağılımı ({dagilim.toplam})</b>
                    {Object.entries(dagilim.sayilar).map(([ad, adet]) => (
                      <div key={ad} style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span>
                          <span style={{
                            display: 'inline-block', width: 10, height: 10,
                            borderRadius: 2, marginRight: 6,
                            background: BAGLAM_RENK[ad] || '#94a3b8',
                          }} />
                          {BAGLAM_ETIKET[ad] || ad}
                        </span>
                        <b>{adet}</b>
                      </div>
                    ))}
                    {dagilim.sayilar['gradyan kusagi'] === undefined &&
                     dagilim.sayilar['manyetik yuksek'] === undefined && (
                      <div style={{ color: '#f59e0b', marginTop: 6, lineHeight: 1.5 }}>
                        Bu alanda manyetik olarak öne çıkan poligon yok.
                        Katman çalışıyor — vurgulanacak bir şey bulamadı.
                        Daha geniş bir alan çizersen ayrışma görülebilir.
                      </div>
                    )}
                  </div>
                )}

                <div style={{ fontSize: 11, lineHeight: 1.7, marginBottom: 8 }}>
                  <div><span style={{ display: 'inline-block', width: 22, height: 3, background: '#a855f7', marginRight: 6, verticalAlign: 'middle' }} />Gradyan kuşağı — yapısal sınır</div>
                  <div><span style={{ display: 'inline-block', width: 22, height: 3, background: '#0ea5e9', marginRight: 6, verticalAlign: 'middle' }} />Manyetik yüksek — manyetit zengini</div>
                </div>

                <div style={{
                  fontSize: 10.5, color: '#94a3b8', lineHeight: 1.6,
                  borderTop: '1px solid #334155', paddingTop: 8,
                }}>
                  <b style={{ color: '#cbd5e1' }}>Veri:</b> {sonuc.veri_kaynagi}<br />
                  <b style={{ color: '#cbd5e1' }}>Hücre:</b> ~{(sonuc.hucre_boyu_m / 1000).toFixed(1)} km
                  ({sonuc.hucre_sayisi} adet)<br />
                  <span style={{ color: '#f59e0b' }}>
                    Manyetik veri optik analizden ~370 kat kabadır. Poligon şekilleri
                    optik veriden gelir; manyetik veri yalnızca bölgesel bağlam ekler.
                    Parsel ölçeğinde manyetik yorum için drone manyetometre uçuşu gerekir.
                  </span>
                </div>
              </>
            )}
          </>
        }
      </div>
      )}
    </>
  );
}
