import { useEffect, useRef, useState, useCallback } from 'react';
import { MapContainer, TileLayer, GeoJSON, useMap, useMapEvents, Circle, CircleMarker } from 'react-leaflet';
import L from 'leaflet';
import '@geoman-io/leaflet-geoman-free';
import { supabase } from './supabaseClient';
import Giris from './Giris';
import AdminPaneli from './AdminPaneli';
import Harita3D from './Harita3D';
import ManyetikKatman from './ManyetikKatman';
import AnalizV2 from './AnalizV2';
import GuvenlikKatmani from './GuvenlikKatmani';
import KatmanKontrol, { VARSAYILAN_FILTRE } from './KatmanKontrol';
import AramaIsareti from './AramaIsareti';
import TarihceKatmani from './TarihceKatmani';
import AnalizV3 from './AnalizV3';
import BilesikRapor from './BilesikRapor';
import AracCubugu from './AracCubugu';
import { RENKLER, ETIKETLER, ONERILER, MINERAL_ETIKETLERI } from './siniflar';

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
  const oneri = ONERILER[sinif];
  layer.bindTooltip(
    `<b>v1 — ${ETIKETLER[sinif] || 'Bilinmiyor'}</b>` +
    (oneri ? `<br/><i>${oneri}</i>` : '')
  );
}

