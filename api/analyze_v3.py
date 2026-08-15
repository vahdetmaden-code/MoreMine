from http.server import BaseHTTPRequestHandler
import json
import os
import ee
import requests
from datetime import datetime, timedelta
from google.oauth2 import service_account

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_ANON_KEY")

# =====================================================================
# ANALIZ MOTORU v3 — CROSTA PCA + DEMIR/KIL BIRLIKTELIGI
# =====================================================================
# api/analyze.py ve api/analyze_v2.py'ye HIC DOKUNULMAZ.
#
# v3'un cozdugu sorun:
#
#   v1 ve v2, band oranlarinin AGIRLIKLI TOPLAMINI aliyor. Toplamda tek
#   basina guclu bir demir sinyali, kil hic olmasa bile skoru yukari
#   cekebiliyor. Yani "demir yuksek + kil yok" olan bir dere yatagi
#   alüvyonu ile "demir yuksek + kil yuksek" olan bir gossan ayni skoru
#   alabiliyor.
#
#   ALTINI DEMIRDEN AYIRAN SEY DEMIRIN FAZLALIGI DEGIL, KILIN DEMIRE
#   ESLIK ETMESIDIR. Cunku altin tasiyan asidik hidrotermal sivilar
#   kayaci bozup KIL uretir. Demir yatagi veya kirmizi toprak cevresinde
#   kil halesi olmaz.
#
# v3 iki degisiklik yapiyor:
#
#   1) CROSTA (yonlendirilmis PCA): band oranlari yerine temel bilesen
#      analizi. Demir oksit ve hidroksil (kil) sinyallerini BIRBIRINDEN
#      BAGIMSIZ iki ayri bilesen olarak cikariyor. Band orani bunlari
#      ayiramiyor cunku ayni bantlari paylasiyorlar.
#
#   2) BIRLIKTELIK KURALI: skor toplam degil CARPIM.
#         demir yuksek + kil yuksek  -> altin adayi
#         demir yuksek + kil yok     -> demir/toprak/aluvyon, ELE
#         kil yuksek + demir yok     -> alakasiz killesme, ELE
#      Carpim kullanmak sart: biri sifirsa sonuc sifir olmali. Toplamda
#      tek guclu sinyal digerinin yoklugunu gizler.
# =====================================================================

ORTAK_CRS = 'EPSG:3857'
ORTAK_OLCEK = 10
PCA_OLCEK = 30            # PCA istatistigi icin - 10 m gereksiz pahali
BOLGESEL_OLCEK = 120
BOLGESEL_TAMPON = 25000

# Crosta band setleri.
# Klasik Crosta Landsat TM1,3,4,5 / TM1,3,4,7 ikilisini kullanir.
# Sentinel-2 karsiliklari:
# Klasik Crosta band setleri (Landsat TM karsiliklariyla):
#   Hidroksil/kil : TM 1,4,5,7  -> B2, B8A, B11, B12
#       Kil 2.2 um'de SOGURUR (B12 dusuk), 1.6 um'de YANSITIR (B11 yuksek).
#       Ayirt edici kontrast B11 vs B12'dir.
#   Demir oksit   : TM 1,3,4,5  -> B2, B4, B8A, B11
#       Demir oksit kirmizida (B4) YANSITIR, mavide (B2) SOGURUR.
#
# ILK SURUMDE kil setinde B4/B8A kontrasti kullaniyordum; bu mineralojik
# olarak yanlisti ve kil sinyalini zayiflatiyordu.
KIL_BANTLARI = ['B2', 'B8A', 'B11', 'B12']
KIL_HEDEF, KIL_KARSIT = 2, 3        # B11 parlak, B12 karanlik

DEMIR_BANTLARI = ['B2', 'B4', 'B8A', 'B11']
DEMIR_HEDEF, DEMIR_KARSIT = 1, 0    # B4 parlak, B2 karanlik

# Varyans payi bunun altinda kalan bilesenler gurultu sayilir.
# Ozvektorler birim uzunlukta oldugu icin bir GURULTU bileseni de buyuk
# yuklere sahip gorunebiliyor; varyans suzgeci olmadan secim onu kapiyordu.
MIN_VARYANS_PAYI = 0.02

HASSASIYET_YUZDELIK = {
    'yuksek': [70, 84, 93, 98],
    'orta':   [85, 93, 97, 99],
    'dusuk':  [93, 96, 98, 99],
}

