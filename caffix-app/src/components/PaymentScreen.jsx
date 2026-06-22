import React, { useState, useEffect } from 'react';
import { ArrowLeft, RefreshCw, CreditCard, QrCode, Smartphone, Landmark, Check, Wallet } from 'lucide-react';

export default function PaymentScreen({ orderDetails, onPaymentSuccess, onPaymentFailed, onCancel }) {
  const [timeLeft, setTimeLeft] = useState(180); // 3 minutes
  const [activeTab, setActiveTab] = useState('UPI'); // UPI, QR, CARD, NETBANKING
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingStatus, setProcessingStatus] = useState('');
  
  // Form states for mock checkout
  const [vpa, setVpa] = useState('kiosk01@caffix');
  const [cardNumber, setCardNumber] = useState('4111 2222 3333 4444');
  const [cardExpiry, setCardExpiry] = useState('12/28');
  const [cardCvv, setCardCvv] = useState('123');
  const [selectedBank, setSelectedBank] = useState('');
  const [selectedWallet, setSelectedWallet] = useState('');

  // 1. Session Countdown
  useEffect(() => {
    if (timeLeft <= 0) {
      onCancel();
      return;
    }
    const timer = setInterval(() => {
      setTimeLeft((prev) => prev - 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [timeLeft]);

  // 2. Automatically launch Razorpay if keys are real
  useEffect(() => {
    if (orderDetails?.razorpay_key && orderDetails.razorpay_key !== 'mock') {
      launchRealRazorpay();
    }
  }, [orderDetails]);

  const launchRealRazorpay = () => {
    if (!window.Razorpay) {
      alert('Razorpay SDK failed to load. Running mock interface instead.');
      return;
    }

    const token = localStorage.getItem('kioskToken') || '';
    const options = {
      key: orderDetails.razorpay_key,
      amount: orderDetails.price * 100, // in paise
      currency: 'INR',
      name: 'CAFFIX',
      description: `Order ${orderDetails.name} (${orderDetails.size})`,
      order_id: orderDetails.razorpay_order_id,
      handler: async function (response) {
        setIsProcessing(true);
        setProcessingStatus('Verifying secure signature...');
        try {
          const verifyRes = await fetch('http://localhost:5000/api/payments/verify', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
              order_id: orderDetails.dbId,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_order_id: response.razorpay_order_id,
              razorpay_signature: response.razorpay_signature
            })
          });

          const verifyData = await verifyRes.json();
          if (verifyData.status === 'success') {
            onPaymentSuccess();
          } else {
            onPaymentFailed();
          }
        } catch (e) {
          console.error('Signature verification call failed:', e);
          onPaymentFailed();
        }
      },
      prefill: {
        name: 'Kiosk User',
        email: 'kiosk01@caffix.com'
      },
      theme: {
        color: '#2C1E17'
      },
      modal: {
        ondismiss: function () {
          // If modal closed without paying, route to payment failed
          onPaymentFailed();
        }
      }
    };

    const rzp = new window.Razorpay(options);
    rzp.open();
  };

  // 3. Process Mock Payment Verification
  const handleMockPay = async () => {
    setIsProcessing(true);
    setProcessingStatus('Connecting Gateway...');

    const statuses = [
      { text: 'Handshaking banking channels...', delay: 600 },
      { text: 'Verifying UPI / Card credentials...', delay: 1200 },
      { text: 'Confirming signature with database...', delay: 1800 }
    ];

    statuses.forEach((item) => {
      setTimeout(() => {
        setProcessingStatus(item.text);
      }, item.delay);
    });

    setTimeout(async () => {
      const token = localStorage.getItem('kioskToken') || '';
      const mockPayId = 'pay_mock_' + Math.floor(100000 + Math.random() * 900000);
      const mockSignature = 'sig_mock_' + Math.floor(100000 + Math.random() * 900000);

      try {
        const verifyRes = await fetch('http://localhost:5000/api/payments/verify', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({
            order_id: orderDetails.dbId,
            razorpay_payment_id: mockPayId,
            razorpay_order_id: orderDetails.razorpay_order_id,
            razorpay_signature: mockSignature
          })
        });

        const verifyData = await verifyRes.json();
        setIsProcessing(false);
        if (verifyData.status === 'success') {
          onPaymentSuccess();
        } else {
          onPaymentFailed();
        }
      } catch (err) {
        console.error('Verify mock signature call failed:', err);
        setIsProcessing(false);
        onPaymentFailed();
      }
    }, 2400);
  };

  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const isRealRazorpay = orderDetails?.razorpay_key && orderDetails.razorpay_key !== 'mock';

  return (
    <div className="w-full h-full flex flex-col justify-between p-4 bg-cream-light relative overflow-hidden">
      {/* Header Row */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          <button
            onClick={onCancel}
            className="p-2 rounded-xl bg-cream border border-coffee-light/20 hover:bg-cream-dark active:scale-95 active-touch-feedback"
            aria-label="Cancel order"
          >
            <ArrowLeft className="w-5 h-5 text-coffee" />
          </button>
          <div>
            <h2 className="font-sans font-extrabold text-2xl text-coffee-dark tracking-tight leading-none">
              Awaiting Payment
            </h2>
            <p className="text-xs text-coffee-light font-medium tracking-wide mt-0.5">
              {isRealRazorpay ? 'Razorpay payment frame is loading...' : 'Select a payment method from the checkout interface'}
            </p>
          </div>
        </div>
        <div className="text-right">
          <span className="text-[10px] uppercase font-bold text-coffee-light tracking-wide block">Order ID</span>
          <span className="font-mono text-sm font-bold text-coffee-dark bg-white border border-coffee-light/10 px-2.5 py-0.5 rounded-lg shadow-sm">
            {orderDetails?.dbId}
          </span>
        </div>
      </div>

      {/* Main Payment Section */}
      <div className="grid grid-cols-5 gap-4 flex-grow items-center my-1 overflow-hidden">
        {/* Left Side: Invoice & Timer */}
        <div className="col-span-2 flex flex-col justify-between self-stretch bg-white rounded-2xl border border-coffee-light/10 p-4 shadow-sm">
          <div className="space-y-4">
            {/* Invoice Breakdown */}
            <div className="bg-cream-light/40 rounded-xl p-3 border border-cream space-y-1.5 shadow-inner">
              <span className="text-[10px] uppercase font-black text-coffee-light/85 tracking-widest block">Selected Drink</span>
              <div className="text-sm font-extrabold text-coffee-dark leading-snug">{orderDetails?.name}</div>
              <div className="text-xs text-coffee-light">Size: {orderDetails?.size}</div>
              <div className="flex justify-between items-center pt-2 border-t border-cream-dark/30 mt-2 font-bold text-sm text-coffee">
                <span>Amount Due:</span>
                <span className="text-lg text-coffee-dark font-black">₹{orderDetails?.price}</span>
              </div>
            </div>

            {/* Timer Block */}
            <div className="flex flex-col items-center justify-center p-3 bg-red-50/50 rounded-xl border border-red-100">
              <span className="text-[10px] uppercase font-bold text-red-700 tracking-wider">Session Expires In</span>
              <div className="text-3xl font-black text-red-800 font-mono mt-0.5 tracking-widest animate-pulse">
                {formatTime(timeLeft)}
              </div>
            </div>
          </div>

          {/* Cancel button */}
          <button
            onClick={onCancel}
            className="w-full py-2.5 bg-red-50 hover:bg-red-100 text-red-700 border border-red-200 font-bold text-xs rounded-xl transition-colors active:scale-98 active-touch-feedback"
          >
            Cancel Order
          </button>
        </div>

        {/* Right Side: Interactive Payment Client */}
        <div className="col-span-3 flex flex-col items-center justify-center self-stretch bg-white rounded-2xl border border-coffee-light/10 p-4 shadow-sm relative overflow-hidden">
          
          {/* Overlay loading states */}
          {isProcessing ? (
            <div className="absolute inset-0 bg-white/95 flex flex-col justify-center items-center z-20 p-6 text-center animate-fade-in">
              <RefreshCw className="w-12 h-12 animate-spin text-gold mb-4" />
              <h3 className="font-extrabold text-lg text-coffee-dark">Processing Payment...</h3>
              <p className="text-xs text-coffee-light mt-2 font-mono">{processingStatus}</p>
            </div>
          ) : null}

          {isRealRazorpay ? (
            /* REAL RAZORPAY VIEW */
            <div className="flex flex-col items-center justify-center text-center p-6 space-y-4">
              <div className="p-4 bg-emerald-50 rounded-full border border-emerald-100 text-emerald-600 animate-pulse">
                <Smartphone className="w-12 h-12" />
              </div>
              <h3 className="font-extrabold text-lg text-coffee-dark">Razorpay Portal Launched</h3>
              <p className="text-xs text-coffee-light max-w-xs leading-relaxed">
                A secure modal checkout sheet has loaded. Complete payment on the overlay interface to vend your coffee.
              </p>
              <button
                onClick={launchRealRazorpay}
                className="py-2.5 px-6 bg-coffee text-cream-light font-bold text-xs rounded-xl shadow-md hover:bg-coffee-dark border border-gold/20 flex items-center gap-2 transition-all active:scale-95"
              >
                <RefreshCw className="w-4 h-4" />
                <span>Relaunch Checkout Sheet</span>
              </button>
            </div>
          ) : (
            /* MOCK INTERACTIVE RAZORPAY POPUP MODAL */
            <div className="w-full h-full flex flex-col justify-between">
              {/* Fake Gateway Header */}
              <div className="flex items-center justify-between border-b border-slate-100 pb-2.5 shrink-0">
                <div className="flex items-center gap-2">
                  <div className="bg-blue-600 px-2.5 py-1 rounded text-[10px] font-black text-white tracking-widest leading-none">
                    RAZORPAY
                  </div>
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Demo Sandbox</span>
                </div>
                <div className="text-right">
                  <span className="text-[9px] uppercase font-bold text-slate-400 block leading-none">Paying CAFFIX</span>
                  <span className="text-sm font-black text-slate-800">₹{orderDetails?.price}</span>
                </div>
              </div>

              {/* Tabs list */}
              <div className="flex bg-slate-100 p-1 rounded-xl shrink-0 my-2 text-xs font-bold gap-1">
                {[
                  { id: 'UPI', label: 'UPI / QR', icon: QrCode },
                  { id: 'CARD', label: 'Cards', icon: CreditCard },
                  { id: 'NETBANKING', label: 'NetBanking', icon: Landmark },
                  { id: 'WALLET', label: 'Wallets', icon: Wallet }
                ].map((tab) => {
                  const Icon = tab.icon;
                  return (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id)}
                      className={`flex-grow flex items-center justify-center gap-1.5 py-2 rounded-lg transition-all ${
                        activeTab === tab.id
                          ? 'bg-white text-blue-600 shadow-sm'
                          : 'text-slate-500 hover:text-slate-800'
                      }`}
                    >
                      <Icon className="w-3.5 h-3.5" />
                      <span>{tab.label}</span>
                    </button>
                  );
                })}
              </div>

              {/* Tab viewports */}
              <div className="flex-grow flex flex-col justify-center overflow-y-auto px-1 py-2">
                {/* 1. UPI TAB */}
                {activeTab === 'UPI' && (
                  <div className="space-y-3.5 text-center">
                    <div className="flex justify-center gap-6 items-center">
                      {/* Fake Vector QR */}
                      <div 
                        onClick={handleMockPay}
                        title="Click to quickly simulate QR Scan payment!"
                        className="p-2 bg-white rounded-xl border border-slate-200 shadow-sm cursor-pointer hover:border-blue-500 transition-colors group relative"
                      >
                        <svg className="w-24 h-24 text-slate-800" viewBox="0 0 100 100">
                          <rect x="5" y="5" width="20" height="20" fill="currentColor" />
                          <rect x="10" y="10" width="10" height="10" fill="#FFF" />
                          <rect x="75" y="5" width="20" height="20" fill="currentColor" />
                          <rect x="80" y="10" width="10" height="10" fill="#FFF" />
                          <rect x="5" y="75" width="20" height="20" fill="currentColor" />
                          <rect x="10" y="80" width="10" height="10" fill="#FFF" />
                          <g fill="currentColor" opacity="0.85">
                            <rect x="35" y="15" width="15" height="5" />
                            <rect x="55" y="10" width="5" height="15" />
                            <rect x="35" y="30" width="5" height="20" />
                            <rect x="45" y="45" width="15" height="5" />
                            <rect x="5" y="35" width="15" height="5" />
                            <rect x="25" y="65" width="20" height="5" />
                            <rect x="70" y="35" width="20" height="5" />
                            <rect x="80" y="45" width="5" height="15" />
                            <rect x="50" y="70" width="5" height="20" />
                            <rect x="65" y="80" width="20" height="5" />
                          </g>
                        </svg>
                        <div className="absolute inset-0 bg-blue-600/90 rounded-xl flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                          <span className="text-[9px] text-white font-bold uppercase tracking-wider">Scan & Pay</span>
                        </div>
                      </div>
                      <div className="text-left max-w-[150px]">
                        <h4 className="text-xs font-extrabold text-slate-800">Scan QR Code</h4>
                        <p className="text-[10px] text-slate-500 leading-normal mt-1">
                          Scan the QR using any UPI app (GPay, PhonePe, Paytm) to simulate success.
                        </p>
                      </div>
                    </div>

                    <div className="relative flex items-center shrink-0 my-1 text-slate-300 text-[10px] font-bold uppercase tracking-wider justify-center gap-2">
                      <span className="h-px bg-slate-100 flex-grow" />
                      <span>OR Pay via UPI ID</span>
                      <span className="h-px bg-slate-100 flex-grow" />
                    </div>

                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={vpa}
                        onChange={(e) => setVpa(e.target.value)}
                        placeholder="username@upi"
                        className="flex-grow pl-3 pr-2 py-1.5 border border-slate-200 rounded-lg text-xs font-semibold focus:outline-none focus:border-blue-500 font-mono"
                      />
                      <button
                        onClick={handleMockPay}
                        className="px-4 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-lg active:scale-95 transition-transform"
                      >
                        Pay ₹{orderDetails?.price}
                      </button>
                    </div>
                  </div>
                )}

                {/* 2. CARD TAB */}
                {activeTab === 'CARD' && (
                  <div className="space-y-2 text-left">
                    <div>
                      <label className="text-[9px] font-bold text-slate-400 uppercase">Card Number</label>
                      <input
                        type="text"
                        value={cardNumber}
                        onChange={(e) => setCardNumber(e.target.value)}
                        className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-semibold focus:outline-none focus:border-blue-500 font-mono"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-[9px] font-bold text-slate-400 uppercase">Expiry</label>
                        <input
                          type="text"
                          value={cardExpiry}
                          onChange={(e) => setCardExpiry(e.target.value)}
                          className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-semibold focus:outline-none focus:border-blue-500 font-mono"
                        />
                      </div>
                      <div>
                        <label className="text-[9px] font-bold text-slate-400 uppercase">CVV</label>
                        <input
                          type="password"
                          value={cardCvv}
                          onChange={(e) => setCardCvv(e.target.value)}
                          className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-semibold focus:outline-none focus:border-blue-500 font-mono"
                        />
                      </div>
                    </div>
                    <button
                      onClick={handleMockPay}
                      className="w-full py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-lg mt-3 active:scale-95 transition-transform"
                    >
                      Pay ₹{orderDetails?.price}
                    </button>
                  </div>
                )}

                {/* 3. NETBANKING TAB */}
                {activeTab === 'NETBANKING' && (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-2">
                      {[
                        { id: 'SBI', name: 'State Bank of India' },
                        { id: 'HDFC', name: 'HDFC Bank' },
                        { id: 'ICICI', name: 'ICICI Bank' },
                        { id: 'AXIS', name: 'Axis Bank' }
                      ].map((bank) => (
                        <button
                          key={bank.id}
                          onClick={() => setSelectedBank(bank.id)}
                          className={`p-2 border text-[11px] font-semibold rounded-lg text-left flex justify-between items-center transition-colors ${
                            selectedBank === bank.id
                              ? 'border-blue-600 bg-blue-50/50 text-blue-800'
                              : 'border-slate-100 bg-slate-50 hover:bg-slate-100 text-slate-700'
                          }`}
                        >
                          <span>{bank.name}</span>
                          {selectedBank === bank.id && <Check className="w-3.5 h-3.5 text-blue-600" />}
                        </button>
                      ))}
                    </div>
                    <button
                      onClick={handleMockPay}
                      disabled={!selectedBank}
                      className={`w-full py-2 font-bold text-xs rounded-lg mt-1 transition-all active:scale-95 ${
                        selectedBank
                          ? 'bg-blue-600 hover:bg-blue-700 text-white cursor-pointer'
                          : 'bg-slate-100 text-slate-400 cursor-not-allowed'
                      }`}
                    >
                      Pay ₹{orderDetails?.price}
                    </button>
                  </div>
                )}

                {/* 4. WALLET TAB */}
                {activeTab === 'WALLET' && (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-2">
                      {[
                        { id: 'PAYTM', name: 'Paytm Wallet' },
                        { id: 'PHONEPE', name: 'PhonePe Wallet' },
                        { id: 'AMAZON', name: 'Amazon Pay' },
                        { id: 'MOBIKWIK', name: 'MobiKwik' }
                      ].map((wallet) => (
                        <button
                          key={wallet.id}
                          onClick={() => setSelectedWallet(wallet.id)}
                          className={`p-2 border text-[11px] font-semibold rounded-lg text-left flex justify-between items-center transition-colors ${
                            selectedWallet === wallet.id
                              ? 'border-blue-600 bg-blue-50/50 text-blue-800'
                              : 'border-slate-100 bg-slate-50 hover:bg-slate-100 text-slate-700'
                          }`}
                        >
                          <span>{wallet.name}</span>
                          {selectedWallet === wallet.id && <Check className="w-3.5 h-3.5 text-blue-600" />}
                        </button>
                      ))}
                    </div>
                    <button
                      onClick={handleMockPay}
                      disabled={!selectedWallet}
                      className={`w-full py-2 font-bold text-xs rounded-lg mt-1 transition-all active:scale-95 ${
                        selectedWallet
                          ? 'bg-blue-600 hover:bg-blue-700 text-white cursor-pointer'
                          : 'bg-slate-100 text-slate-400 cursor-not-allowed'
                      }`}
                    >
                      Pay ₹{orderDetails?.price}
                    </button>
                  </div>
                )}
              </div>

              {/* Secure footer */}
              <div className="border-t border-slate-100 pt-1.5 shrink-0 flex items-center justify-between text-[9px] text-slate-400 font-bold uppercase tracking-wider">
                <span>🔒 PCI-DSS Compliant</span>
                <span>Demo Sandbox</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
