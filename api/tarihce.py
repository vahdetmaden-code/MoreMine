from http.server import BaseHTTPRequestHandler
import json
import os
import requests

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_ANON_KEY")
GEMINI_KEY = os.environ.get("GEMINI_API_KEY")

# Google Search grounding destekleyen model.
# Neden grounding: kucuk Anadolu yerlesimleri hakkinda model kendi
# hafizasindan konusursa "burada Frigler bakir islemis" gibi MAKUL AMA
# UYDURMA cumleler uretir. Arama entegrasyonu acikken model cevabi
# uretmeden once gercekten arama yapar ve kaynak dondurur.
GEMINI_MODEL = "gemini-2.5-flash"
GEMINI_URL = (
    f"https://generativelanguage.googleapis.com/v1beta/models/"
    f"{GEMINI_MODEL}:generateContent"
)

SISTEM_TALIMATI = """Sen Anadolu tarihi ve antik madencilik konusunda uzman bir araştırmacısın.
Sana bir koordinat ve konum adı verilecek. O bölge hakkında kısa bir tarihsel bağlam özeti yazacaksın.

ÇOK ÖNEMLİ KURALLAR:
- Emin olmadığın hiçbir şeyi yazma. Bilgi yoksa "Bu bölgeye özgü kayıt bulunamadı" de.
- Uydurma tarih, uydurma medeniyet adı, uydurma maden sahası ASLA yazma.
- Genel Anadolu tarihini bölgeye özgüymüş gibi sunma. "Anadolu'da Hititler yaşamıştır"
  gibi her yere uyan cümleler kurma; sadece O BÖLGEYE dair spesifik bilgi ver.
- Bölge küçükse, en yakın tarihi öneme sahip yerleşimi belirt ve uzaklığını yaz.

ÇIKTI BİÇİMİ — sadece şu JSON'u döndür, başka hiçbir şey yazma:
{
  "medeniyetler": "Bölgede hüküm sürmüş medeniyetler ve dönemleri. 2-4 cümle.",
  "madencilik": "Bölgede bilinen antik veya tarihi madencilik faaliyeti: cüruf yığınları, eski galeriler, Osmanlı maden kayıtları, çıkarılan metaller. Kayıt yoksa açıkça belirt. 2-4 cümle.",
  "jeolojik_not": "Bölgenin jeolojik yapısı ve maden potansiyeli hakkında bilinen bilgi. 1-3 cümle.",
  "guven": "yuksek | orta | dusuk — bulduğun bilginin bölgeye ne kadar özgü olduğuna göre"
}

"madencilik" alanı en önemlisi: eski madencilik faaliyeti cevherleşmenin en güvenilir
göstergelerinden biridir. Bu konuda bulduğun her spesifik bilgiyi yaz."""


def kullanici_dogrula(kullanici_token):
    yanit = requests.get(
        f"{SUPABASE_URL}/auth/v1/user",
        headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {kullanici_token}"},
        timeout=8,
    )
    if yanit.status_code != 200:
        raise RuntimeError("Oturum doğrulanamadı, lütfen tekrar giriş yap.")
    return yanit.json().get("id")


def json_ayikla(metin):
    """
    Model bazen JSON'u ```json ... ``` bloğu içinde döndürür veya öncesine
    açıklama ekler. Ham metinden ilk geçerli JSON nesnesini çıkarıyoruz.
    """
    temiz = metin.strip()
    if temiz.startswith("```"):
        temiz = temiz.split("```")[1]
        if temiz.startswith("json"):
            temiz = temiz[4:]
    bas = temiz.find("{")
    son = temiz.rfind("}")
    if bas == -1 or son == -1:
        return None
    try:
        return json.loads(temiz[bas:son + 1])
    except json.JSONDecodeError:
        return None


