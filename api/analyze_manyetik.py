from http.server import BaseHTTPRequestHandler
import json
import os
import math
import requests

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_ANON_KEY")

# EMAG2 v3 hucre boyu. Turkiye kesitinde ~3.70 km olctuk.
HUCRE_DERECE = 1.0 / 30.0          # 2 ark-dakika
HUCRE_METRE = 3700
VERI_KAYNAGI = "EMAG2 v3 (NOAA/NCEI) - deniz seviyesi, ~3.7 km hucre"


# ---------------------------------------------------------------------
# MANYETIK PROFILLER
# ---------------------------------------------------------------------
# Her cevher tipi manyetik veride FARKLI bir imza arar.
#
#   gradyan  : manyetik alanin ne kadar HIZLI degistigi.
#              Fay, kirik, kontak, intruzyon kenari = yapisal sinirlar.
#   analitik : kaynagin TAM USTUNDE tepe yapar -> manyetik cismin konumu.
#   anomali  : ham deger. Yuksek = manyetit acisindan zengin.
#
# Agirliklar toplami her zaman 1.0.
MANYETIK_PROFILLER = {
    # Altin manyetik DEGILDIR. Aranan sey altinin kendisi degil, onu
    # tasiyan yapi: fay ve kirik kusaklari. Ustelik hidrotermal alterasyon
    # cogu zaman manyetiti yok eder -> altin sahalari bazen manyetik DUSUK
    # verir. Bu yuzden degerin kendisi degil, DEGISIM HIZI onemli.
    'altin': {'gradyan': 0.60, 'analitik': 0.25, 'anomali': 0.15},

    # Porfiri bakirda manyetit acisindan zengin bir cekirdek var, ama
    # sistemin kenarinda keskin gradyan da var. Ikisi birlikte aranir.
    'bakir': {'gradyan': 0.40, 'analitik': 0.40, 'anomali': 0.20},

    # Manyetit dogrudan guclu sinyal verir. Analitik sinyal kaynagin tam
    # ustunde tepe yaptigi icin burada en degerlisi o.
    'demir': {'gradyan': 0.15, 'analitik': 0.50, 'anomali': 0.35},

    # Podiform krom serpantinize ultramafik kayaclarda bulunur;
    # bunlar guclu manyetik imza verir.
    'krom': {'gradyan': 0.30, 'analitik': 0.45, 'anomali': 0.25},

    'genel': {'gradyan': 0.34, 'analitik': 0.33, 'anomali': 0.33},
}


# ---------------------------------------------------------------------
# KULLANICI DOGRULAMA  (analyze.py ile ayni desen)
# ---------------------------------------------------------------------

def kullanici_bilgisini_al(kullanici_token):
    kullanici_yaniti = requests.get(
        f"{SUPABASE_URL}/auth/v1/user",
        headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {kullanici_token}"},
        timeout=8,
    )
    if kullanici_yaniti.status_code != 200:
        raise RuntimeError("Oturum dogrulanamadi, lutfen tekrar giris yap.")
    kullanici_id = kullanici_yaniti.json().get("id")

    profil_yaniti = requests.get(
        f"{SUPABASE_URL}/rest/v1/profiller?id=eq.{kullanici_id}&select=aktif,rol",
        headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {kullanici_token}"},
        timeout=8,
    )
    profiller = profil_yaniti.json()
    if not profiller:
        raise RuntimeError("Kullanici profili bulunamadi.")
    return kullanici_id, profiller[0]


# ---------------------------------------------------------------------
# VERI OKUMA
# ---------------------------------------------------------------------

