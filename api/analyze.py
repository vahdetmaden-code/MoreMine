from http.server import BaseHTTPRequestHandler
import json
import os
import ee
import requests
from datetime import datetime, timedelta
from google.oauth2 import service_account

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_ANON_KEY")

_ee_hazir = False


def gee_baslat():
    global _ee_hazir
    if _ee_hazir:
        return
    key_json = os.environ.get("GEE_SERVICE_ACCOUNT_JSON")
    if not key_json:
        raise RuntimeError("GEE_SERVICE_ACCOUNT_JSON ortam değişkeni ayarlanmamış.")
    bilgiler = json.loads(key_json)
    credentials = service_account.Credentials.from_service_account_info(
        bilgiler, scopes=['https://www.googleapis.com/auth/earthengine']
    )
    ee.Initialize(credentials)
    _ee_hazir = True


def kullanici_bilgisini_al(kullanici_token):
    """Token'dan kullanıcı id'sini ve profilini (aktif/limit) çeker."""
    kullanici_yaniti = requests.get(
        f"{SUPABASE_URL}/auth/v1/user",
        headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {kullanici_token}"},
        timeout=8,
    )
    if kullanici_yaniti.status_code != 200:
        raise RuntimeError("Oturum doğrulanamadı, lütfen tekrar giriş yap.")
    kullanici_id = kullanici_yaniti.json().get("id")

    profil_yaniti = requests.get(
        f"{SUPABASE_URL}/rest/v1/profiller?id=eq.{kullanici_id}&select=aktif,tarama_limiti",
        headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {kullanici_token}"},
        timeout=8,
    )
    profiller = profil_yaniti.json()
    if not profiller:
        raise RuntimeError("Kullanıcı profili bulunamadı.")
    return kullanici_id, profiller[0]


def limit_kontrolu_yap(kullanici_id, tarama_limiti, kullanici_token, hariç_id):
    if tarama_limiti is None:
        return  # sınırsız
    sayim_yaniti = requests.get(
        f"{SUPABASE_URL}/rest/v1/taramalar?kullanici_id=eq.{kullanici_id}&id=neq.{hariç_id}&select=id",
        headers={
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {kullanici_token}",
            "Prefer": "count=exact",
        },
        timeout=8,
    )
    mevcut_sayi = len(sayim_yaniti.json())
    if mevcut_sayi >= tarama_limiti:
        raise RuntimeError(f"Tarama limitine ulaştın ({tarama_limiti}). Daha fazla tarama için yöneticinle iletişime geç.")


