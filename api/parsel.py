"""
PARSEL SORGU (TKGM) — BAGIMSIZ MODUL
====================================

Haritada pin ile isaretlenen noktanin KADASTRAL parsel bilgisini
TKGM (Tapu ve Kadastro Genel Mudurlugu) acik servisinden alir:
il / ilce / mahalle / ada / parsel / tapu alani / nitelik ve
parselin sinir geometrisi.

Analiz motorlarindan (analyze.py, analyze_v2/v3/v4.py) TAMAMEN
bagimsizdir; ne Earth Engine ne Supabase tablolarina dokunur.
Sadece kullanici oturumunu dogrular ve TKGM'ye vekillik eder.

NEDEN SUNUCU TARAFI (neden tarayicidan dogrudan cagirmiyoruz):
TKGM servisi CORS basligi dondurmuyor. Tarayicidan fetch edilirse
istek atilir ama yanit JavaScript'e KAPALI olur ("blocked by CORS
policy"). Bu yuzden istegi Vercel fonksiyonu yapiyor, yaniti kendi
alanimizdan donduruyoruz.

SAVUNMACI YAZILDI: TKGM servisi resmi dokumante bir API degil; adres
ve alan adlari zaman icinde degisebiliyor. Bu yuzden
  - birden fazla adres sirayla denenir,
  - alan adlari ESNEK okunur (ilAd / il / ILADI ... hepsi aranir),
  - ham yanit da 'ham' alaninda geri gonderilir; boylece alan adi
    degisirse ekranda en azindan ham veri gorunur, modul korlesmez.
"""

from http.server import BaseHTTPRequestHandler
import json
import os
import requests

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_ANON_KEY")

# TOPLAM SURE BUTCESI (saniye).
# Vercel fonksiyonu 30 sn'de kesiliyor; bu butce dolmadan mutlaka cevap
# donuyoruz ki kullanici 504 yerine ACIKLAYICI bir mesaj gorsun.
TOPLAM_BUTCE = 14
BAGLANTI_ZAMAN_ASIMI = 5      # el sikisma
OKUMA_ZAMAN_ASIMI = 8         # govdeyi okuma

# Sirayla denenecek TKGM adresleri. Ilki cevap verirse digerleri atlanir.
# {lat} ve {lon} yer tutucular.
TKGM_ADRESLERI = [
    "https://cbsapi.tkgm.gov.tr/megsiswebapi.v3/api/parsel/{lat}/{lon}",
    "https://cbsservis.tkgm.gov.tr/megsiswebapi.v2/api/parsel/{lat}/{lon}",
    "https://cbs.tkgm.gov.tr/megsiswebapi.v3/api/parsel/{lat}/{lon}",
]

# Servis bazi istemcileri reddediyor; tarayici benzeri baslik gonderiyoruz.
BASLIKLAR = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Referer": "https://parselsorgu.tkgm.gov.tr/",
}

# Ekranda gostermek istedigimiz alanlar ve TKGM'de gorulebilecek
# olasi karsiliklari. Buyuk/kucuk harf duyarsiz aranir.
ALAN_ESLESMESI = {
    "il":        ["ilAd", "ilad", "il", "ILADI", "iladi", "ilAdi", "cityName"],
    "ilce":      ["ilceAd", "ilcead", "ilce", "ILCEADI", "ilceadi", "ilceAdi", "districtName"],
    "mahalle":   ["mahalleAd", "mahallead", "mahalle", "MAHALLEADI", "mahalleadi",
                  "mahalleAdi", "koyAd", "neighbourhoodName"],
    "ada":       ["adaNo", "adano", "ada", "ADANO", "adaNumarasi", "blockNumber"],
    "parsel":    ["parselNo", "parselno", "parsel", "PARSELNO", "parselNumarasi", "parcelNumber"],
    "alan":      ["alan", "ALAN", "tapuAlani", "tapualani", "yuzolcumu", "area"],
    "nitelik":   ["nitelik", "NITELIK", "vasif", "vasfi", "zeminTipi", "zemintipi", "quality"],
    "mevkii":    ["mevkii", "MEVKII", "mevki", "mevkiiAd", "locality"],
    "pafta":     ["pafta", "PAFTA", "paftaNo", "paftano", "sheetNumber"],
    "parsel_id": ["parselId", "parselid", "id", "PARSELID", "objectId", "parcelId"],
    "durum":     ["durum", "DURUM", "status"],
    "ozet":      ["ozet", "OZET", "özet"],
    "zemin":     ["zeminKmdurum", "zeminkmdurum", "zeminTipi", "zemintipi"],
}

