import React, { useState } from 'react';
import { ShieldCheck, Delete, X, Circle } from 'lucide-react';

export default function AdminPasscode({ onSuccess, onCancel }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState(false);

  const handleKeyPress = (num) => {
    if (error) setError(false);
    if (pin.length < 4) {
      const newPin = pin + num;
      setPin(newPin);

      // Verify immediately when 4 digits are input
      if (newPin.length === 4) {
        if (newPin === '1234') {
          onSuccess();
        } else {
          setTimeout(() => {
            setError(true);
            setPin('');
          }, 250);
        }
      }
    }
  };

  const handleBackspace = () => {
    if (pin.length > 0) {
      setPin(pin.slice(0, -1));
    }
  };

  const handleClear = () => {
    setPin('');
    setError(false);
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
        <div className="flex flex-col items-center mb-6 text-center">
          <div className={`p-3.5 rounded-full ${error ? 'bg-red-50 border border-red-200' : 'bg-cream border border-gold/20'} mb-2 shadow-sm`}>
            <ShieldCheck className={`w-8 h-8 ${error ? 'text-red-600' : 'text-coffee'}`} />
          </div>
          <h2 className="font-sans font-extrabold text-xl text-coffee-dark">Admin Credentials</h2>
          <p className="text-[11px] font-semibold text-coffee-light/75 uppercase tracking-wider mt-1">
            {error ? 'Invalid PIN code. Try again.' : 'Enter 4-Digit Passcode to continue'}
          </p>
        </div>

        {/* PIN Indicators */}
        <div className="flex gap-4 mb-8">
          {[0, 1, 2, 3].map((index) => (
            <div
              key={index}
              className={`w-4 h-4 rounded-full border-2 transition-all duration-150 ${
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
              onClick={() => handleKeyPress(num)}
              className="py-3 bg-cream/40 hover:bg-cream-dark active:scale-95 text-coffee-dark font-sans font-black text-xl rounded-2xl border border-coffee-light/10 shadow-sm active-touch-feedback"
            >
              {num}
            </button>
          ))}
          <button
            onClick={handleClear}
            className="py-3 text-xs font-bold text-coffee hover:text-coffee-dark active:scale-95 uppercase tracking-wide"
          >
            Clear
          </button>
          <button
            onClick={() => handleKeyPress(0)}
            className="py-3 bg-cream/40 hover:bg-cream-dark active:scale-95 text-coffee-dark font-sans font-black text-xl rounded-2xl border border-coffee-light/10 shadow-sm active-touch-feedback"
          >
            0
          </button>
          <button
            onClick={handleBackspace}
            className="py-3 flex justify-center items-center text-coffee active:scale-95"
            aria-label="Delete"
          >
            <Delete className="w-5 h-5" />
          </button>
        </div>

        <span className="text-[9px] font-bold text-coffee-light/30 uppercase tracking-widest mt-6">
          Authorized personnel only • CAFFIX
        </span>
      </div>
    </div>
  );
}
