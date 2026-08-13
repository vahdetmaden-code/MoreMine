import { useEffect, useState } from 'react';
import { Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';

/*
 * ARAMA İŞARETİ (PIN)
 * -------------------
 * Aranan konuma uçtuktan sonra orada bir iğne bırakır. Önceden sistem
 * doğru yere gidiyordu ama hiçbir iz bırakmadığı için haritanın tam
 * olarak neresine bakıldığı anlaşılmıyordu.
 *
 * İğneye tıklanınca konum adı ve koordinatlar görünür, koordinat
 * kopyalanabilir.
 */

// Leaflet'in varsayılan ikonu bundle'da bozuk yol veriyor; kendi SVG'mizi
// gömüyoruz. Böylece harici dosya bağımlılığı da olmuyor.
const IGNE_IKONU = L.divIcon({
  className: '',
  html: `
    <div style="position:relative;width:30px;height:42px;">
      <svg width="30" height="42" viewBox="0 0 30 42" xmlns="http://www.w3.org/2000/svg">
        <path d="M15 0C6.7 0 0 6.7 0 15c0 11.2 15 27 15 27s15-15.8 15-27C30 6.7 23.3 0 15 0z"
              fill="#dc2626" stroke="#fff" stroke-width="2.5"/>
        <circle cx="15" cy="15" r="5.5" fill="#fff"/>
      </svg>
    </div>`,
  iconSize: [30, 42],
  iconAnchor: [15, 42],   // ucu tam koordinatta dursun
  popupAnchor: [0, -38],
});

export default function AramaIsareti({ nokta, onTemizle }) {
  const map = useMap();
  const [kopyalandi, setKopyalandi] = useState(false);

  // İğne konulur konulmaz balonu aç — kullanıcı nereye bakıldığını hemen görsün
  useEffect(() => {
    if (!nokta) return;
    const zamanlayici = setTimeout(() => {
      map.eachLayer((katman) => {
        if (katman.options?.icon === IGNE_IKONU) katman.openPopup();
      });
    }, 1300);   // flyTo animasyonu bitsin
    return () => clearTimeout(zamanlayici);
  }, [nokta, map]);

  if (!nokta) return null;

  const koordinatMetni = `${nokta.lat.toFixed(6)}, ${nokta.lng.toFixed(6)}`;

  const kopyala = async () => {
    try {
      await navigator.clipboard.writeText(koordinatMetni);
      setKopyalandi(true);
      setTimeout(() => setKopyalandi(false), 2000);
    } catch {
      /* pano izni yoksa sessizce geç */
    }
  };

  return (
    <Marker position={[nokta.lat, nokta.lng]} icon={IGNE_IKONU}>
      <Popup>
        <div style={{ minWidth: 190, fontSize: 13, lineHeight: 1.5 }}>
          {nokta.ad && (
            <div style={{ fontWeight: 700, marginBottom: 5 }}>{nokta.ad}</div>
          )}
          <div style={{ fontFamily: 'monospace', fontSize: 12, color: '#334155', marginBottom: 8 }}>
            {koordinatMetni}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={kopyala}
              style={{
                flex: 1, padding: '6px 8px', borderRadius: 6, border: 'none',
                background: kopyalandi ? '#16a34a' : '#2563eb', color: '#fff',
                cursor: 'pointer', fontSize: 12,
              }}
            >
              {kopyalandi ? 'Kopyalandı' : 'Koordinatı kopyala'}
            </button>
            {onTemizle && (
              <button
                onClick={onTemizle}
                title="İğneyi kaldır"
                style={{
                  padding: '6px 10px', borderRadius: 6, border: '1px solid #cbd5e1',
                  background: '#fff', color: '#475569', cursor: 'pointer', fontSize: 12,
                }}
              >
                ✕
              </button>
            )}
          </div>
        </div>
      </Popup>
    </Marker>
  );
}