def tarihce_uret(lat, lon, konum_adi):
    if not GEMINI_KEY:
        raise RuntimeError(
            "GEMINI_API_KEY ortam değişkeni tanımlı değil. "
            "Vercel > Settings > Environment Variables bölümünden ekle."
        )

    soru = (
        f"Konum: {konum_adi or 'bilinmiyor'}\n"
        f"Koordinat: {lat:.4f}, {lon:.4f}\n\n"
        f"Bu koordinatın bulunduğu bölge hakkında tarihsel bağlam özeti hazırla. "
        f"Özellikle bu bölgede bilinen antik veya tarihi MADENCİLİK faaliyetini araştır: "
        f"cüruf yığınları, antik galeriler, Osmanlı dönemi maden kayıtları, "
        f"çıkarılmış metaller. Yakın çevredeki (30 km içindeki) arkeolojik sahaları da "
        f"dikkate al."
    )

    govde = {
        "systemInstruction": {"parts": [{"text": SISTEM_TALIMATI}]},
        "contents": [{"role": "user", "parts": [{"text": soru}]}],
        # Google Search grounding — model önce arar, sonra cevaplar
        "tools": [{"google_search": {}}],
        "generationConfig": {
            "temperature": 0.2,      # düşük: uydurmayı azaltır
            "maxOutputTokens": 1200,
        },
    }

    yanit = requests.post(
        GEMINI_URL,
        headers={"Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY},
        json=govde,
        timeout=45,
    )

    if yanit.status_code != 200:
        raise RuntimeError(f"Gemini hatası ({yanit.status_code}): {yanit.text[:250]}")

    veri = yanit.json()
    try:
        adaylar = veri["candidates"][0]
        parcalar = adaylar["content"]["parts"]
        ham_metin = "".join(p.get("text", "") for p in parcalar)
    except (KeyError, IndexError):
        raise RuntimeError("Gemini beklenmeyen bir yanıt döndürdü.")

    ayiklanan = json_ayikla(ham_metin)
    if not ayiklanan:
        # JSON çıkmadıysa ham metni tek alanda göster — boş dönmektense iyi
        return {
            "medeniyetler": ham_metin[:900],
            "madencilik": "",
            "jeolojik_not": "",
            "guven": "dusuk",
            "kaynaklar": [],
        }

    # Grounding kaynaklarını topla — kullanıcı doğrulayabilsin
    kaynaklar = []
    try:
        parcalar_meta = adaylar.get("groundingMetadata", {})
        for parca in parcalar_meta.get("groundingChunks", [])[:5]:
            web = parca.get("web", {})
            if web.get("uri"):
                kaynaklar.append({
                    "baslik": web.get("title", "Kaynak"),
                    "adres": web["uri"],
                })
    except (AttributeError, TypeError):
        pass

    ayiklanan["kaynaklar"] = kaynaklar
    return ayiklanan


def tarihceyi_kaydet(tarama_id, tarihce, kullanici_token):
    try:
        yanit = requests.patch(
            f"{SUPABASE_URL}/rest/v1/taramalar?id=eq.{tarama_id}",
            headers={
                "apikey": SUPABASE_KEY,
                "Authorization": f"Bearer {kullanici_token}",
                "Content-Type": "application/json",
                "Prefer": "return=minimal",
            },
            json={"tarihce": tarihce},
            timeout=10,
        )
        if yanit.status_code >= 300:
            return f"Kayıt hatası ({yanit.status_code})"
        return None
    except Exception as e:
        return f"İstek hatası: {e}"


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            auth = self.headers.get('Authorization', '')
            kullanici_token = auth[7:] if auth.startswith('Bearer ') else None
            if not kullanici_token:
                raise RuntimeError("Oturum bilgisi eksik.")

            uzunluk = int(self.headers.get('Content-Length', 0))
            veri = json.loads(self.rfile.read(uzunluk))

            koordinatlar = veri.get('koordinatlar') or []
            if len(koordinatlar) < 3:
                raise RuntimeError("Geçerli bir alan bulunamadı.")

            tarama_id = veri.get('tarama_id')
            konum_adi = veri.get('konum_adi')

            kullanici_dogrula(kullanici_token)

            # Alanın ağırlık merkezi
            lat = sum(k['lat'] for k in koordinatlar) / len(koordinatlar)
            lon = sum(k['lng'] for k in koordinatlar) / len(koordinatlar)

            tarihce = tarihce_uret(lat, lon, konum_adi)

            kayit_hatasi = None
            if tarama_id:
                kayit_hatasi = tarihceyi_kaydet(tarama_id, tarihce, kullanici_token)

            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({
                "basarili": True,
                "tarihce": tarihce,
                "kayit_hatasi": kayit_hatasi,
            }).encode())

        except Exception as e:
            self.send_response(500)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"basarili": False, "hata": str(e)}).encode())
