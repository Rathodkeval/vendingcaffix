import React, { useState, useEffect, useRef, useCallback } from 'react';
import KioskHeader from './components/KioskHeader';
import WelcomeScreen from './components/WelcomeScreen';
import SelectionScreen from './components/SelectionScreen';
import SummaryScreen from './components/SummaryScreen';
import FlavorAndCustomizationView from './components/FlavorAndCustomizationView';
import PaymentScreen from './components/PaymentScreen';
import SuccessScreen from './components/SuccessScreen';
import AdminPasscode from './components/AdminPasscode';
import AdminDashboard from './components/AdminDashboard';
import PaymentFailedScreen from './components/PaymentFailedScreen';
import { Wrench, Loader2, ShieldAlert } from 'lucide-react';
import { AnimatePresence, LayoutGroup } from 'framer-motion';
import {
  DEFAULT_PRICES,
  DEFAULT_AVAILABILITY,
  fetchKioskSyncState,
  resolveEffectiveMachineId
} from './utils/kioskSync';

const API_BASE = import.meta.env.VITE_API_URL || (
  window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.port === '8000' || window.location.port === '5173'
    ? 'http://localhost:5000/api'
    : '/api'
);

const KIOSK_POLL_INTERVAL_MS = 15000;
const SYNC_PAUSED_SCREENS = ['PAYMENT', 'PAYMENT_FAILED', 'SUCCESS'];

