/*
 * ORTAK SINIF TANIMLARI
 * ---------------------
 * Renkler, etiketler ve mineral profil adları TEK YERDE tanımlı.
 *
 * Neden: bu tanımlar önceden App.jsx, AnalizV2.jsx ve AnalizV3.jsx içinde
 * ayrı ayrı duruyordu. Birinde bir renk değişirse diğerleri sessizce
 * kayıyordu ve aynı kırmızı, üç motorda farklı şeyi ifade etmeye
 * başlıyordu. Artık hepsi buradan okuyor.
 *
 * SINIFIN ANLAMI TÜM MOTORLARDA AYNIDIR:
 *   4 → o motorun kendi ölçütüne göre en üst dilim
 *   1 → eşiği zar zor geçen
 * Eşiğin NASIL hesaplandığı motorlara göre değişir (v1 çizilen alandan,
 * v2/v3 bölgesel yüzdelikten) ama sınıfın taşıdığı anlam aynıdır.
 */

export const RENKLER = {
  '-1': '#9ca3af',  // Analiz dışı (su / bitki örtüsü)
  '0': '#1e3a8a',   // Anomali yok
  '1': '#22c55e',   // Zayıf
  '2': '#facc15',   // Orta
  '3': '#f97316',   // Güçlü
  '4': '#ef4444',   // Çok güçlü
};

export const ETIKETLER = {
  '-1': 'Analiz Dışı (su / bitki örtüsü)',
  '0': 'Anomali Yok',
  '1': 'Zayıf Etki',
  '2': 'Orta Etki',
  '3': 'Güçlü Etki',
  '4': 'Çok Güçlü Etki',
};

export const ONERILER = {
  '0': 'Kayda değer bir şey yok.',
  '1': 'Kayda değer değil, geçilebilir.',
  '2': 'Not al, çevresiyle birlikte değerlendir.',
  '3': 'Saha ziyareti planla, yüzey örneği al.',
  '4': 'Öncelikli saha kontrolü — altın tanıyan dedektörle incele.',
};

/*
 * MİNERAL PROFİLLERİ
 * Parantez içindeki açıklama, o profilin gerçekte NEYE baktığını söylüyor.
 * Sistem altın ölçmez; altın sistemlerine eşlik eden spektral imzayı arar.
 */
export const MINERAL_ETIKETLERI = {
  altin: 'Altın (kil–demir birlikteliği)',
  bakir: 'Bakır (kil + demir dengeli)',
  demir: 'Demir (demir oksit)',
  genel: 'Genel Keşif',
};

// Motorların çizgi tipleri — haritada birbirinden ayırt etmek için
export const MOTOR_CIZGI = {
  v1: { dashArray: null, ad: 'düz çizgi' },
  v2: { dashArray: '5 3', ad: 'kesikli çizgi' },
  v3: { dashArray: '2 4', ad: 'noktalı çizgi' },
};

export function sinifRengi(sinif) {
  return RENKLER[String(sinif)] || '#9ca3af';
}

export function sinifEtiketi(sinif) {
  return ETIKETLER[String(sinif)] || 'Bilinmiyor';
}

export function sinifOnerisi(sinif) {
  return ONERILER[String(sinif)] || '';
}