// Haritaya çizim aracını (Geoman) ekleyen ve çizilen alanı üst bileşene bildiren yardımcı bileşen
// Leaflet popup'ları düz HTML olduğu için React state'e doğrudan erişemiyor,
// bu yüzden paylaşım fonksiyonunu global (window) üzerinden erişilebilir yapıyoruz.
if (typeof window !== 'undefined') {
  window.__konumPaylas = async (lat, lng) => {
    const metin = `📍 Konum: ${lat.toFixed(6)}, ${lng.toFixed(6)}\nHaritada gör: https://www.google.com/maps?q=${lat},${lng}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Konum', text: metin });
      } catch {
        // kullanıcı paylaşımı iptal etti, sorun değil
      }
    } else {
      await navigator.clipboard.writeText(metin);
      window.alert('Konum panoya kopyalandı. İstediğin mesaj uygulamasına yapıştırabilirsin.');
    }
  };
}

function CizimAraci({ onAlanCizildi }) {
  const map = useMap();
  const kontrolEklendiRef = useRef(false);

  useEffect(() => {
    if (kontrolEklendiRef.current) return;
    kontrolEklendiRef.current = true;

    map.pm.addControls({
      position: 'topleft',
      drawMarker: true,
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
      // Nokta işaretleme (pin) -> koordinat göster + paylaş imkanı sun.
      // Analiz alanı (poligon/dikdörtgen) mantığını ETKİLEMEZ, ayrı bir akış.
      if (e.shape === 'Marker') {
        const katman = e.layer;
        const { lat, lng } = katman.getLatLng();
        katman
          .bindPopup(`
            <div style="font-size:12px; line-height:1.5;">
              <b>📍 İşaretlenen Konum</b><br/>
              ${lat.toFixed(6)}, ${lng.toFixed(6)}<br/>
              <button
                onclick="window.__konumPaylas(${lat}, ${lng})"
                style="margin-top:6px; padding:6px 10px; border:none; border-radius:6px; background:#2563eb; color:white; cursor:pointer; font-size:12px;"
              >Paylaş</button>
            </div>
          `)
          .openPopup();
        return;
      }

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

// Verilen tek bir noktaya (arama sonucu / favori konum) uçan yardımcı bileşen
function NoktayaUc({ hedef }) {
  const map = useMap();
  useEffect(() => {
    if (!hedef) return;
    map.flyTo([hedef.lat, hedef.lng], hedef.zoom || 15, { duration: 1.2 });
  }, [hedef, map]);
  return null;
}

// Haritanın o anki merkezini bir ref'te tutar (buton tıklamasında "şu anki konumu kaydet" için)
function MerkezTakibi({ merkezRef }) {
  const map = useMapEvents({
    moveend: () => {
      merkezRef.current = map.getCenter();
    },
  });
  useEffect(() => {
    merkezRef.current = map.getCenter();
  }, [map]);
  return null;
}

// Verilen koordinat setine haritayı odaklayan (uçarak giden) yardımcı bileşen
function HaritaOdakla({ hedef }) {
  const map = useMap();
  useEffect(() => {
    if (!hedef || hedef.length < 3) return;
    const sinirlar = L.latLngBounds(hedef.map((k) => [k.lat, k.lng]));
    const zamanlayici = setTimeout(() => {
      map.flyToBounds(sinirlar, { duration: 1.2, padding: [40, 40] });
    }, 80);
    return () => clearTimeout(zamanlayici);
  }, [hedef, map]);
  return null;
}

// Sayfa açıldığında kullanıcının konumunu bulup haritayı oraya götüren bileşen
// Cihazın gerçek konumunu SÜREKLİ izleyip haritada hareket eden bir nokta olarak
// gösteren katman. Diğer hiçbir katmana/noktaya dokunmaz, bağımsız çalışır.
function CanliKonumKatmani({ aktif }) {
  const [konum, setKonum] = useState(null);
  const izleyiciIdRef = useRef(null);

  useEffect(() => {
    if (!aktif || !navigator.geolocation) {
      if (izleyiciIdRef.current !== null) {
        navigator.geolocation.clearWatch(izleyiciIdRef.current);
        izleyiciIdRef.current = null;
      }
      setKonum(null);
      return;
    }

    izleyiciIdRef.current = navigator.geolocation.watchPosition(
      (pozisyon) => {
        setKonum({
          lat: pozisyon.coords.latitude,
          lng: pozisyon.coords.longitude,
          dogruluk: pozisyon.coords.accuracy,
        });
      },
      () => {
        // konum alınamadı -> sessizce geç, harita etkilenmesin
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
    );

    return () => {
      if (izleyiciIdRef.current !== null) {
        navigator.geolocation.clearWatch(izleyiciIdRef.current);
        izleyiciIdRef.current = null;
      }
    };
  }, [aktif]);

  if (!aktif || !konum) return null;

  return (
    <>
      {konum.dogruluk && (
        <Circle
          center={[konum.lat, konum.lng]}
          radius={konum.dogruluk}
          pathOptions={{ color: '#3b82f6', weight: 1, fillColor: '#3b82f6', fillOpacity: 0.12 }}
        />
      )}
      <CircleMarker
        center={[konum.lat, konum.lng]}
        radius={8}
        pathOptions={{ color: 'white', weight: 2, fillColor: '#3b82f6', fillOpacity: 1 }}
        className="canli-konum-nokta"
      />
    </>
  );
}

function KonumTespiti({ tetikleyici }) {
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
  }, [map, tetikleyici]);

  return null;
}

function AnaUygulama({ oturum, rol }) {
  const [ciziliAlan, setCiziliAlan] = useState(null);
  const [sonuc, setSonuc] = useState(null);
  const [katmanFiltre, setKatmanFiltre] = useState(VARSAYILAN_FILTRE);
  const [aktifTaramaId, setAktifTaramaId] = useState(null);
  const [v2Sonuc, setV2Sonuc] = useState(null);
  const [v3Sonuc, setV3Sonuc] = useState(null);
  const [tarihce, setTarihce] = useState(null);
  const [aktifKonumAdi, setAktifKonumAdi] = useState(null);
  // Aynı anda yalnızca bir panel açık olsun (üst üste binmeyi önler)
  const [acikPanel, setAcikPanel] = useState(null);
  // "Taramayı Başlat" sonrası v2 ve v3'ü de otomatik çalıştırmak için sayaç
  const [tumMotorlar, setTumMotorlar] = useState(true);
  const [zincirTetik, setZincirTetik] = useState(0);
  // Üç motorun durumu — Bileşik Rapor bunu okur
  const [motorDurum, setMotorDurum] = useState({});
  const motorDurumBildir = useCallback((motor, bilgi) => {
    setMotorDurum((o) => ({ ...o, [motor]: bilgi }));
  }, []);
  const v2Durum = useCallback((b) => motorDurumBildir('v2', b), [motorDurumBildir]);
  const v3Durum = useCallback((b) => motorDurumBildir('v3', b), [motorDurumBildir]);
  const [sonucGorunur, setSonucGorunur] = useState(true);
  const [odaklanilacakAlan, setOdaklanilacakAlan] = useState(null);
  const [yukleniyor, setYukleniyor] = useState(false);
  const [asama, setAsama] = useState('boşta'); // boşta | uyduGeliyor | taraniyor | tamamlandı
  const [detayAsamasi, setDetayAsamasi] = useState(0);
  const [hata, setHata] = useState(null);
  const [gecmis, setGecmis] = useState([]);
  const [konumTetikleyici, setKonumTetikleyici] = useState(0);
  const [canliKonumAktif, setCanliKonumAktif] = useState(false);
  const [tarihSabitle, setTarihSabitle] = useState(false);
  const [ozelBaslangic, setOzelBaslangic] = useState('');
  const [ozelBitis, setOzelBitis] = useState('');
  const [hedefMineral, setHedefMineral] = useState('altin');
  const [sonKullanilanTarihler, setSonKullanilanTarihler] = useState(null);
  const [aramaMetni, setAramaMetni] = useState('');
  const [aramaIsareti, setAramaIsareti] = useState(null);
  const [aramaSonuclari, setAramaSonuclari] = useState([]);
  const [aramaYukleniyor, setAramaYukleniyor] = useState(false);
  const [ucusHedefi, setUcusHedefi] = useState(null);
  const [favoriler, setFavoriler] = useState([]);
  const [gizlenenleriGoster, setGizlenenleriGoster] = useState(false);
  const [sadeceFavoriler, setSadeceFavoriler] = useState(false);
  const merkezRef = useRef(null);
  const [adminPaneliAcik, setAdminPaneliAcik] = useState(false);
  const [gorunum3D, setGorunum3D] = useState(false);
  const ciziliKatmanRef = useRef(null);

  const TARAMA_ASAMALARI = [
    'Uygun uydu aranıyor...',
    'Uyduya bağlanılıyor...',
    'Uydu verileri alınıyor...',
    'Uydu verileri analiz ediliyor...',
  ];

  const gecmisiYukle = useCallback(async () => {
    const { data, error } = await supabase
      .from('taramalar')
      .select('id, created_at, durum, koordinatlar, konum_adi, gizli, hedef_mineral, favori, sonuc_v2, sonuc_v3')
      .order('created_at', { ascending: false })
      .limit(50);
    if (!error) setGecmis(data);
  }, []);

  const favorileriYukle = useCallback(async () => {
    const { data, error } = await supabase
      .from('favori_konumlar')
      .select('id, isim, lat, lng, created_at')
      .order('created_at', { ascending: false });
    // Hata sessizce yutulursa "favorilerim kayboldu" gibi görünüyor.
    // Sebebi görebilmek için ekrana yazıyoruz.
    if (error) {
      setHata('Kayıtlı konumlar okunamadı: ' + error.message);
      return;
    }
    setFavoriler(data || []);
  }, []);

  useEffect(() => {
    gecmisiYukle();
    favorileriYukle();
  }, [gecmisiYukle, favorileriYukle]);

  const konumAra = async (e) => {
    e.preventDefault();
    if (!aramaMetni.trim()) return;

    /*
     * Önce KOORDİNAT mı diye bak. Nominatim "39.4221, 38.5288" gibi bir
     * girdiyi genelde bulamıyor; oysa kullanıcının en çok yaptığı şey
     * koordinat yapıştırmak. Desteklenen biçimler:
     *   39.4221, 38.5288      39.4221 38.5288      39.4221;38.5288
     */
    const koordinatKalibi = /^\s*(-?\d{1,3}(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:[.,]\d+)?)\s*$/;
    const eslesme = aramaMetni.trim().match(koordinatKalibi);
    if (eslesme) {
      const enlem = parseFloat(eslesme[1].replace(',', '.'));
      const boylam = parseFloat(eslesme[2].replace(',', '.'));
      if (Math.abs(enlem) <= 90 && Math.abs(boylam) <= 180) {
        setUcusHedefi({ lat: enlem, lng: boylam, zoom: 16 });
        setAramaIsareti({ lat: enlem, lng: boylam, ad: 'Girilen koordinat' });
        setAramaSonuclari([]);
        return;
      }
    }

    setAramaYukleniyor(true);
    setAramaSonuclari([]);
    try {
      const yanit = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(aramaMetni)}`
      );
      const veri = await yanit.json();
      setAramaSonuclari(veri);
    } catch {
      setHata('Konum aranırken bir hata oluştu.');
    } finally {
      setAramaYukleniyor(false);
    }
  };

  const aramaSonucunaGit = (sonuc) => {
    const enlem = parseFloat(sonuc.lat);
    const boylam = parseFloat(sonuc.lon);
    setUcusHedefi({ lat: enlem, lng: boylam, zoom: 16 });
    // Uçtuğumuz yere iğne bırak: kullanıcı haritanın tam olarak neresine
    // bakıldığını görebilsin.
    setAramaIsareti({
      lat: enlem,
      lng: boylam,
      ad: (sonuc.display_name || '').split(',').slice(0, 3).join(',').trim(),
    });
    setAramaSonuclari([]);
  };

  const konumuKaydet = async () => {
    const merkez = merkezRef.current;
    if (!merkez) return;
    const isim = window.prompt('Bu konum için bir isim ver:');
    if (!isim || !isim.trim()) return;
    const { error } = await supabase
      .from('favori_konumlar')
      .insert({ kullanici_id: oturum.user.id, isim: isim.trim(), lat: merkez.lat, lng: merkez.lng });
    if (error) {
      setHata('Konum kaydedilemedi: ' + error.message);
      return;
    }
    favorileriYukle();
  };

  const alaniPaylas = async () => {
    if (!ciziliAlan || ciziliAlan.length < 3) {
      setHata('Paylaşmak için önce haritada bir alan çiz.');
      return;
    }
    const ortLat = ciziliAlan.reduce((t, k) => t + k.lat, 0) / ciziliAlan.length;
    const ortLng = ciziliAlan.reduce((t, k) => t + k.lng, 0) / ciziliAlan.length;
    const koordMetni = ciziliAlan.map((k, i) => `${i + 1}. ${k.lat.toFixed(6)}, ${k.lng.toFixed(6)}`).join('\n');
    const metin = `📍 İşaretlenen Alan Koordinatları:\n${koordMetni}\n\nHaritada gör: https://www.google.com/maps?q=${ortLat},${ortLng}`;

    if (navigator.share) {
      try {
        await navigator.share({ title: 'İşaretlenen Alan', text: metin });
      } catch {
        // kullanıcı iptal etti, sorun değil
      }
    } else {
      await navigator.clipboard.writeText(metin);
      setHata(null);
      window.alert('Alan koordinatları panoya kopyalandı. İstediğin mesaj uygulamasına yapıştırabilirsin.');
    }
  };

  const favoriyeGit = (f) => {
    setUcusHedefi({ lat: f.lat, lng: f.lng, zoom: 16 });
  };

  const favoriSil = async (id, e) => {
    e.stopPropagation();
    const { error } = await supabase.from('favori_konumlar').delete().eq('id', id);
    if (error) {
      setHata('Silinemedi: ' + error.message);
      return;
    }
    setFavoriler((liste) => liste.filter((f) => f.id !== id));
  };

  const taramaFavoriDegistir = async (id, yeniDeger, e) => {
    e.stopPropagation();
    // Önce ekranda güncelle, sonra kaydet: buton anında tepki versin
    setGecmis((liste) => liste.map((t) => (t.id === id ? { ...t, favori: yeniDeger } : t)));
    const { error } = await supabase.from('taramalar').update({ favori: yeniDeger }).eq('id', id);
    if (error) {
      setHata('Favori işlemi başarısız: ' + error.message);
      setGecmis((liste) => liste.map((t) => (t.id === id ? { ...t, favori: !yeniDeger } : t)));
    }
  };

  const gizlemeDegistir = async (id, yeniDeger, e) => {
    e.stopPropagation();
    const { error } = await supabase.from('taramalar').update({ gizli: yeniDeger }).eq('id', id);
    if (error) {
      setHata('İşlem başarısız: ' + error.message);
      return;
    }
    setGecmis((liste) => liste.map((t) => (t.id === id ? { ...t, gizli: yeniDeger } : t)));
  };

  // Tarama sırasında alt-aşama metnini döngüyle değiştir (arka planda ciddi bir iş yapıldığı hissini verir)
  useEffect(() => {
    if (asama !== 'taraniyor') {
      setDetayAsamasi(0);
      return;
    }
    const zamanlayici = setInterval(() => {
      setDetayAsamasi((i) => (i + 1) % TARAMA_ASAMALARI.length);
    }, 1600);
    return () => clearInterval(zamanlayici);
  }, [asama]);

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

  const konumAdiniBul = async (koordinatlar) => {
    try {
      const ortLat = koordinatlar.reduce((t, k) => t + k.lat, 0) / koordinatlar.length;
      const ortLng = koordinatlar.reduce((t, k) => t + k.lng, 0) / koordinatlar.length;
      const yanit = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=json&lat=${ortLat}&lon=${ortLng}&zoom=14`
      );
      const veri = await yanit.json();
      const a = veri.address || {};
      const parcalar = [a.suburb || a.neighbourhood || a.village, a.town || a.city || a.county].filter(Boolean);
      return parcalar.length ? parcalar.join(', ') : (veri.display_name || 'Bilinmeyen Konum');
    } catch {
      return 'Bilinmeyen Konum';
    }
  };

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
    motorDurumBildir('v1', { durum: 'calisiyor' });
    setMotorDurum((o) => ({ ...o, v2: undefined, v3: undefined }));

    try {
      const konumAdi = await konumAdiniBul(ciziliAlan);

      const { data: kayit, error: eklemeHatasi } = await supabase
        .from('taramalar')
        .insert({
          koordinatlar: ciziliAlan, durum: 'İşleniyor', kullanici_id: oturum.user.id, konum_adi: konumAdi,
          ozel_tarih_baslangic: tarihSabitle && ozelBaslangic ? ozelBaslangic : null,
          ozel_tarih_bitis: tarihSabitle && ozelBitis ? ozelBitis : null,
          hedef_mineral: hedefMineral,
        })
        .select()
        .single();

      if (eklemeHatasi) throw eklemeHatasi;

      // v2 bu taramanın içine yazacak; önceki taramanın v2 sonucunu temizle
      setAktifTaramaId(kayit.id);
      setV2Sonuc(null);
      setV3Sonuc(null);
      setTarihce(null);
      setAktifKonumAdi(konumAdi);

      // Uydunun konuma "yaklaştığı" animasyonu bir süre göster, sonra tarama evresine geç
      await beklet(1800);
      setAsama('taraniyor');

      const yanit = await fetch('/api/analyze', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${oturum.access_token}`,
        },
        body: JSON.stringify({
          id: kayit.id,
          koordinatlar: ciziliAlan,
          ozel_baslangic: tarihSabitle && ozelBaslangic ? ozelBaslangic : null,
          ozel_bitis: tarihSabitle && ozelBitis ? ozelBitis : null,
          hedef_mineral: hedefMineral,
        }),
      });

      const cevap = await yanit.json();

      if (!yanit.ok || !cevap.basarili) {
        throw new Error(cevap.hata || 'Analiz sırasında bilinmeyen bir hata oluştu.');
      }

      if (cevap.kayit_hatasi) {
        setHata('Sonuç ekranda gösteriliyor ama veritabanına KAYDEDİLEMEDİ: ' + cevap.kayit_hatasi);
      }

      setSonuc(cevap.sonuc);
      motorDurumBildir('v1', { durum: 'tamam', ozellikler: cevap.sonuc?.features || [] });
      setSonKullanilanTarihler(cevap.kullanilan_tarihler || null);
      setAsama('tamamlandı');
      gecmisiYukle();
      // v1 bitti; istenirse v2 ve v3 kendiliğinden devam etsin
      if (tumMotorlar) setZincirTetik((v) => v + 1);
      await beklet(1400);
    } catch (e) {
      console.error(e);
      setHata(e.message || String(e));
      motorDurumBildir('v1', { durum: 'hata', mesaj: e.message || String(e) });
    } finally {
      setYukleniyor(false);
      setAsama('boşta');
    }
  };

  const gecmisTaramaSil = async (id, e) => {
    e.stopPropagation();
    if (!window.confirm('Bu taramayı silmek istediğine emin misin?')) return;
    const { error } = await supabase.from('taramalar').delete().eq('id', id);
    if (error) {
      setHata('Silinemedi: ' + error.message);
      return;
    }
    setGecmis((liste) => liste.filter((t) => t.id !== id));
  };

  const gecmisTaramayiAc = async (id) => {
    setHata(null);
    setSonuc(null);
    setV2Sonuc(null);
    setV3Sonuc(null);
    setTarihce(null);
    setAktifTaramaId(id);
    const { data, error } = await supabase
      .from('taramalar')
      .select('sonuc, sonuc_v2, sonuc_v3, durum, hata_mesaji, koordinatlar, konum_adi')
      .eq('id', id)
      .single();

    if (error) {
      setHata('Kayıt okunamadı: ' + error.message);
      return;
    }
    if (data.koordinatlar) {
      setOdaklanilacakAlan(data.koordinatlar);
    }
    // v2 sonucu varsa onu da geri yükle — tek tarama, iki katman
    if (data.sonuc_v2) {
      setV2Sonuc(data.sonuc_v2);
    }
    if (data.sonuc_v3) {
      setV3Sonuc(data.sonuc_v3);
    }
    setAktifKonumAdi(data.konum_adi || null);

    /*
     * Tarihçe AYRI sorguyla çekiliyor.
     * Sebep: "tarihce" sütunu veritabanında henüz yoksa (SQL çalıştırılmadıysa)
     * Supabase tüm sorguyu reddediyor ve tarama hiç açılmıyordu. Ayrı sorguda
     * hata olursa sessizce geçiyoruz — tarama yine de açılıyor.
     */
    supabase
      .from('taramalar')
      .select('tarihce')
      .eq('id', id)
      .single()
      .then(({ data: tarihceKaydi }) => {
        if (tarihceKaydi?.tarihce) setTarihce(tarihceKaydi.tarihce);
      })
      .catch(() => { /* sütun yok veya okunamadı, sorun değil */ });
    if (data.durum === 'Hata') {
      setHata('Bu tarama hatayla sonuçlanmıştı: ' + (data.hata_mesaji || 'Detay yok.'));
      return;
    }
    if (data.durum !== 'Tamamlandı' || !data.sonuc) {
      setHata('Bu tarama tamamlanmamış görünüyor (muhtemelen eski, yarıda kalmış bir deneme). Silip yeniden deneyebilirsin.');
      return;
    }
    setSonucGorunur(true);
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
      {gorunum3D && sonuc && <Harita3D sonuc={sonuc} onKapat={() => setGorunum3D(false)} />}

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* SOL PANEL */}
        <div style={{ width: '320px', background: '#0f172a', color: 'white', padding: '20px', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
          <h2 style={{ marginTop: 0, fontSize: '18px' }}>Uydu Alterasyon Taraması</h2>

          {/* KONUM ARAMA */}
          <div style={{ position: 'relative' }}>
            <form onSubmit={konumAra} style={{ display: 'flex', gap: '6px', marginTop: '4px' }}>
              <input
                type="text" value={aramaMetni} onChange={(e) => setAramaMetni(e.target.value)}
                placeholder="Yer adı veya koordinat (39.4221, 38.5288)"
                style={{ flex: 1, padding: '9px', borderRadius: '8px', border: '1px solid #334155', background: '#1e293b', color: 'white', fontSize: '12px' }}
              />
              <button type="submit" disabled={aramaYukleniyor} style={{ padding: '0 12px', borderRadius: '8px', border: 'none', background: '#334155', color: 'white', cursor: 'pointer', fontSize: '13px' }}>
                {aramaYukleniyor ? <span className="donen-ikon" style={{ display: 'inline-block', width: '12px', height: '12px', border: '2px solid rgba(255,255,255,0.4)', borderTopColor: 'white', borderRadius: '50%' }} /> : '🔍'}
              </button>
            </form>

            {aramaSonuclari.length > 0 && (
              <div
                className="yumusak-giris"
                style={{
                  position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 500,
                  background: '#1e293b', borderRadius: '8px', border: '1px solid #334155',
                  maxHeight: '260px', overflowY: 'auto', boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
                }}
              >
                {aramaSonuclari.map((s, i) => (
                  <div
                    key={i}
                    onClick={() => aramaSonucunaGit(s)}
                    style={{
                      padding: '10px 12px', fontSize: '12px', lineHeight: 1.4, cursor: 'pointer',
                      borderBottom: i < aramaSonuclari.length - 1 ? '1px solid #334155' : 'none',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = '#334155')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    {s.display_name}
                  </div>
                ))}
              </div>
            )}
          </div>

          <button
            onClick={alaniPaylas}
            style={{
              padding: '9px', marginTop: '8px', background: 'transparent', color: '#94a3b8',
              border: '1px solid #334155', borderRadius: '8px', cursor: 'pointer', fontSize: '12px',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
            }}
          >
            📤 İşaretlenen Alanı Paylaş
          </button>

          <button
            onClick={() => setKonumTetikleyici((v) => v + 1)}
            style={{
              padding: '9px', marginTop: '10px', background: 'transparent', color: '#94a3b8',
              border: '1px solid #334155', borderRadius: '8px', cursor: 'pointer', fontSize: '12px',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
            }}
          >
            📍 Konumuma Git
          </button>

          <button
            onClick={() => setCanliKonumAktif((v) => !v)}
            style={{
              padding: '9px', marginTop: '8px', background: canliKonumAktif ? '#1e3a8a' : 'transparent',
              color: canliKonumAktif ? '#93c5fd' : '#94a3b8',
              border: `1px solid ${canliKonumAktif ? '#2563eb' : '#334155'}`, borderRadius: '8px',
              cursor: 'pointer', fontSize: '12px',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
            }}
          >
            {canliKonumAktif ? '🔵 Canlı Konum: Açık' : '⚪ Canlı Konumu Göster'}
          </button>

          <button
            onClick={konumuKaydet}
            style={{
              padding: '9px', marginTop: '8px', background: 'transparent', color: '#94a3b8',
              border: '1px solid #334155', borderRadius: '8px', cursor: 'pointer', fontSize: '12px',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
            }}
          >
            ⭐ Bu Konumu Kaydet
          </button>

          <div style={{ marginTop: '12px' }}>
            <label style={{ fontSize: '11px', color: '#94a3b8' }}>Hedef Mineral</label>
            <select
              value={hedefMineral} onChange={(e) => setHedefMineral(e.target.value)}
              style={{ width: '100%', padding: '9px', marginTop: '4px', borderRadius: '8px', border: '1px solid #334155', background: '#1e293b', color: 'white', fontSize: '12px' }}
            >
              {Object.entries(MINERAL_ETIKETLERI).map(([deger, etiket]) => (
                <option key={deger} value={deger}>{etiket}</option>
              ))}
            </select>
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '10px', fontSize: '12px', color: '#94a3b8', cursor: 'pointer' }}>
            <input type="checkbox" checked={tumMotorlar} onChange={(e) => setTumMotorlar(e.target.checked)} />
            Tarama sonrası v2 ve v3 de çalışsın
          </label>

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

          {sonuc && (
            <button
              onClick={() => setGorunum3D(true)}
              style={{
                padding: '9px', marginTop: '8px', background: 'transparent', color: '#94a3b8',
                border: '1px solid #334155', borderRadius: '8px', cursor: 'pointer', fontSize: '12px',
              }}
            >
              🧊 3D Görünüm
            </button>
          )}

          {/* TARİH SABİTLEME (sadece admin) */}
          {rol === 'admin' && (
          <div style={{ marginTop: '14px', borderTop: '1px solid #334155', paddingTop: '12px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: '#94a3b8', cursor: 'pointer' }}>
              <input type="checkbox" checked={tarihSabitle} onChange={(e) => setTarihSabitle(e.target.checked)} />
              Tarih aralığını sabitle (admin)
            </label>
            {tarihSabitle && (
              <div className="yumusak-giris" style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <input
                  type="date" value={ozelBaslangic} onChange={(e) => setOzelBaslangic(e.target.value)}
                  style={{ padding: '7px', borderRadius: '6px', border: '1px solid #334155', background: '#1e293b', color: 'white', fontSize: '12px' }}
                />
                <input
                  type="date" value={ozelBitis} onChange={(e) => setOzelBitis(e.target.value)}
                  style={{ padding: '7px', borderRadius: '6px', border: '1px solid #334155', background: '#1e293b', color: 'white', fontSize: '12px' }}
                />
                <div style={{ fontSize: '10px', color: '#64748b' }}>Boş bırakılırsa varsayılan (son 6 ay, en temiz 10 görüntü) kullanılır.</div>
              </div>
            )}
          </div>
          )}

          {sonKullanilanTarihler && sonKullanilanTarihler.length > 0 && (
            <div style={{ marginTop: '10px', fontSize: '11px', color: '#64748b' }}>
              Kullanılan görüntü tarihleri: {sonKullanilanTarihler.join(', ')}
            </div>
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

          {/* FAVORİ KONUMLAR */}
          <div style={{ marginTop: '20px', borderTop: '1px solid #334155', paddingTop: '15px' }}>
            <h3 style={{ fontSize: '14px', margin: '0 0 10px 0' }}>Kayıtlı Konumlar</h3>
            {favoriler.length === 0 && <div style={{ fontSize: '12px', color: '#64748b' }}>Henüz kayıtlı konum yok.</div>}
            {favoriler.map((f) => (
              <div
                key={f.id}
                onClick={() => favoriyeGit(f)}
                style={{ padding: '7px 8px', marginBottom: '6px', background: '#1e293b', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '6px' }}
              >
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>⭐ {f.isim}</div>
                <button
                  onClick={(e) => favoriSil(f.id, e)}
                  title="Sil"
                  style={{ flexShrink: 0, background: 'transparent', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: '13px' }}
                >
                  🗑
                </button>
              </div>
            ))}
          </div>

          {/* GEÇMİŞ */}
          <div style={{ marginTop: '20px', borderTop: '1px solid #334155', paddingTop: '15px', flex: 1 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
              <h3 style={{ fontSize: '14px', margin: 0 }}>Geçmiş Taramalar</h3>
              <button
                onClick={() => setSadeceFavoriler((v) => !v)}
                title={sadeceFavoriler ? 'Tümünü göster' : 'Sadece favorileri göster'}
                style={{
                  background: sadeceFavoriler ? '#78350f' : 'transparent',
                  border: `1px solid ${sadeceFavoriler ? '#f59e0b' : '#334155'}`,
                  borderRadius: '6px', padding: '3px 9px', cursor: 'pointer',
                  color: sadeceFavoriler ? '#fde68a' : '#64748b', fontSize: '11px',
                  marginLeft: 'auto', marginRight: '6px',
                }}
              >
                ⭐ {sadeceFavoriler ? 'Favoriler' : 'Tümü'}
              </button>
              {rol === 'admin' && (
                <label style={{ fontSize: '10px', color: '#64748b', display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                  <input type="checkbox" checked={gizlenenleriGoster} onChange={(e) => setGizlenenleriGoster(e.target.checked)} />
                  Gizlenenleri göster
                </label>
              )}
            </div>
            {gecmis.filter((t) => (rol === 'admin' && gizlenenleriGoster ? true : !t.gizli) && (!sadeceFavoriler || t.favori)).length === 0 && (
              <div style={{ fontSize: '12px', color: '#64748b' }}>
                {sadeceFavoriler ? 'Favori tarama yok. Listedeki yıldıza basarak ekleyebilirsin.' : 'Henüz tarama yok.'}
              </div>
            )}
            {gecmis
              .filter((t) => (rol === 'admin' && gizlenenleriGoster ? true : !t.gizli))
              .filter((t) => !sadeceFavoriler || t.favori)
              .map((t) => (
              <div
                key={t.id}
                onClick={() => gecmisTaramayiAc(t.id)}
                style={{ padding: '8px', marginBottom: '6px', background: '#1e293b', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '6px', opacity: t.gizli ? 0.5 : 1 }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, color: 'white', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {t.konum_adi || 'Konum bulunamadı'} {t.gizli && '(gizli)'}
                  </div>
                  <div style={{ color: '#64748b', fontSize: '10px' }}>{MINERAL_ETIKETLERI[t.hedef_mineral] || 'Altın'}</div>
                  <div style={{ display: 'flex', gap: '4px', marginTop: '2px' }}>
                    {[
                      { ad: 'v1', var: true, renk: '#3b82f6' },
                      { ad: 'v2', var: !!t.sonuc_v2, renk: '#0891b2' },
                      { ad: 'v3', var: !!t.sonuc_v3, renk: '#059669' },
                    ].map((m) => (
                      <span key={m.ad} style={{
                        fontSize: '9px', padding: '1px 5px', borderRadius: '4px',
                        background: m.var ? m.renk : 'transparent',
                        border: `1px solid ${m.var ? m.renk : '#334155'}`,
                        color: m.var ? '#fff' : '#475569',
                      }}>{m.ad}</span>
                    ))}
                  </div>
                  <div style={{ color: '#64748b', fontSize: '11px' }}>{new Date(t.created_at).toLocaleString('tr-TR')}</div>
                  <div style={{ color: t.durum === 'Tamamlandı' ? '#4ade80' : t.durum === 'Hata' ? '#f87171' : '#fbbf24' }}>
                    {t.durum}
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flexShrink: 0, alignItems: 'center' }}>
                  <button
                    onClick={(e) => taramaFavoriDegistir(t.id, !t.favori, e)}
                    title={t.favori ? 'Favorilerden çıkar' : 'Favorilere ekle'}
                    style={{
                      background: 'transparent', border: 'none', cursor: 'pointer',
                      fontSize: '15px', padding: '2px 4px', lineHeight: 1,
                      filter: t.favori ? 'none' : 'grayscale(1)',
                      opacity: t.favori ? 1 : 0.45,
                    }}
                  >
                    ⭐
                  </button>
                {rol === 'admin' && (
                  <>
                    <button
                      onClick={(e) => gizlemeDegistir(t.id, !t.gizli, e)}
                      title={t.gizli ? 'Göster' : 'Gizle'}
                      style={{ background: 'transparent', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: '13px', padding: '2px 4px' }}
                    >
                      {t.gizli ? '👁' : '🙈'}
                    </button>
                    <button
                      onClick={(e) => gecmisTaramaSil(t.id, e)}
                      title="Sil"
                      style={{ background: 'transparent', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: '14px', padding: '2px 4px' }}
                    >
                      🗑
                    </button>
                  </>
                )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* HARİTA */}
        <div style={{ flex: 1, position: 'relative' }}>
          <MapContainer center={[40.97, 29.06]} zoom={14} style={{ height: '100%', width: '100%' }}>
            <TileLayer url="https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}" maxZoom={22} maxNativeZoom={20} />
            <MerkezTakibi merkezRef={merkezRef} />
            <NoktayaUc hedef={ucusHedefi} />
            <KonumTespiti tetikleyici={konumTetikleyici} />
            <HaritaOdakla hedef={odaklanilacakAlan} />
            <CanliKonumKatmani aktif={canliKonumAktif} />
            <CizimAraci onAlanCizildi={alanCizildi} />
            {sonuc && sonucGorunur && katmanFiltre.v1 && <GeoJSON key={JSON.stringify(sonuc).length + '-' + katmanFiltre.siniflar.join('')} data={sonuc} style={geojsonStil} onEachFeature={ciziliAlaniGoster} filter={(f) => katmanFiltre.siniflar.includes(Number(f.properties.sinif))} />}
            <ManyetikKatman ciziliAlan={ciziliAlan} optikSonuc={sonuc} taramaId={null} acik={acikPanel === 'manyetik'} onKapat={() => setAcikPanel(null)} />
            <AnalizV2 ciziliAlan={ciziliAlan} onKaydedildi={gecmisiYukle} filtre={katmanFiltre} taramaId={aktifTaramaId} disSonuc={v2Sonuc} tetikleyici={zincirTetik} onDurum={v2Durum} acik={acikPanel === 'v2'} onKapat={() => setAcikPanel(null)} />
            <AramaIsareti nokta={aramaIsareti} onTemizle={() => setAramaIsareti(null)} />
            <TarihceKatmani ciziliAlan={ciziliAlan} taramaId={aktifTaramaId} konumAdi={aktifKonumAdi} disTarihce={tarihce} acik={acikPanel === 'tarihce'} onKapat={() => setAcikPanel(null)} />
            <KatmanKontrol deger={katmanFiltre} onChange={setKatmanFiltre} acik={acikPanel === 'katman'} onKapat={() => setAcikPanel(null)} />
            <AnalizV3 ciziliAlan={ciziliAlan} filtre={katmanFiltre} tetikleyici={zincirTetik} onDurum={v3Durum} taramaId={aktifTaramaId} disSonuc={v3Sonuc} onKaydedildi={gecmisiYukle} acik={acikPanel === 'v3'} onKapat={() => setAcikPanel(null)} />
            <BilesikRapor durumlar={motorDurum} acik={acikPanel === 'rapor'} onKapat={() => setAcikPanel(null)} />
            <AracCubugu acik={acikPanel} onDegis={setAcikPanel} durumlar={motorDurum} />
            <GuvenlikKatmani rol={rol} />
          </MapContainer>

          {/* EVRE 1: UYDU KONUMA YÖNELİYOR */}
          {asama === 'uyduGeliyor' && (
            <div style={{
              position: 'absolute', inset: 0, background: 'radial-gradient(circle at 50% 50%, rgba(15,23,42,0.75), rgba(2,6,23,0.85))',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              zIndex: 2000, pointerEvents: 'none', overflow: 'hidden',
            }}>
              <div className="uydu-yolu" style={{ filter: 'drop-shadow(0 0 14px rgba(56,189,248,0.7))' }}>
                <span style={{ fontSize: '40px' }}>🛰️</span>
              </div>
              <div className="nabiz-metin" style={{ color: 'white', fontSize: '15px', fontWeight: 700, marginTop: '14px', letterSpacing: '0.3px' }}>
                Uygun uydu aranıyor...
              </div>
              <div style={{ color: '#64748b', fontSize: '11px', marginTop: '4px' }}>
                Yörüngedeki Sentinel-2 geçişleri taranıyor
              </div>
            </div>
          )}

          {/* EVRE 2: TARAMA YAPILIYOR */}
          {asama === 'taraniyor' && (
            <div style={{
              position: 'absolute', inset: 0, background: 'radial-gradient(circle at 50% 50%, rgba(15,23,42,0.75), rgba(2,6,23,0.88))',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              zIndex: 2000, pointerEvents: 'none',
            }}>
              <div style={{ position: 'relative', width: '90px', height: '90px', marginBottom: '22px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div className="radar-halka" style={{ width: '90px', height: '90px' }} />
                <div className="radar-halka gecikmeli" style={{ width: '90px', height: '90px' }} />
                <div className="tarama-cizgisi" />
                <span style={{ fontSize: '26px', position: 'relative', zIndex: 1 }}>🛰️</span>
              </div>
              <div key={detayAsamasi} className="yumusak-giris" style={{ color: 'white', fontSize: '15px', fontWeight: 700, letterSpacing: '0.3px', minHeight: '20px' }}>
                {TARAMA_ASAMALARI[detayAsamasi]}
              </div>
              <div style={{ display: 'flex', gap: '5px', marginTop: '12px' }}>
                {TARAMA_ASAMALARI.map((_, i) => (
                  <div key={i} style={{
                    width: '7px', height: '7px', borderRadius: '50%',
                    background: i === detayAsamasi ? '#38bdf8' : '#334155',
                    transition: 'background 0.3s',
                  }} />
                ))}
              </div>
              <div style={{ color: '#64748b', fontSize: '11px', marginTop: '14px' }}>
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
  const [hesapAktif, setHesapAktif] = useState(true);
  const [profilYuklendi, setProfilYuklendi] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setOturum(data.session));

    const { data: dinleyici } = supabase.auth.onAuthStateChange((_olay, yeniOturum) => {
      setOturum(yeniOturum);
    });

    return () => dinleyici.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!oturum) return;
    supabase.from('profiller').select('rol, aktif').eq('id', oturum.user.id).single()
      .then(({ data }) => {
        setRol(data?.rol || 'kullanici');
        setHesapAktif(data?.aktif !== false);
        setProfilYuklendi(true);
        if (data?.aktif === false) {
          supabase.auth.signOut();
        }
      });
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

  if (profilYuklendi && !hesapAktif) {
    return (
      <div style={{ height: '100vh', width: '100vw', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: '#020617', color: 'white', gap: '10px' }}>
        <div style={{ fontSize: '30px' }}>🚫</div>
        <div style={{ fontSize: '15px', fontWeight: 600 }}>Hesabın devre dışı bırakılmış</div>
        <div style={{ fontSize: '12px', color: '#94a3b8' }}>Erişim için yöneticinle iletişime geç.</div>
      </div>
    );
  }

  return <AnaUygulama oturum={oturum} rol={rol} />;
}