# Birliktelik agirligi: skorun ne kadari carpim kuralindan gelsin.
# 1.0 = tamamen birliktelik (en katı). 0.7 birakiyoruz ki tek basina cok
# guclu bir sinyal tamamen kaybolmasin ama belirgin sekilde geri dussun.
BIRLIKTELIK_AGIRLIGI = 0.7

_ee_hazir = False


def gee_baslat():
    global _ee_hazir
    if _ee_hazir:
        return
    key_json = os.environ.get("GEE_SERVICE_ACCOUNT_JSON")
    if not key_json:
        raise RuntimeError("GEE_SERVICE_ACCOUNT_JSON ortam değişkeni ayarlanmamış.")
    credentials = service_account.Credentials.from_service_account_info(
        json.loads(key_json),
        scopes=['https://www.googleapis.com/auth/earthengine'],
    )
    ee.Initialize(credentials)
    _ee_hazir = True


def kullanici_bilgisini_al(kullanici_token):
    kullanici_yaniti = requests.get(
        f"{SUPABASE_URL}/auth/v1/user",
        headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {kullanici_token}"},
        timeout=8,
    )
    if kullanici_yaniti.status_code != 200:
        raise RuntimeError("Oturum doğrulanamadı, lütfen tekrar giriş yap.")
    kullanici_id = kullanici_yaniti.json().get("id")

    profil_yaniti = requests.get(
        f"{SUPABASE_URL}/rest/v1/profiller?id=eq.{kullanici_id}&select=aktif,rol",
        headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {kullanici_token}"},
        timeout=8,
    )
    profiller = profil_yaniti.json()
    if not profiller:
        raise RuntimeError("Kullanıcı profili bulunamadı.")
    return kullanici_id, profiller[0]


# ---------------------------------------------------------------------
# CROSTA — YONLENDIRILMIS TEMEL BILESEN ANALIZI
# ---------------------------------------------------------------------

def temel_bilesenler(goruntu, bantlar, bolge, maske):
    """
    Verilen band setinin temel bilesenlerini hesaplar ve
    (bilesen_goruntusu, ozvektor_matrisi) dondurur.

    Ozvektorler Python tarafina cekiliyor cunku HANGI bilesenin aradigimiz
    mineral oldugunu yuklerin isaretine bakarak secmemiz gerekiyor —
    bu Crosta yonteminin can alici noktasi. Bilesen sirasi sabit degildir,
    her goruntude degisebilir.
    """
    img = goruntu.select(bantlar).updateMask(maske)

    ortalamalar = img.reduceRegion(
        reducer=ee.Reducer.mean(), geometry=bolge,
        crs=ORTAK_CRS, scale=PCA_OLCEK,
        maxPixels=1e10, bestEffort=True, tileScale=4,
    )
    merkezli = img.subtract(ee.Image.constant(ortalamalar.values(bantlar)))

    diziler = merkezli.toArray()
    kovaryans = diziler.reduceRegion(
        reducer=ee.Reducer.centeredCovariance(), geometry=bolge,
        crs=ORTAK_CRS, scale=PCA_OLCEK,
        maxPixels=1e10, bestEffort=True, tileScale=4,
    )
    kov_dizi = ee.Array(kovaryans.get('array'))
    ozcozum = kov_dizi.eigen()                 # [n, n+1]
    ozdegerler = ozcozum.slice(1, 0, 1)        # ilk sutun = ozdegerler
    ozvektorler = ozcozum.slice(1, 1)          # gerisi = ozvektorler (satir = bilesen)

    yukler = ozvektorler.getInfo()
    ozdeger_listesi = [satir[0] for satir in ozdegerler.getInfo()]

    bilesenler = ee.Image(ozvektorler) \
        .matrixMultiply(diziler.toArray(1)) \
        .arrayProject([0]) \
        .arrayFlatten([[f'pc{i + 1}' for i in range(len(bantlar))]])

    return bilesenler, yukler, ozdeger_listesi