def manyetik_hucreleri_getir(lat_min, lat_max, lon_min, lon_max, kullanici_token):
    """Cizilen alani kapsayan manyetik hucreleri Supabase'den ceker."""
    # Kucuk alanlarda hic hucre yakalanmamasi ihtimaline karsi pencereyi
    # bir hucre boyu genislet. Kullanicinin cizdigi alan 3.7 km'den kucukse
    # (ki genelde oyle) tam ustune denk gelen hucre bulunamayabilir.
    tampon = HUCRE_DERECE
    sorgu = (
        f"{SUPABASE_URL}/rest/v1/manyetik_grid"
        f"?lat=gte.{lat_min - tampon}&lat=lte.{lat_max + tampon}"
        f"&lon=gte.{lon_min - tampon}&lon=lte.{lon_max + tampon}"
        f"&select=lat,lon,anomali_nt,gradyan,analitik_sinyal,tilt_derece,"
        f"anomali_p,gradyan_p,analitik_p"
        f"&limit=5000"
    )
    yanit = requests.get(
        sorgu,
        headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {kullanici_token}"},
        timeout=15,
    )
    if yanit.status_code != 200:
        raise RuntimeError(f"Manyetik veri okunamadi ({yanit.status_code}).")
    return yanit.json()


# ---------------------------------------------------------------------
# YORUMLAMA
# ---------------------------------------------------------------------

def manyetik_baglam(hucre):
    """
    Hucreyi tek kelimeyle etiketler. Bu etiket kullaniciya gosterilir,
    sayilardan daha anlasilir oldugu icin.
    """
    a = hucre.get('anomali_p') or 0.5
    g = hucre.get('gradyan_p') or 0.5

    if g >= 0.85:
        return 'gradyan kusagi'      # yapisal sinir - altin/bakir icin en ilginc
    if a >= 0.85:
        return 'manyetik yuksek'     # manyetit zengini - demir/krom icin
    if a <= 0.15:
        return 'manyetik dusuk'      # alterasyonla manyetit kaybi olabilir
    return 'notr'


def manyetik_skor(hucre, profil_adi):
    agirlik = MANYETIK_PROFILLER.get(profil_adi, MANYETIK_PROFILLER['altin'])
    return round(
        (hucre.get('gradyan_p') or 0) * agirlik['gradyan'] +
        (hucre.get('analitik_p') or 0) * agirlik['analitik'] +
        (hucre.get('anomali_p') or 0) * agirlik['anomali'],
        3,
    )


def en_yakin_hucre(lat, lon, hucreler):
    if not hucreler:
        return None
    en_iyi, en_kisa = None, float('inf')
    for h in hucreler:
        d = (h['lat'] - lat) ** 2 + ((h['lon'] - lon) * math.cos(math.radians(lat))) ** 2
        if d < en_kisa:
            en_kisa, en_iyi = d, h
    # Hucre boyunun 1.5 katindan uzaksa "veri yok" say - uydurma yapma
    if math.sqrt(en_kisa) > HUCRE_DERECE * 1.5:
        return None
    return en_iyi


def poligon_merkezi(halka):
    """GeoJSON poligonunun dis halkasinin agirlik merkezi."""
    if not halka:
        return None, None
    lon_top = sum(n[0] for n in halka)
    lat_top = sum(n[1] for n in halka)
    return lat_top / len(halka), lon_top / len(halka)


# ---------------------------------------------------------------------
# KATMAN 1: optik poligonlarin manyetik oznitelikleri
# ---------------------------------------------------------------------

