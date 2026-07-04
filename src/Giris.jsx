import { useState } from 'react';
import { supabase } from './supabaseClient';

export default function Giris() {
  const [mod, setMod] = useState('giris'); // 'giris' | 'kayit'
  const [eposta, setEposta] = useState('');
  const [sifre, setSifre] = useState('');
  const [hata, setHata] = useState(null);
  const [bilgi, setBilgi] = useState(null);
  const [yukleniyor, setYukleniyor] = useState(false);

  const gonder = async (e) => {
    e.preventDefault();
    setHata(null);
    setBilgi(null);
    setYukleniyor(true);

    try {
      if (mod === 'giris') {
        const { error } = await supabase.auth.signInWithPassword({ email: eposta, password: sifre });
        if (error) throw error;
      } else {
        const { error } = await supabase.auth.signUp({ email: eposta, password: sifre });
        if (error) throw error;
        setBilgi('Kayıt oluşturuldu. E-postana gelen doğrulama bağlantısına tıkladıktan sonra giriş yapabilirsin.');
      }
    } catch (err) {
      setHata(err.message || String(err));
    } finally {
      setYukleniyor(false);
    }
  };

  return (
    <div style={{
      height: '100vh', width: '100vw', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'radial-gradient(circle at 30% 20%, #1e293b, #020617)',
    }}>
      <form onSubmit={gonder} className="yumusak-giris" style={{
        width: '340px', background: '#0f172a', padding: '30px', borderRadius: '14px',
        border: '1px solid #1e293b', boxShadow: '0 10px 40px rgba(0,0,0,0.4)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
          <div style={{
            width: '34px', height: '34px', borderRadius: '9px',
            background: 'linear-gradient(135deg, #f59e0b, #ef4444)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 800, fontSize: '16px', color: '#0b1220',
          }}>M</div>
          <div>
            <div style={{ color: 'white', fontWeight: 700, fontSize: '15px' }}>MORE MINE</div>
            <div style={{ color: '#64748b', fontSize: '11px' }}>Uydu Alterasyon Taraması</div>
          </div>
        </div>

        <h2 style={{ color: 'white', fontSize: '17px', margin: '18px 0 16px 0' }}>
          {mod === 'giris' ? 'Giriş Yap' : 'Hesap Oluştur'}
        </h2>

        <label style={{ color: '#94a3b8', fontSize: '12px' }}>E-posta</label>
        <input
          type="email" required value={eposta} onChange={(e) => setEposta(e.target.value)}
          style={{ width: '100%', padding: '10px', marginTop: '4px', marginBottom: '14px', borderRadius: '8px', border: '1px solid #334155', background: '#1e293b', color: 'white' }}
        />

        <label style={{ color: '#94a3b8', fontSize: '12px' }}>Şifre</label>
        <input
          type="password" required minLength={6} value={sifre} onChange={(e) => setSifre(e.target.value)}
          style={{ width: '100%', padding: '10px', marginTop: '4px', marginBottom: '18px', borderRadius: '8px', border: '1px solid #334155', background: '#1e293b', color: 'white' }}
        />

        {hata && (
          <div className="yumusak-giris" style={{ background: '#7f1d1d', color: 'white', padding: '10px', borderRadius: '8px', fontSize: '12px', marginBottom: '14px' }}>
            {hata}
          </div>
        )}
        {bilgi && (
          <div className="yumusak-giris" style={{ background: '#14532d', color: 'white', padding: '10px', borderRadius: '8px', fontSize: '12px', marginBottom: '14px' }}>
            {bilgi}
          </div>
        )}

        <button type="submit" disabled={yukleniyor} style={{
          width: '100%', padding: '11px', background: '#2563eb', color: 'white', border: 'none',
          borderRadius: '8px', fontWeight: 600, cursor: yukleniyor ? 'default' : 'pointer', fontSize: '14px',
        }}>
          {yukleniyor ? 'Bekleyin...' : mod === 'giris' ? 'Giriş Yap' : 'Kayıt Ol'}
        </button>

        <div style={{ textAlign: 'center', marginTop: '16px', fontSize: '12px', color: '#64748b' }}>
          {mod === 'giris' ? (
            <>Hesabın yok mu?{' '}
              <span style={{ color: '#60a5fa', cursor: 'pointer' }} onClick={() => { setMod('kayit'); setHata(null); setBilgi(null); }}>Kayıt Ol</span>
            </>
          ) : (
            <>Zaten hesabın var mı?{' '}
              <span style={{ color: '#60a5fa', cursor: 'pointer' }} onClick={() => { setMod('giris'); setHata(null); setBilgi(null); }}>Giriş Yap</span>
            </>
          )}
        </div>
      </form>
    </div>
  );
}
