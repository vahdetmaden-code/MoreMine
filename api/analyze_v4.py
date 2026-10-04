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
# ANALIZ MOTORU v4 — BIRLESIK DOGRULAMA
# =====================================================================
# analyze.py, analyze_v2.py ve analyze_v3.py'ye HIC DOKUNULMAZ.
#
# v4 NEDEN VAR:
#
#   v2 "bu sinyal zamanla kararli mi" sorusunu cevapliyor.
#   v3 "mineral bilesimi dogru mu" sorusunu cevapliyor.
#   Ikisini AYRI calistirip haritada cakistirmak iki sorun doguruyordu:
#
#     1) Poligon sinirlari farkli ciktigi icin "kesisim" goz karari kaliyordu;
#        guvenilir bir m2 vermek mumkun degildi.
#     2) Poligonlari geometrik olarak kesistirmek de yanlis olurdu: iki ayri
#        esikten gecmis iki sekli ust uste bindirmek, PIKSEL seviyesinde
#        gercekte ne oldugunu soylemez.
#
#   v4 ikisini TEK MOTORDA, piksel seviyesinde birlestiriyor. Bir piksel
#   v4'te isaretlenmek icin AYNI ANDA:
#     - demir ve kil birlikteligine sahip olmali  (v3'un isi)
#     - bunu birden fazla tarihte surdurmeli      (v2'nin isi)
#   Boylece cikan her poligonun m2'si ve mineral ortalamasi gercekten
#   olculmus bir sey ifade ediyor.
#
# PERFORMANS TASARIMI — onemli:
#   Crosta PCA'yi her goruntu icin ayri hesaplamak cok pahali olurdu
#   (10 goruntu x 2 band seti x kovaryans = zaman asimi).
#   Bunun yerine: ozvektorler MEDYAN BILESIKTEN BIR KEZ hesaplanir,
#   sonra AYNI donusum her goruntuye uygulanir.
#   Bu sadece hizli degil, DOGRU olan da bu: Crosta donusumunu tanimlayan
#   sey arazinin kovaryans yapisidir — bu arazinin ozelligidir, tarihe gore
#   degismez. Degisen sey aydinlatma ve nemdir. Ayni donusumu her tarihe
#   uygulamak, tam olarak "bu mineral imzasi israrla duruyor mu" sorusunu
#   test eder.
# =====================================================================

ORTAK_CRS = 'EPSG:3857'
ORTAK_OLCEK = 10
PCA_OLCEK = 30
BOLGESEL_OLCEK = 120
BOLGESEL_TAMPON = 25000

# Crosta band setleri (v3 ile birebir ayni — ayni mineraloji)
KIL_BANTLARI = ['B2', 'B8A', 'B11', 'B12']
KIL_HEDEF, KIL_KARSIT = 2, 3        # B11 parlak, B12 karanlik

DEMIR_BANTLARI = ['B2', 'B4', 'B8A', 'B11']
DEMIR_HEDEF, DEMIR_KARSIT = 1, 0    # B4 parlak, B2 karanlik

MIN_VARYANS_PAYI = 0.02

HASSASIYET_YUZDELIK = {
    'yuksek': [70, 84, 93, 98],
    'orta':   [85, 93, 97, 99],
    'dusuk':  [93, 96, 98, 99],
}

# Birliktelik agirligi: skorun ne kadari carpim kuralindan gelsin
BIRLIKTELIK_AGIRLIGI = 0.7

# Bir goruntude "mineral imzasi var" sayilmak icin gereken birliktelik esigi.
# Bolgesel yuzdelikten turetiliyor, sabit degil.
KARARLILIK_YUZDELIGI = 75

# Kararlilik carpaninin tabani. 0 yapmak fazla sert olurdu: bulut/golge
# yuzunden bir piksel bazi goruntulerde maskeli olabilir ve bu onun
# "kararsiz" oldugu anlamina gelmez.
KARARLILIK_TABANI = 0.45

GORUNTU_SAYISI = 8

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
# CROSTA — v3 ile ayni, dogrulanmis mantik
# ---------------------------------------------------------------------

