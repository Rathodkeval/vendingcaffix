import React, { useState } from 'react';
import { Lock, Mail, ShieldCheck, Cpu, AlertCircle, ArrowRight } from 'lucide-react';
import { adminApi, clearStoredToken } from '../services/api';

export default function AuthPage({ onAuthenticated, sessionNotice }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleLoginSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await adminApi.login(email.trim(), password);
      const userData = res.data;
      const jwtToken = res.token;

      if (!userData || !jwtToken) {
        throw new Error('Invalid authentication response from server.');
      }

      if (userData.role !== 'admin') {
        clearStoredToken();
        throw new Error(
          'Access denied: This portal is restricted to CAFFIX Super Admin accounts. Customer owners must sign in through the CAFFIX Owner Portal.'
        );
      }

      await onAuthenticated(jwtToken, userData, remember);
    } catch (err) {
      setError(err.message || 'Unable to sign in. Please verify your Super Admin credentials.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col lg:flex-row bg-[#FAF6F0]">
      {/* Left Admin Brand Showcase Panel */}
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
              <div className="text-xs font-semibold text-[#C9A66B] uppercase tracking-widest">
                Super Admin Operations Portal
              </div>
            </div>
          </div>

          <h1 className="font-display text-3xl lg:text-4xl font-bold text-white mt-10 leading-tight">
            Global Fleet Operations & Owner Governance
          </h1>
          <p className="text-[#EED9C4]/85 text-sm lg:text-base mt-4 leading-relaxed">
            Register CAFFIX vending machines, invite and manage customer owner accounts, assign or
            reassign fleet ownership, monitor global sales, and oversee per-machine pricing across
            every kiosk.
          </p>
        </div>

        <div className="relative z-10 mt-10 pt-8 border-t border-[#4E3629] grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs text-[#EED9C4]/90">
          <div className="bg-[#4E3629]/40 p-3.5 rounded-xl border border-[#C9A66B]/20">
            <div className="font-semibold text-[#C9A66B] flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4" />
              Super Admin Isolation
            </div>
            <p className="mt-1 text-[#EED9C4]/75">
              Enforced server-side portal and role verification on every admin endpoint.
            </p>
          </div>
          <div className="bg-[#4E3629]/40 p-3.5 rounded-xl border border-[#C9A66B]/20">
            <div className="font-semibold text-[#C9A66B] flex items-center gap-1.5">
              <Cpu className="w-4 h-4" />
              Global Fleet Provisioning
            </div>
            <p className="mt-1 text-[#EED9C4]/75">
              Onboard machines, generate single-use owner invites, and manage assignments live.
            </p>
          </div>
        </div>
      </div>

      {/* Right Authentication Form Panel */}
      <div className="flex-1 flex items-center justify-center p-6 sm:p-10 lg:p-16">
        <div className="w-full max-w-md bg-white rounded-3xl border border-[#EED9C4] shadow-lg p-7 sm:p-9">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#2C1E17] text-[#C9A66B] text-xs font-bold uppercase tracking-wider mb-5">
            <ShieldCheck className="w-3.5 h-3.5" />
            CAFFIX Super Admin Only
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

          <form onSubmit={handleLoginSubmit} className="space-y-4">
            <div>
              <h2 className="font-display text-2xl font-bold text-[#2C1E17]">
                Admin Sign In
              </h2>
              <p className="text-xs text-slate-500 mt-1">
                Sign in with an authorized CAFFIX Super Admin account.
              </p>
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#4E3629] mb-1.5">
                Administrator Email
              </label>
              <div className="relative">
                <Mail className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="admin@caffix.com"
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
                  placeholder="Enter your admin password"
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
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 px-4 rounded-xl bg-[#4E3629] hover:bg-[#2C1E17] text-white font-semibold text-sm flex items-center justify-center gap-2 transition-colors disabled:opacity-60 cursor-pointer"
            >
              {loading ? 'Verifying Admin...' : 'Sign In to Admin Portal'}
              <ArrowRight className="w-4 h-4" />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