def crosta_bileseni_sec(ozdegerler, yukler, hedef_ix, karsit_ix):
    """
    Aradigimiz mineral hangi temel bilesende?

    UC ELEME, sirayla:

      1) ALBEDO ELEMESI — tum yukleri AYNI ISARETLI olan bilesen genel
         parlakliktir, mineraloji tasimaz.
         DIKKAT: "PC1'i atla" demek YANLISTIR. Ilk surumde oyle yapiyordum
         ve testte PC1'in gercek demir bileseni oldugu (korelasyon +1.00)
         ortaya cikti. Albedo'yu SIRA ile degil ISARET DESENI ile taniyoruz.

      2) GURULTU ELEMESI — varyans payi MIN_VARYANS_PAYI altindakiler.
         Ozvektorler birim uzunlukta oldugu icin son bilesenler de buyuk
         yuke sahip gorunur; varyans suzgeci olmadan secim onlari kapiyordu.

      3) CROSTA KONTRASTI — hedef mineralin parlak oldugu band ile karanlik
         oldugu band ZIT ISARETLI olmali. Puan varyans payiyla agirliklanir.

    Doner: (bilesen_indeksi, isaret_carpani, hedef_yuk_buyuklugu)
      isaret_carpani: hedef bandin yuku negatifse -1; boylece YUKSEK deger
      her zaman COK mineral demek olur.
      hedef_yuk_buyuklugu: guven gostergesi. 0.5+ saglam, 0.3 alti supheli.
    """
    toplam = sum(ozdegerler) or 1.0
    en_iyi_ix, en_iyi_puan, en_iyi_isaret, en_iyi_yuk = None, -1.0, 1, 0.0

    for i, (ozdeger, satir) in enumerate(zip(ozdegerler, yukler)):
        pay = ozdeger / toplam
        if pay < MIN_VARYANS_PAYI:
            continue
        if all(x > 0 for x in satir) or all(x < 0 for x in satir):
            continue                                   # albedo
        h, k = satir[hedef_ix], satir[karsit_ix]
        if h == 0 or k == 0 or (h > 0) == (k > 0):
            continue                                   # Crosta kontrasti yok
        puan = (abs(h) + abs(k)) * (pay ** 0.5)
        if puan > en_iyi_puan:
            en_iyi_ix, en_iyi_puan = i, puan
            en_iyi_isaret, en_iyi_yuk = (1 if h > 0 else -1), abs(h)

    if en_iyi_ix is None:
        # Uygun bilesen yok: en cok varyansli ikinci bilesene dus, yonu hedefe gore ayarla
        yedek = 1 if len(yukler) > 1 else 0
        return yedek, (1 if yukler[yedek][hedef_ix] > 0 else -1), abs(yukler[yedek][hedef_ix])

    return en_iyi_ix, en_iyi_isaret, en_iyi_yuk


def bolgesel_normalize(goruntu, bolge, maske):
    """0-1 arasina cek: alt %2 ve ust %98 bolgeden alinir."""
    istatistik = goruntu.updateMask(maske).reduceRegion(
        reducer=ee.Reducer.percentile([2, 98]), geometry=bolge,
        crs=ORTAK_CRS, scale=BOLGESEL_OLCEK,
        maxPixels=1e10, bestEffort=True, tileScale=4,
    )
    anahtarlar = istatistik.keys()
    p2 = ee.Number(istatistik.get(anahtarlar.get(0)))
    p98 = ee.Number(istatistik.get(anahtarlar.get(1)))
    genislik = p98.subtract(p2).max(1e-6)
    return goruntu.subtract(p2).divide(genislik).clamp(0, 1)


# ---------------------------------------------------------------------
# ANA MOTOR
# ---------------------------------------------------------------------

