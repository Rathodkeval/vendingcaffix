import { AlertTriangle, CheckCircle2, Home } from 'lucide-react';

export default function DispenseFailedScreen({ orderDetails, failedOrder, onFinished }) {
  const orderId = failedOrder?.id || orderDetails?.dbId || '—';
  const paymentId = failedOrder?.razorpay_payment_id || orderDetails?.razorpay_payment_id || null;
  const amount = failedOrder?.amount ?? orderDetails?.price ?? '—';

  return (
    <div className="w-full h-full flex flex-col justify-between items-center py-10 px-6 bg-cream-light relative overflow-hidden text-center">
      <div className="absolute top-10 left-10 w-72 h-72 bg-red-100/40 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-10 right-10 w-72 h-72 bg-amber-100/30 rounded-full blur-3xl pointer-events-none" />

      <div />

      <div className="z-10 flex flex-col items-center bg-white p-6 rounded-3xl border border-red-200 shadow-lg max-w-sm w-full">
        <div className="relative w-20 h-20 mb-4 flex items-center justify-center bg-red-50 rounded-full border-2 border-red-500/20">
          <AlertTriangle className="w-12 h-12 text-red-600" />
        </div>

        <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-50 border border-emerald-200 text-[11px] font-bold text-emerald-800 mb-3">
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
          <span>Payment Confirmed • Dispensing Failed</span>
        </div>

        <h2 className="font-sans font-extrabold text-2xl text-coffee-dark tracking-tight">
          Unable to Dispense Drink
        </h2>

        <p className="text-xs font-semibold text-coffee-light mt-2 max-w-[290px] leading-relaxed">
          Your payment succeeded, but the machine could not dispense your beverage. Please{' '}
          <strong>do not pay again</strong> — share your Order ID below with support or staff for a
          full refund.
        </p>

        <div className="bg-red-50/50 border border-red-100 p-3 rounded-2xl w-full mt-4 text-xs font-bold text-coffee-dark space-y-1.5">
          <div className="flex justify-between">
            <span>Order ID:</span>
            <span className="font-mono text-red-900">{orderId}</span>
          </div>
          {paymentId && (
            <div className="flex justify-between border-t border-red-200/40 pt-1">
              <span>Payment ID:</span>
              <span className="font-mono text-[11px] text-coffee">{paymentId}</span>
            </div>
          )}
          <div className="flex justify-between border-t border-red-200/40 pt-1">
            <span>Paid Amount:</span>
            <span>₹{amount}</span>
          </div>
        </div>
      </div>

      <div className="z-10 w-full max-w-xs flex flex-col gap-3">
        <button
          onClick={onFinished}
          className="py-3.5 px-6 bg-coffee text-cream-light font-sans font-bold text-sm rounded-xl shadow-md hover:bg-coffee-dark border border-gold/20 flex items-center justify-center gap-2 active:scale-95 w-full transition-transform"
        >
          <Home className="w-4 h-4" />
          <span>Return to Home</span>
        </button>
      </div>
    </div>
  );
}