def crosta_donusumu_ogren(goruntu, bantlar, bolge, maske):
    """
    Band setinin temel bilesenlerini MEDYAN BILESIKTEN ogrenir.

    Doner: (ozvektor_matrisi_ee, yukler_python, ozdegerler_python)
    Ozvektorler Python'a cekiliyor cunku hangi bilesenin aradigimiz mineral
    oldugunu yuklerin ISARETINE bakarak secmemiz gerekiyor; bilesen sirasi
    sabit degildir.
    """
    img = goruntu.select(bantlar).updateMask(maske)

    ortalamalar = img.reduceRegion(
        reducer=ee.Reducer.mean(), geometry=bolge,
        crs=ORTAK_CRS, scale=PCA_OLCEK,
        maxPixels=1e10, bestEffort=True, tileScale=4,
    )
    merkezli = img.subtract(ee.Image.constant(ortalamalar.values(bantlar)))

    kovaryans = merkezli.toArray().reduceRegion(
        reducer=ee.Reducer.centeredCovariance(), geometry=bolge,
        crs=ORTAK_CRS, scale=PCA_OLCEK,
        maxPixels=1e10, bestEffort=True, tileScale=4,
    )
    ozcozum = ee.Array(kovaryans.get('array')).eigen()
    ozdegerler_ee = ozcozum.slice(1, 0, 1)
    ozvektorler_ee = ozcozum.slice(1, 1)

    yukler = ozvektorler_ee.getInfo()
    ozdegerler = [satir[0] for satir in ozdegerler_ee.getInfo()]

    return ozvektorler_ee, yukler, ozdegerler, ortalamalar


def crosta_uygula(goruntu, bantlar, ozvektorler_ee, ortalamalar, bilesen_ix, isaret):
    """
    ONCEDEN OGRENILMIS donusumu bir goruntuye uygular ve secilen
    bileseni tek bantli goruntu olarak dondurur.

    Bu fonksiyon hem medyan bilesik hem de tek tek tarihler icin kullanilir;
    hepsi AYNI donusumden gectigi icin degerleri karsilastirilabilir olur.
    """
    merkezli = goruntu.select(bantlar).subtract(
        ee.Image.constant(ortalamalar.values(bantlar))
    )
    bilesenler = ee.Image(ozvektorler_ee) \
        .matrixMultiply(merkezli.toArray().toArray(1)) \
        .arrayProject([0]) \
        .arrayFlatten([[f'pc{i + 1}' for i in range(len(bantlar))]])
    return bilesenler.select(bilesen_ix).multiply(isaret)


def crosta_bileseni_sec(ozdegerler, yukler, hedef_ix, karsit_ix):
    """
    Aradigimiz mineral hangi temel bilesende? (v3 ile ayni, dogrulanmis)

    UC ELEME, sirayla:
      1) ALBEDO — tum yukleri AYNI ISARETLI olan bilesen genel parlakliktir.
         "PC1'i atla" demek YANLIS olurdu; albedo SIRA ile degil ISARET
         DESENI ile taninir.
      2) GURULTU — varyans payi MIN_VARYANS_PAYI altindakiler. Ozvektorler
         birim uzunlukta oldugu icin gurultu bilesenleri de buyuk yuke
         sahip gorunur.
      3) CROSTA KONTRASTI — hedef ve karsit band ZIT ISARETLI olmali.
    """
    toplam = sum(ozdegerler) or 1.0
    en_iyi_ix, en_iyi_puan, en_iyi_isaret, en_iyi_yuk = None, -1.0, 1, 0.0

    for i, (ozdeger, satir) in enumerate(zip(ozdegerler, yukler)):
        pay = ozdeger / toplam
        if pay < MIN_VARYANS_PAYI:
            continue
        if all(x > 0 for x in satir) or all(x < 0 for x in satir):
            continue
        h, k = satir[hedef_ix], satir[karsit_ix]
        if h == 0 or k == 0 or (h > 0) == (k > 0):
            continue
        puan = (abs(h) + abs(k)) * (pay ** 0.5)
        if puan > en_iyi_puan:
            en_iyi_ix, en_iyi_puan = i, puan
            en_iyi_isaret, en_iyi_yuk = (1 if h > 0 else -1), abs(h)

    if en_iyi_ix is None:
        yedek = 1 if len(yukler) > 1 else 0
        return yedek, (1 if yukler[yedek][hedef_ix] > 0 else -1), abs(yukler[yedek][hedef_ix])

    return en_iyi_ix, en_iyi_isaret, en_iyi_yuk


