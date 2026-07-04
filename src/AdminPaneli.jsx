import { useEffect, useState } from 'react';
import { supabase } from './supabaseClient';

export default function AdminPaneli({ onKapat }) {
  const [kullanicilar, setKullanicilar] = useState([]);
  const [tumTaramalar, setTumTaramalar] = useState([]);
  const [sekme, setSekme] = useState('kullanicilar');
  const [yukleniyor, setYukleniyor] = useState(true);
  const [hata, setHata] = useState(null);

  useEffect(() => {
    const veriYukle = async () => {
      setYukleniyor(true);
      const [{ data: profilVerisi, error: profilHata }, { data: taramaVerisi, error: taramaHata }] = await Promise.all([
        supabase.from('profiller').select('id, eposta, rol, created_at').order('created_at', { ascending: false }),
        supabase.from('taramalar').select('id, created_at, durum, kullanici_id').order('created_at', { ascending: false }).limit(100),
      ]);

      if (profilHata) setHata(profilHata.message);
      else setKullanicilar(profilVerisi);

      if (taramaHata) setHata((h) => h || taramaHata.message);
      else setTumTaramalar(taramaVerisi);

      setYukleniyor(false);
    };
    veriYukle();
  }, []);

  const rolDegistir = async (id, yeniRol) => {
    const { error } = await supabase.from('profiller').update({ rol: yeniRol }).eq('id', id);
    if (error) {
      setHata(error.message);
      return;
    }
    setKullanicilar((liste) => liste.map((k) => (k.id === id ? { ...k, rol: yeniRol } : k)));
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,23,0.85)', zIndex: 3000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className="yumusak-giris" style={{ width: '720px', maxHeight: '80vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', background: '#0f172a', borderRadius: '14px', border: '1px solid #1e293b' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 22px', borderBottom: '1px solid #1e293b' }}>
          <h2 style={{ color: 'white', margin: 0, fontSize: '16px' }}>Admin Paneli</h2>
          <button onClick={onKapat} style={{ background: 'none', border: 'none', color: '#94a3b8', fontSize: '20px', cursor: 'pointer' }}>×</button>
        </div>

        <div style={{ display: 'flex', gap: '6px', padding: '14px 22px 0 22px' }}>
          <button onClick={() => setSekme('kullanicilar')} style={{ padding: '8px 14px', borderRadius: '8px 8px 0 0', border: 'none', background: sekme === 'kullanicilar' ? '#1e293b' : 'transparent', color: 'white', cursor: 'pointer', fontSize: '13px' }}>Kullanıcılar</button>
          <button onClick={() => setSekme('taramalar')} style={{ padding: '8px 14px', borderRadius: '8px 8px 0 0', border: 'none', background: sekme === 'taramalar' ? '#1e293b' : 'transparent', color: 'white', cursor: 'pointer', fontSize: '13px' }}>Tüm Taramalar</button>
        </div>

        <div style={{ padding: '20px 22px', overflowY: 'auto', flex: 1 }}>
          {hata && <div style={{ background: '#7f1d1d', color: 'white', padding: '10px', borderRadius: '8px', fontSize: '12px', marginBottom: '14px' }}>{hata}</div>}
          {yukleniyor && <div style={{ color: '#94a3b8', fontSize: '13px' }}>Yükleniyor...</div>}

          {!yukleniyor && sekme === 'kullanicilar' && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', color: 'white' }}>
              <thead>
                <tr style={{ textAlign: 'left', color: '#64748b', borderBottom: '1px solid #1e293b' }}>
                  <th style={{ padding: '8px' }}>E-posta</th>
                  <th style={{ padding: '8px' }}>Kayıt Tarihi</th>
                  <th style={{ padding: '8px' }}>Rol</th>
                  <th style={{ padding: '8px' }}></th>
                </tr>
              </thead>
              <tbody>
                {kullanicilar.map((k) => (
                  <tr key={k.id} style={{ borderBottom: '1px solid #1e293b' }}>
                    <td style={{ padding: '8px' }}>{k.eposta}</td>
                    <td style={{ padding: '8px', color: '#94a3b8' }}>{new Date(k.created_at).toLocaleDateString('tr-TR')}</td>
                    <td style={{ padding: '8px' }}>
                      <span style={{ padding: '3px 8px', borderRadius: '999px', fontSize: '11px', background: k.rol === 'admin' ? '#7c2d12' : '#1e3a8a' }}>{k.rol}</span>
                    </td>
                    <td style={{ padding: '8px' }}>
                      {k.rol === 'admin' ? (
                        <button onClick={() => rolDegistir(k.id, 'kullanici')} style={{ fontSize: '11px', background: '#334155', color: 'white', border: 'none', borderRadius: '6px', padding: '5px 10px', cursor: 'pointer' }}>Admin Yetkisini Al</button>
                      ) : (
                        <button onClick={() => rolDegistir(k.id, 'admin')} style={{ fontSize: '11px', background: '#334155', color: 'white', border: 'none', borderRadius: '6px', padding: '5px 10px', cursor: 'pointer' }}>Admin Yap</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {!yukleniyor && sekme === 'taramalar' && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', color: 'white' }}>
              <thead>
                <tr style={{ textAlign: 'left', color: '#64748b', borderBottom: '1px solid #1e293b' }}>
                  <th style={{ padding: '8px' }}>Tarih</th>
                  <th style={{ padding: '8px' }}>Kullanıcı ID</th>
                  <th style={{ padding: '8px' }}>Durum</th>
                </tr>
              </thead>
              <tbody>
                {tumTaramalar.map((t) => (
                  <tr key={t.id} style={{ borderBottom: '1px solid #1e293b' }}>
                    <td style={{ padding: '8px' }}>{new Date(t.created_at).toLocaleString('tr-TR')}</td>
                    <td style={{ padding: '8px', color: '#94a3b8', fontSize: '11px' }}>{t.kullanici_id}</td>
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
