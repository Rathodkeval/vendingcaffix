import { useEffect, useState } from 'react';
import { AlertCircle, RefreshCw, XCircle, Loader2 } from 'lucide-react';

export default function PaymentFailedScreen({ orderDetails, failureMessage, onRetry, onCancel }) {
  const [pendingAction, setPendingAction] = useState(null); // 'retry' | 'cancel' | null

  useEffect(() => {
    const timer = setTimeout(() => {
      if (onCancel && !pendingAction) {
        onCancel({ reason: 'timeout' });
      }
    }, 60000);
    return () => clearTimeout(timer);
  }, [onCancel, pendingAction]);

  const handleAction = async (actionType, handler, arg) => {
    if (pendingAction || typeof handler !== 'function') return;
    setPendingAction(actionType);
    try {
      await handler(arg);
    } finally {
      setPendingAction(null);
    }
  };

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
        {failureMessage && (
          <div className="px-4 py-2.5 rounded-xl bg-red-50 border border-red-200 text-red-700 text-xs font-sans text-center">
            {failureMessage}
          </div>
        )}

        {/* Retry Button */}
        <button
          disabled={Boolean(pendingAction)}
          onClick={() => handleAction('retry', onRetry)}
          className="py-4 px-6 bg-coffee text-cream-light font-sans font-bold text-sm rounded-xl shadow-md hover:bg-coffee-dark border border-gold/20 flex items-center justify-center gap-2 active:scale-95 active-touch-feedback w-full transition-transform disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {pendingAction === 'retry' ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          <span>{pendingAction === 'retry' ? 'Checking Payment...' : 'Try Payment Again'}</span>
        </button>

        {/* Cancel Button */}
        <button
          disabled={Boolean(pendingAction)}
          onClick={() => handleAction('cancel', onCancel, { reason: 'customer_cancelled' })}
          className="py-3.5 px-6 bg-red-50 hover:bg-red-100 text-red-700 font-sans font-bold text-xs rounded-xl border border-red-200 flex items-center justify-center gap-2 active:scale-95 active-touch-feedback w-full transition-transform disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {pendingAction === 'cancel' ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />}
          <span>{pendingAction === 'cancel' ? 'Checking Status...' : 'Cancel & Return to Menu'}</span>
        </button>
      </div>
    </div>
  );
}
