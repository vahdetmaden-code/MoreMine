import L from 'leaflet';

/*
 * VARSAYILAN HARİTA İĞNESİ
 * ========================
 * SORUN: Leaflet'in kendi iğnesi marker-icon.png / marker-shadow.png
 * dosyalarına GÖRECELİ yoldan bakar. Vite paketlerken bu yollar bozuluyor,
 * tarayıcı resmi bulamıyor ve iğne yerine kırık resim ikonu + "Marker"
 * alt yazısı çıkıyor. (Geoman ile bırakılan pin'lerde görülen durum buydu.)
 *
 * ÇÖZÜM: İğneyi dış dosyaya hiç bağlamıyoruz — SVG'yi doğrudan gömüyoruz.
 * Böylece paketleme yolu ne olursa olsun iğne her zaman çizilir.
 *
 * Bu dosya import edildiği anda Leaflet'in VARSAYILAN ikonunu değiştirir;
 * dolayısıyla Geoman'ın çizim aracıyla bırakılan pin'ler de düzelir.
 * (Arama iğnesi AramaIsareti.jsx içinde kendi ikonunu kullanmaya devam eder.)
 */

export function igneYap(renk = '#dc2626') {
  return L.divIcon({
    className: '',
    html: `
      <div style="position:relative;width:30px;height:42px;
                  filter:drop-shadow(0 2px 3px rgba(0,0,0,0.45));">
        <svg width="30" height="42" viewBox="0 0 30 42" xmlns="http://www.w3.org/2000/svg">
          <path d="M15 0C6.7 0 0 6.7 0 15c0 11.2 15 27 15 27s15-15.8 15-27C30 6.7 23.3 0 15 0z"
                fill="${renk}" stroke="#fff" stroke-width="2.5"/>
          <circle cx="15" cy="15" r="5.5" fill="#fff"/>
        </svg>
      </div>`,
    iconSize: [30, 42],
    iconAnchor: [15, 42],    // iğnenin UCU tam koordinatta dursun
    popupAnchor: [0, -38],
    tooltipAnchor: [0, -20],
  });
}

export const VARSAYILAN_IGNE = igneYap('#dc2626');

// Leaflet'in tüm yeni Marker'ları için varsayılan ikon
L.Marker.prototype.options.icon = VARSAYILAN_IGNE;

// Geoman çizim aracı kendi "draft" ikonunu kullanabildiği için ona da söylüyoruz.
// (setGlobalOptions harita örneği üzerinde çağrılır; CizimAraci içinde yapılıyor.)
export const GEOMAN_IGNE_AYARI = { markerStyle: { icon: VARSAYILAN_IGNE } };
