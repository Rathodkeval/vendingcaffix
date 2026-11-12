import React, { useState, useEffect } from 'react';
import { Lock, Mail, KeyRound, ShieldCheck, AlertCircle, CheckCircle2, ArrowRight } from 'lucide-react';
import { ownerApi, clearStoredToken, extractInviteFromHash } from '../services/api';

export default function AuthPage({ onAuthenticated, sessionNotice }) {
  const [mode, setMode] = useState('login'); // 'login' | 'setup'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [inviteToken, setInviteToken] = useState('');
  const [remember, setRemember] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  useEffect(() => {
    const parseHashInvite = () => {
      const { token: hashToken, email: hashEmail } = extractInviteFromHash(window.location.hash);
      if (hashToken) {
        setMode('setup');
        setInviteToken(hashToken);
        if (hashEmail) {
          setEmail(hashEmail);
        }
        // Immediately scrub the raw token fragment from the URL bar and browser history
        // so it is never exposed in analytics, address bar, or subsequent navigation.
        if (window.history && window.history.replaceState) {
          window.history.replaceState(null, document.title, window.location.pathname);
        }
      } else if (hashEmail) {
        setEmail(hashEmail);
      }
    };

    parseHashInvite();
    window.addEventListener('hashchange', parseHashInvite);
    return () => window.removeEventListener('hashchange', parseHashInvite);
  }, []);

  const handleLoginSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccessMsg('');
    setLoading(true);

    try {
      const res = await ownerApi.login(email.trim(), password);
      const userData = res.data;
      const jwtToken = res.token;

      if (!userData || !jwtToken) {
        throw new Error('Invalid authentication response from server.');
      }

      if (userData.role === 'admin') {
        clearStoredToken();
        const adminPortalUrl =
          typeof import.meta !== 'undefined' && import.meta.env?.VITE_ADMIN_PORTAL_URL
            ? String(import.meta.env.VITE_ADMIN_PORTAL_URL).trim()
            : '';
        throw new Error(
          adminPortalUrl
            ? `Administrator accounts cannot sign into the Machine Owner Dashboard. Please use the CAFFIX Admin Dashboard (${adminPortalUrl}).`
            : 'Administrator accounts cannot sign into the Machine Owner Dashboard. Please sign in through the dedicated CAFFIX Admin Dashboard.'
        );
      }

      if (userData.role !== 'owner') {
        clearStoredToken();
        throw new Error('Access denied: Only CAFFIX Machine Owner accounts can sign into the Owner Portal.');
      }

      await onAuthenticated(jwtToken, userData, remember);
    } catch (err) {
      setError(err.message || 'Unable to sign in. Please verify your email and password.');
    } finally {
      setLoading(false);
    }
  };

  const handleSetupPasswordSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccessMsg('');

    if (password.length < 8) {
      setError('Password must be at least 8 characters long.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    if (!inviteToken || inviteToken.trim().length < 16) {
      setError('Please enter your valid one-time invitation token.');
      return;
    }

    setLoading(true);
    try {
      const res = await ownerApi.setupPassword({
        token: inviteToken.trim(),
        email: email.trim() || undefined,
        password
      });

      const userData = res.data;
      const jwtToken = res.token;
      setSuccessMsg('Password configured! Signing you into your Owner Dashboard...');

      // Clear setup_token from URL bar for security
      if (window.history && window.history.replaceState) {
        window.history.replaceState({}, document.title, window.location.pathname);
      }

      await onAuthenticated(jwtToken, userData, remember);
    } catch (err) {
      setError(err.message || 'Password setup failed. The token may be invalid, expired, or already used.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col lg:flex-row bg-[#FAF6F0]">
      {/* Left Brand Showcase Panel */}
      <div className="lg:w-5/12 bg-[#2C1E17] text-[#FAF6F0] p-8 lg:p-12 flex flex-col justify-between relative overflow-hidden">
        <div className="relative z-10">
          <div className="flex items-center gap-3.5">
            <img
              src="/assets/logo.png"
              alt="CAFFIX"
              className="w-12 h-12 rounded-2xl bg-[#FAF6F0] p-1 object-contain shadow-md"
            />
            <div>
              <div className="font-display text-2xl font-extrabold tracking-wider text-white">
                CAFFIX
              </div>
              <div className="text-xs font-medium text-[#DCC39A] uppercase tracking-widest">
                Smart Coffee Vending Ecosystem
              </div>
            </div>
          </div>

          <h1 className="font-display text-3xl lg:text-4xl font-bold text-white mt-10 leading-tight">
            Manage Your Vending Fleet & Real-Time Revenue
          </h1>
          <p className="text-[#EED9C4]/85 text-sm lg:text-base mt-4 leading-relaxed">
            Monitor Raspberry Pi 4 machine connectivity, customize per-machine beverage pricing,
            control safe maintenance mode transitions, and track verified sales across all your
            assigned CAFFIX kiosks.
          </p>
        </div>

        <div className="relative z-10 mt-10 pt-8 border-t border-[#4E3629] grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs text-[#EED9C4]/90">
          <div className="bg-[#4E3629]/40 p-3.5 rounded-xl border border-[#C9A66B]/20">
            <div className="font-semibold text-[#C9A66B] flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4" />
              Strict Machine Ownership
            </div>
            <p className="mt-1 text-[#EED9C4]/75">
              Live database & Firestore ownership verification on every API request.
            </p>
          </div>
          <div className="bg-[#4E3629]/40 p-3.5 rounded-xl border border-[#C9A66B]/20">
            <div className="font-semibold text-[#C9A66B] flex items-center gap-1.5">
              <KeyRound className="w-4 h-4" />
              Per-Machine Pricing
            </div>
            <p className="mt-1 text-[#EED9C4]/75">
              Configure independent beverage prices & availability for each location.
            </p>
          </div>
        </div>
      </div>

      {/* Right Authentication Form Panel */}
      <div className="flex-1 flex items-center justify-center p-6 sm:p-10 lg:p-16">
        <div className="w-full max-w-md bg-white rounded-3xl border border-[#EED9C4] shadow-lg p-7 sm:p-9">
          {/* Mode Switcher */}
          <div className="grid grid-cols-2 p-1 bg-[#FAF6F0] rounded-2xl border border-[#EED9C4] mb-6">
            <button
              type="button"
              onClick={() => {
                setMode('login');
                setError('');
              }}
              className={`py-2.5 text-xs sm:text-sm font-semibold rounded-xl transition-all ${
                mode === 'login'
                  ? 'bg-[#4E3629] text-white shadow-xs'
                  : 'text-[#8C6246] hover:text-[#2C1E17]'
              }`}
            >
              Owner Sign In
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('setup');
                setError('');
              }}
              className={`py-2.5 text-xs sm:text-sm font-semibold rounded-xl transition-all ${
                mode === 'setup'
                  ? 'bg-[#4E3629] text-white shadow-xs'
                  : 'text-[#8C6246] hover:text-[#2C1E17]'
              }`}
            >
              Activate Invite Token
            </button>
          </div>

          {sessionNotice && (
            <div className="mb-5 p-3.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-xs font-medium flex items-start gap-2.5">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{sessionNotice}</span>
            </div>
          )}

          {error && (
            <div className="mb-5 p-3.5 rounded-xl bg-red-50 border border-red-200 text-red-700 text-xs font-medium flex items-start gap-2.5">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {successMsg && (
            <div className="mb-5 p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-medium flex items-start gap-2.5">
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{successMsg}</span>
            </div>
          )}

          {mode === 'login' ? (
            <form onSubmit={handleLoginSubmit} className="space-y-4">
              <div>
                <h2 className="font-display text-2xl font-bold text-[#2C1E17]">
                  Welcome Back
                </h2>
                <p className="text-xs text-slate-500 mt-1">
                  Sign in with your CAFFIX Machine Owner account.
                </p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#4E3629] mb-1.5">
                  Email Address
                </label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="owner@company.com"
                    className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-[#EED9C4] bg-[#FAF6F0]/50 text-sm focus:outline-none focus:border-[#4E3629] focus:bg-white"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#4E3629] mb-1.5">
                  Password
                </label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
                  <input
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter your password"
                    className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-[#EED9C4] bg-[#FAF6F0]/50 text-sm focus:outline-none focus:border-[#4E3629] focus:bg-white"
                  />
                </div>
              </div>

              <div className="flex items-center justify-between text-xs">
                <label className="inline-flex items-center gap-2 text-slate-600 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={remember}
                    onChange={(e) => setRemember(e.target.checked)}
                    className="rounded border-slate-300 text-[#4E3629] focus:ring-[#4E3629]"
                  />
                  Keep me signed in
                </label>
                <button
                  type="button"
                  onClick={() => setMode('setup')}
                  className="font-semibold text-[#8C6246] hover:text-[#4E3629]"
                >
                  Have an invite token?
                </button>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full py-3 px-4 rounded-xl bg-[#4E3629] hover:bg-[#2C1E17] text-white font-semibold text-sm flex items-center justify-center gap-2 transition-colors disabled:opacity-60 cursor-pointer"
              >
                {loading ? 'Signing in...' : 'Sign In to Dashboard'}
                <ArrowRight className="w-4 h-4" />
              </button>
            </form>
          ) : (
            <form onSubmit={handleSetupPasswordSubmit} className="space-y-4">
              <div>
                <h2 className="font-display text-2xl font-bold text-[#2C1E17]">
                  Activate Owner Account
                </h2>
                <p className="text-xs text-slate-500 mt-1">
                  Use your single-use 24-hour invitation token to set your permanent password.
                </p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#4E3629] mb-1.5">
                  One-Time Invitation Token
                </label>
                <div className="relative">
                  <KeyRound className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
                  <input
                    type="text"
                    required
                    value={inviteToken}
                    onChange={(e) => setInviteToken(e.target.value)}
                    placeholder="64-character hex invitation token"
                    className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-[#EED9C4] bg-[#FAF6F0]/50 text-xs font-mono focus:outline-none focus:border-[#4E3629] focus:bg-white"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#4E3629] mb-1.5">
                  Invited Email Address (Optional verification)
                </label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="owner@company.com"
                    className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-[#EED9C4] bg-[#FAF6F0]/50 text-sm focus:outline-none focus:border-[#4E3629] focus:bg-white"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#4E3629] mb-1.5">
                  New Password (min 8 characters)
                </label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
                  <input
                    type="password"
                    required
                    minLength={8}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Create a strong password"
                    className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-[#EED9C4] bg-[#FAF6F0]/50 text-sm focus:outline-none focus:border-[#4E3629] focus:bg-white"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#4E3629] mb-1.5">
                  Confirm New Password
                </label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
                  <input
                    type="password"
                    required
                    minLength={8}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Re-enter your password"
                    className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-[#EED9C4] bg-[#FAF6F0]/50 text-sm focus:outline-none focus:border-[#4E3629] focus:bg-white"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full py-3 px-4 rounded-xl bg-[#4E3629] hover:bg-[#2C1E17] text-white font-semibold text-sm flex items-center justify-center gap-2 transition-colors disabled:opacity-60 cursor-pointer"
              >
                {loading ? 'Activating Account...' : 'Set Password & Open Dashboard'}
                <ArrowRight className="w-4 h-4" />
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

