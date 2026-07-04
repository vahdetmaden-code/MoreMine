import { useEffect, useRef, useState, useCallback } from 'react';
import { MapContainer, TileLayer, GeoJSON, useMap } from 'react-leaflet';
import L from 'leaflet';
import '@geoman-io/leaflet-geoman-free';
import { supabase } from './supabaseClient';
import Giris from './Giris';
import AdminPaneli from './AdminPaneli';

// Sınıf değerine göre renk (motor.py / api/analyze.py ile birebir aynı olmalı)
const RENKLER = {
  '-1': '#9ca3af', // Analiz Dışı (su/bitki/yerleşim)
  '0': '#1e3a8a',  // Anomali Yok
  '1': '#22c55e',  // Zayıf
  '2': '#facc15',  // Orta
  '3': '#f97316',  // Güçlü
  '4': '#ef4444',  // Çok Güçlü
};

const ETIKETLER = {
  '-1': 'Analiz Dışı (su / bitki örtüsü / yerleşim)',
  '0': 'Anomali Yok',
  '1': 'Zayıf Anomali',
  '2': 'Orta Anomali',
  '3': 'Güçlü Anomali',
  '4': 'Çok Güçlü Anomali (öncelikli inceleme)',
};

function geojsonStil(feature) {
  const sinif = String(feature.properties.sinif);
  return {
    color: '#1e293b',
    weight: 1,
    fillColor: RENKLER[sinif] || '#9ca3af',
    fillOpacity: 0.55,
  };
}

function ciziliAlaniGoster(feature, layer) {
  const sinif = String(feature.properties.sinif);
  layer.bindTooltip(ETIKETLER[sinif] || 'Bilinmiyor');
}

// Haritaya çizim aracını (Geoman) ekleyen ve çizilen alanı üst bileşene bildiren yardımcı bileşen
function CizimAraci({ onAlanCizildi }) {
  const map = useMap();
  const kontrolEklendiRef = useRef(false);

  useEffect(() => {
    if (kontrolEklendiRef.current) return;
    kontrolEklendiRef.current = true;

    map.pm.addControls({
      position: 'topleft',
      drawMarker: false,
      drawCircle: false,
      drawCircleMarker: false,
      drawPolyline: false,
      drawRectangle: true,
      drawPolygon: true,
      editMode: true,
      dragMode: false,
      cutPolygon: false,
      removalMode: true,
    });

    map.on('pm:create', (e) => {
      const katman = e.layer;
      const koordinatlar = katman.getLatLngs()[0].map((nokta) => ({
        lat: nokta.lat,
        lng: nokta.lng,
      }));
      onAlanCizildi(koordinatlar, katman);
    });
  }, [map, onAlanCizildi]);

  return null;
}

// Sayfa açıldığında kullanıcının konumunu bulup haritayı oraya götüren bileşen
function KonumTespiti() {
  const map = useMap();

  useEffect(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (konum) => {
        map.flyTo([konum.coords.latitude, konum.coords.longitude], 15, { duration: 1.5 });
      },
      () => {
        // İzin verilmedi veya konum alınamadı -> varsayılan görünümde kal, sessizce geç
      },
      { enableHighAccuracy: false, timeout: 8000 }
    );
  }, [map]);

  return null;
}