def poligonlari_zenginlestir(optik_geojson, hucreler, profil_adi):
    """
    ONEMLI: Poligonlarin SEKLI degistirilmez. Sekil tamamen optik veriden
    gelir. Manyetik veri sadece her poligona OZNITELIK ekler.

    Manyetik degeri optik poligonun konturuna "giydirmek" gorsel olarak
    etkileyici olurdu ama icinde sifir yeni bilgi olurdu - sekil zaten
    optikten geliyor. Bu yuzden yapmiyoruz.
    """
    if not optik_geojson or not optik_geojson.get('features'):
        return None

    zenginlestirilmis = {'type': 'FeatureCollection', 'features': []}

    for ozellik in optik_geojson['features']:
        yeni = json.loads(json.dumps(ozellik))  # kopyala, orijinali bozma
        ozel = yeni.setdefault('properties', {})

        geo = yeni.get('geometry') or {}
        koordinatlar = geo.get('coordinates') or []
        halka = []
        if geo.get('type') == 'Polygon' and koordinatlar:
            halka = koordinatlar[0]
        elif geo.get('type') == 'MultiPolygon' and koordinatlar:
            halka = koordinatlar[0][0]

        lat, lon = poligon_merkezi(halka)
        hucre = en_yakin_hucre(lat, lon, hucreler) if lat is not None else None

        if hucre:
            ozel['manyetik_deger'] = round(hucre.get('anomali_nt') or 0, 1)
            ozel['manyetik_gradyan_p'] = round(hucre.get('gradyan_p') or 0, 3)
            ozel['manyetik_tilt'] = round(hucre.get('tilt_derece') or 0, 1)
            ozel['manyetik_baglam'] = manyetik_baglam(hucre)
            ozel['manyetik_skor'] = manyetik_skor(hucre, profil_adi)

            # Optik sinif (1-4) ile manyetik skoru birlestir.
            # Optik sekli, manyetik baglami temsil eder - ikisi de esit agirlikta.
            optik_sinif = ozel.get('sinif') or ozel.get('label') or 0
            try:
                optik_normal = min(1.0, float(optik_sinif) / 4.0)
            except (TypeError, ValueError):
                optik_normal = 0.0
            ozel['birlesik_skor'] = round(
                0.5 * optik_normal + 0.5 * ozel['manyetik_skor'], 3
            )
            # Kullaniciya tek cumlelik yorum
            if ozel['manyetik_baglam'] == 'gradyan kusagi' and optik_normal >= 0.75:
                ozel['yorum'] = ('Guclu optik alterasyon + yapisal sinir. '
                                 'Oncelikli saha kontrolu.')
            elif ozel['manyetik_baglam'] == 'manyetik yuksek' and optik_normal >= 0.75:
                ozel['yorum'] = 'Guclu optik alterasyon + manyetit zengini zemin.'
            elif optik_normal >= 0.75:
                ozel['yorum'] = ('Optik anomali guclu, manyetik veri ayirt edici '
                                 'bir sey soylemiyor.')
            else:
                ozel['yorum'] = 'Zayif/orta sinyal.'
        else:
            ozel['manyetik_baglam'] = 'veri yok'
            ozel['manyetik_skor'] = None
            ozel['birlesik_skor'] = None
            ozel['yorum'] = 'Bu konumda manyetik veri bulunmuyor.'

        zenginlestirilmis['features'].append(yeni)

    return zenginlestirilmis


# ---------------------------------------------------------------------
# KATMAN 2: gercek manyetik hucreler
# ---------------------------------------------------------------------

def grid_geojson_uret(hucreler, profil_adi):
    """
    Hucreleri OLDUGU GIBI, kare olarak dondurur. Yumusatma, interpolasyon,
    kontur YOK.

    Sebep: interpolasyon her zaman puruzsuz ve inandirici konturlar uretir,
    ama uretilen detay tamamen matematiksel uydurmadir - olcumden gelmez.
    Kullanici 3.7 km'lik kareleri gorsun ki optik veriyle arasindaki olcek
    farkini gozuyle anlasin.
    """
    yarim = HUCRE_DERECE / 2.0
    ozellikler = []

    for h in hucreler:
        lat, lon = h['lat'], h['lon']
        ozellikler.append({
            'type': 'Feature',
            'geometry': {
                'type': 'Polygon',
                'coordinates': [[
                    [lon - yarim, lat - yarim],
                    [lon + yarim, lat - yarim],
                    [lon + yarim, lat + yarim],
                    [lon - yarim, lat + yarim],
                    [lon - yarim, lat - yarim],
                ]],
            },
            'properties': {
                'anomali_nt': round(h.get('anomali_nt') or 0, 1),
                'gradyan_p': round(h.get('gradyan_p') or 0, 3),
                'analitik_p': round(h.get('analitik_p') or 0, 3),
                'tilt_derece': round(h.get('tilt_derece') or 0, 1),
                'baglam': manyetik_baglam(h),
                'skor': manyetik_skor(h, profil_adi),
            },
        })

    return {'type': 'FeatureCollection', 'features': ozellikler}


