from http.server import BaseHTTPRequestHandler
import json
import os
import requests

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")


def istegi_yapan_admin_mi(kullanici_token):
    """İsteği yapan kişinin gerçekten admin olup olmadığını doğrular."""
    if not kullanici_token:
        return False
    try:
        yanit = requests.get(
            f"{SUPABASE_URL}/auth/v1/user",
            headers={"apikey": SUPABASE_ANON_KEY, "Authorization": f"Bearer {kullanici_token}"},
            timeout=8,
        )
        if yanit.status_code != 200:
            return False
        kullanici_id = yanit.json().get("id")

        profil_yaniti = requests.get(
            f"{SUPABASE_URL}/rest/v1/profiller?id=eq.{kullanici_id}&select=rol",
            headers={"apikey": SUPABASE_ANON_KEY, "Authorization": f"Bearer {kullanici_token}"},
            timeout=8,
        )
        profiller = profil_yaniti.json()
        return bool(profiller) and profiller[0].get("rol") == "admin"
    except Exception:
        return False


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            auth_header = self.headers.get('Authorization', '')
            kullanici_token = auth_header[len('Bearer '):] if auth_header.startswith('Bearer ') else None

            if not istegi_yapan_admin_mi(kullanici_token):
                self.send_response(403)
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"basarili": False, "hata": "Bu işlem için admin yetkisi gerekiyor."}).encode())
                return

            if not SUPABASE_SERVICE_ROLE_KEY:
                raise RuntimeError("SUPABASE_SERVICE_ROLE_KEY ortam değişkeni ayarlanmamış.")

            content_length = int(self.headers.get('Content-Length', 0))
            veri = json.loads(self.rfile.read(content_length))
            eposta = veri['eposta']
            sifre = veri['sifre']
            tarama_limiti = veri.get('tarama_limiti')  # None = sınırsız
            rol = veri.get('rol', 'kullanici')
            if rol not in ('kullanici', 'admin'):
                rol = 'kullanici'

            olusturma_yaniti = requests.post(
                f"{SUPABASE_URL}/auth/v1/admin/users",
                headers={
                    "apikey": SUPABASE_SERVICE_ROLE_KEY,
                    "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
                    "Content-Type": "application/json",
                },
                json={"email": eposta, "password": sifre, "email_confirm": True},
                timeout=15,
            )

            if olusturma_yaniti.status_code >= 300:
                raise RuntimeError(f"Kullanıcı oluşturulamadı: {olusturma_yaniti.text}")

            yeni_kullanici_id = olusturma_yaniti.json().get("id")

            # tarama_limiti ve rol'ü profile yaz (profil satırı trigger ile zaten otomatik oluştu)
            requests.patch(
                f"{SUPABASE_URL}/rest/v1/profiller?id=eq.{yeni_kullanici_id}",
                headers={
                    "apikey": SUPABASE_SERVICE_ROLE_KEY,
                    "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
                    "Content-Type": "application/json",
                    "Prefer": "return=minimal",
                },
                json={"tarama_limiti": tarama_limiti, "rol": rol},
                timeout=10,
            )

            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"basarili": True}).encode())

        except Exception as e:
            self.send_response(500)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"basarili": False, "hata": str(e)}).encode())
