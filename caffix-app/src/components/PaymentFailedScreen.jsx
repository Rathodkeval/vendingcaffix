import React from 'react';
import { AlertCircle, RefreshCw, XCircle } from 'lucide-react';

export default function PaymentFailedScreen({ orderDetails, onRetry, onCancel }) {
  return (
    <div className="w-full h-full flex flex-col justify-between items-center py-10 px-6 bg-cream-light relative overflow-hidden text-center">
      {/* Decorative Blur Rings */}
      <div className="absolute top-10 left-10 w-72 h-72 bg-red-100/40 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-10 right-10 w-72 h-72 bg-gold/10 rounded-full blur-3xl pointer-events-none" />

      {/* Spacer */}
      <div />

      {/* Error Hero Card */}
      <div className="z-10 flex flex-col items-center bg-white p-6 rounded-3xl border border-red-100 shadow-lg max-w-sm w-full">
        {/* Animated Warning Icon */}
        <div className="relative w-20 h-20 mb-4 flex items-center justify-center bg-red-50 rounded-full border-2 border-red-500/20">
          <AlertCircle className="w-12 h-12 text-red-600 animate-pulse" />
        </div>

        <h2 className="font-sans font-extrabold text-3xl text-coffee-dark tracking-tight">
          Payment Failed
        </h2>
        
        <p className="text-sm font-semibold text-coffee-light mt-2 max-w-[280px] leading-snug">
          The transaction could not be processed. Please select another payment method or try again.
        </p>

        <div className="bg-red-50/50 border border-red-100 p-3 rounded-2xl w-full mt-4 text-xs font-bold text-red-800 space-y-1">
          <div className="flex justify-between">
            <span>Drink:</span>
            <span>{orderDetails?.name}</span>
          </div>
          <div className="flex justify-between border-t border-red-200/40 pt-1 mt-1">
            <span>Amount Due:</span>
            <span>₹{orderDetails?.price}</span>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="z-10 w-full max-w-xs flex flex-col gap-3">
        {/* Retry Button */}
        <button
          onClick={onRetry}
          className="py-4 px-6 bg-coffee text-cream-light font-sans font-bold text-sm rounded-xl shadow-md hover:bg-coffee-dark border border-gold/20 flex items-center justify-center gap-2 active:scale-95 active-touch-feedback w-full transition-transform"
        >
          <RefreshCw className="w-4 h-4" />
          <span>Try Payment Again</span>
        </button>

        {/* Cancel Button */}
        <button
          onClick={onCancel}
          className="py-3.5 px-6 bg-red-50 hover:bg-red-100 text-red-700 font-sans font-bold text-xs rounded-xl border border-red-200 flex items-center justify-center gap-2 active:scale-95 active-touch-feedback w-full transition-transform"
        >
          <XCircle className="w-4 h-4" />
          <span>Cancel & Return to Menu</span>
        </button>
      </div>
    </div>
  );
}
