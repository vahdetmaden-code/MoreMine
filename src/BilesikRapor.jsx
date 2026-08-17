import { RENKLER, ETIKETLER, ONERILER } from './siniflar';

/*
 * BİLEŞİK ANALİZ RAPORU
 * ---------------------
 * Üç motorun sonuçlarını yan yana, okunabilir tek bir tabloda gösterir.
 * Ayrıca her motorun o anki DURUMUNU canlı gösterir — önceden analizlerin
 * çalışıp çalışmadığı görünmüyordu.
 *
 * Bilerek YAPMADIĞI şey: motorların kesişimini alıp "doğru cevap" diye
 * sunmak. Üç motor farklı soru soruyor; kesişimi filtre yapmak, yalnız
 * v3'ün gördüğü gerçek bir hedefi gözden kaçırmaya yol açar. Rapor
 * karşılaştırmayı önüne koyar, kararı sana bırakır.
 */

const MOTOR_BILGI = {
  v1: { ad: 'v1 — Geniş Tarama', renk: '#3b82f6', not: 'Ham spektral anomali' },
  v2: { ad: 'v2 — Kararlı Anomali', renk: '#0891b2', not: 'Zamanla ısrarla çıkanlar' },
  v3: { ad: 'v3 — Mineral Ayrımı', renk: '#059669', not: 'Demir–kil birlikteliği' },
};

const DURUM_ETIKET = {
  bekliyor: { ad: 'Çalıştırılmadı', renk: '#64748b', ikon: '○' },
  calisiyor: { ad: 'Çalışıyor…', renk: '#f59e0b', ikon: '◐' },
  tamam: { ad: 'Tamamlandı', renk: '#22c55e', ikon: '●' },
  hata: { ad: 'Hata', renk: '#dc2626', ikon: '✕' },
};

function sinifSay(ozellikler) {
  const sayim = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const o of ozellikler || []) {
    const s = Number(o?.properties?.sinif);
    if (sayim[s] !== undefined) sayim[s] += 1;
  }
  return sayim;
}

function toplamAlan(ozellikler) {
  let m2 = 0;
  for (const o of ozellikler || []) m2 += Number(o?.properties?.alan_m2) || 0;
  return m2;
}

function alanYazi(m2) {
  if (!m2) return '—';
  if (m2 >= 1e6) return `${(m2 / 1e6).toFixed(2)} km²`;
  return `${Math.round(m2 / 1000) / 10} ha`;
}

