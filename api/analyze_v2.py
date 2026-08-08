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
# ANALIZ MOTORU v2
# =====================================================================
# api/analyze.py'ye HIC DOKUNULMAZ. Bu ayri, bagimsiz bir motordur.
# Ayni alani iki motorla tarayip sonuclari karsilastirabilirsin.
#
# v1'e gore UC TEMEL FARK:
#
#   1) BOLGESEL REFERANS
#      v1, cizilen alanin KENDI ICINDE en yuksek %10'u anomali sayiyordu.
#      Bu yuzden tamamen siradan bir tarlada bile mutlaka "yuksek anomali"
#      buluyordu - cunku her zaman bir en yuksek %10 vardir.
#      v2, cizilen alani cevresindeki ~25 km'lik bolgeyle karsilastirir.
#      Artik "yuksek" gercekten "bu bolgede alisilmadik" demek.
#      Sonuc: siradan bir alanda SIFIR poligon donebilir. Bu dogru davranis.
#
#   2) ZAMANSAL KARARLILIK
#      v1, 10 goruntunun medyanini alip tek bileşik uretiyordu.
#      v2, her goruntuyu AYRI hesaplar ve sorar: bu piksel kac goruntude
#      anomali cikti? Farkli mevsim, gunes acisi ve nemde israrla anomali
#      veren yer jeolojidir. Tek goruntude cikan yer surulmus tarla,
#      nem lekesi veya golge artefaktidir.
#
#   3) ARAZI ORTUSU MASKESI
#      ESA WorldCover (10 m, ucretsiz) ile ekili tarim alani ve yapilasma
#      maskelenir. Parsel sinirlarini takip eden sahte poligonlarin ve
#      kiremit cati kaynakli yanlis pozitiflerin ana kaynagi budur.
#      NOT: WorldCover tas ocagi ve maden sahalarini "ciplak" (60) sinifina
#      koyar, "yapilasma" (50) sinifina degil. Yani v1'de NDBI ile yasanan
#      "maden sahasini yerlesim sanip elemek" sorunu burada olusmaz.
# =====================================================================

MINERAL_PROFILLERI = {
    'altin': {'d': 0.40, 'k': 0.40, 'f': 0.20},
    'bakir': {'d': 0.45, 'k': 0.35, 'f': 0.20},
    'demir': {'d': 0.70, 'k': 0.15, 'f': 0.15},
    'genel': {'d': 0.34, 'k': 0.33, 'f': 0.33},
}

ORTAK_CRS = 'EPSG:3857'
ORTAK_OLCEK = 10          # cizilen alan icin (v1 ile ayni)
BOLGESEL_OLCEK = 60       # bolgesel istatistik icin - kaba yeter, cok daha hizli
BOLGESEL_TAMPON = 25000   # metre

# MUTLAK sinif esikleri, HASSASIYET seviyesine gore.
# v1'de esikler alanin kendi yuzdeliklerinden geliyordu (hep bir seyler bulunurdu).
# v2'de esikler SABIT: skor bolgesel dagilima gore normalize edildigi icin
# 0.60 demek "bu bolgenin ust dilimlerinde" demek.
#
# NOT: ilk denemede tek bir sabit esik seti kullanmistim (1.sinif = 0.55) ve
# hicbir yerde poligon uretmedi. Sebebi: bir pikselin o esige ulasmasi icin
# UC indeksin de bolgesel p95'e yakin olmasi gerekiyordu, ama indeksler
# gerçekte bu kadar birlikte hareket etmiyor. Simdi hem esikler dusuruldu
# hem de kullanici hassasiyeti degistirebiliyor.
HASSASIYET_ESIKLERI = {
    'yuksek': {1: 0.30, 2: 0.40, 3: 0.50, 4: 0.62},   # cok sinyal, cok gurultu
    'orta':   {1: 0.40, 2: 0.50, 3: 0.60, 4: 0.72},   # varsayilan
    'dusuk':  {1: 0.50, 2: 0.60, 3: 0.70, 4: 0.82},   # sadece en guclu olanlar
}

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
# ANA MOTOR
# ---------------------------------------------------------------------

