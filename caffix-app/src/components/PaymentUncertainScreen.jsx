import { useState, useEffect, useCallback } from 'react';
import { Clock, RefreshCw, Home, ShieldCheck } from 'lucide-react';
import {
  verifyPaymentWithRetry,
  fetchAuthoritativeOrderStatus,
  isOrderPaidOrActive
} from '../utils/paymentLifecycle';

export default function PaymentUncertainScreen({
  orderDetails,
  verifyPayload,
  initialMessage,
  apiBase,
  onConfirmedPaid,
  onConfirmedFailed,
  onReturnHome
}) {
  const [isChecking, setIsChecking] = useState(false);
  const [statusMessage, setStatusMessage] = useState(
    initialMessage ||
      'We are confirming your payment with the bank. Please wait a moment and do not scan or pay again.'
  );

  const checkPaymentState = useCallback(async () => {
    if (isChecking || !orderDetails?.dbId) return;
    setIsChecking(true);
    const token = localStorage.getItem('kioskToken') || '';

    try {
      // 1. Check authoritative backend order status first (covers webhook / prior verify completion)
      const orderStatus = await fetchAuthoritativeOrderStatus({
        apiBase,
        token,
        orderId: orderDetails.dbId
      });

      if (orderStatus.ok && isOrderPaidOrActive(orderStatus.order)) {
        onConfirmedPaid(orderStatus.order);
        return;
      }

      if (
        orderStatus.ok &&
        String(orderStatus.order?.status || '').toUpperCase() === 'FAILED'
      ) {
        onConfirmedFailed?.({
          message: 'Payment was marked failed by Razorpay. No amount will be captured.'
        });
        return;
      }

      // 2. If we retained the signed Razorpay handler response, retry bounded verification
      if (verifyPayload) {
        const retryResult = await verifyPaymentWithRetry({
          apiBase,
          token,
          payload: verifyPayload,
          maxAttempts: 2,
          initialDelayMs: 600
        });
        if (retryResult.outcome === 'VERIFIED') {
          onConfirmedPaid(retryResult.order);
          return;
        }
        if (retryResult.outcome === 'FAILED') {
          onConfirmedFailed?.({ message: retryResult.message });
          return;
        }
        setStatusMessage(
          retryResult.message ||
            'Confirmation is still pending. Please try checking status again shortly or contact support with your Order ID.'
        );
      } else {
        setStatusMessage(
          'Payment confirmation is still pending at the gateway. If debited, your order will reconcile automatically.'
        );
      }
    } finally {
      setIsChecking(false);
    }
  }, [apiBase, isChecking, onConfirmedFailed, onConfirmedPaid, orderDetails?.dbId, verifyPayload]);

  // Bounded automatic background re-checks (every 5s for up to 3 checks = 15s)
  useEffect(() => {
    let checksRemaining = 3;
    const interval = setInterval(() => {
      if (checksRemaining <= 0) {
        clearInterval(interval);
        return;
      }
      checksRemaining -= 1;
      checkPaymentState();
    }, 5000);
    return () => clearInterval(interval);
  }, [checkPaymentState]);

  return (
    <div className="w-full h-full flex flex-col justify-between items-center py-10 px-6 bg-cream-light relative overflow-hidden text-center">
      <div className="absolute top-10 left-10 w-72 h-72 bg-amber-100/50 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-10 right-10 w-72 h-72 bg-gold/15 rounded-full blur-3xl pointer-events-none" />

      <div />

      <div className="z-10 flex flex-col items-center bg-white p-6 rounded-3xl border border-amber-200 shadow-lg max-w-sm w-full">
        <div className="relative w-20 h-20 mb-4 flex items-center justify-center bg-amber-50 rounded-full border-2 border-amber-400/30">
          <Clock className="w-11 h-11 text-amber-600 animate-pulse" />
        </div>

        <h2 className="font-sans font-extrabold text-2xl text-coffee-dark tracking-tight">
          Payment Confirmation Pending
        </h2>

        <div className="mt-2 inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-50 border border-amber-200 text-[11px] font-bold text-amber-900">
          <ShieldCheck className="w-3.5 h-3.5 text-amber-700" />
          <span>Do Not Pay Again</span>
        </div>

        <p className="text-xs font-semibold text-coffee-light mt-3 max-w-[300px] leading-relaxed">
          {statusMessage}
        </p>

        <div className="bg-amber-50/50 border border-amber-100 p-3 rounded-2xl w-full mt-4 text-xs font-bold text-coffee-dark space-y-1.5">
          <div className="flex justify-between">
            <span>Order ID:</span>
            <span className="font-mono">{orderDetails?.dbId || '—'}</span>
          </div>
          <div className="flex justify-between border-t border-amber-200/40 pt-1">
            <span>Drink:</span>
            <span>{orderDetails?.name || '—'}</span>
          </div>
          <div className="flex justify-between border-t border-amber-200/40 pt-1">
            <span>Amount:</span>
            <span>₹{orderDetails?.price ?? '—'}</span>
          </div>
        </div>
      </div>

      <div className="z-10 w-full max-w-xs flex flex-col gap-3">
        <button
          onClick={checkPaymentState}
          disabled={isChecking}
          className="py-3.5 px-6 bg-coffee text-cream-light font-sans font-bold text-sm rounded-xl shadow-md hover:bg-coffee-dark border border-gold/20 flex items-center justify-center gap-2 active:scale-95 disabled:opacity-60 w-full transition-transform"
        >
          <RefreshCw className={`w-4 h-4 ${isChecking ? 'animate-spin' : ''}`} />
          <span>{isChecking ? 'Checking Status...' : 'Check Payment Status'}</span>
        </button>

        <button
          onClick={onReturnHome}
          disabled={isChecking}
          className="py-3 px-6 bg-white hover:bg-cream text-coffee-dark font-sans font-bold text-xs rounded-xl border border-coffee-light/20 flex items-center justify-center gap-2 active:scale-95 disabled:opacity-60 w-full transition-transform"
        >
          <Home className="w-4 h-4" />
          <span>Return to Home (Keep Order Safe)</span>
        </button>
      </div>
    </div>
  );
}

