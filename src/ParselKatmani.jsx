import { useState, useEffect, useCallback, useRef } from 'react';
import { GeoJSON } from 'react-leaflet';
import { supabase } from './supabaseClient';

/*
 * PARSEL KATMANI (TKGM KADASTRO SORGUSU)
 * ======================================
 * Haritaya pin bırakılan noktanın tapu-kadastro kimliğini gösterir:
 * il / ilçe / mahalle / ada / parsel / tapu alanı / nitelik, ve parselin
 * SINIRINI haritaya çizer.
 *
 * Analiz tarafına (v1–v4, manyetik) hiç dokunmaz: ayrı dosya, ayrı
 * uç nokta (/api/parsel), ayrı panel. Veri kaydı da yapmaz — her sorgu
 * anlıktır, Supabase'e hiçbir şey yazılmaz.
 *
 * NEDEN SUNUCU ÜZERİNDEN: TKGM servisi CORS başlığı döndürmediği için
 * tarayıcıdan doğrudan çağrılamaz; istek /api/parsel fonksiyonuna gider.
 *
 * ÖNEMLİ NOT (doğruluk): burada gösterilen bilgi TKGM'nin açık parsel
 * servisinden gelir; resmî tapu kaydı yerine geçmez. Hukuki işlem için
 * Tapu Müdürlüğü / e-Devlet kaydı esastır.
 */

const SINIR_STILI = {
  color: '#38bdf8',
  weight: 3,
  opacity: 0.95,
  fillColor: '#38bdf8',
  fillOpacity: 0.12,
  dashArray: '8 5',          // analiz poligonlarıyla karışmasın
};

// Tapu alanı "4.250,75" gibi Türkçe biçimde gelebiliyor.
function alanSayiya(deger) {
  if (deger == null) return null;
  if (typeof deger === 'number') return deger;
  const metin = String(deger).trim();
  if (!metin) return null;
  // binlik ayıracı nokta, ondalık ayıracı virgül
  const duz = metin.replace(/\./g, '').replace(',', '.').replace(/[^\d.]/g, '');
  const sayi = parseFloat(duz);
  return Number.isFinite(sayi) ? sayi : null;
}

function alanMetni(deger) {
  const m2 = alanSayiya(deger);
  if (m2 == null) return deger != null ? String(deger) : '—';
  const donum = m2 / 1000;
  return `${m2.toLocaleString('tr-TR', { maximumFractionDigits: 2 })} m²` +
    (m2 >= 1000 ? `  (${donum.toLocaleString('tr-TR', { maximumFractionDigits: 2 })} dönüm)` : '');
}

const SATIRLAR = [
  ['il', 'İl'],
  ['ilce', 'İlçe'],
  ['mahalle', 'Mahalle / Köy'],
  ['ada', 'Ada No'],
  ['parsel', 'Parsel No'],
  ['nitelik', 'Niteliği'],
  ['mevkii', 'Mevkii'],
  ['pafta', 'Pafta'],
];