# Servis "o noktada parsel yok" durumunu JSON degil XML ile bildiriyor:
#   <Error><Message>Parsel Bulunamadı: Enlem = ... </Message></Error>
# Bu BIR HATA DEGIL, gecerli bir cevaptir. Onceki surumde hata sayilip
# yedek adresler de deneniyordu ve fonksiyon zaman asimina ugruyordu (504).
BULUNAMADI_IZLERI = ("parsel bulunamad", "<error>", "bulunamadı", "bulunamadi")


def xml_mesaji(govde):
    """<Message>...</Message> icindeki metni dondurur (yoksa None)."""
    if not govde:
        return None
    bas = govde.lower().find("<message>")
    if bas == -1:
        return None
    son = govde.lower().find("</message>", bas)
    if son == -1:
        return None
    return govde[bas + 9:son].strip() or None


def kullanici_dogrula(kullanici_token):
    """Supabase oturumunu dogrular. Modulu acik vekile cevirmemek icin sart."""
    yanit = requests.get(
        f"{SUPABASE_URL}/auth/v1/user",
        headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {kullanici_token}"},
        timeout=8,
    )
    if yanit.status_code != 200:
        raise RuntimeError("Oturum doğrulanamadı, lütfen tekrar giriş yap.")
    return yanit.json().get("id")


def _duz_sozluk(nesne, hedef=None, derinlik=0):
    """
    Ic ice sozlukleri tek duzlemde toplar.

    Neden: TKGM yaniti bazen {properties: {...}}, bazen
    {properties: {parsel: {...}}} bicimde geliyor. Aramayi tek
    duzlemde yapmak, yapinin degismesine karsi bagisiklik saglar.
    Ayni ada sahip ic alanlar varsa ILK bulunan korunur (ust seviye
    daha guvenilir).
    """
    if hedef is None:
        hedef = {}
    if derinlik > 4 or not isinstance(nesne, dict):
        return hedef
    for anahtar, deger in nesne.items():
        if isinstance(deger, dict):
            _duz_sozluk(deger, hedef, derinlik + 1)
        elif isinstance(deger, list):
            continue                      # geometri/koordinat listeleri bizi ilgilendirmiyor
        elif anahtar not in hedef:
            hedef[anahtar] = deger
    return hedef


def alanlari_oku(ozellikler):
    """Esnek alan okuma: ALAN_ESLESMESI'ndeki adaylari sirayla dener."""
    duz = _duz_sozluk(ozellikler)
    kucuk = {str(k).lower(): v for k, v in duz.items()}

    sonuc = {}
    for ad, adaylar in ALAN_ESLESMESI.items():
        for aday in adaylar:
            deger = kucuk.get(aday.lower())
            if deger not in (None, "", []):
                sonuc[ad] = deger
                break
        else:
            sonuc[ad] = None
    return sonuc


def geometri_bul(veri):
    """
    Yanitin icinden GeoJSON geometrisini cikarir.

    Olasi bicimler:
      {"type":"Feature","geometry":{...}}
      {"type":"FeatureCollection","features":[{"geometry":{...}}]}
      {"geometry":{...}}  /  dogrudan {"type":"Polygon","coordinates":[...]}
    """
    if not isinstance(veri, dict):
        return None

    tip = veri.get("type")
    if tip in ("Polygon", "MultiPolygon") and veri.get("coordinates"):
        return {"type": tip, "coordinates": veri["coordinates"]}

    if tip == "FeatureCollection":
        for ozellik in veri.get("features") or []:
            geo = geometri_bul(ozellik)
            if geo:
                return geo
        return None

    geo = veri.get("geometry")
    if isinstance(geo, dict) and geo.get("coordinates"):
        return {"type": geo.get("type", "Polygon"), "coordinates": geo["coordinates"]}

    # Bazi surumler geometriyi farkli adla veriyor
    for anahtar in ("geom", "shape", "sinir", "boundary"):
        aday = veri.get(anahtar)
        if isinstance(aday, dict) and aday.get("coordinates"):
            return {"type": aday.get("type", "Polygon"), "coordinates": aday["coordinates"]}

    return None


