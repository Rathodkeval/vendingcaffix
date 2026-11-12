import React, { useState } from 'react';
import { ShieldCheck, Delete, X } from 'lucide-react';

const MIN_PASSCODE_LENGTH = 6;
const MAX_PASSCODE_LENGTH = 12;

export default function AdminPasscode({ onSuccess, onCancel }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleKeyPress = (num) => {
    if (submitting) return;
    if (error) setError(false);
    if (pin.length < MAX_PASSCODE_LENGTH) {
      setPin((prev) => prev + String(num));
    }
  };

  const handleBackspace = () => {
    if (submitting) return;
    if (pin.length > 0) {
      setPin(pin.slice(0, -1));
    }
  };

  const handleClear = () => {
    if (submitting) return;
    setPin('');
    setError(false);
  };

  const handleSubmit = async () => {
    if (submitting || pin.length < MIN_PASSCODE_LENGTH) return;
    setSubmitting(true);
    setError(false);
    try {
      const ok = await onSuccess(pin);
      if (!ok) {
        setError(true);
        setPin('');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-coffee-dark/85 backdrop-blur-md">
      <div className="relative bg-white/95 rounded-3xl border border-coffee-light/20 p-6 w-full max-w-sm shadow-2xl flex flex-col items-center">
        {/* Close Button */}
        <button
          onClick={onCancel}
          className="absolute top-4 right-4 p-1.5 rounded-full hover:bg-cream-dark text-coffee-light active:scale-90"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Title */}
        <div className="flex flex-col items-center mb-5 text-center">
          <div className={`p-3.5 rounded-full ${error ? 'bg-red-50 border border-red-200' : 'bg-cream border border-gold/20'} mb-2 shadow-sm`}>
            <ShieldCheck className={`w-8 h-8 ${error ? 'text-red-600' : 'text-coffee'}`} />
          </div>
          <h2 className="font-sans font-extrabold text-xl text-coffee-dark">Admin Credentials</h2>
          <p className="text-[11px] font-semibold text-coffee-light/75 uppercase tracking-wider mt-1">
            {error
              ? 'Invalid passcode. Try again.'
              : `Enter ${MIN_PASSCODE_LENGTH}+ digit passcode`}
          </p>
        </div>

        {/* PIN Indicators */}
        <div className="flex flex-wrap justify-center gap-2.5 mb-6 min-h-[20px]">
          {Array.from({ length: Math.max(MIN_PASSCODE_LENGTH, pin.length) }).map((_, index) => (
            <div
              key={index}
              className={`w-3.5 h-3.5 rounded-full border-2 transition-all duration-150 ${
                error
                  ? 'border-red-500 bg-red-100 animate-shake'
                  : index < pin.length
                  ? 'border-coffee bg-coffee scale-110 shadow-sm'
                  : 'border-coffee-light/35 bg-transparent'
              }`}
            />
          ))}
        </div>

        {/* Keypad Grid */}
        <div className="grid grid-cols-3 gap-3.5 w-full max-w-[280px]">
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((num) => (
            <button
              key={num}
              disabled={submitting}
              onClick={() => handleKeyPress(num)}
              className="py-3 bg-cream/40 hover:bg-cream-dark active:scale-95 text-coffee-dark font-sans font-black text-xl rounded-2xl border border-coffee-light/10 shadow-sm active-touch-feedback disabled:opacity-50"
            >
              {num}
            </button>
          ))}
          <button
            disabled={submitting}
            onClick={handleClear}
            className="py-3 text-xs font-bold text-coffee hover:text-coffee-dark active:scale-95 uppercase tracking-wide disabled:opacity-50"
          >
            Clear
          </button>
          <button
            disabled={submitting}
            onClick={() => handleKeyPress(0)}
            className="py-3 bg-cream/40 hover:bg-cream-dark active:scale-95 text-coffee-dark font-sans font-black text-xl rounded-2xl border border-coffee-light/10 shadow-sm active-touch-feedback disabled:opacity-50"
          >
            0
          </button>
          <button
            disabled={submitting}
            onClick={handleBackspace}
            className="py-3 flex justify-center items-center text-coffee active:scale-95 disabled:opacity-50"
            aria-label="Delete"
          >
            <Delete className="w-5 h-5" />
          </button>
        </div>

        <button
          disabled={submitting || pin.length < MIN_PASSCODE_LENGTH}
          onClick={handleSubmit}
          className="mt-5 w-full max-w-[280px] py-3 rounded-2xl bg-coffee-dark text-white font-bold text-sm uppercase tracking-wider shadow-sm hover:bg-coffee active:scale-98 disabled:opacity-40"
        >
          {submitting ? 'Verifying...' : 'Unlock Admin'}
        </button>

        <span className="text-[9px] font-bold text-coffee-light/30 uppercase tracking-widest mt-4">
          Authorized personnel only • CAFFIX
        </span>
      </div>
    </div>
  );
}
