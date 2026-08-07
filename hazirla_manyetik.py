# -*- coding: utf-8 -*-
"""
MoreMine - Manyetik veri hazirlama betigi  (TEK SEFERLIK CALISTIRILIR)
=======================================================================

Ne yapar:
  1. EMAG2 v3 kuresel manyetik anomali verisini okur
  2. Turkiye kesitini alir
  3. Turev urunlerini hesaplar (yatay gradyan, analitik sinyal, tilt)
  4. Supabase'e yuklenmeye hazir bir CSV uretir

Bu betik VERCEL'DE CALISMAZ ve calismasi gerekmiyor. Kendi bilgisayarinda
bir kez calistiriyorsun, cikan CSV'yi Supabase'e yukluyorsun, isi bitiyor.

-----------------------------------------------------------------------
KURULUM (Windows, PowerShell):

    cd C:\\Projects\\MoreMine
    pip install numpy scipy rasterio pandas

VERIYI INDIR:
    https://www.ncei.noaa.gov/products/earth-magnetic-model-anomaly-grid-2
    sayfasindan EMAG2_V3 GeoTIFF dosyasini indir
    (dosya adi genelde: EMAG2_V3_SeaLevel_DataTiff.tif)

    Indirdigin dosyayi C:\\Projects\\MoreMine\\veri\\ klasorune koy.

CALISTIR:
    python hazirla_manyetik.py veri\\EMAG2_V3_SeaLevel_DataTiff.tif

CIKTI:
    veri\\manyetik_grid_turkiye.csv
-----------------------------------------------------------------------
"""

import os
import sys

import numpy as np

# ---------------------------------------------------------------------
# AYARLAR
# ---------------------------------------------------------------------

# Turkiye + cevresinden bir miktar tampon (sinir bolgelerinde kenar
# etkisi olusmasin diye kasten genis tutuldu; sonda kirpiliyor)
TURKIYE = {"lon_min": 25.0, "lon_max": 45.5, "lat_min": 35.0, "lat_max": 43.0}
TAMPON_DERECE = 2.0  # turev hesabinda kenar bozulmasini disarida birakmak icin

CIKTI_DOSYA = os.path.join("veri", "manyetik_grid_turkiye.csv")

# EMAG2'de veri olmayan hucreler icin kullanilan deger
GECERSIZ_DEGERLER = (-99999, 99999, -32767)


# ---------------------------------------------------------------------
# TUREV HESAPLARI
# (sentetik kaynak testiyle dogrulandi: analitik sinyal kaynagin ustunde,
#  yatay gradyan kaynagin kenarinda tepe yapiyor)
# ---------------------------------------------------------------------

def dusey_turev_fft(grid, dx_m, dy_m):
    """
    Dusey turev (dT/dz). Frekans uzayinda dalga sayisi ile carpilarak
    hesaplanir. Kenar etkisini azaltmak icin grid aynalanarak genisletilir.
    """
    ny, nx = grid.shape
    pad_y, pad_x = ny // 2, nx // 2
    g = np.pad(grid, ((pad_y, pad_y), (pad_x, pad_x)), mode="reflect")

    ky = 2 * np.pi * np.fft.fftfreq(g.shape[0], d=dy_m)
    kx = 2 * np.pi * np.fft.fftfreq(g.shape[1], d=dx_m)
    KX, KY = np.meshgrid(kx, ky)
    K = np.sqrt(KX ** 2 + KY ** 2)

    G = np.fft.fft2(g)
    dz = np.real(np.fft.ifft2(G * K))
    return dz[pad_y:pad_y + ny, pad_x:pad_x + nx]


def turevleri_hesapla(grid, dx_m, dy_m):
    """
    Ham anomali gridinden uc turev urunu uretir.

      yatay_gradyan : yapisal sinirlari (fay, kontak, intruzyon kenari)
                      isaretler. Altin/bakir yataklari cogunlukla burada olur.
      analitik      : kaynagin TAM USTUNDE tepe yapar. Manyetik cismin
                      konumunu verir (demir cevheri icin en degerlisi).
      tilt          : derinlikten bagimsiz normalize sinyal. Sifir gectigi
                      yer kaynagin kenarini isaretler.
    """
    dTdy, dTdx = np.gradient(grid, dy_m, dx_m)
    dTdz = dusey_turev_fft(grid, dx_m, dy_m)

    yatay_gradyan = np.sqrt(dTdx ** 2 + dTdy ** 2)
    analitik = np.sqrt(dTdx ** 2 + dTdy ** 2 + dTdz ** 2)
    tilt = np.degrees(np.arctan2(dTdz, yatay_gradyan + 1e-12))

    return yatay_gradyan, analitik, tilt


