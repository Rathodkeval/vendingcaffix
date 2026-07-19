import React, { useState, useEffect, useRef } from 'react';

export default function KioskHeader({ onAdminAccess }) {
  const [time, setTime] = useState(new Date());
  const tapCountRef = useRef(0);
  const tapTimerRef = useRef(null);

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const formatTime = (date) => {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
  };

  const handleLogoClick = () => {
    tapCountRef.current++;
    clearTimeout(tapTimerRef.current);
    tapTimerRef.current = setTimeout(() => { tapCountRef.current = 0; }, 1000);
    if (tapCountRef.current >= 3) {
      tapCountRef.current = 0;
      if (onAdminAccess) onAdminAccess();
    }
  };

  return (
    <header className="relative flex justify-between items-center px-6 py-4 bg-coffee-dark text-cream-light border-b border-coffee/20 shadow-md">
      {/* Brand Section */}
      <div className="flex items-center gap-3 cursor-pointer z-10" onClick={handleLogoClick}>
        <img 
          src="/assets/logo.png" 
          alt="Caffix Logo" 
          className="h-10 w-auto object-contain rounded-xl bg-white shadow-inner p-0.5 animate-bounce" 
        />
      </div>

      {/* Centered Tagline */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <span className="font-sans text-lg font-black tracking-widest text-[#FAF6F0] bg-[#FAF6F0]/10 px-6 py-1 rounded-full border border-[#FAF6F0]/20 shadow-inner">
          Your AI Barista
        </span>
      </div>

      {/* Clock & Status */}
      <div className="flex items-center gap-6 z-10">
        <span className="font-mono text-lg font-semibold tracking-wider text-cream/80">
          {formatTime(time)}
        </span>
        <div className="flex items-center gap-2 bg-coffee/40 px-3 py-1.5 rounded-full border border-coffee-light/30">
          <span className="w-2.5 h-2.5 bg-emerald-500 rounded-full animate-ping"></span>
          <span className="w-2.5 h-2.5 bg-emerald-500 rounded-full absolute"></span>
          <span className="text-xs font-semibold uppercase tracking-wider text-emerald-400">Ready</span>
        </div>
      </div>
    </header>
  );
}