export default function BilesikRapor({ durumlar, acik, onKapat }) {
  if (!acik) return null;

  const d = durumlar || {};
  const motorlar = ['v1', 'v2', 'v3'];

  // Yorum cümlesi: sayılara bakıp tek cümlelik özet üret
  const yorumla = () => {
    const v1s = d.v1?.ozellikler?.length || 0;
    const v2s = d.v2?.ozellikler?.length || 0;
    const v3s = d.v3?.ozellikler?.length || 0;
    if (d.v3?.durum !== 'tamam' && d.v2?.durum !== 'tamam') return null;

    const parcalar = [];
    if (v1s && v3s) {
      const oran = Math.round((1 - v3s / v1s) * 100);
      if (oran > 0) parcalar.push(`v3, v1'in bulduklarının %${oran}'ini eledi.`);
    }
    const ayrim = d.v3?.ayrim;
    if (ayrim) {
      const t = ayrim.demir_ve_kil + ayrim.sadece_demir + ayrim.sadece_kil;
      if (t > 0) {
        const sd = Math.round((ayrim.sadece_demir / t) * 100);
        if (sd >= 50) {
          parcalar.push(`Alanın %${sd}'i "demir var, kil yok" — dere yatağı alüvyonu veya kırmızı toprak tipik olarak buraya düşer.`);
        } else if (ayrim.demir_ve_kil > 0) {
          const dk = Math.round((ayrim.demir_ve_kil / t) * 100);
          parcalar.push(`Alanın %${dk}'inde demir ve kil birlikte — alterasyon için beklenen imza.`);
        }
      }
    }
    if (d.v3?.crosta?.supheli) {
      parcalar.push('Bileşen ayrımı zayıf çıktı; v3 sonucuna temkinli yaklaş.');
    }
    return parcalar.length ? parcalar.join(' ') : null;
  };

  const yorum = yorumla();

  return (
    <div style={{
      position: 'absolute', right: 12, bottom: 62, zIndex: 1000,
      width: 'min(330px, calc(100vw - 24px))',
      maxHeight: 'calc(100vh - 150px)', overflowY: 'auto',
      WebkitOverflowScrolling: 'touch',
      background: 'rgba(15,23,42,0.96)', color: '#e2e8f0',
      borderRadius: 12, padding: 14, fontSize: 13,
      boxShadow: '0 4px 20px rgba(0,0,0,0.45)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <b>📊 Bileşik Rapor</b>
        <button
          onClick={() => onKapat && onKapat()}
          style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 18 }}
        >×</button>
      </div>

      {/* --- MOTOR DURUMLARI --- */}
      {motorlar.map((m) => {
        const bilgi = MOTOR_BILGI[m];
        const durum = d[m]?.durum || 'bekliyor';
        const de = DURUM_ETIKET[durum];
        const ozellikler = d[m]?.ozellikler;
        const sayim = sinifSay(ozellikler);
        const toplam = ozellikler?.length || 0;

        return (
          <div key={m} style={{
            borderLeft: `3px solid ${bilgi.renk}`, paddingLeft: 9,
            marginBottom: 12,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
              <b style={{ fontSize: 12.5 }}>{bilgi.ad}</b>
              <span style={{ color: de.renk, fontSize: 11.5, whiteSpace: 'nowrap' }}>
                {de.ikon} {de.ad}
              </span>
            </div>
            <div style={{ color: '#64748b', fontSize: 10.5, marginBottom: 4 }}>{bilgi.not}</div>

            {durum === 'hata' && (
              <div style={{ color: '#fca5a5', fontSize: 11, lineHeight: 1.5 }}>
                {d[m]?.mesaj}
              </div>
            )}

            {durum === 'tamam' && (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}>
                  <span style={{ color: '#94a3b8' }}>Poligon</span>
                  <b>{toplam}</b>
                </div>
                {toplamAlan(ozellikler) > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}>
                    <span style={{ color: '#94a3b8' }}>Toplam alan</span>
                    <b>{alanYazi(toplamAlan(ozellikler))}</b>
                  </div>
                )}
                {toplam > 0 && (
                  <div style={{ display: 'flex', gap: 4, marginTop: 5 }}>
                    {[4, 3, 2, 1].map((s) => (
                      <div key={s} style={{ flex: 1, textAlign: 'center' }}>
                        <div style={{
                          height: 4, background: RENKLER[String(s)],
                          borderRadius: 2, marginBottom: 2,
                          opacity: sayim[s] ? 1 : 0.25,
                        }} />
                        <div style={{ fontSize: 10, color: sayim[s] ? '#e2e8f0' : '#475569' }}>
                          {sayim[s]}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        );
      })}

      {/* --- v3 MİNERAL AYRIMI --- */}
      {d.v3?.ayrim && (() => {
        const a = d.v3.ayrim;
        const t = a.demir_ve_kil + a.sadece_demir + a.sadece_kil;
        if (!t) return null;
        return (
          <div style={{ borderTop: '1px solid #334155', paddingTop: 10, marginBottom: 10 }}>
            <b style={{ fontSize: 12, color: '#cbd5e1' }}>Mineral dağılımı</b>
            {a.demir_esigi != null && (
              <div style={{ color: '#64748b', fontSize: 10.5, marginTop: 2 }}>
                Eşik bölgesel medyandan: demir {a.demir_esigi} · kil {a.kil_esigi}
              </div>
            )}
            <div style={{ display: 'flex', height: 10, borderRadius: 5, overflow: 'hidden', margin: '7px 0' }}>
              <div style={{ width: `${(a.demir_ve_kil / t) * 100}%`, background: '#22c55e' }} />
              <div style={{ width: `${(a.sadece_demir / t) * 100}%`, background: '#dc2626' }} />
              <div style={{ width: `${(a.sadece_kil / t) * 100}%`, background: '#f59e0b' }} />
            </div>
            {[
              { ad: 'Demir + kil', deger: a.demir_ve_kil, renk: '#22c55e' },
              { ad: 'Sadece demir', deger: a.sadece_demir, renk: '#dc2626' },
              { ad: 'Sadece kil', deger: a.sadece_kil, renk: '#f59e0b' },
            ].map((x) => (
              <div key={x.ad} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, lineHeight: 1.7 }}>
                <span>
                  <span style={{
                    display: 'inline-block', width: 9, height: 9, borderRadius: 2,
                    background: x.renk, marginRight: 6,
                  }} />
                  {x.ad}
                </span>
                <b>%{Math.round((x.deger / t) * 100)}</b>
              </div>
            ))}
          </div>
        );
      })()}

      {/* --- YORUM --- */}
      {yorum && (
        <div style={{
          background: 'rgba(30,58,138,0.35)', border: '1px solid #1e40af',
          borderRadius: 8, padding: 9, marginBottom: 10,
          fontSize: 11.5, lineHeight: 1.6,
        }}>
          {yorum}
        </div>
      )}

      {/* --- SINIF ANLAMLARI --- */}
      <div style={{ borderTop: '1px solid #334155', paddingTop: 10, fontSize: 11, lineHeight: 1.6 }}>
        <b style={{ color: '#cbd5e1' }}>Sınıf anlamları</b>
        {[4, 3, 2, 1].map((s) => (
          <div key={s} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginTop: 4 }}>
            <span style={{
              display: 'inline-block', width: 10, height: 10, borderRadius: 2,
              background: RENKLER[String(s)], flexShrink: 0, marginTop: 3,
            }} />
            <span>
              <b>{ETIKETLER[String(s)]}</b>
              <span style={{ color: '#94a3b8' }}> — {ONERILER[String(s)]}</span>
            </span>
          </div>
        ))}
      </div>

      <div style={{
        marginTop: 10, paddingTop: 9, borderTop: '1px solid #334155',
        fontSize: 10.5, color: '#94a3b8', lineHeight: 1.55,
      }}>
        Üç motor farklı soru sorar; biri diğerinin doğrulaması değildir.
        Kesişim bilerek "tek doğru cevap" olarak sunulmaz — yalnız v3'ün
        gördüğü bir yer, v2'nin bulut gölgesi yüzünden elediği gerçek bir
        hedef olabilir.
      </div>
    </div>
  );
}