def yuzdelik_sirasi(dizi, gecerli_maske):
    """
    Her hucrenin Turkiye genelindeki yuzdelik sirasini (0-1) hesaplar.

    Neden gerekli: kullanicinin cizdigi kucuk bir alanda 3-5 manyetik hucre
    olur. O kadar az veriyle "bu bolgede yuksek mi" sorusuna cevap verilemez.
    Bu yuzden karsilastirmayi TURKIYE GENELINE gore yapiyoruz -> "bu deger
    Turkiye'deki tum degerlerin %92'sinden yuksek" gibi anlamli bir ifade.
    """
    sonuc = np.full(dizi.shape, np.nan)
    degerler = dizi[gecerli_maske]
    if degerler.size == 0:
        return sonuc
    sirali = np.sort(degerler)
    sonuc[gecerli_maske] = np.searchsorted(sirali, degerler, side="right") / sirali.size
    return sonuc


# ---------------------------------------------------------------------
# VERI OKUMA
# ---------------------------------------------------------------------

def geotiff_oku(yol):
    try:
        import rasterio
        from rasterio.windows import from_bounds
    except ImportError:
        print("HATA: rasterio kurulu degil.  ->  pip install rasterio")
        sys.exit(1)

    lon_min = TURKIYE["lon_min"] - TAMPON_DERECE
    lon_max = TURKIYE["lon_max"] + TAMPON_DERECE
    lat_min = TURKIYE["lat_min"] - TAMPON_DERECE
    lat_max = TURKIYE["lat_max"] + TAMPON_DERECE

    with rasterio.open(yol) as kaynak:
        print(f"  Kaynak boyut : {kaynak.width} x {kaynak.height}")
        print(f"  Kaynak CRS   : {kaynak.crs}")
        print(f"  Bant sayisi  : {kaynak.count}")
        print(f"  Veri tipi    : {kaynak.dtypes}")

        # --- DOGRULAMA: sayisal veri mi, renkli goruntu mu? ---
        # NOAA sayfasinda GORSEL surumler de GeoTIFF olarak sunuluyor
        # (Color-relief, Color Hillshade). Bunlar 3-4 bantli, 0-255 arasi
        # RGB degerleri icerir; icinde nanotesla degeri YOKTUR.
        # Ihtiyacimiz olan: "EMAG2v3 Source GeoTIFFs > Sea Level" (tek bant, float32)
        gorsel_mi = (
            kaynak.count >= 3
            or any(t in ("uint8", "int8") for t in kaynak.dtypes)
        )
        if gorsel_mi:
            print("\n" + "!" * 62)
            print("HATA: Bu dosya SAYISAL VERI DEGIL, RENKLI GORUNTU.")
            print("!" * 62)
            print(f"  Bulunan : {kaynak.count} bant, {kaynak.dtypes}")
            print("  Gereken : 1 bant, ('float32',)")
            print()
            print("  Yanlislikla su dosyalardan birini indirmis olabilirsin:")
            print("    - Color-relief Image   (150 MB)")
            print("    - Color Hillshade Image (294 MB)")
            print()
            print("  DOGRUSU, NOAA sayfasindaki tablonun 2. satiri:")
            print("    'EMAG2v3 Source GeoTIFFs'  ->  Sea Level  (175 MB)")
            print("!" * 62)
            sys.exit(1)

        pencere = from_bounds(lon_min, lat_min, lon_max, lat_max,
                              kaynak.transform)
        grid = kaynak.read(1, window=pencere).astype(np.float64)
        donusum = kaynak.window_transform(pencere)

    ny, nx = grid.shape
    # Hucre merkezlerinin koordinatlari
    lon = donusum.c + donusum.a * (np.arange(nx) + 0.5)
    lat = donusum.f + donusum.e * (np.arange(ny) + 0.5)

    return grid, lon, lat


