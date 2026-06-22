import React, { useState, useEffect } from 'react';
import KioskHeader from './components/KioskHeader';
import WelcomeScreen from './components/WelcomeScreen';
import SelectionScreen from './components/SelectionScreen';
import SummaryScreen from './components/SummaryScreen';
import PaymentScreen from './components/PaymentScreen';
import PreparingScreen from './components/PreparingScreen';
import SuccessScreen from './components/SuccessScreen';
import AdminPasscode from './components/AdminPasscode';
import AdminDashboard from './components/AdminDashboard';
import PaymentFailedScreen from './components/PaymentFailedScreen';
import { Wrench } from 'lucide-react';

const API_BASE = import.meta.env.VITE_API_URL || (
  window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.port === '8000' || window.location.port === '5173'
    ? 'http://localhost:5000/api'
    : '/api'
);

export default function App() {
  const [screen, setScreen] = useState('WELCOME');
  const [selectedCoffee, setSelectedCoffee] = useState(null);
  const [orderDetails, setOrderDetails] = useState(null);
  
  // Admin & Settings States
  const [prices, setPrices] = useState({ classic: 100, vanilla: 100, hazelnut: 100 });
  const [maintenanceMode, setMaintenanceMode] = useState(false);
  const [inventory, setInventory] = useState({
    water: 100,
    coffee: 100,
    milk: 100,
    vanilla: 100,
    hazelnut: 100
  });

  // Orders Log history
  const [orderHistory, setOrderHistory] = useState([]);

  // Kiosk Startup: Silently login as kiosk to verify credentials and pull prices
  const refreshKioskData = async (token) => {
    try {
      // 1. Get products list
      const prodRes = await fetch(`${API_BASE}/products`);
      const prodData = await prodRes.json();
      if (prodData.status === 'success') {
        const prodList = prodData.data;
        const priceMap = {};
        prodList.forEach((p) => {
          if (p.id === 1) priceMap.classic = p.price;
          if (p.id === 2) priceMap.vanilla = p.price;
          if (p.id === 3) priceMap.hazelnut = p.price;
        });
        setPrices(priceMap);
      }

      // 2. Get machine status/levels
      const machineRes = await fetch(`${API_BASE}/machine-status`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const machineData = await machineRes.json();
      if (machineData.status === 'success') {
        const m = machineData.data;
        setMaintenanceMode(m.status === 'maintenance');
        setInventory({
          water: m.inventory.water,
          coffee: m.inventory.coffee,
          milk: m.inventory.milk,
          vanilla: m.inventory.vanilla,
          hazelnut: m.inventory.hazelnut
        });
      }
    } catch (error) {
      console.error('Kiosk data refresh failed:', error);
    }
  };

  const refreshAdminData = async (token) => {
    try {
      // 1. Get orders history
      const ordersRes = await fetch(`${API_BASE}/orders`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const ordersData = await ordersRes.json();
      if (ordersData.status === 'success') {
        const formatted = ordersData.data.map((o) => ({
          id: o.id,
          name: o.product_name || (o.product_id === 1 ? 'Classic Coffee' : o.product_id === 2 ? 'Vanilla Coffee' : 'Hazelnut Coffee'),
          size: 'Medium',
          price: o.amount,
          time: `${new Date(o.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}, ${new Date(o.created_at).toLocaleDateString()}`
        }));
        setOrderHistory(formatted);
      }

      // 2. Refresh machine levels
      await refreshKioskData(token);
    } catch (error) {
      console.error('Admin data refresh failed:', error);
    }
  };

  useEffect(() => {
    async function initKiosk() {
      try {
        const res = await fetch(`${API_BASE}/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'kiosk01@caffix.com', password: 'kiosk123' })
        });
        const data = await res.json();
        if (data.status === 'success') {
          localStorage.setItem('kioskToken', data.token);
          await refreshKioskData(data.token);
        }
      } catch (e) {
        console.error('Kiosk silent login failed:', e);
      }
    }
    initKiosk();
  }, []);

  // Transition handlers
  const handleStartOrder = () => {
    setScreen('SELECTION');
  };

  const handleSelectCoffee = (coffee) => {
    setSelectedCoffee(coffee);
    setScreen('SUMMARY');
  };

  const handleConfirmOrder = async (details) => {
    const token = localStorage.getItem('kioskToken') || '';
    const idMap = { classic: 1, vanilla: 2, hazelnut: 3 };
    
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
          machine_id: 'CFX-MC-01'
        })
      });
      
      const data = await res.json();
      if (data.status === 'success') {
        setOrderDetails({ 
          ...details, 
          dbId: data.data.id,
          razorpay_order_id: data.data.razorpay_order_id,
          razorpay_key: data.data.razorpay_key
        });
        setScreen('PAYMENT');
      } else {
        alert(data.message || 'Failed to place order. Depleted ingredients!');
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
        body: JSON.stringify({ status: 'PAID' })
      });
      setScreen('PREPARING');
    } catch (e) {
      console.error('Update status to PAID failed:', e);
    }
  };

  const handleBrewComplete = async () => {
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
    await refreshKioskData(token);
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
    try {
      await fetch(`${API_BASE}/machines/CFX-MC-01/refill`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ ingredient: key })
      });
      await refreshAdminData(token);
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

      await refreshAdminData(token);
    } catch (e) {
      console.error('Update prices failed:', e);
    }
  };

  // Toggle Maintenance helper
  const handleToggleMaintenance = async () => {
    const token = localStorage.getItem('adminToken') || '';
    const newStatus = maintenanceMode ? 'online' : 'maintenance';
    try {
      await fetch(`${API_BASE}/machines/CFX-MC-01/status`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ status: newStatus })
      });
      await refreshAdminData(token);
    } catch (error) {
      console.error('Toggle maintenance failed:', error);
    }
  };

  // Hidden admin credentials triggers
  const handleTriggerAdmin = () => {
    setScreen('PASSCODE');
  };

  const handleAdminSuccess = async () => {
    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'admin@caffix.com', password: 'admin123' })
      });
      const data = await res.json();
      if (data.status === 'success') {
        localStorage.setItem('adminToken', data.token);
        await refreshAdminData(data.token);
        setScreen('ADMIN');
      }
    } catch (error) {
      console.error('Admin login failed:', error);
    }
  };

  const handleAdminCancel = () => {
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
          <>
            {screen === 'WELCOME' && (
              <WelcomeScreen 
                onStart={handleStartOrder} 
                onAdminAccess={handleTriggerAdmin}
              />
            )}
            {screen === 'SELECTION' && (
              <SelectionScreen 
                onSelect={handleSelectCoffee} 
                onBack={() => setScreen('WELCOME')}
                prices={prices}
              />
            )}
            {screen === 'SUMMARY' && (
              <SummaryScreen 
                selectedCoffee={selectedCoffee} 
                onConfirm={handleConfirmOrder} 
                onBack={() => setScreen('SELECTION')} 
              />
            )}
            {screen === 'PAYMENT' && (
              <PaymentScreen 
                orderDetails={orderDetails} 
                onPaymentSuccess={handlePaymentSuccess} 
                onPaymentFailed={() => setScreen('PAYMENT_FAILED')}
                onCancel={handleCancelOrder} 
              />
            )}
            {screen === 'PAYMENT_FAILED' && (
              <PaymentFailedScreen 
                orderDetails={orderDetails} 
                onRetry={() => setScreen('PAYMENT')}
                onCancel={handleCancelOrder}
              />
            )}
            {screen === 'PREPARING' && (
              <PreparingScreen onComplete={handleBrewComplete} />
            )}
            {screen === 'SUCCESS' && (
              <SuccessScreen onFinished={handleFinishOrder} />
            )}
            {screen === 'PASSCODE' && (
              <AdminPasscode 
                onSuccess={handleAdminSuccess} 
                onCancel={handleAdminCancel} 
              />
            )}
            {screen === 'ADMIN' && (
              <AdminDashboard
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
          </>
        )}
      </main>
    </div>
  );
}
