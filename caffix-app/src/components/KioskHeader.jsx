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
    <header className="flex justify-between items-center px-6 py-4 bg-coffee-dark text-cream-light border-b border-coffee/20 shadow-md">
      {/* Brand Section */}
      <div className="flex items-center gap-3 cursor-pointer" onClick={handleLogoClick}>
        <svg className="w-8 h-8 fill-gold animate-bounce" viewBox="0 0 24 24">
          <path d="M2 21h18v-2H2v2zM20 8h-2V5h2V2h-2v3H4v8c0 3.31 2.69 6 6 6h4c3.31 0 6-2.69 6-6v-3h2c1.1 0 2-.9 2-2V9c0-1.1-.9-2-2-2zm-2 5c0 2.21-1.79 4-4 4h-4c-2.21 0-4-1.79-4-4V7h12v6zm2-3h-2V9h2v1z" />
        </svg>
        <span className="font-sans font-extrabold text-2xl tracking-wider uppercase text-gold">Caffix</span>
      </div>

      {/* Clock & Status */}
      <div className="flex items-center gap-6">
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
