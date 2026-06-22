import React, { useState, useEffect } from 'react';
import { CheckCircle2, ArrowRight } from 'lucide-react';

export default function SuccessScreen({ onFinished }) {
  const [secondsLeft, setSecondsLeft] = useState(10);

  useEffect(() => {
    if (secondsLeft <= 0) {
      onFinished();
      return;
    }
    const timer = setInterval(() => {
      setSecondsLeft((prev) => prev - 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [secondsLeft]);

  return (
    <div className="w-full h-full flex flex-col justify-between items-center py-10 px-6 bg-cream-light relative overflow-hidden text-center">
      {/* Decorative Blur Rings */}
      <div className="absolute top-10 left-10 w-72 h-72 bg-emerald-100/40 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-10 right-10 w-72 h-72 bg-gold/15 rounded-full blur-3xl pointer-events-none" />

      {/* Spacer */}
      <div />

      {/* Success Hero Card */}
      <div className="z-10 flex flex-col items-center bg-white p-6 rounded-3xl border border-coffee-light/10 shadow-lg max-w-sm w-full">
        {/* Animated Checkmark */}
        <div className="relative w-20 h-20 mb-4 flex items-center justify-center bg-emerald-50 rounded-full border-2 border-emerald-500/20">
          <CheckCircle2 className="w-16 h-16 text-emerald-600 animate-bounce" />
          <span className="absolute w-20 h-20 bg-emerald-400/20 rounded-full -z-10 animate-ping"></span>
        </div>

        <h2 className="font-sans font-extrabold text-3xl text-coffee-dark tracking-tight">
          Order Complete!
        </h2>
        
        <p className="text-sm font-semibold text-coffee-light mt-2 max-w-[280px] leading-snug">
          Please collect your freshly brewed beverage from the cup tray.
        </p>

        <div className="bg-cream-light/50 border border-cream px-4 py-2.5 rounded-2xl w-full mt-4 text-xs font-bold text-coffee">
          Enjoy your Caffix premium coffee!
        </div>
      </div>

      {/* Redirect countdown card */}
      <div className="z-10 w-full max-w-xs flex flex-col items-center gap-3">
        {/* Visual progress countdown */}
        <div className="flex items-center gap-2 text-xs font-bold text-coffee-light uppercase tracking-wider">
          <span>Returning to Home in</span>
          <span className="font-mono text-sm text-gold-dark font-black bg-white border border-coffee-light/10 px-2 py-0.5 rounded-lg">
            {secondsLeft}s
          </span>
        </div>

        {/* Skip button */}
        <button
          onClick={onFinished}
          className="py-3 px-6 bg-coffee text-cream-light font-sans font-bold text-sm rounded-xl shadow-md hover:bg-coffee-dark border border-gold/20 flex items-center justify-center gap-2 active:scale-95 active-touch-feedback w-full transition-transform"
        >
          <span>Return Immediately</span>
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