def analiz_v2(koordinatlar, hedef_mineral='altin',
              tarim_maskesi=True, yerlesim_maskesi=True,
              hassasiyet='orta',
              ozel_baslangic=None, ozel_bitis=None):
    gee_baslat()

    agirliklar = MINERAL_PROFILLERI.get(hedef_mineral, MINERAL_PROFILLERI['altin'])
    esikler = HASSASIYET_ESIKLERI.get(hassasiyet, HASSASIYET_ESIKLERI['orta'])

    kord_listesi = [[k['lng'], k['lat']] for k in koordinatlar]
    aoi = ee.Geometry.Polygon([kord_listesi])
    bolge = aoi.buffer(BOLGESEL_TAMPON)   # bolgesel referans alani

    # --- Tarih penceresi (v1 ile ayni kural: son 6 ay, en temiz 10 goruntu) ---
    if ozel_baslangic and ozel_bitis:
        baslangic_tarihi, bitis_tarihi = ozel_baslangic, ozel_bitis
    else:
        bugun = datetime.utcnow()
        baslangic_tarihi = (bugun - timedelta(days=180)).strftime('%Y-%m-%d')
        bitis_tarihi = (bugun + timedelta(days=1)).strftime('%Y-%m-%d')

    s2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED') \
        .filterBounds(aoi) \
        .filterDate(baslangic_tarihi, bitis_tarihi) \
        .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 70)) \
        .sort('CLOUDY_PIXEL_PERCENTAGE') \
        .limit(10)

    zaman_damgalari = s2.aggregate_array('system:time_start').getInfo()
    kullanilan_tarihler = sorted({
        datetime.utcfromtimestamp(t / 1000).strftime('%Y-%m-%d') for t in zaman_damgalari
    })
    goruntu_sayisi = len(kullanilan_tarihler)
    if goruntu_sayisi == 0:
        raise RuntimeError("Bu alan ve tarih aralığında kullanılabilir Sentinel-2 görüntüsü bulunamadı.")

    def maskS2(image):
        scl = image.select('SCL')
        mask = (scl.neq(0).multiply(scl.neq(1)).multiply(scl.neq(3))
                .multiply(scl.neq(8)).multiply(scl.neq(9))
                .multiply(scl.neq(10)).multiply(scl.neq(11)))
        return image.updateMask(mask).select(
            ['B2', 'B3', 'B4', 'B8', 'B8A', 'B11', 'B12']
        ).divide(10000)

    s2_temiz = s2.map(maskS2)

    # -----------------------------------------------------------------
    # AŞAMA 0 — MASKELER
    # -----------------------------------------------------------------
    medyan = s2_temiz.median()

    ndvi = medyan.normalizedDifference(['B8', 'B4'])
    mndwi = medyan.normalizedDifference(['B3', 'B11'])
    suMaskesi = mndwi.gt(0.15)
    bitkiMaskesi = ndvi.gt(0.25)

    gecerliMaske = suMaskesi.Or(bitkiMaskesi).Not()

    # ESA WorldCover 2021 (10 m). Siniflar:
    #   40 = ekili tarim alani,  50 = yapilasma
    #   60 = ciplak/seyrek bitki  <- tas ocagi, maden sahasi, mostra BURADA
    ortu = ee.ImageCollection('ESA/WorldCover/v200').first().select('Map')
    if tarim_maskesi:
        gecerliMaske = gecerliMaske.And(ortu.neq(40))
    if yerlesim_maskesi:
        gecerliMaske = gecerliMaske.And(ortu.neq(50))

    # -----------------------------------------------------------------
    # İNDEKSLER
    # -----------------------------------------------------------------
    def indeksleri_uret(img):
        blue, red = img.select('B2'), img.select('B4')
        nir8a = img.select('B8A')
        swir1, swir2 = img.select('B11'), img.select('B12')
        d = red.divide(blue.add(0.0001)).rename('d')
        k = swir1.divide(swir2.add(0.0001)).rename('k')
        f = swir2.divide(nir8a.add(0.0001)).rename('f')
        return d.addBands(k).addBands(f)

    medyan_indeks = indeksleri_uret(medyan)

    # -----------------------------------------------------------------
    # AŞAMA 1 — BÖLGESEL REFERANS
    # -----------------------------------------------------------------
    # Kritik nokta: istatistik BÖLGEDEN alınır, çizilen alandan değil.
    # Böylece "yüksek" = "bu bölge için alışılmadık" anlamına gelir.
    bolgesel_istatistik = medyan_indeks.updateMask(gecerliMaske).reduceRegion(
        reducer=ee.Reducer.percentile([5, 50, 95]),
        geometry=bolge, crs=ORTAK_CRS, scale=BOLGESEL_OLCEK,
        maxPixels=1e10, bestEffort=True, tileScale=4,
    )

    def bolgesel_normalize(image, band_adi):
        p5 = ee.Number(bolgesel_istatistik.get(band_adi + '_p5'))
        p95 = ee.Number(bolgesel_istatistik.get(band_adi + '_p95'))
        genislik = ee.Number(p95.subtract(p5)).max(0.0001)
        return image.select(band_adi).subtract(p5).divide(genislik).clamp(0, 1)

    def skor_uret(indeks_img):
        d = bolgesel_normalize(indeks_img, 'd')
        k = bolgesel_normalize(indeks_img, 'k')
        f = bolgesel_normalize(indeks_img, 'f')
        return (d.multiply(agirliklar['d'])
                .add(k.multiply(agirliklar['k']))
                .add(f.multiply(agirliklar['f']))
                .rename('skor'))

    taban_skor = skor_uret(medyan_indeks).updateMask(gecerliMaske)

    # -----------------------------------------------------------------
    # AŞAMA 5 — ZAMANSAL KARARLILIK
    # -----------------------------------------------------------------
    # Her görüntü ayrı hesaplanır, aynı bölgesel eşiğe göre normalize edilir.
    # Sonra: bu piksel kaç görüntüde 0.70 eşiğini geçti?
    KARARLILIK_ESIGI = 0.70

    def tek_goruntu_bayrak(img):
        return skor_uret(indeksleri_uret(img)).gt(KARARLILIK_ESIGI)

    bayraklar = s2_temiz.map(tek_goruntu_bayrak)
    kararlilik = bayraklar.sum().divide(goruntu_sayisi) \
        .rename('kararlilik').updateMask(gecerliMaske)

    # -----------------------------------------------------------------
    # AŞAMA 6 — BİRLEŞİK SKOR
    # -----------------------------------------------------------------
    # Çarpım kullanıyoruz: kararlılık düşükse skor da düşer.
    # Toplama olsaydı tek güçlü sinyal, kararsızlığı gizlerdi.
    #
    # 0.50 taban: ilk sürümde 0.35 kullanmıştım ve kararlılık çarpanı skoru
    # eşiğin altına çekip her yerde sıfır sonuç üretti. Bulut/gölge yüzünden
    # bir piksel bazı görüntülerde maskeli olabiliyor; bu onun kararsız
    # olduğu anlamına gelmiyor. Çarpan artık daha yumuşak.
    nihai_skor = taban_skor.multiply(
        ee.Image(0.50).add(kararlilik.multiply(0.50))
    ).rename('skor')

    nihai_puruzsuz = nihai_skor.focal_median(
        radius=25, units='meters', kernelType='circle'
    ).reproject(crs=ORTAK_CRS, scale=ORTAK_OLCEK)

    # -----------------------------------------------------------------
    # TEŞHİS: gerçek skor dağılımı
    # -----------------------------------------------------------------
    # Eşiği tahminle ayarlamak yerine, alanda gerçekte hangi skorların
    # olduğunu ölçüp geri döndürüyoruz. Sıfır sonuç çıktığında "eşik mi
    # yüksek, gerçekten mi bir şey yok" sorusu böylece cevaplanabiliyor.
    skor_dagilim = nihai_puruzsuz.addBands(kararlilik).updateMask(gecerliMaske) \
        .reduceRegion(
            reducer=ee.Reducer.percentile([50, 75, 90, 95, 99]).combine(
                reducer2=ee.Reducer.max(), sharedInputs=True),
            geometry=aoi, crs=ORTAK_CRS, scale=ORTAK_OLCEK,
            maxPixels=1e10, bestEffort=True, tileScale=4,
        ).getInfo()

    def yuvarla(x):
        return round(x, 3) if isinstance(x, (int, float)) else None

    teshis_skor = {
        'p50': yuvarla(skor_dagilim.get('skor_p50')),
        'p75': yuvarla(skor_dagilim.get('skor_p75')),
        'p90': yuvarla(skor_dagilim.get('skor_p90')),
        'p95': yuvarla(skor_dagilim.get('skor_p95')),
        'p99': yuvarla(skor_dagilim.get('skor_p99')),
        'max': yuvarla(skor_dagilim.get('skor_max')),
    }
    teshis_kararlilik = {
        'p50': yuvarla(skor_dagilim.get('kararlilik_p50')),
        'p90': yuvarla(skor_dagilim.get('kararlilik_p90')),
        'max': yuvarla(skor_dagilim.get('kararlilik_max')),
    }

    # -----------------------------------------------------------------
    # SINIFLANDIRMA — MUTLAK EŞİKLERLE
    # -----------------------------------------------------------------
    siniflandirilmis = ee.Image(0) \
        .where(nihai_puruzsuz.gt(esikler[1]), 1) \
        .where(nihai_puruzsuz.gt(esikler[2]), 2) \
        .where(nihai_puruzsuz.gt(esikler[3]), 3) \
        .where(nihai_puruzsuz.gt(esikler[4]), 4) \
        .updateMask(gecerliMaske) \
        .updateMask(nihai_puruzsuz.gt(esikler[1])) \
        .rename('sinif').toInt() \
        .reproject(crs=ORTAK_CRS, scale=ORTAK_OLCEK)

    # --- Teşhis sayıları ---
    # ÖNEMLİ: bunlar AYRI reduceRegion çağrılarıyla alınıyor.
    # Önceki sürümde sabit bir görüntüye (ee.Image(1)) bant ekleyip tek çağrıda
    # sayıyordum; sabit görüntünün kendi projeksiyonu olmadığı için sayım
    # güvenilmez sonuç veriyordu ve anomali sayısı yanlışlıkla 0 çıkıyordu.
    def piksel_say(maskeli_img):
        sonuc = maskeli_img.selfMask().rename('n').reduceRegion(
            reducer=ee.Reducer.count(), geometry=aoi,
            crs=ORTAK_CRS, scale=ORTAK_OLCEK,
            maxPixels=1e10, bestEffort=True, tileScale=4,
        ).getInfo()
        return sonuc.get('n') or 0

    gecerli_piksel = piksel_say(gecerliMaske)
    anomali_piksel = piksel_say(nihai_puruzsuz.gt(esikler[1]).And(gecerliMaske))

    if gecerli_piksel < 15:
        raise RuntimeError(
            f"Analiz edilebilir çıplak zemin bulunamadı (geçerli piksel: {gecerli_piksel}). "
            f"Bu alan büyük ihtimalle su, bitki örtüsü, ekili tarım veya yapılaşma. "
            f"Maskeleri panelden kapatıp tekrar deneyebilirsin."
        )

    # -----------------------------------------------------------------
    # VEKTÖRLEŞTİRME
    # -----------------------------------------------------------------
    # Erken çıkış YOK. Önceki sürümde "anomali pikseli 0" ise vektörleştirmeye
    # hiç geçmiyordum; sayım hatalıysa bu, aslında poligon üretecek bir alanda
    # da boş sonuç veriyordu. Artık her zaman vektörleştirip GERÇEK poligon
    # sayısına bakıyoruz.
    cok_bantli = siniflandirilmis \
        .addBands(nihai_puruzsuz.rename('skor')) \
        .addBands(kararlilik.rename('kararlilik'))

    vektorler = cok_bantli.reduceToVectors(
        geometry=aoi, crs=ORTAK_CRS, scale=ORTAK_OLCEK,
        geometryType='polygon', labelProperty='sinif',
        reducer=ee.Reducer.mean(),
        maxPixels=1e10, bestEffort=True, eightConnected=True, tileScale=4,
    )

    def kenariYumusat(f):
        # DİKKAT: v1'deki buffer(18) -> buffer(-18) tekniğini buradan çıkardım.
        # O teknik köşeleri güzel yuvarlatıyor AMA 36 metreden ince bir poligonu
        # tamamen yok ediyor (negatif buffer şekli içe doğru kapatıyor).
        # Anomali lekelerinin çoğu ince ve uzun olduğu için hepsi bu adımda
        # buharlaşıyordu ve sonuç boş görünüyordu.
        # Şimdi sadece basitleştirme + hafif tek yönlü yumuşatma var.
        g = f.geometry().simplify(8)
        return f.setGeometry(g).set('alan_m2', g.area(10))

    vektorler = vektorler.map(kenariYumusat) \
        .filter(ee.Filter.gte('alan_m2', 800))   # ~8 piksel; altı gürültü

    sonuc_geojson = vektorler.getInfo()
    poligon_sayisi = len(sonuc_geojson.get('features') or [])

    if poligon_sayisi == 0:
        return {'type': 'FeatureCollection', 'features': []}, {
            'kullanilan_tarihler': kullanilan_tarihler,
            'goruntu_sayisi': goruntu_sayisi,
            'gecerli_piksel': gecerli_piksel,
            'anomali_piksel': anomali_piksel,
            'hassasiyet': hassasiyet,
            'esikler': esikler,
            'skor_dagilimi': teshis_skor,
            'kararlilik_dagilimi': teshis_kararlilik,
            'bos_sonuc_aciklamasi': (
                f"Eşik {esikler[1]}, alandaki en yüksek skor {teshis_skor.get('max')}, "
                f"eşiği geçen piksel {anomali_piksel}. "
                + ("Eşiği geçen piksel var ama hepsi 800 m²'nin altında dağınık "
                   "lekeler — anlamlı büyüklükte bir hedef oluşmuyor."
                   if anomali_piksel > 0
                   else "Bölgesel arka plandan ayrışan bir şey yok.")
            ),
        }

    return sonuc_geojson, {
        'poligon_sayisi': poligon_sayisi,
        'kullanilan_tarihler': kullanilan_tarihler,
        'goruntu_sayisi': goruntu_sayisi,
        'gecerli_piksel': gecerli_piksel,
        'anomali_piksel': anomali_piksel,
        'hassasiyet': hassasiyet,
        'esikler': esikler,
        'skor_dagilimi': teshis_skor,
        'kararlilik_dagilimi': teshis_kararlilik,
        'bos_sonuc_aciklamasi': None,
    }


