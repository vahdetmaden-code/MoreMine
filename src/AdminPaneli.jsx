import { useEffect, useState } from 'react';
import { supabase } from './supabaseClient';

export default function AdminPaneli({ onKapat }) {
  const [kullanicilar, setKullanicilar] = useState([]);
  const [tumTaramalar, setTumTaramalar] = useState([]);
  const [sekme, setSekme] = useState('kullanicilar');
  const [yukleniyor, setYukleniyor] = useState(true);
  const [hata, setHata] = useState(null);
  const [basari, setBasari] = useState(null);

  const [yeniEposta, setYeniEposta] = useState('');
  const [yeniSifre, setYeniSifre] = useState('');
  const [yeniLimit, setYeniLimit] = useState('');
  const [ekleniyor, setEkleniyor] = useState(false);

  const veriYukle = async () => {
    setYukleniyor(true);
    const [{ data: profilVerisi, error: profilHata }, { data: taramaVerisi, error: taramaHata }] = await Promise.all([
      supabase.from('profiller').select('id, eposta, rol, aktif, tarama_limiti, created_at').order('created_at', { ascending: false }),
      supabase.from('taramalar').select('id, created_at, durum, kullanici_id, konum_adi').order('created_at', { ascending: false }).limit(100),
    ]);

    if (profilHata) setHata(profilHata.message);
    else setKullanicilar(profilVerisi);

    if (taramaHata) setHata((h) => h || taramaHata.message);
    else setTumTaramalar(taramaVerisi);

    setYukleniyor(false);
  };

  useEffect(() => { veriYukle(); }, []);

  const rolDegistir = async (id, yeniRol) => {
    const { error } = await supabase.from('profiller').update({ rol: yeniRol }).eq('id', id);
    if (error) { setHata(error.message); return; }
    setKullanicilar((liste) => liste.map((k) => (k.id === id ? { ...k, rol: yeniRol } : k)));
  };

  const aktiflikDegistir = async (id, yeniDeger) => {
    const { error } = await supabase.from('profiller').update({ aktif: yeniDeger }).eq('id', id);
    if (error) { setHata(error.message); return; }
    setKullanicilar((liste) => liste.map((k) => (k.id === id ? { ...k, aktif: yeniDeger } : k)));
  };

  const limitGuncelle = async (id, limitDegeri) => {
    const sayi = limitDegeri === '' ? null : parseInt(limitDegeri, 10);
    const { error } = await supabase.from('profiller').update({ tarama_limiti: sayi }).eq('id', id);
    if (error) { setHata(error.message); return; }
    setKullanicilar((liste) => liste.map((k) => (k.id === id ? { ...k, tarama_limiti: sayi } : k)));
  };

  const kullaniciEkle = async (e) => {
    e.preventDefault();
    setHata(null);
    setBasari(null);
    setEkleniyor(true);
    try {
      const { data: oturumVerisi } = await supabase.auth.getSession();
      const yanit = await fetch('/api/admin_kullanici_ekle', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${oturumVerisi.session.access_token}`,
        },
        body: JSON.stringify({
          eposta: yeniEposta,
          sifre: yeniSifre,
          tarama_limiti: yeniLimit === '' ? null : parseInt(yeniLimit, 10),
        }),
      });
      const cevap = await yanit.json();
      if (!yanit.ok || !cevap.basarili) throw new Error(cevap.hata || 'Kullanıcı eklenemedi.');

      setBasari('Kullanıcı başarıyla oluşturuldu.');
      setYeniEposta('');
      setYeniSifre('');
      setYeniLimit('');
      veriYukle();
    } catch (err) {
      setHata(err.message || String(err));
    } finally {
      setEkleniyor(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,23,0.85)', zIndex: 3000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className="yumusak-giris" style={{ width: '760px', maxHeight: '85vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', background: '#0f172a', borderRadius: '14px', border: '1px solid #1e293b' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 22px', borderBottom: '1px solid #1e293b' }}>
          <h2 style={{ color: 'white', margin: 0, fontSize: '16px' }}>Admin Paneli</h2>
          <button onClick={onKapat} style={{ background: 'none', border: 'none', color: '#94a3b8', fontSize: '20px', cursor: 'pointer' }}>×</button>
        </div>

        <div style={{ display: 'flex', gap: '6px', padding: '14px 22px 0 22px' }}>
          <button onClick={() => setSekme('kullanicilar')} style={{ padding: '8px 14px', borderRadius: '8px 8px 0 0', border: 'none', background: sekme === 'kullanicilar' ? '#1e293b' : 'transparent', color: 'white', cursor: 'pointer', fontSize: '13px' }}>Kullanıcılar</button>
          <button onClick={() => setSekme('ekle')} style={{ padding: '8px 14px', borderRadius: '8px 8px 0 0', border: 'none', background: sekme === 'ekle' ? '#1e293b' : 'transparent', color: 'white', cursor: 'pointer', fontSize: '13px' }}>Kullanıcı Ekle</button>
          <button onClick={() => setSekme('taramalar')} style={{ padding: '8px 14px', borderRadius: '8px 8px 0 0', border: 'none', background: sekme === 'taramalar' ? '#1e293b' : 'transparent', color: 'white', cursor: 'pointer', fontSize: '13px' }}>Tüm Taramalar</button>
        </div>

        <div style={{ padding: '20px 22px', overflowY: 'auto', flex: 1 }}>
          {hata && <div style={{ background: '#7f1d1d', color: 'white', padding: '10px', borderRadius: '8px', fontSize: '12px', marginBottom: '14px' }}>{hata}</div>}
          {basari && <div style={{ background: '#14532d', color: 'white', padding: '10px', borderRadius: '8px', fontSize: '12px', marginBottom: '14px' }}>{basari}</div>}
          {yukleniyor && <div style={{ color: '#94a3b8', fontSize: '13px' }}>Yükleniyor...</div>}

          {!yukleniyor && sekme === 'kullanicilar' && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', color: 'white' }}>
              <thead>
                <tr style={{ textAlign: 'left', color: '#64748b', borderBottom: '1px solid #1e293b' }}>
                  <th style={{ padding: '8px' }}>E-posta</th>
                  <th style={{ padding: '8px' }}>Rol</th>
                  <th style={{ padding: '8px' }}>Durum</th>
                  <th style={{ padding: '8px' }}>Tarama Limiti</th>
                  <th style={{ padding: '8px' }}></th>
                </tr>
              </thead>
              <tbody>
                {kullanicilar.map((k) => (
                  <tr key={k.id} style={{ borderBottom: '1px solid #1e293b' }}>
                    <td style={{ padding: '8px' }}>{k.eposta}</td>
                    <td style={{ padding: '8px' }}>
                      <span style={{ padding: '3px 8px', borderRadius: '999px', fontSize: '11px', background: k.rol === 'admin' ? '#7c2d12' : '#1e3a8a' }}>{k.rol}</span>
                    </td>
                    <td style={{ padding: '8px' }}>
                      <span style={{ padding: '3px 8px', borderRadius: '999px', fontSize: '11px', background: k.aktif ? '#14532d' : '#3f3f46', color: k.aktif ? '#4ade80' : '#a1a1aa' }}>
                        {k.aktif ? 'Aktif' : 'Pasif'}
                      </span>
                    </td>
                    <td style={{ padding: '8px' }}>
                      <input
                        type="number" min="0" placeholder="Sınırsız"
                        defaultValue={k.tarama_limiti ?? ''}
                        onBlur={(e) => limitGuncelle(k.id, e.target.value)}
                        style={{ width: '80px', padding: '5px 7px', borderRadius: '6px', border: '1px solid #334155', background: '#1e293b', color: 'white', fontSize: '12px' }}
                      />
                    </td>
                    <td style={{ padding: '8px', display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                      {k.rol === 'admin' ? (
                        <button onClick={() => rolDegistir(k.id, 'kullanici')} style={{ fontSize: '11px', background: '#334155', color: 'white', border: 'none', borderRadius: '6px', padding: '5px 9px', cursor: 'pointer' }}>Admin Yetkisini Al</button>
                      ) : (
                        <button onClick={() => rolDegistir(k.id, 'admin')} style={{ fontSize: '11px', background: '#334155', color: 'white', border: 'none', borderRadius: '6px', padding: '5px 9px', cursor: 'pointer' }}>Admin Yap</button>
                      )}
                      {k.aktif ? (
                        <button onClick={() => aktiflikDegistir(k.id, false)} style={{ fontSize: '11px', background: '#7f1d1d', color: 'white', border: 'none', borderRadius: '6px', padding: '5px 9px', cursor: 'pointer' }}>Pasif Yap</button>
                      ) : (
                        <button onClick={() => aktiflikDegistir(k.id, true)} style={{ fontSize: '11px', background: '#14532d', color: 'white', border: 'none', borderRadius: '6px', padding: '5px 9px', cursor: 'pointer' }}>Aktif Yap</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {!yukleniyor && sekme === 'ekle' && (
            <form onSubmit={kullaniciEkle} style={{ maxWidth: '340px' }}>
              <label style={{ color: '#94a3b8', fontSize: '12px' }}>E-posta</label>
              <input
                type="email" required value={yeniEposta} onChange={(e) => setYeniEposta(e.target.value)}
                style={{ width: '100%', padding: '10px', marginTop: '4px', marginBottom: '14px', borderRadius: '8px', border: '1px solid #334155', background: '#1e293b', color: 'white' }}
              />
              <label style={{ color: '#94a3b8', fontSize: '12px' }}>Geçici Şifre</label>
              <input
                type="text" required minLength={6} value={yeniSifre} onChange={(e) => setYeniSifre(e.target.value)}
                style={{ width: '100%', padding: '10px', marginTop: '4px', marginBottom: '14px', borderRadius: '8px', border: '1px solid #334155', background: '#1e293b', color: 'white' }}
              />
              <label style={{ color: '#94a3b8', fontSize: '12px' }}>Tarama Limiti (boş = sınırsız)</label>
              <input
                type="number" min="0" value={yeniLimit} onChange={(e) => setYeniLimit(e.target.value)}
                style={{ width: '100%', padding: '10px', marginTop: '4px', marginBottom: '18px', borderRadius: '8px', border: '1px solid #334155', background: '#1e293b', color: 'white' }}
              />
              <button type="submit" disabled={ekleniyor} style={{ width: '100%', padding: '11px', background: '#2563eb', color: 'white', border: 'none', borderRadius: '8px', fontWeight: 600, cursor: ekleniyor ? 'default' : 'pointer', fontSize: '14px' }}>
                {ekleniyor ? 'Ekleniyor...' : 'Kullanıcı Oluştur'}
              </button>
            </form>
          )}

          {!yukleniyor && sekme === 'taramalar' && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', color: 'white' }}>
              <thead>
                <tr style={{ textAlign: 'left', color: '#64748b', borderBottom: '1px solid #1e293b' }}>
                  <th style={{ padding: '8px' }}>Tarih</th>
                  <th style={{ padding: '8px' }}>Konum</th>
                  <th style={{ padding: '8px' }}>Durum</th>
                </tr>
              </thead>
              <tbody>
                {tumTaramalar.map((t) => (
                  <tr key={t.id} style={{ borderBottom: '1px solid #1e293b' }}>
                    <td style={{ padding: '8px' }}>{new Date(t.created_at).toLocaleString('tr-TR')}</td>
                    <td style={{ padding: '8px', color: '#94a3b8' }}>{t.konum_adi || '—'}</td>
                    <td style={{ padding: '8px', color: t.durum === 'Tamamlandı' ? '#4ade80' : t.durum === 'Hata' ? '#f87171' : '#fbbf24' }}>{t.durum}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