def csv_oku(yol):
    """
    EMAG2 v3 CSV surumunu okur.

    SUTUN DUZENI (baslik satiri yok, 8 sutun):
        0: i          satir indeksi
        1: j          sutun indeksi
        2: lon        boylam
        3: lat        enlem
        4: deniz      deniz seviyesi anomalisi  <- COK BOSLUK VAR (99999)
        5: yukseltilmis  4 km'ye yukseltilmis anomali  <- KESINTISIZ
        6: kod        veri kaynagi kodu
        7: hata       tahmini hata

    HANGI SUTUNU KULLANIYORUZ VE NEDEN:

      4. sutun (deniz seviyesi) daha keskindir, yuzeye yakin detayi
      korur. AMA sadece gercek ucus/gemi olcumu olan yerlerde doludur;
      Turkiye'nin buyuk kisminda 99999 (veri yok) yazar. Ilk denemede
      Usak civarinda en yakin hucre 95 km oteye dustu, sebebi buydu.

      5. sutun (yukseltilmis) uydu modelinden turetilir ve HER YERDE
      doludur. Bedeli: veri 4 km yuksege tasinmis gibi hesaplandigi icin
      daha puruzsuzdur, ince detay bastirilmistir.

      Bizim hucre boyumuz zaten ~3.7 km. Yani 4 km'lik yukseltmenin
      sildigi detayi bu cozunurlukte zaten coozemezdik. Buna karsilik
      kesintisiz kapsama, turev hesabi icin sart: gridde delik olursa
      gradyan o kenarlarda sahte sicramalar uretir.

      Bu yuzden 5. sutunu kullaniyoruz. Iki sutunu karistirmak (birinde
      olani ondan, olmayani digerinden almak) daha da kotu olurdu:
      iki kaynagin birlestigi yerde YAPAY bir gradyan kusagi olusur ve
      sistem orayi "yapisal sinir" sanip yanlis hedef uretirdi.
    """
    try:
        import pandas as pd
    except ImportError:
        print("HATA: pandas kurulu degil.  ->  pip install pandas")
        sys.exit(1)

    SUTUN_LON, SUTUN_LAT = 2, 3
    SUTUN_DENIZ, SUTUN_YUKSELTILMIS = 4, 5

    lon_min = TURKIYE["lon_min"] - TAMPON_DERECE
    lon_max = TURKIYE["lon_max"] + TAMPON_DERECE
    lat_min = TURKIYE["lat_min"] - TAMPON_DERECE
    lat_max = TURKIYE["lat_max"] + TAMPON_DERECE

    print("  CSV parca parca okunuyor (dosya buyuk, birkac dakika surer)...")
    parcalar = []
    okunan = 0
    for parca in pd.read_csv(
        yol, chunksize=2_000_000, header=None, sep=",",
        usecols=[SUTUN_LON, SUTUN_LAT, SUTUN_DENIZ, SUTUN_YUKSELTILMIS],
    ):
        parca.columns = ["lon", "lat", "deniz", "yukseltilmis"]
        okunan += len(parca)
        p = parca[
            (parca.lon >= lon_min) & (parca.lon <= lon_max) &
            (parca.lat >= lat_min) & (parca.lat <= lat_max)
        ]
        if len(p):
            parcalar.append(p)
        sys.stdout.write(f"\r  Taranan satir: {okunan:,}   "
                         f"Turkiye kesitinde bulunan: "
                         f"{sum(len(x) for x in parcalar):,}")
        sys.stdout.flush()
    print()

    if not parcalar:
        print("HATA: CSV icinde Turkiye araligina denk gelen satir yok.")
        sys.exit(1)

    tablo = pd.concat(parcalar, ignore_index=True)

    # --- Iki sutunun kapsamini karsilastirip kullaniciya goster ---
    deniz_dolu = int((tablo.deniz.abs() < 10000).sum())
    yuk_dolu = int((tablo.yukseltilmis.abs() < 10000).sum())
    toplam = len(tablo)
    print(f"  Turkiye kesiti          : {toplam:,} hucre")
    print(f"  4. sutun (deniz sv.)    : {deniz_dolu:,} dolu "
          f"(%{100*deniz_dolu/toplam:.0f}) - BOSLUKLU, kullanilmiyor")
    print(f"  5. sutun (yukseltilmis) : {yuk_dolu:,} dolu "
          f"(%{100*yuk_dolu/toplam:.0f}) - KULLANILAN")

    tablo = tablo[tablo.yukseltilmis.abs() < 10000]
    if len(tablo) == 0:
        print("HATA: yukseltilmis sutununda da gecerli deger yok.")
        sys.exit(1)

    # --- Gridi vektorel kur (satir satir dongu cok yavas kaliyordu) ---
    lat_artan = np.sort(tablo.lat.unique())
    lon = np.sort(tablo.lon.unique())
    lat = lat_artan[::-1]  # kuzeyden guneye

    satir = (len(lat_artan) - 1) - np.searchsorted(lat_artan, tablo.lat.values)
    sutun = np.searchsorted(lon, tablo.lon.values)

    grid = np.full((len(lat), len(lon)), np.nan)
    grid[satir, sutun] = tablo.yukseltilmis.values

    dolu = np.isfinite(grid).sum()
    print(f"  Grid                    : {len(lat)} x {len(lon)} "
          f"({dolu:,} dolu, %{100*dolu/grid.size:.0f} kapsama)")

    return grid, lon, lat