function AnaUygulama({ oturum, rol }) {
  const [ciziliAlan, setCiziliAlan] = useState(null);
  const [sonuc, setSonuc] = useState(null);
  const [sonucGorunur, setSonucGorunur] = useState(true);
  const [yukleniyor, setYukleniyor] = useState(false);
  const [asama, setAsama] = useState('boşta'); // boşta | uyduGeliyor | taraniyor | tamamlandı
  const [hata, setHata] = useState(null);
  const [gecmis, setGecmis] = useState([]);
  const [adminPaneliAcik, setAdminPaneliAcik] = useState(false);
  const ciziliKatmanRef = useRef(null);

  const gecmisiYukle = useCallback(async () => {
    const { data, error } = await supabase
      .from('taramalar')
      .select('id, created_at, durum, koordinatlar, isim')
      .order('created_at', { ascending: false })
      .limit(20);
    if (!error) setGecmis(data);
  }, []);

  useEffect(() => {
    gecmisiYukle();
  }, [gecmisiYukle]);

  const alanCizildi = useCallback((koordinatlar, katman) => {
    // Önceki çizim varsa temizle (tek seferde bir alan)
    if (ciziliKatmanRef.current) {
      ciziliKatmanRef.current.remove();
    }
    ciziliKatmanRef.current = katman;
    setCiziliAlan(koordinatlar);
    setSonuc(null);
    setHata(null);
  }, []);

  const beklet = (ms) => new Promise((r) => setTimeout(r, ms));

  const taramayiBaslat = async () => {
    if (!ciziliAlan || ciziliAlan.length < 3) {
      setHata('Önce haritada sol üstteki poligon/dikdörtgen aracıyla bir alan çiz.');
      return;
    }
    setYukleniyor(true);
    setSonucGorunur(true);
    setHata(null);
    setSonuc(null);
    setAsama('uyduGeliyor');

    try {
      const { data: kayit, error: eklemeHatasi } = await supabase
        .from('taramalar')
        .insert({ koordinatlar: ciziliAlan, durum: 'İşleniyor', kullanici_id: oturum.user.id })
        .select()
        .single();

      if (eklemeHatasi) throw eklemeHatasi;

      // Uydunun konuma "yaklaştığı" animasyonu bir süre göster, sonra tarama evresine geç
      await beklet(1800);
      setAsama('taraniyor');

      const yanit = await fetch('/api/analyze', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${oturum.access_token}`,
        },
        body: JSON.stringify({ id: kayit.id, koordinatlar: ciziliAlan }),
      });

      const cevap = await yanit.json();

      if (!yanit.ok || !cevap.basarili) {
        throw new Error(cevap.hata || 'Analiz sırasında bilinmeyen bir hata oluştu.');
      }

      if (cevap.kayit_hatasi) {
        setHata('Sonuç ekranda gösteriliyor ama veritabanına KAYDEDİLEMEDİ: ' + cevap.kayit_hatasi);
      }

      setSonuc(cevap.sonuc);
      setAsama('tamamlandı');
      gecmisiYukle();
      await beklet(1400);
    } catch (e) {
      console.error(e);
      setHata(e.message || String(e));
    } finally {
      setYukleniyor(false);
      setAsama('boşta');
    }
  };

  const gecmisTaramayiAc = async (id) => {
    setHata(null);
    setSonuc(null);
    const { data, error } = await supabase
      .from('taramalar')
      .select('sonuc, durum, hata_mesaji')
      .eq('id', id)
      .single();

    if (error) {
      setHata('Kayıt okunamadı: ' + error.message);
      return;
    }
    if (data.durum === 'Hata') {
      setHata('Bu tarama hatayla sonuçlanmıştı: ' + (data.hata_mesaji || 'Detay yok.'));
      return;
    }
    if (data.durum !== 'Tamamlandı' || !data.sonuc) {
      setHata('Bu tarama tamamlanmamış görünüyor (muhtemelen eski, yarıda kalmış bir deneme). Silip yeniden deneyebilirsin.');
      return;
    }
    setSonuc(data.sonuc);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw' }}>

      {/* ÜST BAŞLIK ÇUBUĞU */}
      <div style={{
        height: '56px', minHeight: '56px', background: '#0b1220', borderBottom: '1px solid #1e293b',
        display: 'flex', alignItems: 'center', padding: '0 20px', gap: '12px',
      }}>
        <div style={{
          width: '32px', height: '32px', borderRadius: '8px',
          background: 'linear-gradient(135deg, #f59e0b, #ef4444)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontWeight: 800, fontSize: '15px', color: '#0b1220', flexShrink: 0,
        }}>
          M
        </div>
        <div style={{ lineHeight: 1.1 }}>
          <div style={{ color: 'white', fontWeight: 700, fontSize: '15px', letterSpacing: '0.5px' }}>MORE MINE</div>
          <div style={{ color: '#64748b', fontSize: '11px' }}>Uydu Alterasyon Taraması</div>
        </div>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{ color: '#94a3b8', fontSize: '12px' }}>{oturum.user.email}</div>
          {rol === 'admin' && (
            <button onClick={() => setAdminPaneliAcik(true)} style={{ fontSize: '12px', background: '#334155', color: 'white', border: 'none', borderRadius: '6px', padding: '6px 12px', cursor: 'pointer' }}>
              Admin Paneli
            </button>
          )}
          <button onClick={() => supabase.auth.signOut()} style={{ fontSize: '12px', background: 'transparent', color: '#94a3b8', border: '1px solid #334155', borderRadius: '6px', padding: '6px 12px', cursor: 'pointer' }}>
            Çıkış Yap
          </button>
        </div>
      </div>

      {adminPaneliAcik && <AdminPaneli onKapat={() => setAdminPaneliAcik(false)} />}

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* SOL PANEL */}
        <div style={{ width: '320px', background: '#0f172a', color: 'white', padding: '20px', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
          <h2 style={{ marginTop: 0, fontSize: '18px' }}>Uydu Alterasyon Taraması</h2>
          <p style={{ fontSize: '12px', color: '#94a3b8', lineHeight: 1.4 }}>
            Haritada sol üstteki araçlarla bir alan çiz, ardından "Taramayı Başlat" butonuna bas.
            Sonuç, Sentinel-2 yüzey verisinden hesaplanan bir alterasyon anomalisidir;
            yer altı derinliği göstermez, sahada doğrulama gerektirir.
          </p>

          <button
            onClick={taramayiBaslat}
            disabled={yukleniyor}
            style={{
              padding: '12px', marginTop: '10px', background: yukleniyor ? '#475569' : '#2563eb',
              color: 'white', border: 'none', borderRadius: '8px', cursor: yukleniyor ? 'default' : 'pointer',
              fontSize: '14px', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
            }}
          >
            {yukleniyor && <span className="donen-ikon" style={{ display: 'inline-block', width: '14px', height: '14px', border: '2px solid rgba(255,255,255,0.4)', borderTopColor: 'white', borderRadius: '50%' }} />}
            {yukleniyor ? 'Taranıyor...' : 'Taramayı Başlat'}
          </button>

          {sonuc && (
            <button
              onClick={() => setSonucGorunur((v) => !v)}
              style={{
                padding: '9px', marginTop: '8px', background: 'transparent', color: '#94a3b8',
                border: '1px solid #334155', borderRadius: '8px', cursor: 'pointer', fontSize: '12px',
              }}
            >
              {sonucGorunur ? 'Tarama Sonucunu Gizle' : 'Tarama Sonucunu Göster'}
            </button>
          )}

          {hata && (
            <div className="yumusak-giris" style={{ marginTop: '12px', padding: '10px', background: '#7f1d1d', borderRadius: '6px', fontSize: '12px' }}>
              {hata}
            </div>
          )}

          {/* LEJANT */}
          <div style={{ marginTop: '20px', borderTop: '1px solid #334155', paddingTop: '15px' }}>
            <h3 style={{ fontSize: '14px', margin: '0 0 10px 0' }}>Lejant</h3>
            {Object.entries(ETIKETLER).map(([sinif, etiket]) => (
              <div key={sinif} style={{ display: 'flex', alignItems: 'center', marginBottom: '8px' }}>
                <div style={{ width: '16px', height: '16px', backgroundColor: RENKLER[sinif], marginRight: '10px', borderRadius: '4px', flexShrink: 0 }} />
                <div style={{ fontSize: '12px' }}>{etiket}</div>
              </div>
            ))}
          </div>

          {/* GEÇMİŞ */}
          <div style={{ marginTop: '20px', borderTop: '1px solid #334155', paddingTop: '15px', flex: 1 }}>
            <h3 style={{ fontSize: '14px', margin: '0 0 10px 0' }}>Geçmiş Taramalar</h3>
            {gecmis.length === 0 && <div style={{ fontSize: '12px', color: '#64748b' }}>Henüz tarama yok.</div>}
            {gecmis.map((t) => (
              <div
                key={t.id}
                onClick={() => gecmisTaramayiAc(t.id)}
                style={{ padding: '8px', marginBottom: '6px', background: '#1e293b', borderRadius: '6px', cursor: 'pointer', fontSize: '12px' }}
              >
                <div>{new Date(t.created_at).toLocaleString('tr-TR')}</div>
                <div style={{ color: t.durum === 'Tamamlandı' ? '#4ade80' : t.durum === 'Hata' ? '#f87171' : '#fbbf24' }}>
                  {t.durum}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* HARİTA */}
        <div style={{ flex: 1, position: 'relative' }}>
          <MapContainer center={[40.97, 29.06]} zoom={14} style={{ height: '100%', width: '100%' }}>
            <TileLayer url="https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}" maxZoom={22} maxNativeZoom={20} />
            <KonumTespiti />
            <CizimAraci onAlanCizildi={alanCizildi} />
            {sonuc && sonucGorunur && <GeoJSON key={JSON.stringify(sonuc).length} data={sonuc} style={geojsonStil} onEachFeature={ciziliAlaniGoster} />}
          </MapContainer>

          {/* EVRE 1: UYDU KONUMA YÖNELİYOR */}
          {asama === 'uyduGeliyor' && (
            <div style={{
              position: 'absolute', inset: 0, background: 'rgba(2, 6, 23, 0.55)',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              zIndex: 2000, pointerEvents: 'none', overflow: 'hidden',
            }}>
              <div className="uydu-yolu">
                <span style={{ fontSize: '34px' }}>🛰️</span>
              </div>
              <div className="nabiz-metin" style={{ color: 'white', fontSize: '14px', fontWeight: 600, marginTop: '10px' }}>
                Uydu, seçilen konuma yönleniyor...
              </div>
            </div>
          )}

          {/* EVRE 2: TARAMA YAPILIYOR */}
          {asama === 'taraniyor' && (
            <div style={{
              position: 'absolute', inset: 0, background: 'rgba(2, 6, 23, 0.55)',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              zIndex: 2000, pointerEvents: 'none',
            }}>
              <div style={{ position: 'relative', width: '60px', height: '60px', marginBottom: '18px' }}>
                <div className="radar-halka" />
                <div className="radar-halka gecikmeli" />
              </div>
              <div className="nabiz-metin" style={{ color: 'white', fontSize: '14px', fontWeight: 600, letterSpacing: '0.3px' }}>
                Sentinel-2 verisi taranıyor...
              </div>
              <div style={{ color: '#94a3b8', fontSize: '12px', marginTop: '4px' }}>
                Bu işlem alanın büyüklüğüne göre biraz sürebilir
              </div>
            </div>
          )}

          {/* EVRE 3: TAMAMLANDI */}
          {asama === 'tamamlandı' && (
            <div className="yumusak-giris" style={{
              position: 'absolute', inset: 0, background: 'rgba(2, 6, 23, 0.35)',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              zIndex: 2000, pointerEvents: 'none',
            }}>
              <div style={{ fontSize: '30px', marginBottom: '8px' }}>✅</div>
              <div style={{ color: 'white', fontSize: '15px', fontWeight: 700 }}>Tarama Tamamlandı</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [oturum, setOturum] = useState(undefined); // undefined: henüz kontrol edilmedi, null: giriş yok
  const [rol, setRol] = useState('kullanici');

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setOturum(data.session));

    const { data: dinleyici } = supabase.auth.onAuthStateChange((_olay, yeniOturum) => {
      setOturum(yeniOturum);
    });

    return () => dinleyici.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!oturum) return;
    supabase.from('profiller').select('rol').eq('id', oturum.user.id).single()
      .then(({ data }) => setRol(data?.rol || 'kullanici'));
  }, [oturum]);

  if (oturum === undefined) {
    return (
      <div style={{ height: '100vh', width: '100vw', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#020617', color: '#64748b', fontSize: '13px' }}>
        Yükleniyor...
      </div>
    );
  }

  if (!oturum) {
    return <Giris />;
  }

  return <AnaUygulama oturum={oturum} rol={rol} />;
}