# ---------------------------------------------------------------------
# KAYIT
# ---------------------------------------------------------------------

def sonucu_kaydet(kayit, kullanici_token):
    try:
        yanit = requests.post(
            f"{SUPABASE_URL}/rest/v1/manyetik_sonuclar",
            headers={
                "apikey": SUPABASE_KEY,
                "Authorization": f"Bearer {kullanici_token}",
                "Content-Type": "application/json",
                "Prefer": "return=minimal",
            },
            json=kayit,
            timeout=10,
        )
        if yanit.status_code >= 300:
            return f"Kayit hatasi ({yanit.status_code}): {yanit.text[:200]}"
        return None
    except Exception as e:
        return f"Istek hatasi: {e}"


# ---------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------

class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            auth_header = self.headers.get('Authorization', '')
            kullanici_token = auth_header[7:] if auth_header.startswith('Bearer ') else None
            if not kullanici_token:
                raise RuntimeError("Oturum bilgisi eksik, lutfen tekrar giris yap.")

            uzunluk = int(self.headers.get('Content-Length', 0))
            veri = json.loads(self.rfile.read(uzunluk))

            koordinatlar = veri['koordinatlar']
            tarama_id = veri.get('tarama_id')
            optik_sonuc = veri.get('optik_sonuc')
            profil_adi = veri.get('hedef_profil', 'altin')
            if profil_adi not in MANYETIK_PROFILLER:
                profil_adi = 'altin'

            kullanici_id, profil = kullanici_bilgisini_al(kullanici_token)
            if not profil.get('aktif', True):
                raise RuntimeError("Hesabin devre disi birakilmis.")

            # Cizilen alanin sinir kutusu
            lat_list = [k['lat'] for k in koordinatlar]
            lon_list = [k['lng'] for k in koordinatlar]
            hucreler = manyetik_hucreleri_getir(
                min(lat_list), max(lat_list), min(lon_list), max(lon_list),
                kullanici_token,
            )

            if not hucreler:
                raise RuntimeError(
                    "Bu alanda manyetik veri bulunamadi. EMAG2 kapsami "
                    "Turkiye karasini kapsar; deniz ve bazi sinir bolgelerinde "
                    "bosluk olabilir."
                )

            grid = grid_geojson_uret(hucreler, profil_adi)
            poligonlar = poligonlari_zenginlestir(optik_sonuc, hucreler, profil_adi)

            kayit_hatasi = None
            if tarama_id:
                kayit_hatasi = sonucu_kaydet({
                    "tarama_id": tarama_id,
                    "kullanici_id": kullanici_id,
                    "hedef_profil": profil_adi,
                    "poligon_oznitelik": poligonlar,
                    "grid_geojson": grid,
                    "veri_kaynagi": VERI_KAYNAGI,
                    "hucre_boyu_m": HUCRE_METRE,
                    "hucre_sayisi": len(hucreler),
                }, kullanici_token)

            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({
                "basarili": True,
                "grid": grid,
                "poligonlar": poligonlar,
                "hedef_profil": profil_adi,
                "veri_kaynagi": VERI_KAYNAGI,
                "hucre_boyu_m": HUCRE_METRE,
                "hucre_sayisi": len(hucreler),
                "kayit_hatasi": kayit_hatasi,
            }).encode())

        except Exception as e:
            self.send_response(500)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"basarili": False, "hata": str(e)}).encode())
