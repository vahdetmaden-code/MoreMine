import { useEffect, useRef, useState, useCallback } from 'react';
import { MapContainer, TileLayer, GeoJSON, useMap } from 'react-leaflet';
import L from 'leaflet';
import '@geoman-io/leaflet-geoman-free';
import { supabase } from './supabaseClient';

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

export default function App() {
  const [ciziliAlan, setCiziliAlan] = useState(null);
  const [sonuc, setSonuc] = useState(null);
  const [yukleniyor, setYukleniyor] = useState(false);
  const [hata, setHata] = useState(null);
  const [gecmis, setGecmis] = useState([]);
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

  const analizEt = async () => {
    if (!ciziliAlan || ciziliAlan.length < 3) {
      setHata('Önce haritada sol üstteki poligon/dikdörtgen aracıyla bir alan çiz.');
      return;
    }
    setYukleniyor(true);
    setHata(null);
    setSonuc(null);

    try {
      const { data: kayit, error: eklemeHatasi } = await supabase
        .from('taramalar')
        .insert({ koordinatlar: ciziliAlan, durum: 'İşleniyor' })
        .select()
        .single();

      if (eklemeHatasi) throw eklemeHatasi;

      const yanit = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: kayit.id, koordinatlar: ciziliAlan }),
      });

      const cevap = await yanit.json();

      if (!yanit.ok || !cevap.basarili) {
        throw new Error(cevap.hata || 'Analiz sırasında bilinmeyen bir hata oluştu.');
      }

      setSonuc(cevap.sonuc);
      gecmisiYukle();
    } catch (e) {
      console.error(e);
      setHata(e.message || String(e));
    } finally {
      setYukleniyor(false);
    }
  };

  const gecmisTaramayiAc = async (id) => {
    setHata(null);
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
      setHata('Bu tarama hatayla sonuçlanmıştı: ' + (data.hata_mesaji || ''));
      return;
    }
    setSonuc(data.sonuc);
  };

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw' }}>
      {/* SOL PANEL */}
      <div style={{ width: '320px', background: '#0f172a', color: 'white', padding: '20px', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
        <h2 style={{ marginTop: 0, fontSize: '18px' }}>Altın Alterasyon Taraması</h2>
        <p style={{ fontSize: '12px', color: '#94a3b8', lineHeight: 1.4 }}>
          Haritada sol üstteki araçlarla bir alan çiz, ardından "Analiz Et" butonuna bas.
          Sonuç, Sentinel-2 yüzey verisinden hesaplanan bir alterasyon anomalisidir;
          yer altı derinliği göstermez, sahada doğrulama gerektirir.
        </p>

        <button
          onClick={analizEt}
          disabled={yukleniyor}
          style={{
            padding: '12px', marginTop: '10px', background: yukleniyor ? '#475569' : '#2563eb',
            color: 'white', border: 'none', borderRadius: '8px', cursor: yukleniyor ? 'default' : 'pointer',
            fontSize: '14px', fontWeight: 600,
          }}
        >
          {yukleniyor ? 'Analiz Ediliyor... (biraz sürebilir)' : 'Analiz Et'}
        </button>

        {hata && (
          <div style={{ marginTop: '12px', padding: '10px', background: '#7f1d1d', borderRadius: '6px', fontSize: '12px' }}>
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
      <div style={{ flex: 1 }}>
        <MapContainer center={[40.97, 29.06]} zoom={14} style={{ height: '100%', width: '100%' }}>
          <TileLayer url="https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}" maxZoom={22} maxNativeZoom={20} />
          <CizimAraci onAlanCizildi={alanCizildi} />
          {sonuc && <GeoJSON key={JSON.stringify(sonuc).length} data={sonuc} style={geojsonStil} onEachFeature={ciziliAlaniGoster} />}
        </MapContainer>
      </div>
    </div>
  );
}