def analiz_v3(koordinatlar, hassasiyet='orta', yerlesim_maskesi=True):
    gee_baslat()

    yuzdelikler = HASSASIYET_YUZDELIK.get(hassasiyet, HASSASIYET_YUZDELIK['orta'])

    aoi = ee.Geometry.Polygon([[[k['lng'], k['lat']] for k in koordinatlar]])
    bolge = aoi.buffer(BOLGESEL_TAMPON)

    bugun = datetime.utcnow()
    baslangic = (bugun - timedelta(days=180)).strftime('%Y-%m-%d')
    bitis = (bugun + timedelta(days=1)).strftime('%Y-%m-%d')

    s2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED') \
        .filterBounds(aoi) \
        .filterDate(baslangic, bitis) \
        .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 70)) \
        .sort('CLOUDY_PIXEL_PERCENTAGE') \
        .limit(10)

    zaman_damgalari = s2.aggregate_array('system:time_start').getInfo()
    kullanilan_tarihler = sorted({
        datetime.utcfromtimestamp(t / 1000).strftime('%Y-%m-%d') for t in zaman_damgalari
    })
    if not kullanilan_tarihler:
        raise RuntimeError("Bu alan ve tarih aralığında kullanılabilir Sentinel-2 görüntüsü bulunamadı.")

    def maskS2(image):
        scl = image.select('SCL')
        temiz = (scl.neq(0).multiply(scl.neq(1)).multiply(scl.neq(3))
                 .multiply(scl.neq(8)).multiply(scl.neq(9))
                 .multiply(scl.neq(10)).multiply(scl.neq(11)))
        return image.updateMask(temiz).select(
            ['B2', 'B3', 'B4', 'B8', 'B8A', 'B11', 'B12']
        ).divide(10000)

    medyan = s2.map(maskS2).median()

    # --- Maskeler ---
    ndvi = medyan.normalizedDifference(['B8', 'B4'])
    mndwi = medyan.normalizedDifference(['B3', 'B11'])
    gecerliMaske = mndwi.gt(0.15).Or(ndvi.gt(0.25)).Not()

    if yerlesim_maskesi:
        ortu = ee.ImageCollection('ESA/WorldCover/v200').first().select('Map')
        gecerliMaske = gecerliMaske.And(ortu.neq(50))

    # --- CROSTA: kil ve demir bilesenlerini AYRI AYRI cikar ---
    kil_pc, kil_yukler, kil_ozd = temel_bilesenler(medyan, KIL_BANTLARI, bolge, gecerliMaske)
    kil_ix, kil_isaret, kil_guven = crosta_bileseni_sec(
        kil_ozd, kil_yukler, KIL_HEDEF, KIL_KARSIT)
    kil_ham = kil_pc.select(kil_ix).multiply(kil_isaret).rename('kil')

    demir_pc, demir_yukler, demir_ozd = temel_bilesenler(medyan, DEMIR_BANTLARI, bolge, gecerliMaske)
    demir_ix, demir_isaret, demir_guven = crosta_bileseni_sec(
        demir_ozd, demir_yukler, DEMIR_HEDEF, DEMIR_KARSIT)
    demir_ham = demir_pc.select(demir_ix).multiply(demir_isaret).rename('demir')

    kil = bolgesel_normalize(kil_ham, bolge, gecerliMaske).rename('kil')
    demir = bolgesel_normalize(demir_ham, bolge, gecerliMaske).rename('demir')

    # --- BIRLIKTELIK: geometrik ortalama ---
    # Geometrik ortalama sec(ildi) cunku biri sifira yaklastiginda sonuc de
    # sifira gider — aritmetik ortalamada tek guclu sinyal digerini gizlerdi.
    birliktelik = demir.multiply(kil).sqrt().rename('birliktelik')

    # Tek basina guclu sinyaller tamamen kaybolmasin diye kismi agirlik
    aritmetik = demir.add(kil).divide(2)
    skor = birliktelik.multiply(BIRLIKTELIK_AGIRLIGI) \
        .add(aritmetik.multiply(1 - BIRLIKTELIK_AGIRLIGI)) \
        .updateMask(gecerliMaske).rename('skor')

    skor_puruzsuz = skor.focal_median(radius=25, units='meters', kernelType='circle') \
        .reproject(crs=ORTAK_CRS, scale=ORTAK_OLCEK)

    # --- Bolgesel esikler ---
    bolgesel = skor.updateMask(gecerliMaske).reduceRegion(
        reducer=ee.Reducer.percentile(yuzdelikler), geometry=bolge,
        crs=ORTAK_CRS, scale=BOLGESEL_OLCEK,
        maxPixels=1e10, bestEffort=True, tileScale=4,
    ).getInfo()

    esikler = {}
    for sira, yuzde in enumerate(yuzdelikler, start=1):
        deger = bolgesel.get(f'skor_p{yuzde}')
        esikler[sira] = round(float(deger), 4) if deger is not None else None
    if esikler.get(1) is None:
        raise RuntimeError("Bölgesel referans hesaplanamadı; çevrede yeterli çıplak zemin yok olabilir.")
    for sira in (2, 3, 4):
        if esikler.get(sira) is None or esikler[sira] <= esikler[sira - 1]:
            esikler[sira] = round(esikler[sira - 1] + 0.001, 4)

    # --- AYRIM TESHISI: v3'un asil cevabi ---
    # "Demir var ama kil yok" olan pikseller v1/v2'de anomali cikardi,
    # v3'te elenmeli. Bu sayilar tam olarak bunu olcuyor.
    AYRIM_ESIK = 0.6

    def piksel_say(maske_img):
        sonuc = maske_img.selfMask().rename('n').reduceRegion(
            reducer=ee.Reducer.count(), geometry=aoi,
            crs=ORTAK_CRS, scale=ORTAK_OLCEK,
            maxPixels=1e10, bestEffort=True, tileScale=4,
        ).getInfo()
        return sonuc.get('n') or 0

    demir_yuksek = demir.gt(AYRIM_ESIK).And(gecerliMaske)
    kil_yuksek = kil.gt(AYRIM_ESIK).And(gecerliMaske)

    ayrim = {
        'gecerli_zemin': piksel_say(gecerliMaske),
        'demir_ve_kil': piksel_say(demir_yuksek.And(kil_yuksek)),      # altin adayi
        'sadece_demir': piksel_say(demir_yuksek.And(kil_yuksek.Not())),  # elenen
        'sadece_kil': piksel_say(kil_yuksek.And(demir_yuksek.Not())),
    }

    # --- Siniflandirma ---
    siniflar = ee.Image(0) \
        .where(skor_puruzsuz.gt(esikler[1]), 1) \
        .where(skor_puruzsuz.gt(esikler[2]), 2) \
        .where(skor_puruzsuz.gt(esikler[3]), 3) \
        .where(skor_puruzsuz.gt(esikler[4]), 4) \
        .updateMask(gecerliMaske) \
        .updateMask(skor_puruzsuz.gt(esikler[1])) \
        .rename('sinif').toInt() \
        .reproject(crs=ORTAK_CRS, scale=ORTAK_OLCEK)

    cok_bantli = siniflar \
        .addBands(skor_puruzsuz.rename('skor')) \
        .addBands(demir.rename('demir')) \
        .addBands(kil.rename('kil')) \
        .addBands(birliktelik.rename('birliktelik'))

    vektorler = cok_bantli.reduceToVectors(
        geometry=aoi, crs=ORTAK_CRS, scale=ORTAK_OLCEK,
        geometryType='polygon', labelProperty='sinif',
        reducer=ee.Reducer.mean(),
        maxPixels=1e10, bestEffort=True, eightConnected=True, tileScale=4,
    )

    def kenariYumusat(f):
        # buffer(-18) BILEREK kullanilmiyor: 36 m'den ince poligonlari yok ediyor
        g = f.geometry().simplify(8)
        return f.setGeometry(g).set('alan_m2', g.area(10))

    vektorler = vektorler.map(kenariYumusat).filter(ee.Filter.gte('alan_m2', 400))
    ham = vektorler.getInfo()

    def gecerli_mi(o):
        g = (o or {}).get('geometry') or {}
        koord = g.get('coordinates')
        if not g.get('type') or not isinstance(koord, list) or not koord:
            return False
        if g['type'] == 'Polygon':
            return isinstance(koord[0], list) and len(koord[0]) >= 4
        if g['type'] == 'MultiPolygon':
            return any(isinstance(p, list) and p and len(p[0]) >= 4 for p in koord)
        return False

    ozellikler = [o for o in (ham.get('features') or []) if gecerli_mi(o)]

    return {'type': 'FeatureCollection', 'features': ozellikler}, {
        'poligon_sayisi': len(ozellikler),
        'kullanilan_tarihler': kullanilan_tarihler,
        'goruntu_sayisi': len(kullanilan_tarihler),
        'hassasiyet': hassasiyet,
        'yuzdelikler': yuzdelikler,
        'esikler': esikler,
        'ayrim': ayrim,
        'crosta': {
            'kil_bileseni': f'PC{kil_ix + 1}',
            'demir_bileseni': f'PC{demir_ix + 1}',
            'kil_varyans': round(kil_ozd[kil_ix] / (sum(kil_ozd) or 1), 3),
            'demir_varyans': round(demir_ozd[demir_ix] / (sum(demir_ozd) or 1), 3),
            'kil_guven': round(kil_guven, 3),
            'demir_guven': round(demir_guven, 3),
            # Hedef band yuku zayifsa bilesen secimi supheli demektir;
            # kullanici sonuca ona gore baksin.
            'supheli': bool(kil_guven < 0.3 or demir_guven < 0.3),
        },
    }


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            auth = self.headers.get('Authorization', '')
            token = auth[7:] if auth.startswith('Bearer ') else None
            if not token:
                raise RuntimeError("Oturum bilgisi eksik, lütfen tekrar giriş yap.")

            uzunluk = int(self.headers.get('Content-Length', 0))
            veri = json.loads(self.rfile.read(uzunluk))

            _, profil = kullanici_bilgisini_al(token)
            if not profil.get('aktif', True):
                raise RuntimeError("Hesabın devre dışı bırakılmış.")

            geojson, bilgi = analiz_v3(
                veri['koordinatlar'],
                hassasiyet=veri.get('hassasiyet', 'orta'),
                yerlesim_maskesi=veri.get('yerlesim_maskesi', True),
            )

            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({
                "basarili": True, "sonuc": geojson, "motor": "v3", **bilgi,
            }).encode())

        except Exception as e:
            self.send_response(500)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"basarili": False, "hata": str(e)}).encode())