export default function App() {
  const [kioskStatus, setKioskStatus] = useState('VERIFYING'); // 'VERIFYING' | 'AUTHORIZED' | 'UNAUTHORIZED'
  const [machineId, setMachineId] = useState(null);
  const [screen, setScreen] = useState('WELCOME');
  const [selectedCoffee, setSelectedCoffee] = useState(null);
  const [orderDetails, setOrderDetails] = useState(null);
  
  // Admin & Settings States
  const [prices, setPrices] = useState(DEFAULT_PRICES);
  const [availability, setAvailability] = useState(DEFAULT_AVAILABILITY);
  const [maintenanceMode, setMaintenanceMode] = useState(false);
  const [inventory, setInventory] = useState({
    water: 100,
    coffee: 100,
    milk: 100,
    vanilla: 100,
    hazelnut: 100,
    irish: 100,
    mocha: 100
  });

  // Orders Log history
  const [orderHistory, setOrderHistory] = useState([]);
  const screenRef = useRef(screen);
  const refreshSeqRef = useRef(0);

  useEffect(() => {
    screenRef.current = screen;
  }, [screen]);

  // Kiosk Startup & Live Sync: Pull machine-scoped prices, availability, and status/levels
  const refreshKioskData = useCallback(async (tokenOverride, targetMachineId) => {
    const seq = ++refreshSeqRef.current;
    try {
      const activeToken = tokenOverride ?? localStorage.getItem('kioskToken') ?? '';
      const activeMachineId = resolveEffectiveMachineId(
        targetMachineId ?? machineId ?? localStorage.getItem('machineId'),
        import.meta.env.VITE_MACHINE_ID
      );

      const syncState = await fetchKioskSyncState({
        apiBase: API_BASE,
        token: activeToken,
        machineId: activeMachineId
      });

      // Ignore superseded in-flight responses
      if (seq !== refreshSeqRef.current) return;

      if (syncState.prices) {
        setPrices(syncState.prices);
      }
      if (syncState.availability) {
        setAvailability(syncState.availability);
      }
      if (syncState.maintenanceMode !== null) {
        setMaintenanceMode(syncState.maintenanceMode);
      }
      if (syncState.inventory) {
        setInventory(syncState.inventory);
      }
    } catch (error) {
      console.error('Kiosk data refresh failed:', error);
    }
  }, [machineId]);

  const refreshAdminData = async (token, targetMachineId = machineId) => {
    try {
      // 1. Get orders history for the active machine
      const queryStr = targetMachineId ? `?machine_id=${encodeURIComponent(targetMachineId)}` : '';
      const ordersRes = await fetch(`${API_BASE}/orders${queryStr}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const ordersData = await ordersRes.json();
      if (ordersData.status === 'success') {
        const formatted = ordersData.data.map((o) => ({
          id: o.id,
          name: o.product_name || (o.product_id === 1 ? 'Classic Crest' : o.product_id === 2 ? 'Vanilla Velvet' : o.product_id === 3 ? 'Hazel Gold' : o.product_id === 4 ? 'Irish Emerald' : 'Mocha Bliss'),
          size: 'Medium',
          price: o.amount,
          time: `${new Date(o.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}, ${new Date(o.created_at).toLocaleDateString()}`
        }));
        setOrderHistory(formatted);
      }

      // 2. Refresh machine levels
      await refreshKioskData(token, targetMachineId);
    } catch (error) {
      console.error('Admin data refresh failed:', error);
    }
  };

  useEffect(() => {
    async function verifyKioskDevice() {
      const urlParams = new URLSearchParams(window.location.search);
      const kioskParam = urlParams.get('kiosk');
      const hasMachineParam = urlParams.has('machine_id');
      const machineParam = urlParams.get('machine_id');

      if (!kioskParam) {
        setKioskStatus('UNAUTHORIZED');
        return;
      }

      if (hasMachineParam && (!machineParam || !machineParam.trim())) {
        setKioskStatus('UNAUTHORIZED');
        return;
      }

      try {
        const fallbackEnvMachineId = resolveEffectiveMachineId(null, import.meta.env.VITE_MACHINE_ID);
        const queryMachineId = hasMachineParam ? machineParam.trim() : fallbackEnvMachineId;
        const verifyQuery = new URLSearchParams({ kiosk: kioskParam });
        if (queryMachineId) {
          verifyQuery.set('machine_id', queryMachineId);
        }

        const res = await fetch(`${API_BASE}/kiosk/verify?${verifyQuery.toString()}`, {
          cache: 'no-store'
        });
        if (!res.ok) {
          setKioskStatus('UNAUTHORIZED');
          return;
        }
        const data = await res.json();
        if (data && data.authorized === true && data.machine_id && data.token) {
          const verifiedMachineId = data.machine_id;
          setMachineId(verifiedMachineId);
          localStorage.setItem('machineId', verifiedMachineId);
          localStorage.setItem('kioskToken', data.token);
          setKioskStatus('AUTHORIZED');
          await refreshKioskData(data.token, verifiedMachineId);
        } else {
          setKioskStatus('UNAUTHORIZED');
        }
      } catch (err) {
        console.error('Kiosk verification failed:', err);
        setKioskStatus('UNAUTHORIZED');
      }
    }

    verifyKioskDevice();
  }, []);

  // Background polling, focus, visibility, and online resume sync
  useEffect(() => {
    if (kioskStatus !== 'AUTHORIZED' || !machineId) return undefined;

    const triggerSyncIfIdle = () => {
      if (SYNC_PAUSED_SCREENS.includes(screenRef.current)) return;
      refreshKioskData(undefined, machineId);
    };

    const intervalId = setInterval(triggerSyncIfIdle, KIOSK_POLL_INTERVAL_MS);
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        triggerSyncIfIdle();
      }
    };

    window.addEventListener('focus', triggerSyncIfIdle);
    window.addEventListener('online', triggerSyncIfIdle);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      clearInterval(intervalId);
      window.removeEventListener('focus', triggerSyncIfIdle);
      window.removeEventListener('online', triggerSyncIfIdle);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [kioskStatus, machineId, refreshKioskData]);

  // Transition handlers
  const handleStartOrder = () => {
    refreshKioskData(undefined, machineId);
    setScreen('SELECTION');
  };

  const handleSelectCoffee = (coffee) => {
    setSelectedCoffee(coffee);
    setScreen('SUMMARY');
  };

  const handleConfirmOrder = async (details) => {
    const token = localStorage.getItem('kioskToken') || '';
    const activeMachineId = machineId || localStorage.getItem('machineId');
    const idMap = { classic: 1, vanilla: 2, hazelnut: 3, irish: 4, mocha: 5 };

    if (!activeMachineId) {
      alert('Machine identity is not verified. Unable to place order.');
      return;
    }
    
    try {
      const res = await fetch(`${API_BASE}/orders/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          product_id: idMap[selectedCoffee.id],
          amount: details.price,
          machine_id: activeMachineId,
          extra_sugar: true,
          base: details.base
        })
      });
      
      const data = await res.json();
      if (data.status === 'success') {
        setOrderDetails({ 
          ...details, 
          dbId: data.data.id,
          machine_id: data.data.machine_id || activeMachineId,
          razorpay_order_id: data.data.razorpay_order_id,
          razorpay_key: data.data.razorpay_key
        });
        setScreen('PAYMENT');
      } else {
        await refreshKioskData(token, activeMachineId);
        const msg = data.message || 'Failed to place order. Depleted ingredients!';
        if (
          msg.toLowerCase().includes('unavailable') ||
          msg.toLowerCase().includes('depleted') ||
          msg.toLowerCase().includes('invalid order amount')
        ) {
          setSelectedCoffee(null);
          setScreen('SELECTION');
        }
        alert(msg);
      }
    } catch (e) {
      console.error('Checkout creation failed:', e);
    }
  };

  const handlePaymentSuccess = async () => {
    const token = localStorage.getItem('kioskToken') || '';
    try {
      await fetch(`${API_BASE}/orders/${orderDetails.dbId}/status`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ status: 'COMPLETED' })
      });
      setScreen('SUCCESS');
    } catch (e) {
      console.error('Update status to COMPLETED failed:', e);
    }
  };

  const handleFinishOrder = async () => {
    // Reset and return
    setSelectedCoffee(null);
    setOrderDetails(null);
    const token = localStorage.getItem('kioskToken') || '';
    await refreshKioskData(token, machineId);
    setScreen('WELCOME');
  };

  const handleCancelOrder = async () => {
    const token = localStorage.getItem('kioskToken') || '';
    try {
      if (orderDetails && orderDetails.dbId) {
        await fetch(`${API_BASE}/orders/${orderDetails.dbId}/status`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({ status: 'CANCELLED' })
        });
      }
    } catch (e) {
      console.error('Cancel order failed:', e);
    }
    setSelectedCoffee(null);
    setOrderDetails(null);
    setScreen('SELECTION');
  };

  // Refill ingredients helper
  const handleRefillInventory = async (key) => {
    const token = localStorage.getItem('adminToken') || '';
    const activeMachineId = machineId || localStorage.getItem('machineId');
    if (!activeMachineId) return;
    try {
      await fetch(`${API_BASE}/machines/${encodeURIComponent(activeMachineId)}/refill`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ ingredient: key })
      });
      await refreshAdminData(token, activeMachineId);
    } catch (error) {
      console.error('Inventory refill failed:', error);
    }
  };

  // Pricing Update helper
  const handleUpdatePrices = async (tempPrices) => {
    const token = localStorage.getItem('adminToken') || '';
    try {
      // Classic price update
      await fetch(`${API_BASE}/products/1/price`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ price: tempPrices.classic })
      });
      
      // Vanilla price update
      await fetch(`${API_BASE}/products/2/price`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ price: tempPrices.vanilla })
      });

      // Hazelnut price update
      await fetch(`${API_BASE}/products/3/price`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ price: tempPrices.hazelnut })
      });

      // Irish price update
      await fetch(`${API_BASE}/products/4/price`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ price: tempPrices.irish })
      });

      // Mocha price update
      await fetch(`${API_BASE}/products/5/price`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ price: tempPrices.mocha })
      });

      await refreshAdminData(token, machineId);
    } catch (e) {
      console.error('Update prices failed:', e);
    }
  };

  // Toggle Maintenance helper
  const handleToggleMaintenance = async () => {
    const token = localStorage.getItem('adminToken') || '';
    const activeMachineId = machineId || localStorage.getItem('machineId');
    if (!activeMachineId) return;
    const newStatus = maintenanceMode ? 'online' : 'maintenance';
    try {
      await fetch(`${API_BASE}/machines/${encodeURIComponent(activeMachineId)}/status`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ status: newStatus })
      });
      await refreshAdminData(token, activeMachineId);
    } catch (error) {
      console.error('Toggle maintenance failed:', error);
    }
  };

  // Hidden admin credentials triggers
  const handleTriggerAdmin = () => {
    setScreen('PASSCODE');
  };

  const handleAdminSuccess = async (passcode = '1234') => {
    const kioskToken = localStorage.getItem('kioskToken') || '';
    const activeMachineId = machineId || localStorage.getItem('machineId');
    try {
      const res = await fetch(`${API_BASE}/auth/kiosk-admin`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${kioskToken}`
        },
        body: JSON.stringify({ passcode: String(passcode), machine_id: activeMachineId })
      });
      const data = await res.json();
      if (data.status === 'success') {
        localStorage.setItem('adminToken', data.token);
        await refreshAdminData(data.token, activeMachineId);
        setScreen('ADMIN');
      }
    } catch (error) {
      console.error('Admin login failed:', error);
    }
  };

  const handleAdminCancel = () => {
    setSelectedCoffee(null);
    setScreen('WELCOME');
  };

  // Handle triple-tap on maintenance screen logo to unlock/exit
  const [maintTaps, setMaintTaps] = useState(0);
  const handleMaintLogoClick = () => {
    const nextTaps = maintTaps + 1;
    setMaintTaps(nextTaps);
    
    // reset taps count timer
    const timer = setTimeout(() => setMaintTaps(0), 1000);
    
    if (nextTaps >= 3) {
      setMaintTaps(0);
      clearTimeout(timer);
      setScreen('PASSCODE');
    }
  };

  if (kioskStatus === 'VERIFYING') {
    return (
      <div className="flex flex-col items-center justify-center h-full w-full bg-[#FAF6F0] text-coffee p-8 select-none">
        <Loader2 className="w-12 h-12 text-gold animate-spin mb-4" />
        <p className="font-sans font-semibold text-lg text-coffee-dark tracking-wide">
          Verifying kiosk...
        </p>
      </div>
    );
  }

  if (kioskStatus === 'UNAUTHORIZED') {
    return (
      <div className="flex flex-col items-center justify-center h-full w-full bg-[#FAF6F0] text-coffee p-8 text-center select-none">
        <div className="p-5 bg-red-100 border-2 border-red-300 rounded-full mb-6 shadow-sm">
          <ShieldAlert className="w-16 h-16 text-red-600" />
        </div>
        <h1 className="font-sans font-extrabold text-3xl md:text-4xl text-coffee-dark tracking-tight mb-4">
          Unauthorized Device
        </h1>
        <p className="font-sans text-base md:text-lg text-coffee-light max-w-md leading-relaxed">
          This ordering system is available only on authorized CAFFIX vending machines.
        </p>

      </div>
    );
  }

  return (

    <div className="flex flex-col h-full w-full bg-[#FAF6F0] overflow-hidden select-none">
      {/* Show header on normal customer screens, hide in Welcome and Admin panels */}
      {screen !== 'WELCOME' && screen !== 'ADMIN' && screen !== 'PASSCODE' && !maintenanceMode && (
        <KioskHeader onAdminAccess={handleTriggerAdmin} />
      )}

      {/* Main Viewport Router */}
      <main className="flex-grow w-full relative overflow-hidden">
        {/* Render maintenance page blockade if active and not in admin dashboard */}
        {maintenanceMode && screen !== 'ADMIN' && screen !== 'PASSCODE' ? (
          <div className="relative w-full h-full flex flex-col justify-center items-center p-8 bg-coffee-dark text-cream-light text-center">
            {/* Clickable wrench icon for admin trigger override */}
            <div 
              onClick={handleMaintLogoClick}
              className="p-6 bg-coffee border-2 border-gold/45 rounded-full shadow-lg mb-6 animate-pulse cursor-pointer select-none"
            >
              <Wrench className="w-16 h-16 text-gold" />
            </div>
            <h1 className="font-sans font-extrabold text-4xl text-gold tracking-tight">
              Under Maintenance
            </h1>
            <p className="text-sm text-cream/70 font-semibold mt-3 max-w-sm leading-relaxed">
              We are currently performing routine diagnostics and refilling ingredients. CAFFIX will be back online shortly!
            </p>
            <span className="text-[10px] text-cream/30 uppercase tracking-widest font-bold mt-12">
              CAFFIX Smart Coffee Systems
            </span>
          </div>
        ) : (
          <LayoutGroup>
            {/* Welcome Screen Wrapper */}
            <div
              className="absolute inset-0 transition-opacity duration-300"
              style={{
                opacity: screen === 'WELCOME' ? 1 : 0,
                pointerEvents: screen === 'WELCOME' ? 'auto' : 'none',
                zIndex: screen === 'WELCOME' ? 10 : 0,
                display: (screen === 'WELCOME' || screen === 'SELECTION' || screen === 'SUMMARY') ? 'block' : 'none'
              }}
            >
              <WelcomeScreen 
                key="welcome"
                onStart={handleStartOrder} 
                onAdminAccess={handleTriggerAdmin}
              />
            </div>
            
            {/* Flavor Selection Screen Wrapper (Always mounted/preloaded) */}
            <div
              className="absolute inset-0 transition-opacity duration-300"
              style={{
                opacity: (screen === 'SELECTION' || screen === 'SUMMARY') ? 1 : 0,
                pointerEvents: (screen === 'SELECTION' || screen === 'SUMMARY') ? 'auto' : 'none',
                zIndex: (screen === 'SELECTION' || screen === 'SUMMARY') ? 20 : 0,
                display: (screen === 'WELCOME' || screen === 'SELECTION' || screen === 'SUMMARY') ? 'block' : 'none'
              }}
            >
              <FlavorAndCustomizationView
                key="flavor_and_summary"
                initialStep={screen}
                prices={prices}
                availability={availability}
                inventory={inventory}
                selectedCoffee={selectedCoffee}
                onSelectCoffee={(coffee) => setSelectedCoffee(coffee)}
                onConfirmOrder={handleConfirmOrder}
                onBackToWelcome={() => {
                  setSelectedCoffee(null);
                  setScreen('WELCOME');
                }}
              />
            </div>

            <AnimatePresence mode="popLayout">
              {screen === 'PAYMENT' && (
                <PaymentScreen 
                  key="payment"
                  orderDetails={orderDetails} 
                  onPaymentSuccess={handlePaymentSuccess} 
                  onPaymentFailed={() => setScreen('PAYMENT_FAILED')}
                  onCancel={handleCancelOrder} 
                />
              )}
              {screen === 'PAYMENT_FAILED' && (
                <PaymentFailedScreen 
                  key="payment_failed"
                  orderDetails={orderDetails} 
                  onRetry={() => setScreen('PAYMENT')}
                  onCancel={handleCancelOrder}
                />
              )}

              {screen === 'SUCCESS' && (
                <SuccessScreen key="success" onFinished={handleFinishOrder} />
              )}
              {screen === 'PASSCODE' && (
                <AdminPasscode 
                  key="passcode"
                  onSuccess={handleAdminSuccess} 
                  onCancel={handleAdminCancel} 
                />
              )}
              {screen === 'ADMIN' && (
                <AdminDashboard
                  key="admin"
                  prices={prices}
                  onUpdatePrices={handleUpdatePrices}
                  maintenanceMode={maintenanceMode}
                  onToggleMaintenance={handleToggleMaintenance}
                  orderHistory={orderHistory}
                  inventory={inventory}
                  onRefillInventory={handleRefillInventory}
                  onExit={handleFinishOrder}
                />
              )}
            </AnimatePresence>
          </LayoutGroup>
        )}
      </main>
    </div>
  );
}