# ---------------------------------------------------------------------
# ANA AKIS
# ---------------------------------------------------------------------

def internetten_indir(url):
    """
    Verilen adresten dosyayi indirir ve veri klasorune kaydeder.
    Tarayicidan indirmeye gore avantaji: dogru satirdaki linki
    yapistirdigin surece karisiklik olmaz, ve indirme biter bitmez
    dosyanin dogru tipte olup olmadigi kontrol edilir.
    """
    import urllib.request

    os.makedirs("veri", exist_ok=True)
    dosya_adi = url.split("/")[-1].split("?")[0] or "emag2_indirilen.tif"
    hedef = os.path.join("veri", dosya_adi)

    print(f"  Adres : {url}")
    print(f"  Hedef : {hedef}")

    def ilerleme(blok, blok_boyut, toplam):
        if toplam <= 0:
            return
        inen = blok * blok_boyut
        yuzde = min(100.0, inen * 100.0 / toplam)
        sys.stdout.write(
            f"\r  Iniyor: {yuzde:5.1f}%  "
            f"({inen/1048576:.0f} / {toplam/1048576:.0f} MB)"
        )
        sys.stdout.flush()

    try:
        urllib.request.urlretrieve(url, hedef, reporthook=ilerleme)
        print()
    except Exception as e:
        print(f"\nHATA: indirme basarisiz -> {e}")
        sys.exit(1)

    boyut_mb = os.path.getsize(hedef) / 1048576
    print(f"  Indi  : {boyut_mb:.1f} MB")
    return hedef


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        print("KULLANIM:")
        print("  python hazirla_manyetik.py <dosya_yolu>")
        print("  python hazirla_manyetik.py <indirme_adresi>")
        sys.exit(1)

    girdi = sys.argv[1]

    if girdi.lower().startswith(("http://", "https://")):
        print("=" * 62)
        print("Internetten indiriliyor...")
        print("=" * 62)
        kaynak_yol = internetten_indir(girdi)
    else:
        kaynak_yol = girdi

    if not os.path.exists(kaynak_yol):
        print(f"HATA: dosya bulunamadi -> {kaynak_yol}")
        sys.exit(1)

    print("=" * 62)
    print("MoreMine - Manyetik veri hazirlama")
    print("=" * 62)

    # --- 1. OKU ---
    print("\n[1/5] EMAG2 verisi okunuyor...")
    if kaynak_yol.lower().endswith((".tif", ".tiff")):
        grid, lon, lat = geotiff_oku(kaynak_yol)
    elif kaynak_yol.lower().endswith(".csv"):
        grid, lon, lat = csv_oku(kaynak_yol)
    else:
        print("HATA: dosya .tif veya .csv olmali.")
        sys.exit(1)

    # Gecersiz degerleri temizle
    for gecersiz in GECERSIZ_DEGERLER:
        grid[grid == gecersiz] = np.nan
    grid[np.abs(grid) > 10000] = np.nan  # akil disi degerler

    print(f"  Kesit boyutu : {grid.shape[0]} satir x {grid.shape[1]} sutun")
    print(f"  Boylam       : {lon.min():.2f} - {lon.max():.2f}")
    print(f"  Enlem        : {lat.min():.2f} - {lat.max():.2f}")

    gecerli = np.isfinite(grid)
    print(f"  Gecerli hucre: {gecerli.sum():,} / {grid.size:,}")
    if gecerli.sum() < 100:
        print("HATA: neredeyse hic gecerli veri yok. Dosya yanlis olabilir.")
        sys.exit(1)

    # --- DOGRULAMA: degerler gercek manyetik anomali gibi mi duruyor? ---
    # Gercek EMAG2 verisinde Turkiye kesiti tipik olarak -400 .. +600 nT
    # araliginda DALGALANIR. Deger cesitliligi cok dusukse ya yanlis dosya
    # ya da yanlis bant okunmustur.
    benzersiz = len(np.unique(np.round(grid[gecerli], 1)))
    std_sapma = float(np.nanstd(grid))
    print(f"  Deger araligi: {np.nanmin(grid):+.1f} .. {np.nanmax(grid):+.1f} nT")
    print(f"  Std sapma    : {std_sapma:.1f} nT   (benzersiz deger: {benzersiz:,})")

    if benzersiz < 50 or std_sapma < 1.0:
        print("\n" + "!" * 62)
        print("HATA: Degerler manyetik anomali gibi durmuyor.")
        print("!" * 62)
        print("  Gercek veride binlerce farkli deger ve 50-200 nT")
        print("  civari standart sapma beklenir.")
        print("  Burada neredeyse sabit deger var -> renkli goruntu dosyasi.")
        print()
        print("  DOGRUSU: 'EMAG2v3 Source GeoTIFFs' -> Sea Level (175 MB)")
        print("!" * 62)
        sys.exit(1)

    # --- 2. BOSLUKLARI DOLDUR ---
    # FFT bosluk (NaN) kaldirmaz. Deniz/veri bosluklarini ortalama ile
    # gecici doldurup, hesap bitince o hucreleri yine gecersiz isaretliyoruz.
    print("\n[2/5] Veri bosluklari geciciolarak dolduruluyor...")
    ortalama = np.nanmean(grid)
    grid_dolu = np.where(gecerli, grid, ortalama)

    # --- 3. HUCRE BOYUTU ---
    d_lon = abs(lon[1] - lon[0]) if len(lon) > 1 else 1 / 30
    d_lat = abs(lat[1] - lat[0]) if len(lat) > 1 else 1 / 30
    orta_enlem = float(np.mean(lat))

    dy_m = d_lat * 111_320.0
    dx_m = d_lon * 111_320.0 * np.cos(np.radians(orta_enlem))
    print(f"\n[3/5] Hucre boyutu: {dx_m/1000:.2f} km (dogu-bati) "
          f"x {dy_m/1000:.2f} km (kuzey-guney)")
    print(f"  NOT: optik analiz 10 m calisiyor. Manyetik veri "
          f"{dx_m/10:.0f} kat daha kaba.")

    # --- 4. TUREVLER ---
    print("\n[4/5] Turev urunleri hesaplaniyor...")
    yatay_gradyan, analitik, tilt = turevleri_hesapla(grid_dolu, dx_m, dy_m)

    anomali_p = yuzdelik_sirasi(grid, gecerli)
    gradyan_p = yuzdelik_sirasi(yatay_gradyan, gecerli)
    analitik_p = yuzdelik_sirasi(analitik, gecerli)

    print(f"  anomali  : {np.nanmin(grid):+.1f} .. {np.nanmax(grid):+.1f} nT")
    print(f"  gradyan  : {np.nanmin(yatay_gradyan[gecerli]):.3g} .. "
          f"{np.nanmax(yatay_gradyan[gecerli]):.3g} nT/m")
    print(f"  tilt     : {np.nanmin(tilt[gecerli]):+.1f} .. "
          f"{np.nanmax(tilt[gecerli]):+.1f} derece")

    # --- 5. CSV YAZ ---
    print("\n[5/5] CSV yaziliyor...")
    os.makedirs(os.path.dirname(CIKTI_DOSYA) or ".", exist_ok=True)

    LON, LAT = np.meshgrid(lon, lat)

    # Tamponu simdi kirp - kenar bozulmalari disarida kalsin
    kirp = (
        (LON >= TURKIYE["lon_min"]) & (LON <= TURKIYE["lon_max"]) &
        (LAT >= TURKIYE["lat_min"]) & (LAT <= TURKIYE["lat_max"]) &
        gecerli
    )

    satir_sayisi = 0
    with open(CIKTI_DOSYA, "w", encoding="utf-8", newline="") as f:
        f.write("lat,lon,anomali_nt,gradyan,analitik_sinyal,tilt_derece,"
                "anomali_p,gradyan_p,analitik_p\n")
        idx = np.argwhere(kirp)
        for i, j in idx:
            f.write(
                f"{LAT[i, j]:.5f},{LON[i, j]:.5f},"
                f"{grid[i, j]:.2f},"
                f"{yatay_gradyan[i, j]:.6g},"
                f"{analitik[i, j]:.6g},"
                f"{tilt[i, j]:.2f},"
                f"{anomali_p[i, j]:.4f},"
                f"{gradyan_p[i, j]:.4f},"
                f"{analitik_p[i, j]:.4f}\n"
            )
            satir_sayisi += 1

    boyut_mb = os.path.getsize(CIKTI_DOSYA) / 1024 / 1024

    print(f"\n{'=' * 62}")
    print(f"TAMAM.")
    print(f"  Dosya  : {CIKTI_DOSYA}")
    print(f"  Satir  : {satir_sayisi:,}")
    print(f"  Boyut  : {boyut_mb:.1f} MB")
    print(f"{'=' * 62}")
    print("\nSONRAKI ADIM:")
    print("  1. Supabase panelinde manyetik_tablolar.sql dosyasini calistir")
    print("  2. Table Editor > manyetik_grid > Import data from CSV")
    print(f"  3. {CIKTI_DOSYA} dosyasini yukle")


if __name__ == "__main__":
    main()