def altin_anomali_vektor_uret(koordinatlar):
    gee_baslat()

    kord_listesi = [[k['lng'], k['lat']] for k in koordinatlar]
    aoi = ee.Geometry.Polygon([kord_listesi])

    # ÖNEMLİ DÜZELTME (2. sürüm): Önceki "90 gün yetmezse 6 aya atla" mantığı
    # ANİ ve TUTARSIZ sonuçlara yol açıyordu — sınırda bir görüntü daha/az
    # bulununca sistem aniden bambaşka bir görüntü setine geçip sınıflandırmayı
    # baştan aşağı değiştiriyordu. Artık TEK ve SABİT bir kural var: her zaman
    # son 6 aylık pencereden, bulut oranına göre EN TEMİZ 10 görüntü seçiliyor.
    # Bu, hem güncel hem de gün be gün tutarlı bir sonuç verir.
    bugun = datetime.utcnow()
    baslangic_tarihi = (bugun - timedelta(days=180)).strftime('%Y-%m-%d')
    bitis_tarihi = (bugun + timedelta(days=1)).strftime('%Y-%m-%d')

    s2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED') \
        .filterBounds(aoi) \
        .filterDate(baslangic_tarihi, bitis_tarihi) \
        .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 70)) \
        .sort('CLOUDY_PIXEL_PERCENTAGE') \
        .limit(10)

    def maskS2(image):
        scl = image.select('SCL')
        mask = (scl.neq(0).multiply(scl.neq(1)).multiply(scl.neq(3))
                .multiply(scl.neq(8)).multiply(scl.neq(9))
                .multiply(scl.neq(10)).multiply(scl.neq(11)))
        return image.updateMask(mask).select(
            ['B2', 'B3', 'B4', 'B8', 'B8A', 'B11', 'B12']
        ).divide(10000)

    # ÖNEMLİ DÜZELTME: tüm bantları tek, sabit 10 metrelik bir ızgaraya oturtuyoruz.
    # Farklı çözünürlükteki bantları (10m / 20m) hizasız bırakmak, önceki denemede
    # gördüğün o anlamsız derecede büyük/kaba kareleri üretiyordu.
    ORTAK_CRS = 'EPSG:3857'
    ORTAK_OLCEK = 15  # Hız/detay dengesi için 15m (Sentinel-2 SWIR bantlarının gerçek çözünürlüğüne yakın)

    img = s2.map(maskS2).median().clip(aoi) \
        .reproject(crs=ORTAK_CRS, scale=ORTAK_OLCEK)

    blue, green, red = img.select('B2'), img.select('B3'), img.select('B4')
    nir, nir8a = img.select('B8'), img.select('B8A')
    swir1, swir2 = img.select('B11'), img.select('B12')

    # --- Maskeler: su / bitki ---
    ndvi = img.normalizedDifference(['B8', 'B4'])
    mndwi = img.normalizedDifference(['B3', 'B11'])

    suMaskesi = mndwi.gt(0.15)
    bitkiMaskesi = ndvi.gt(0.25)
    # NOT: NDBI tabanlı "yerleşim" maskesi BİLEREK kaldırıldı. NDBI, beton/asfaltı
    # çıplak kaya/toprak/taş ocağından spektral olarak ayırt edemiyor (ikisi de
    # SWIR bandında benzer davranıyor) — bu yüzden tam da bu aracın analiz etmesi
    # gereken taş ocağı/maden sahası gibi alanları yanlışlıkla "yerleşim" sanıp
    # engelliyordu. Artık sadece su ve bitki hariç tutuluyor; bina/beton üzerinde
    # ara sıra anlamsız sinyal çıkabilir ama bu, kullanıcının kendi gözüyle
    # eleyebileceği çok daha küçük bir sorun.
    gecerliMaske = suMaskesi.Or(bitkiMaskesi).Not()

    # Bu alanda hiç analiz edilebilir (çıplak toprak/kaya) piksel kalmış mı diye kontrol et.
    # Kontrol etmezsek, tamamen orman/su/yerleşim olan bir alanda Earth Engine null
    # değerler üzerinde işlem yapmaya çalışıp anlaşılmaz bir hatayla çöküyor.
    # --- TEŞHİS: hangi maskenin ne kadar alanı kapladığını ayrı ayrı say ---
    # (Bu sayılar aynı bölgede art arda "veri yok" hatası almaya devam edersek
    # kör tahmin yerine kesin sebebi görmek için eklendi.)
    toplam_sayim = ndvi.rename('t').reduceRegion(
        reducer=ee.Reducer.count(), geometry=aoi, crs=ORTAK_CRS, scale=ORTAK_OLCEK,
        maxPixels=1e10, bestEffort=True, tileScale=4,
    )
    su_sayim = suMaskesi.selfMask().rename('s').reduceRegion(
        reducer=ee.Reducer.count(), geometry=aoi, crs=ORTAK_CRS, scale=ORTAK_OLCEK,
        maxPixels=1e10, bestEffort=True, tileScale=4,
    )
    bitki_sayim = bitkiMaskesi.selfMask().rename('b').reduceRegion(
        reducer=ee.Reducer.count(), geometry=aoi, crs=ORTAK_CRS, scale=ORTAK_OLCEK,
        maxPixels=1e10, bestEffort=True, tileScale=4,
    )
    toplam_piksel = toplam_sayim.get('t').getInfo() or 0
    su_piksel = su_sayim.get('s').getInfo() or 0
    bitki_piksel = bitki_sayim.get('b').getInfo() or 0

    gecerli_sayim = gecerliMaske.selfMask().reduceRegion(
        reducer=ee.Reducer.count(),
        geometry=aoi, crs=ORTAK_CRS, scale=ORTAK_OLCEK, maxPixels=1e10, bestEffort=True, tileScale=4,
    )
    gecerli_piksel_adedi = list(gecerli_sayim.getInfo().values())[0] if gecerli_sayim.getInfo() else 0
    if gecerli_piksel_adedi < 15:
        raise RuntimeError(
            "TEŞHİS BİLGİSİ -> "
            f"toplam piksel (bulut/veri maskesinden geçen): {toplam_piksel}, "
            f"su sayılan: {su_piksel}, bitki sayılan: {bitki_piksel}, "
            f"geçerli (analiz edilebilir): {gecerli_piksel_adedi}. "
            "Bu sayılara göre hangi maskenin/veri eksikliğinin sorumlu olduğunu tespit edeceğiz."
        )

    # --- Altın ile ilişkili alterasyon indeksleri ---
    demirOksit = red.divide(blue.add(0.0001)).rename('d')
    killiAlterasyon = swir1.divide(swir2.add(0.0001)).rename('k')
    ferrozMineral = swir2.divide(nir8a.add(0.0001)).rename('f')

    # HIZ İYİLEŞTİRMESİ: üç indeksin istatistiğini AYRI AYRI değil TEK reduceRegion
    # çağrısında (çok bantlı görüntü olarak) hesaplıyoruz -> Earth Engine'e daha az
    # ağ isteği, daha hızlı yanıt.
    uclu = demirOksit.addBands(killiAlterasyon).addBands(ferrozMineral)
    istatistikler = uclu.updateMask(gecerliMaske).reduceRegion(
        reducer=ee.Reducer.percentile([5, 95]),
        geometry=aoi, crs=ORTAK_CRS, scale=ORTAK_OLCEK,
        maxPixels=1e10, bestEffort=True, tileScale=4,
    )

    def normalizeEt(image, band_adi):
        p5 = ee.Number(istatistikler.get(band_adi + '_p5'))
        p95 = ee.Number(istatistikler.get(band_adi + '_p95'))
        genislik = ee.Number(p95.subtract(p5)).max(0.0001)
        return image.subtract(p5).divide(genislik).clamp(0, 1)

    d = normalizeEt(demirOksit, 'd')
    k = normalizeEt(killiAlterasyon, 'k')
    f = normalizeEt(ferrozMineral, 'f')

    skor = d.multiply(0.40).add(k.multiply(0.40)).add(f.multiply(0.20)).updateMask(gecerliMaske)

    skorPuruzsuz = skor.focal_median(radius=15, units='meters', kernelType='circle') \
        .reproject(crs=ORTAK_CRS, scale=ORTAK_OLCEK)

    stats2 = skorPuruzsuz.reduceRegion(
        reducer=ee.Reducer.percentile([50, 75, 90, 97]),
        geometry=aoi, crs=ORTAK_CRS, scale=ORTAK_OLCEK,
        maxPixels=1e10, bestEffort=True, tileScale=4,
    )
    bandAdi = skorPuruzsuz.bandNames().get(0)
    e50 = ee.Number(stats2.get(ee.String(bandAdi).cat('_p50')))
    e75 = ee.Number(stats2.get(ee.String(bandAdi).cat('_p75')))
    e90 = ee.Number(stats2.get(ee.String(bandAdi).cat('_p90')))
    e97 = ee.Number(stats2.get(ee.String(bandAdi).cat('_p97')))

    siniflandirilmis = ee.Image(0) \
        .where(skorPuruzsuz.gt(e50), 1) \
        .where(skorPuruzsuz.gt(e75), 2) \
        .where(skorPuruzsuz.gt(e90), 3) \
        .where(skorPuruzsuz.gt(e97), 4) \
        .updateMask(gecerliMaske) \
        .rename('sinif') \
        .toInt() \
        .reproject(crs=ORTAK_CRS, scale=ORTAK_OLCEK)

    # --- PİKSEL DEĞİL, VEKTÖR POLİGON ÇIKTISI ---
    vektorler = siniflandirilmis.reduceToVectors(
        geometry=aoi,
        crs=ORTAK_CRS,
        scale=ORTAK_OLCEK,
        geometryType='polygon',
        labelProperty='sinif',
        reducer=ee.Reducer.countEvery(),
        maxPixels=1e10,
        bestEffort=True,
        eightConnected=True,
        tileScale=4,
    )

    def kenariYumusat(f):
        return f.setGeometry(f.geometry().simplify(8))

    vektorler = vektorler.map(kenariYumusat)

    return vektorler.getInfo()


