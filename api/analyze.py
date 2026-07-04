from http.server import BaseHTTPRequestHandler
import json
import os
import ee
import requests
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


def altin_anomali_vektor_uret(koordinatlar):
    gee_baslat()

    kord_listesi = [[k['lng'], k['lat']] for k in koordinatlar]
    aoi = ee.Geometry.Polygon([kord_listesi])

    # Son ~18 ay içindeki, bulut oranı düşük Sentinel-2 görüntülerinin medyan bileşimi.
    s2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED') \
        .filterBounds(aoi) \
        .filterDate('2025-01-01', '2026-07-04') \
        .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 40))

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
    ORTAK_OLCEK = 10

    img = s2.map(maskS2).median().clip(aoi) \
        .reproject(crs=ORTAK_CRS, scale=ORTAK_OLCEK)

    blue, green, red = img.select('B2'), img.select('B3'), img.select('B4')
    nir, nir8a = img.select('B8'), img.select('B8A')
    swir1, swir2 = img.select('B11'), img.select('B12')

    # --- Maskeler: su / bitki / yerleşim (daha sıkı) ---
    ndvi = img.normalizedDifference(['B8', 'B4'])
    mndwi = img.normalizedDifference(['B3', 'B11'])
    ndbi = swir1.subtract(nir).divide(swir1.add(nir).add(0.0001))
    parlaklik = blue.add(green).add(red).divide(3)

    suMaskesi = mndwi.gt(0.15)
    bitkiMaskesi = ndvi.gt(0.30)
    yerlesimMaskesi = ndbi.gt(0.05).And(ndvi.lt(0.25))
    # Çatı/beton/asfalt gibi çok parlak ve bitkisiz yüzeyler için ek güvenlik
    parlakYuzeyMaskesi = parlaklik.gt(0.22).And(ndvi.lt(0.25))

    gecerliMaske = suMaskesi.Or(bitkiMaskesi).Or(yerlesimMaskesi).Or(parlakYuzeyMaskesi).Not()

    # --- Altın ile ilişkili alterasyon indeksleri ---
    demirOksit = red.divide(blue.add(0.0001))
    killiAlterasyon = swir1.divide(swir2.add(0.0001))
    ferrozMineral = swir2.divide(nir8a.add(0.0001))

    def adaptifNormalize(image, band_adi):
        stats = image.updateMask(gecerliMaske).reduceRegion(
            reducer=ee.Reducer.percentile([5, 95]),
            geometry=aoi, crs=ORTAK_CRS, scale=ORTAK_OLCEK, maxPixels=1e10, bestEffort=True
        )
        p5 = ee.Number(stats.get(band_adi + '_p5'))
        p95 = ee.Number(stats.get(band_adi + '_p95'))
        genislik = ee.Number(p95.subtract(p5)).max(0.0001)
        return image.subtract(p5).divide(genislik).clamp(0, 1)

    d = adaptifNormalize(demirOksit.rename('d'), 'd')
    k = adaptifNormalize(killiAlterasyon.rename('k'), 'k')
    f = adaptifNormalize(ferrozMineral.rename('f'), 'f')

    skor = d.multiply(0.40).add(k.multiply(0.40)).add(f.multiply(0.20)).updateMask(gecerliMaske)

    # Gürültü azaltma: artık net metre cinsinden, ortak ızgaraya oturmuş bir yarıçap
    skorPuruzsuz = skor.focal_median(radius=15, units='meters', kernelType='circle') \
        .reproject(crs=ORTAK_CRS, scale=ORTAK_OLCEK)

    stats2 = skorPuruzsuz.reduceRegion(
        reducer=ee.Reducer.percentile([50, 75, 90, 97]),
        geometry=aoi, crs=ORTAK_CRS, scale=ORTAK_OLCEK, maxPixels=1e10, bestEffort=True
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


def supabase_guncelle(kayit_id, alanlar):
    if not (SUPABASE_URL and SUPABASE_KEY and kayit_id):
        return
    try:
        requests.patch(
            f"{SUPABASE_URL}/rest/v1/taramalar?id=eq.{kayit_id}",
            headers={
                "apikey": SUPABASE_KEY,
                "Authorization": f"Bearer {SUPABASE_KEY}",
                "Content-Type": "application/json",
                "Prefer": "return=minimal",
            },
            json=alanlar,
            timeout=10,
        )
    except Exception:
        pass


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        kayit_id = None
        try:
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length)
            veri = json.loads(body)
            kayit_id = veri.get('id')
            koordinatlar = veri['koordinatlar']

            geojson = altin_anomali_vektor_uret(koordinatlar)
            supabase_guncelle(kayit_id, {"durum": "Tamamlandı", "sonuc": geojson})

            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"basarili": True, "sonuc": geojson}).encode())

        except Exception as e:
            supabase_guncelle(kayit_id, {"durum": "Hata", "hata_mesaji": str(e)})
            self.send_response(500)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"basarili": False, "hata": str(e)}).encode())
