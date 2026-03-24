import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { signInWithPopup, GoogleAuthProvider, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '../firebase';
import { Role } from '../context/accessConfig';

export default function Login() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleAuthSuccess = async (user: any) => {
    try {
      console.log('[Login] Auth success, fetching user doc for:', user.uid);
      const userDoc = await getDoc(doc(db, 'users', user.uid));
      if (userDoc.exists()) {
        const userData = userDoc.data();
        console.log('[Login] User doc found. role:', userData.role);
        const role = userData.role as Role;

        if (role === 'system_owner' || role === 'support_admin' || role === 'billing_admin' || role === 'operations_admin' || role === 'security_admin') {
          navigate('/owner');
        } else {
          navigate('/');
        }
      } else {
        console.warn('[Login] No Firestore user doc for uid:', user.uid, '— signing out');
        await signOut(auth);
        setError('Your account has not been provisioned. Please contact your administrator.');
      }
    } catch (err) {
      console.error('[Login] Error fetching user role:', err);
      await signOut(auth);
      setError('Failed to verify your account. Please try again.');
    }
  };

  const handleGoogleLogin = async () => {
    setLoading(true);
    setError('');
    try {
      const provider = new GoogleAuthProvider();
      console.log('[Login] Initiating Google sign-in...');
      const result = await signInWithPopup(auth, provider);
      console.log('[Login] Google sign-in successful:', result.user.uid);
      await handleAuthSuccess(result.user);
    } catch (err: any) {
      console.error('[Login] Google sign-in error:', err);
      setError(`Google sign-in failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleEmailLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      console.log('[Login] Initiating email sign-in for:', email);
      const result = await signInWithEmailAndPassword(auth, email, password);
      console.log('[Login] Email sign-in successful:', result.user.uid);
      await handleAuthSuccess(result.user);
    } catch (err: any) {
      console.error('[Login] Email sign-in error:', err);
      setError(`Invalid email or password: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface">
      <div className="bg-white p-8 rounded-3xl shadow-xl border border-slate-100 w-full max-w-md">
        <h1 className="text-2xl font-black text-primary mb-6">Sign In</h1>
        {error && <p className="text-red-500 text-sm mb-4">{error}</p>}
        <form onSubmit={handleEmailLogin} className="space-y-4 mb-6">
          <input 
            type="email" 
            placeholder="Email" 
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full p-3 border rounded-xl"
            required
          />
          <input 
            type="password" 
            placeholder="Password" 
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full p-3 border rounded-xl"
            required
          />
          <button 
            type="submit"
            disabled={loading}
            className="w-full py-4 bg-primary text-white font-black rounded-2xl hover:bg-primary/90 transition-all"
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
        <button 
          onClick={handleGoogleLogin}
          disabled={loading}
          className="w-full py-4 bg-white border border-slate-200 text-slate-700 font-bold rounded-2xl hover:bg-slate-50 transition-all"
        >
          Sign in with Google
        </button>
      </div>
    </div>
  );
}