def ozellikleri_bul(veri):
    """Yanitin icinden ozellik (properties) sozlugunu cikarir."""
    if not isinstance(veri, dict):
        return {}

    if veri.get("type") == "FeatureCollection":
        for ozellik in veri.get("features") or []:
            bulunan = ozellikleri_bul(ozellik)
            if bulunan:
                return bulunan
        return {}

    ozellikler = veri.get("properties")
    if isinstance(ozellikler, dict) and ozellikler:
        return ozellikler

    # Feature sarmalayici yoksa govdenin kendisi ozellik tasiyor olabilir
    govde = {k: v for k, v in veri.items()
             if k not in ("geometry", "geom", "type", "features", "shape")}
    return govde


def koordinat_sinirlari(geometri):
    """
    Geometrinin kabaca dogru yerde olup olmadigini denetler.

    Daha once (manyetik katmanda) metre tabanli koordinatlarin
    harita olcegine cizilmesi tum ekrani boyamisti. Burada ayni
    hatayi bastan engelliyoruz: boylam ±180, enlem ±90 disindaysa
    geometriyi reddediyoruz.
    """
    if not geometri:
        return None, "Yanıtta parsel sınırı yok."

    noktalar = []

    def topla(dugum, derinlik=0):
        if derinlik > 6:
            return
        if (isinstance(dugum, (list, tuple)) and len(dugum) >= 2
                and all(isinstance(x, (int, float)) for x in dugum[:2])):
            noktalar.append((dugum[0], dugum[1]))
            return
        if isinstance(dugum, (list, tuple)):
            for alt in dugum:
                topla(alt, derinlik + 1)

    topla(geometri.get("coordinates"))

    if len(noktalar) < 3:
        return None, "Parsel sınırı en az 3 nokta içermiyor."

    for lon, lat in noktalar:
        if not (-180 <= lon <= 180 and -90 <= lat <= 90):
            return None, "Parsel sınırı coğrafi koordinat aralığının dışında."

    return geometri, None