def bolgesel_normalize(goruntu, bolge, maske):
    """0-1 arasina cek: alt %2 ve ust %98 BOLGEDEN alinir."""
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

def analiz_v4(koordinatlar, hassasiyet='orta', yerlesim_maskesi=True):
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
        .limit(GORUNTU_SAYISI)

    zaman_damgalari = s2.aggregate_array('system:time_start').getInfo()
    kullanilan_tarihler = sorted({
        datetime.utcfromtimestamp(t / 1000).strftime('%Y-%m-%d') for t in zaman_damgalari
    })
    goruntu_sayisi = len(kullanilan_tarihler)
    if goruntu_sayisi == 0:
        raise RuntimeError("Bu alan ve tarih aralığında kullanılabilir Sentinel-2 görüntüsü bulunamadı.")

    def maskS2(image):
        scl = image.select('SCL')
        temiz = (scl.neq(0).multiply(scl.neq(1)).multiply(scl.neq(3))
                 .multiply(scl.neq(8)).multiply(scl.neq(9))
                 .multiply(scl.neq(10)).multiply(scl.neq(11)))
        return image.updateMask(temiz).select(
            ['B2', 'B3', 'B4', 'B8', 'B8A', 'B11', 'B12']
        ).divide(10000)

    s2_temiz = s2.map(maskS2)
    medyan = s2_temiz.median()

    # --- Maskeler ---
    ndvi = medyan.normalizedDifference(['B8', 'B4'])
    mndwi = medyan.normalizedDifference(['B3', 'B11'])
    gecerliMaske = mndwi.gt(0.15).Or(ndvi.gt(0.25)).Not()

    if yerlesim_maskesi:
        ortu = ee.ImageCollection('ESA/WorldCover/v200').first().select('Map')
        gecerliMaske = gecerliMaske.And(ortu.neq(50))

    # -----------------------------------------------------------------
    # 1) CROSTA DONUSUMUNU MEDYANDAN OGREN
    # -----------------------------------------------------------------
    kil_vek, kil_yuk, kil_ozd, kil_ort = crosta_donusumu_ogren(
        medyan, KIL_BANTLARI, bolge, gecerliMaske)
    kil_ix, kil_isaret, kil_guven = crosta_bileseni_sec(
        kil_ozd, kil_yuk, KIL_HEDEF, KIL_KARSIT)

    demir_vek, demir_yuk, demir_ozd, demir_ort = crosta_donusumu_ogren(
        medyan, DEMIR_BANTLARI, bolge, gecerliMaske)
    demir_ix, demir_isaret, demir_guven = crosta_bileseni_sec(
        demir_ozd, demir_yuk, DEMIR_HEDEF, DEMIR_KARSIT)

    # -----------------------------------------------------------------
    # 2) MEDYAN UZERINDE BIRLIKTELIK
    # -----------------------------------------------------------------
    kil_ham = crosta_uygula(medyan, KIL_BANTLARI, kil_vek, kil_ort, kil_ix, kil_isaret)
    demir_ham = crosta_uygula(medyan, DEMIR_BANTLARI, demir_vek, demir_ort, demir_ix, demir_isaret)

    kil = bolgesel_normalize(kil_ham, bolge, gecerliMaske).rename('kil')
    demir = bolgesel_normalize(demir_ham, bolge, gecerliMaske).rename('demir')

    # Geometrik ortalama: biri sifira yaklasinca sonuc da sifira gider.
    # Aritmetik olsaydi tek guclu sinyal digerinin yoklugunu gizlerdi.
    birliktelik = demir.multiply(kil).sqrt().rename('birliktelik')

    # -----------------------------------------------------------------
    # 3) ZAMANSAL KARARLILIK — ayni donusum her tarihe uygulanir
    # -----------------------------------------------------------------
    # Esik bolgesel dagilimdan geliyor; sabit sayi kullanmak alanin genel
    # seviyesi dusuk oldugunda her seyi eler, yuksek oldugunda hicbir sey
    # elemezdi.
    birliktelik_esik_sozluk = birliktelik.updateMask(gecerliMaske).reduceRegion(
        reducer=ee.Reducer.percentile([KARARLILIK_YUZDELIGI]), geometry=bolge,
        crs=ORTAK_CRS, scale=BOLGESEL_OLCEK,
        maxPixels=1e10, bestEffort=True, tileScale=4,
    ).getInfo()
    birliktelik_esigi = None
    for deger in birliktelik_esik_sozluk.values():
        if deger is not None:
            birliktelik_esigi = float(deger)
            break
    if birliktelik_esigi is None:
        raise RuntimeError(
            "Bölgesel referans hesaplanamadı. Çevredeki 25 km'lik alanda "
            "yeterli çıplak zemin bulunamadı olabilir."
        )

    def tek_tarih_bayrak(img):
        k = crosta_uygula(img, KIL_BANTLARI, kil_vek, kil_ort, kil_ix, kil_isaret)
        d = crosta_uygula(img, DEMIR_BANTLARI, demir_vek, demir_ort, demir_ix, demir_isaret)
        kn = bolgesel_normalize(k, bolge, gecerliMaske)
        dn = bolgesel_normalize(d, bolge, gecerliMaske)
        return dn.multiply(kn).sqrt().gt(birliktelik_esigi)

    kararlilik = s2_temiz.map(tek_tarih_bayrak).sum() \
        .divide(goruntu_sayisi).rename('kararlilik').updateMask(gecerliMaske)

    # -----------------------------------------------------------------
    # 4) BIRLESIK SKOR
    # -----------------------------------------------------------------
    taban = birliktelik.multiply(BIRLIKTELIK_AGIRLIGI) \
        .add(demir.add(kil).divide(2).multiply(1 - BIRLIKTELIK_AGIRLIGI))

    skor = taban.multiply(
        ee.Image(KARARLILIK_TABANI).add(kararlilik.multiply(1 - KARARLILIK_TABANI))
    ).updateMask(gecerliMaske).rename('skor')

    skor_puruzsuz = skor.focal_median(radius=25, units='meters', kernelType='circle') \
        .reproject(crs=ORTAK_CRS, scale=ORTAK_OLCEK)

    # -----------------------------------------------------------------
    # 5) BOLGESEL ESIKLER
    # -----------------------------------------------------------------
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
        raise RuntimeError("Bölgesel eşik hesaplanamadı.")
    for sira in (2, 3, 4):
        if esikler.get(sira) is None or esikler[sira] <= esikler[sira - 1]:
            esikler[sira] = round(esikler[sira - 1] + 0.001, 4)

    siniflar = ee.Image(0) \
        .where(skor_puruzsuz.gt(esikler[1]), 1) \
        .where(skor_puruzsuz.gt(esikler[2]), 2) \
        .where(skor_puruzsuz.gt(esikler[3]), 3) \
        .where(skor_puruzsuz.gt(esikler[4]), 4) \
        .updateMask(gecerliMaske) \
        .updateMask(skor_puruzsuz.gt(esikler[1])) \
        .rename('sinif').toInt() \
        .reproject(crs=ORTAK_CRS, scale=ORTAK_OLCEK)

    # -----------------------------------------------------------------
    # 6) TESHIS SAYIMLARI
    # -----------------------------------------------------------------
    medyanlar = demir.rename('d').addBands(kil.rename('k')) \
        .updateMask(gecerliMaske).reduceRegion(
            reducer=ee.Reducer.median(), geometry=bolge,
            crs=ORTAK_CRS, scale=BOLGESEL_OLCEK,
            maxPixels=1e10, bestEffort=True, tileScale=4,
        ).getInfo()
    demir_esik = float(medyanlar.get('d') or 0.5)
    kil_esik = float(medyanlar.get('k') or 0.5)

    def piksel_say(maske_img):
        sonuc = maske_img.selfMask().rename('n').reduceRegion(
            reducer=ee.Reducer.count(), geometry=aoi,
            crs=ORTAK_CRS, scale=ORTAK_OLCEK,
            maxPixels=1e10, bestEffort=True, tileScale=4,
        ).getInfo()
        return sonuc.get('n') or 0

    d_yuksek = demir.gt(demir_esik).And(gecerliMaske)
    k_yuksek = kil.gt(kil_esik).And(gecerliMaske)

    ayrim = {
        'gecerli_zemin': piksel_say(gecerliMaske),
        'demir_ve_kil': piksel_say(d_yuksek.And(k_yuksek)),
        'sadece_demir': piksel_say(d_yuksek.And(k_yuksek.Not())),
        'sadece_kil': piksel_say(k_yuksek.And(d_yuksek.Not())),
        'demir_esigi': round(demir_esik, 3),
        'kil_esigi': round(kil_esik, 3),
    }

    # -----------------------------------------------------------------
    # 7) VEKTORLESTIRME — her poligon kendi m2'si ve mineral ortalamasiyla
    # -----------------------------------------------------------------
    cok_bantli = siniflar \
        .addBands(skor_puruzsuz.rename('skor')) \
        .addBands(demir.rename('demir')) \
        .addBands(kil.rename('kil')) \
        .addBands(birliktelik.rename('birliktelik')) \
        .addBands(kararlilik.rename('kararlilik'))

    vektorler = cok_bantli.reduceToVectors(
        geometry=aoi, crs=ORTAK_CRS, scale=ORTAK_OLCEK,
        geometryType='polygon', labelProperty='sinif',
        reducer=ee.Reducer.mean(),
        maxPixels=1e10, bestEffort=True, eightConnected=True, tileScale=4,
    )

    def olcule(f):
        # buffer(-18) BILEREK kullanilmiyor: 36 m'den ince poligonlari yok ediyor
        g = f.geometry().simplify(8)
        return f.setGeometry(g).set({
            'alan_m2': g.area(10),
            'merkez_lon': g.centroid(10).coordinates().get(0),
            'merkez_lat': g.centroid(10).coordinates().get(1),
        })

    vektorler = vektorler.map(olcule).filter(ee.Filter.gte('alan_m2', 400))
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

    # Siralama: en guclu hedefler basta olsun ki rapor dogrudan okunabilsin
    ozellikler.sort(
        key=lambda o: (
            -(o['properties'].get('sinif') or 0),
            -(o['properties'].get('skor') or 0),
        )
    )

    toplam_alan = sum(float(o['properties'].get('alan_m2') or 0) for o in ozellikler)
    sinif_alanlari = {}
    for o in ozellikler:
        s = int(o['properties'].get('sinif') or 0)
        sinif_alanlari[s] = sinif_alanlari.get(s, 0) + float(o['properties'].get('alan_m2') or 0)

    return {'type': 'FeatureCollection', 'features': ozellikler}, {
        'poligon_sayisi': len(ozellikler),
        'toplam_alan_m2': round(toplam_alan, 1),
        'sinif_alanlari': {str(k): round(v, 1) for k, v in sinif_alanlari.items()},
        'kullanilan_tarihler': kullanilan_tarihler,
        'goruntu_sayisi': goruntu_sayisi,
        'hassasiyet': hassasiyet,
        'yuzdelikler': yuzdelikler,
        'esikler': esikler,
        'ayrim': ayrim,
        'birliktelik_esigi': round(birliktelik_esigi, 4),
        'crosta': {
            'kil_bileseni': f'PC{kil_ix + 1}',
            'demir_bileseni': f'PC{demir_ix + 1}',
            'kil_varyans': round(kil_ozd[kil_ix] / (sum(kil_ozd) or 1), 3),
            'demir_varyans': round(demir_ozd[demir_ix] / (sum(demir_ozd) or 1), 3),
            'kil_guven': round(kil_guven, 3),
            'demir_guven': round(demir_guven, 3),
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

            geojson, bilgi = analiz_v4(
                veri['koordinatlar'],
                hassasiyet=veri.get('hassasiyet', 'orta'),
                yerlesim_maskesi=veri.get('yerlesim_maskesi', True),
            )

            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({
                "basarili": True, "sonuc": geojson, "motor": "v4", **bilgi,
            }).encode())

        except Exception as e:
            self.send_response(500)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"basarili": False, "hata": str(e)}).encode())
