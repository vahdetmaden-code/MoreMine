import { useEffect } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';

/*
 * DOKUNMA YALITIMI (iPad / telefon)
 * =================================
 * SORUN: Bütün paneller (Katmanlar, v2/v3/v4, Rapor, Tarihçe, Parsel, araç
 * çubuğu) harita KABININ İÇİNDE duruyor. Leaflet kabın üzerindeki her
 * dokunuşu "haritayı kaydır" diye yorumladığı için iPad'de:
 *   - uzun panelde parmakla aşağı kaydırmaya çalışınca panel değil HARİTA kayıyor,
 *   - butona basarken parmak 1-2 piksel kayarsa dokunuş "sürükleme" sayılıp
 *     tıklama düşüyor,
 *   - panele çift dokunma haritayı yakınlaştırıyor.
 * Fare ile belli olmuyor çünkü masaüstünde tekerlek/çift tık davranışı farklı.
 *
 * ÇÖZÜM: Harita kabının DOĞRUDAN çocuğu olan kendi panellerimize Leaflet'in
 * olay yalıtımını uyguluyoruz. Paneller React tarafından sonradan
 * eklenip kaldırıldığı için MutationObserver ile izliyoruz.
 *
 * Hiçbir panel dosyasına dokunmadan çalışır; analiz mantığına etkisi yoktur.
 */

export default function DokunmaYalitimi() {
  const map = useMap();

  useEffect(() => {
    const kap = map.getContainer();
    const islenenler = new WeakSet();

    const bizimPanelMi = (dugum) => {
      if (!(dugum instanceof HTMLElement)) return false;
      if (dugum.tagName !== 'DIV') return false;
      // Leaflet'in kendi katman/kontrol kapları dokunulmaz
      const sinif = String(dugum.className || '');
      return !sinif.includes('leaflet-');
    };

    const uygula = () => {
      for (const cocuk of Array.from(kap.children)) {
        if (!bizimPanelMi(cocuk) || islenenler.has(cocuk)) continue;
        islenenler.add(cocuk);

        // Tıklama ve tekerlek olaylarının haritaya geçmesini engelle
        L.DomEvent.disableClickPropagation(cocuk);
        L.DomEvent.disableScrollPropagation(cocuk);

        // Dokunmatik: sürükleme haritayı kaydırmasın.
        // passive:true — preventDefault ÇAĞIRMIYORUZ, yani panelin kendi
        // scroll'u normal çalışmaya devam eder; sadece olay yukarı gitmez.
        const durdur = (olay) => olay.stopPropagation();
        cocuk.addEventListener('touchstart', durdur, { passive: true });
        cocuk.addEventListener('touchmove', durdur, { passive: true });
        cocuk.addEventListener('touchend', durdur, { passive: true });

        // iOS'ta çift dokunma yakınlaştırmasını panel üzerinde kapat
        cocuk.style.touchAction = cocuk.style.touchAction || 'pan-y';
      }
    };

    uygula();
    const gozlemci = new MutationObserver(uygula);
    gozlemci.observe(kap, { childList: true });
    return () => gozlemci.disconnect();
  }, [map]);

  return null;
}
