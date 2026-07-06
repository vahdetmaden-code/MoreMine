import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

// Sınıf -> renk (2D lejant ile birebir aynı)
const RENK_ESLESME = [
  'match', ['get', 'sinif'],
  -1, '#9ca3af',
  0, '#1e3a8a',
  1, '#22c55e',
  2, '#facc15',
  3, '#f97316',
  4, '#ef4444',
  '#9ca3af',
];

// Sınıf -> görsel yükseklik (metre DEĞİL, sadece şiddeti vurgulayan bir çarpan)
const YUKSEKLIK_ESLESME = [
  'match', ['get', 'sinif'],
  -1, 0,
  0, 4,
  1, 15,
  2, 30,
  3, 50,
  4, 80,
  0,
];

function geojsonMerkeziBul(geojson) {
  let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
  let bulunduMu = false;

  const tara = (coords) => {
    if (typeof coords[0] === 'number') {
      const [lng, lat] = coords;
      bulunduMu = true;
      minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
      minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng);
    } else {
      coords.forEach(tara);
    }
  };

  (geojson.features || []).forEach((f) => f.geometry && tara(f.geometry.coordinates));

  if (!bulunduMu) return { lat: 41.0, lng: 29.0 };
  return { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 };
}

export default function Harita3D({ sonuc, onKapat }) {
  const kapsayiciRef = useRef(null);
  const haritaRef = useRef(null);

  useEffect(() => {
    if (!kapsayiciRef.current || !sonuc) return;
    const merkez = geojsonMerkeziBul(sonuc);

    const harita = new maplibregl.Map({
      container: kapsayiciRef.current,
      style: {
        version: 8,
        sources: {
          uydu: {
            type: 'raster',
            tiles: ['https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}'],
            tileSize: 256,
            attribution: '© Google',
          },
          'terrain-dem': {
            type: 'raster-dem',
            tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
            tileSize: 256,
            encoding: 'terrarium',
            maxzoom: 15,
          },
        },
        layers: [{ id: 'uydu-katmani', type: 'raster', source: 'uydu' }],
        terrain: { source: 'terrain-dem', exaggeration: 1.6 },
        sky: {},
      },
      center: [merkez.lng, merkez.lat],
      zoom: 15.5,
      pitch: 60,
      bearing: -20,
      maxPitch: 85,
      attributionControl: false,
    });

    haritaRef.current = harita;
    harita.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');

    harita.on('load', () => {
      harita.addSource('anomali', { type: 'geojson', data: sonuc });
      harita.addLayer({
        id: 'anomali-3d',
        type: 'fill-extrusion',
        source: 'anomali',
        paint: {
          'fill-extrusion-color': RENK_ESLESME,
          'fill-extrusion-height': YUKSEKLIK_ESLESME,
          'fill-extrusion-base': 0,
          'fill-extrusion-opacity': 0.82,
        },
      });
    });

    return () => harita.remove();
  }, [sonuc]);

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 4000, background: '#000' }}>
      <div ref={kapsayiciRef} style={{ width: '100%', height: '100%' }} />

      <div style={{
        position: 'absolute', top: 16, left: 16, zIndex: 10,
        background: 'rgba(15,23,42,0.92)', color: 'white', padding: '12px 16px',
        borderRadius: '10px', fontSize: '12px', maxWidth: '270px', lineHeight: 1.5,
        border: '1px solid #334155',
      }}>
        <strong>3D Görünüm</strong><br />
        Zemin şekli gerçek arazi yükseltisidir. Renkli bölgelerin <u>yüksekliği anomali
        şiddetini</u> vurgular — gerçek yer altı derinliğini göstermez.
      </div>

      <button onClick={onKapat} style={{
        position: 'absolute', top: 16, right: 60, zIndex: 10,
        background: '#334155', color: 'white', border: 'none', borderRadius: '8px',
        padding: '10px 16px', cursor: 'pointer', fontSize: '13px', fontWeight: 600,
      }}>
        ← 2D'ye Dön
      </button>
    </div>
  );
}