def tkgm_sorgula(lat, lon):
    """
    TKGM'yi sirayla dener.

    Doner: (veri, adres, denemeler, bulunamadi_mesaji)
      - veri dolu              -> parsel bulundu
      - bulunamadi_mesaji dolu -> servis cevap verdi, o noktada parsel YOK
      - ikisi de bossa         -> hata firlatilir

    Yedek adresler SADECE ilk adres hic cevap veremediginde denenir.
    "Parsel yok" cevabi gelirse zincir orada biter; aksi halde her nokta
    icin uc istek atilip fonksiyon zaman asimina ugruyordu.
    """
    import time
    baslangic = time.monotonic()
    denemeler = []

    for kalip in TKGM_ADRESLERI:
        kalan = TOPLAM_BUTCE - (time.monotonic() - baslangic)
        if kalan <= 2:
            denemeler.append("süre bütçesi doldu, kalan adresler denenmedi")
            break

        alan_adi = kalip.split('/')[2]
        adres = kalip.format(lat=f"{lat:.7f}", lon=f"{lon:.7f}")
        try:
            yanit = requests.get(
                adres,
                headers=BASLIKLAR,
                timeout=(BAGLANTI_ZAMAN_ASIMI, min(OKUMA_ZAMAN_ASIMI, max(2, kalan))),
            )
        except requests.RequestException as e:
            denemeler.append(f"{alan_adi}: bağlantı hatası ({type(e).__name__})")
            continue

        govde = (yanit.text or "").strip()
        kucuk = govde.lower()

        # 1) Servis "burada parsel yok" diyor -> gecerli cevap, zinciri bitir
        if any(iz in kucuk for iz in BULUNAMADI_IZLERI):
            denemeler.append(f"{alan_adi}: parsel kaydı yok (HTTP {yanit.status_code})")
            return None, adres, denemeler, (
                xml_mesaji(govde) or "Bu noktada tescilli parsel kaydı bulunamadı."
            )

        # 2) Gecerli JSON mu
        try:
            veri = json.loads(govde) if govde else None
        except ValueError:
            denemeler.append(f"{alan_adi}: JSON değil (HTTP {yanit.status_code}, {govde[:70]})")
            continue

        if not veri:
            denemeler.append(f"{alan_adi}: boş yanıt (HTTP {yanit.status_code})")
            continue

        denemeler.append(f"{alan_adi}: başarılı (HTTP {yanit.status_code})")
        return veri, adres, denemeler, None

    raise RuntimeError(
        "TKGM parsel servisine ulaşılamadı. Denenenler → " + " | ".join(denemeler)
    )


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            auth = self.headers.get('Authorization', '')
            kullanici_token = auth[7:] if auth.startswith('Bearer ') else None
            if not kullanici_token:
                raise RuntimeError("Oturum bilgisi eksik.")

            uzunluk = int(self.headers.get('Content-Length', 0))
            istek = json.loads(self.rfile.read(uzunluk)) if uzunluk else {}

            try:
                lat = float(istek.get('lat'))
                lon = float(istek.get('lon', istek.get('lng')))
            except (TypeError, ValueError):
                raise RuntimeError("Geçerli bir koordinat gönderilmedi.")

            if not (35.5 <= lat <= 42.5 and 25.5 <= lon <= 45.0):
                raise RuntimeError(
                    "Bu nokta Türkiye sınırları dışında görünüyor; "
                    "TKGM parsel kaydı yalnızca Türkiye için var."
                )

            kullanici_dogrula(kullanici_token)

            veri, kullanilan_adres, denemeler, bulunamadi = tkgm_sorgula(lat, lon)

            # Servis cevap verdi ama o noktada parsel yok: bu bir HATA DEGIL.
            # Kullaniciya net bilgi donuyoruz, kirmizi hata kutusu gostermiyoruz.
            if bulunamadi:
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({
                    "ok": True,
                    "nokta": {"lat": lat, "lon": lon},
                    "alanlar": {ad: None for ad in ALAN_ESLESMESI},
                    "geometri": None,
                    "kimlik_var": False,
                    "uyari": (
                        f"{bulunamadi} Bu nokta yol, dere, orman veya kadastro dışı "
                        f"bir alana denk geliyor olabilir; birkaç metre yana al ve "
                        f"tekrar dene."
                    ),
                    "kaynak": kullanilan_adres.split('/')[2],
                    "denemeler": denemeler,
                    "ham": {},
                }, ensure_ascii=False).encode('utf-8'))
                return

            ozellikler = ozellikleri_bul(veri)
            geometri, geo_hatasi = koordinat_sinirlari(geometri_bul(veri))
            alanlar = alanlari_oku(ozellikler)

            # Hicbir kimlik alani okunamadiysa nokta muhtemelen kadastro disi
            # (orman, mera, denizi vb.) ya da alan adlari degismis olabilir.
            kimlik_var = any(alanlar.get(a) for a in ("il", "ilce", "ada", "parsel"))

            cevap = {
                "ok": True,
                "nokta": {"lat": lat, "lon": lon},
                "alanlar": alanlar,
                "geometri": geometri,
                "kimlik_var": kimlik_var,
                "uyari": geo_hatasi,
                "kaynak": kullanilan_adres.split('/')[2],
                "denemeler": denemeler,
                # Ham ozellikler: alan adlari degisirse ekran korlesmesin
                "ham": _duz_sozluk(ozellikler),
            }

            if not kimlik_var:
                cevap["uyari"] = (
                    (geo_hatasi + " ") if geo_hatasi else ""
                ) + ("Bu noktada tescilli parsel kaydı bulunamadı "
                     "(orman, mera, yol veya kadastro dışı alan olabilir).")

            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(cevap, ensure_ascii=False).encode('utf-8'))

        except Exception as e:
            self.send_response(400)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(
                {"ok": False, "hata": str(e)}, ensure_ascii=False
            ).encode('utf-8'))