export default function ParselKatmani({ nokta, acik = false, onKapat, onDurum }) {
  const [sonuc, setSonuc] = useState(null);
  const [yukleniyor, setYukleniyor] = useState(false);
  const [hata, setHata] = useState(null);
  const [hamGoster, setHamGoster] = useState(false);
  const sonSorguRef = useRef(null);

  const durumBildir = useCallback((durum) => {
    if (onDurum) onDurum(durum);
  }, [onDurum]);

  const sorgula = useCallback(async (hedef) => {
    if (!hedef) return;
    setYukleniyor(true);
    setHata(null);
    durumBildir({ durum: 'calisiyor' });
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Oturum bulunamadı, lütfen tekrar giriş yap.');

      const yanit = await fetch('/api/parsel', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ lat: hedef.lat, lon: hedef.lng }),
      });

      const veri = await yanit.json().catch(() => null);
      if (!yanit.ok || !veri?.ok) {
        throw new Error(veri?.hata || `Sunucu hatası (${yanit.status})`);
      }

      setSonuc(veri);
      durumBildir({ durum: veri.kimlik_var ? 'tamam' : 'hata' });
    } catch (e) {
      setSonuc(null);
      setHata(e.message);
      durumBildir({ durum: 'hata' });
    } finally {
      setYukleniyor(false);
    }
  }, [durumBildir]);

  // Pin değiştiğinde otomatik sorgula. Aynı noktada tekrar tekrar
  // istek atmamak için son sorgulanan koordinatı hatırlıyoruz.
  useEffect(() => {
    // Pin kaldırıldı (nokta null) -> sınırı ve sonucu haritadan sil
    if (!nokta) {
      sonSorguRef.current = null;
      setSonuc(null);
      setHata(null);
      return;
    }
    const imza = `${nokta.lat.toFixed(6)},${nokta.lng.toFixed(6)}`;
    if (sonSorguRef.current === imza) return;
    sonSorguRef.current = imza;
    setHamGoster(false);
    sorgula(nokta);
  }, [nokta, sorgula]);

  const alanlar = sonuc?.alanlar || {};
  // Bazı parsellerin ADASI YOKTUR (yalnızca parsel numarası verilir) —
  // TKGM bu durumda adaNo alanını boş döndürüyor. Başlığı parsel
  // numarasına bağlıyoruz, yoksa adasız parseller başlıksız kalıyordu.
  const baslik = alanlar.parsel
    ? `${alanlar.ada || '—'} / ${alanlar.parsel}`
    : null;

  return (
    <>
      {/* --- PARSEL SINIRI (panel kapalı olsa da haritada kalır) --- */}
      {sonuc?.geometri && (
        <GeoJSON
          key={`parsel-${sonuc.nokta.lat}-${sonuc.nokta.lon}`}
          data={{ type: 'Feature', geometry: sonuc.geometri, properties: {} }}
          style={() => SINIR_STILI}
          onEachFeature={(f, katman) => {
            katman.bindTooltip(
              `<b>Parsel ${baslik || ''}</b>` +
              (alanlar.mahalle ? `<br/>${alanlar.mahalle}` : '') +
              (alanlar.alan ? `<br/>${alanMetni(alanlar.alan)}` : ''),
              { sticky: true }
            );
          }}
        />
      )}

      {/* --- PANEL --- */}
      {acik && (
        <div style={{
          position: 'absolute', right: 12, bottom: 62, zIndex: 1000,
          background: 'rgba(15,23,42,0.95)', color: '#e2e8f0',
          borderRadius: 12, padding: 14,
          width: 'min(330px, calc(100vw - 24px))', fontSize: 13,
          maxHeight: 'calc(100vh - 160px)', overflowY: 'auto',
          boxShadow: '0 4px 20px rgba(0,0,0,0.45)',
          WebkitOverflowScrolling: 'touch',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <b>🧾 Parsel Sorgu</b>
            <button
              onClick={() => onKapat && onKapat()}
              style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 18 }}
            >×</button>
          </div>

          {!nokta && (
            <div style={{ color: '#94a3b8', fontSize: 12, lineHeight: 1.6 }}>
              Sol üstteki <b>pin</b> aracıyla haritada bir nokta işaretle;
              o noktanın ada/parsel bilgisi ve sınırı burada görünecek.
            </div>
          )}

          {nokta && (
            <div style={{
              fontFamily: 'monospace', fontSize: 11, color: '#64748b',
              marginBottom: 10, paddingBottom: 8, borderBottom: '1px solid #334155',
            }}>
              📍 {nokta.lat.toFixed(6)}, {nokta.lng.toFixed(6)}
            </div>
          )}

          {yukleniyor && (
            <div style={{ color: '#38bdf8', fontSize: 12 }}>TKGM sorgulanıyor…</div>
          )}

          {hata && !yukleniyor && (
            <div style={{
              background: 'rgba(220,38,38,0.15)', border: '1px solid #dc2626',
              borderRadius: 8, padding: 10, fontSize: 12, lineHeight: 1.5, color: '#fca5a5',
            }}>
              {hata}
            </div>
          )}

          {sonuc && !yukleniyor && (
            <>
              {baslik && (
                <div style={{
                  fontSize: 20, fontWeight: 700, color: '#38bdf8',
                  letterSpacing: 0.5, marginBottom: 2,
                }}>
                  {baslik}
                </div>
              )}
              {baslik && (
                <div style={{ fontSize: 10, color: '#64748b', marginBottom: 10 }}>
                  ADA / PARSEL
                </div>
              )}

              {sonuc.uyari && (
                <div style={{
                  background: 'rgba(245,158,11,0.12)', border: '1px solid #b45309',
                  borderRadius: 8, padding: 9, fontSize: 11.5, lineHeight: 1.5,
                  color: '#fcd34d', marginBottom: 10,
                }}>
                  ⚠ {sonuc.uyari}
                </div>
              )}

              {sonuc.kimlik_var && (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                <tbody>
                  {SATIRLAR.map(([anahtar, etiket]) => (
                    <tr key={anahtar}>
                      <td style={{
                        padding: '5px 0', color: '#94a3b8', whiteSpace: 'nowrap',
                        verticalAlign: 'top', width: '42%',
                      }}>{etiket}</td>
                      <td style={{ padding: '5px 0', fontWeight: 600, textAlign: 'right' }}>
                        {alanlar[anahtar] != null && alanlar[anahtar] !== ''
                          ? String(alanlar[anahtar])
                          : <span style={{ color: '#475569', fontWeight: 400 }}>—</span>}
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td style={{
                      padding: '7px 0 5px', color: '#94a3b8', whiteSpace: 'nowrap',
                      verticalAlign: 'top', borderTop: '1px solid #334155',
                    }}>Tapu Alanı</td>
                    <td style={{
                      padding: '7px 0 5px', fontWeight: 700, textAlign: 'right',
                      color: '#38bdf8', borderTop: '1px solid #334155',
                    }}>
                      {alanMetni(alanlar.alan)}
                    </td>
                  </tr>
                </tbody>
              </table>
              )}

              <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
                <button
                  onClick={() => nokta && (sonSorguRef.current = null, sorgula(nokta))}
                  style={{
                    flex: 1, padding: '7px 6px', borderRadius: 7,
                    border: '1px solid #334155', background: 'transparent',
                    color: '#cbd5e1', cursor: 'pointer', fontSize: 11.5,
                  }}
                >
                  Yeniden sorgula
                </button>
                <button
                  onClick={async () => {
                    const metin = [
                      baslik ? `Ada/Parsel: ${baslik}` : null,
                      alanlar.il ? `İl/İlçe: ${alanlar.il} / ${alanlar.ilce || '—'}` : null,
                      alanlar.mahalle ? `Mahalle: ${alanlar.mahalle}` : null,
                      alanlar.nitelik ? `Nitelik: ${alanlar.nitelik}` : null,
                      alanlar.alan ? `Tapu alanı: ${alanMetni(alanlar.alan)}` : null,
                      `Koordinat: ${sonuc.nokta.lat.toFixed(6)}, ${sonuc.nokta.lon.toFixed(6)}`,
                    ].filter(Boolean).join('\n');
                    try { await navigator.clipboard.writeText(metin); } catch { /* izin yok */ }
                  }}
                  style={{
                    flex: 1, padding: '7px 6px', borderRadius: 7, border: 'none',
                    background: '#0e7490', color: '#fff', cursor: 'pointer', fontSize: 11.5,
                  }}
                >
                  Kopyala
                </button>
              </div>

              <a
                href={`https://parselsorgu.tkgm.gov.tr/#ara/cografi/${sonuc.nokta.lat}/${sonuc.nokta.lon}`}
                target="_blank"
                rel="noreferrer"
                style={{
                  display: 'block', marginTop: 8, textAlign: 'center',
                  fontSize: 11.5, color: '#38bdf8', textDecoration: 'none',
                  padding: '6px', border: '1px solid #164e63', borderRadius: 7,
                }}
              >
                TKGM Parsel Sorgu'da aç ↗
              </a>

              {/* Alan adları değişirse panel körleşmesin: ham veriyi göster */}
              {sonuc.ham && Object.keys(sonuc.ham).length > 0 && (
                <>
                  <button
                    onClick={() => setHamGoster((g) => !g)}
                    style={{
                      marginTop: 10, background: 'none', border: 'none',
                      color: '#64748b', cursor: 'pointer', fontSize: 11, padding: 0,
                    }}
                  >
                    {hamGoster ? '▾' : '▸'} Servisten gelen tüm alanlar
                  </button>
                  {hamGoster && (
                    <pre style={{
                      marginTop: 6, maxHeight: 180, overflow: 'auto',
                      background: '#0f172a', border: '1px solid #1e293b',
                      borderRadius: 7, padding: 8, fontSize: 10.5,
                      color: '#94a3b8', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                    }}>
                      {JSON.stringify(sonuc.ham, null, 1)}
                    </pre>
                  )}
                </>
              )}

              <div style={{
                marginTop: 10, paddingTop: 8, borderTop: '1px solid #1e293b',
                fontSize: 10.5, color: '#64748b', lineHeight: 1.5,
              }}>
                Kaynak: TKGM açık parsel servisi ({sonuc.kaynak}). Bilgilendirme
                amaçlıdır, resmî tapu kaydı yerine geçmez.
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