# ---------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------

class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            auth_header = self.headers.get('Authorization', '')
            kullanici_token = auth_header[7:] if auth_header.startswith('Bearer ') else None
            if not kullanici_token:
                raise RuntimeError("Oturum bilgisi eksik, lütfen tekrar giriş yap.")

            uzunluk = int(self.headers.get('Content-Length', 0))
            veri = json.loads(self.rfile.read(uzunluk))

            koordinatlar = veri['koordinatlar']
            hedef_mineral = veri.get('hedef_mineral', 'altin')
            tarim_maskesi = veri.get('tarim_maskesi', True)
            yerlesim_maskesi = veri.get('yerlesim_maskesi', True)
            hassasiyet = veri.get('hassasiyet', 'orta')

            kullanici_id, profil = kullanici_bilgisini_al(kullanici_token)
            if not profil.get('aktif', True):
                raise RuntimeError("Hesabın devre dışı bırakılmış.")

            geojson, bilgi = analiz_v2(
                koordinatlar,
                hedef_mineral=hedef_mineral,
                tarim_maskesi=tarim_maskesi,
                yerlesim_maskesi=yerlesim_maskesi,
                hassasiyet=hassasiyet,
            )

            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({
                "basarili": True,
                "sonuc": geojson,
                "hedef_mineral": hedef_mineral,
                "motor": "v2",
                **bilgi,
            }).encode())

        except Exception as e:
            self.send_response(500)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"basarili": False, "hata": str(e)}).encode())