def supabase_guncelle(kayit_id, alanlar, kullanici_token=None):
    if not (SUPABASE_URL and SUPABASE_KEY and kayit_id):
        return "SUPABASE_URL/KEY veya kayit_id eksik"
    try:
        yanit = requests.patch(
            f"{SUPABASE_URL}/rest/v1/taramalar?id=eq.{kayit_id}",
            headers={
                "apikey": SUPABASE_KEY,
                "Authorization": f"Bearer {kullanici_token or SUPABASE_KEY}",
                "Content-Type": "application/json",
                "Prefer": "return=minimal",
            },
            json=alanlar,
            timeout=10,
        )
        if yanit.status_code >= 300:
            return f"Supabase PATCH hatası ({yanit.status_code}): {yanit.text[:300]}"
        return None
    except Exception as e:
        return f"İstek hatası: {e}"


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        kayit_id = None
        kullanici_token = None
        try:
            auth_header = self.headers.get('Authorization', '')
            if auth_header.startswith('Bearer '):
                kullanici_token = auth_header[len('Bearer '):]

            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length)
            veri = json.loads(body)
            kayit_id = veri.get('id')
            koordinatlar = veri['koordinatlar']

            if not kullanici_token:
                raise RuntimeError("Oturum bilgisi eksik, lütfen tekrar giriş yap.")

            kullanici_id, profil = kullanici_bilgisini_al(kullanici_token)
            if not profil.get('aktif', True):
                raise RuntimeError("Hesabın devre dışı bırakılmış. Yöneticinle iletişime geç.")
            limit_kontrolu_yap(kullanici_id, profil.get('tarama_limiti'), kullanici_token, kayit_id)

            geojson = altin_anomali_vektor_uret(koordinatlar)
            kayit_hatasi = supabase_guncelle(kayit_id, {"durum": "Tamamlandı", "sonuc": geojson}, kullanici_token)

            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({
                "basarili": True,
                "sonuc": geojson,
                "kayit_hatasi": kayit_hatasi,  # None ise kayıt başarılı demektir
            }).encode())

        except Exception as e:
            supabase_guncelle(kayit_id, {"durum": "Hata", "hata_mesaji": str(e)}, kullanici_token)
            self.send_response(500)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"basarili": False, "hata": str(e)}).encode())