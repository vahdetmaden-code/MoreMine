import { useState } from 'react';
import { supabase } from './supabaseClient';

export default function Giris() {
  const [eposta, setEposta] = useState('');
  const [sifre, setSifre] = useState('');
  const [hata, setHata] = useState(null);
  const [yukleniyor, setYukleniyor] = useState(false);

  const gonder = async (e) => {
    e.preventDefault();
    setHata(null);
    setYukleniyor(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email: eposta, password: sifre });
      if (error) throw error;
    } catch (err) {
      setHata(err.message || String(err));
    } finally {
      setYukleniyor(false);
    }
  };

  return (
    <div style={{
      height: '100vh', width: '100vw', display: 'flex', alignItems: 'center', justifyContent: 'center',
      position: 'relative', overflow: 'hidden',
      background: 'linear-gradient(-45deg, #020617, #0f172a, #1e293b, #020617)',
      backgroundSize: '400% 400%',
      animation: 'gradientAkis 12s ease infinite',
    }}>
      {/* Arka planda yayılan radar halkaları */}
      <div style={{ position: 'absolute', width: '10px', height: '10px', top: '50%', left: '50%' }}>
        <div className="radar-halka" style={{ borderColor: 'rgba(56,189,248,0.5)', width: '100px', height: '100px', animationDuration: '3.5s' }} />
        <div className="radar-halka gecikmeli" style={{ borderColor: 'rgba(56,189,248,0.5)', width: '100px', height: '100px', animationDuration: '3.5s' }} />
      </div>

      <form onSubmit={gonder} className="yumusak-giris" style={{
        position: 'relative', zIndex: 2,
        width: '340px', background: 'rgba(15, 23, 42, 0.85)', backdropFilter: 'blur(6px)', padding: '34px',
        borderRadius: '16px', border: '1px solid #1e293b', boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: '22px' }}>
          <div className="logo-parlama" style={{
            width: '54px', height: '54px', borderRadius: '14px',
            background: 'linear-gradient(135deg, #f59e0b, #ef4444)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 800, fontSize: '22px', color: '#0b1220', marginBottom: '14px',
          }}>M</div>
          <div style={{ color: 'white', fontWeight: 700, fontSize: '17px', letterSpacing: '0.5px' }}>MORE MINE</div>
          <div style={{ color: '#64748b', fontSize: '12px', marginTop: '2px' }}>Uydu Alterasyon Taraması</div>
        </div>

        <label style={{ color: '#94a3b8', fontSize: '12px' }}>E-posta</label>
        <input
          type="email" required value={eposta} onChange={(e) => setEposta(e.target.value)}
          style={{ width: '100%', padding: '10px', marginTop: '4px', marginBottom: '14px', borderRadius: '8px', border: '1px solid #334155', background: '#1e293b', color: 'white' }}
        />

        <label style={{ color: '#94a3b8', fontSize: '12px' }}>Şifre</label>
        <input
          type="password" required value={sifre} onChange={(e) => setSifre(e.target.value)}
          style={{ width: '100%', padding: '10px', marginTop: '4px', marginBottom: '18px', borderRadius: '8px', border: '1px solid #334155', background: '#1e293b', color: 'white' }}
        />

        {hata && (
          <div className="yumusak-giris" style={{ background: '#7f1d1d', color: 'white', padding: '10px', borderRadius: '8px', fontSize: '12px', marginBottom: '14px' }}>
            {hata}
          </div>
        )}

        <button type="submit" disabled={yukleniyor} style={{
          width: '100%', padding: '12px', background: '#2563eb', color: 'white', border: 'none',
          borderRadius: '8px', fontWeight: 600, cursor: yukleniyor ? 'default' : 'pointer', fontSize: '14px',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
        }}>
          {yukleniyor && <span className="donen-ikon" style={{ display: 'inline-block', width: '14px', height: '14px', border: '2px solid rgba(255,255,255,0.4)', borderTopColor: 'white', borderRadius: '50%' }} />}
          {yukleniyor ? 'Giriş yapılıyor...' : 'Giriş Yap'}
        </button>

        <div style={{ textAlign: 'center', marginTop: '18px', fontSize: '11px', color: '#475569' }}>
          Hesabın yoksa yöneticinden davet almalısın.
        </div>
      </form>
    </div>
  );
}
