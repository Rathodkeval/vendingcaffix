import React, { useState, useEffect, useCallback, useRef } from 'react';
import { RefreshCw, AlertCircle, KeyRound, X, CheckCircle2 } from 'lucide-react';
import {
  ownerApi,
  getStoredToken,
  setStoredToken,
  clearStoredToken,
  setOnSessionExpired
} from './services/api';
import Sidebar from './components/Sidebar';
import AuthPage from './pages/AuthPage';
import OverviewPage from './pages/OverviewPage';
import { getKolkataDateString } from './utils/formatters';
import MachinesPage from './pages/MachinesPage';
import MachineDetailsPage from './pages/MachineDetailsPage';
import ProductsPricingPage from './pages/ProductsPricingPage';
import OrdersPage from './pages/OrdersPage';
import SalesReportsPage from './pages/SalesReportsPage';

const ORDERS_PAGE_SIZE = 100;
const PORTAL_POLL_INTERVAL_MS = 30000;

export default function App() {
  const [authChecking, setAuthChecking] = useState(true);
  const [user, setUser] = useState(null);
  const [sessionNotice, setSessionNotice] = useState('');
  const [activeTab, setActiveTab] = useState('overview');

  const [machines, setMachines] = useState([]);
  const [orders, setOrders] = useState([]);
  const [ordersPagination, setOrdersPagination] = useState({ hasMore: false, nextCursor: null });
  const [loadingMoreOrders, setLoadingMoreOrders] = useState(false);
  const [analyticsOverview, setAnalyticsOverview] = useState({ today: null, all: null });
  const [selectedMachineId, setSelectedMachineId] = useState('');
  const [loadingData, setLoadingData] = useState(false);
  const [globalError, setGlobalError] = useState('');
  const pollTickRef = useRef(0);
  const lastLiveSyncAtRef = useRef(0);

  // Change Password Modal State
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passwordStatus, setPasswordStatus] = useState({ error: '', success: '', loading: false });

  const loadDashboardData = useCallback(async (silent = false, options = {}) => {
    const token = getStoredToken();
    if (!token) return;
    if (!silent) setLoadingData(true);
    setGlobalError('');

    const isFullSync = !silent || Boolean(options.includeHeavy);
    const includeLiveOrdersAndToday = isFullSync || options.includeOrders !== false;

    try {
      const todayStr = getKolkataDateString();

      if (isFullSync) {
        const results = await Promise.allSettled([
          ownerApi.getMe(token),
          ownerApi.getMachines(token),
          ownerApi.getOrders({ limit: ORDERS_PAGE_SIZE }, token),
          ownerApi.getAnalyticsOverview({ start_date: todayStr, end_date: todayStr }, token),
          ownerApi.getAnalyticsOverview({}, token)
        ]);

        const meResult = results[0];
        const machinesResult = results[1];
        const ordersResult = results[2];
        const todayAnalyticsResult = results[3];
        const allAnalyticsResult = results[4];

        if (meResult.status === 'rejected') {
          throw meResult.reason;
        }

        const profile = meResult.value?.data;
        if (!profile || profile.role !== 'owner') {
          clearStoredToken();
          setUser(null);
          setSessionNotice(
            profile?.role === 'admin'
              ? 'Administrator accounts cannot access the Machine Owner Dashboard. Please sign in through the CAFFIX Admin Dashboard.'
              : 'Your account does not have permission to access the Owner Portal.'
          );
          return;
        }

        setUser(profile);

        if (machinesResult.status === 'fulfilled') {
          const machineList = machinesResult.value?.data || [];
          setMachines(machineList);
          setSelectedMachineId((prev) => {
            if (prev && machineList.some((m) => m.id === prev)) {
              return prev;
            }
            return machineList[0]?.id || '';
          });
        } else {
          setGlobalError(machinesResult.reason?.message || 'Failed to load machines fleet.');
        }

        if (ordersResult.status === 'fulfilled') {
          setOrders(ordersResult.value?.data || []);
          setOrdersPagination({
            hasMore: Boolean(ordersResult.value?.pagination?.has_more),
            nextCursor: ordersResult.value?.pagination?.next_cursor || null
          });
        } else {
          setOrders([]);
          setOrdersPagination({ hasMore: false, nextCursor: null });
          if (machinesResult.status === 'fulfilled') {
            setGlobalError(ordersResult.reason?.message || 'Unable to synchronize order history.');
          }
        }

        setAnalyticsOverview({
          today: todayAnalyticsResult.status === 'fulfilled' ? (todayAnalyticsResult.value?.data || null) : null,
          all: allAnalyticsResult.status === 'fulfilled' ? (allAnalyticsResult.value?.data || null) : null
        });
      } else {
        // Lightweight background poll: machines (30s heartbeat/connectivity), plus bounded recent
        // orders & today's KPIs on every 60s cycle; skips auth/me and all-time scans.
        const requests = [ownerApi.getMachines(token)];
        if (includeLiveOrdersAndToday) {
          requests.push(ownerApi.getOrders({ limit: ORDERS_PAGE_SIZE }, token));
          requests.push(ownerApi.getAnalyticsOverview({ start_date: todayStr, end_date: todayStr }, token));
        }

        const results = await Promise.allSettled(requests);
        const machinesResult = results[0];

        if (machinesResult.status === 'fulfilled') {
          const machineList = machinesResult.value?.data || [];
          setMachines(machineList);
          setSelectedMachineId((prev) => {
            if (prev && machineList.some((m) => m.id === prev)) {
              return prev;
            }
            return machineList[0]?.id || '';
          });
        }

        if (includeLiveOrdersAndToday) {
          const ordersResult = results[1];
          const todayAnalyticsResult = results[2];

          if (ordersResult?.status === 'fulfilled') {
            const freshPage = ordersResult.value?.data || [];
            setOrders((prev) => {
              if (!prev || prev.length <= ORDERS_PAGE_SIZE) {
                return freshPage;
              }
              const freshIds = new Set(freshPage.map((o) => o.id));
              return [...freshPage, ...prev.filter((o) => !freshIds.has(o.id))];
            });
          }

          if (todayAnalyticsResult?.status === 'fulfilled') {
            setAnalyticsOverview((prev) => ({
              ...prev,
              today: todayAnalyticsResult.value?.data || prev.today
            }));
          }
        }
      }
      lastLiveSyncAtRef.current = Date.now();
    } catch (err) {
      if (err.status !== 401) {
        setGlobalError(err.message || 'Unable to synchronize dashboard data.');
      }
    } finally {
      if (!silent) setLoadingData(false);
    }
  }, []);

  const handleLoadMoreOrders = useCallback(async () => {
    const token = getStoredToken();
    if (!token || !ordersPagination.hasMore || !ordersPagination.nextCursor || loadingMoreOrders) {
      return;
    }
    setLoadingMoreOrders(true);
    try {
      const res = await ownerApi.getOrders(
        { limit: ORDERS_PAGE_SIZE, cursor: ordersPagination.nextCursor },
        token
      );
      const olderOrders = res?.data || [];
      setOrders((prev) => {
        const existingIds = new Set(prev.map((o) => o.id));
        return [...prev, ...olderOrders.filter((o) => !existingIds.has(o.id))];
      });
      setOrdersPagination({
        hasMore: Boolean(res?.pagination?.has_more),
        nextCursor: res?.pagination?.next_cursor || null
      });
    } catch (err) {
      setGlobalError(err.message || 'Unable to load older orders.');
    } finally {
      setLoadingMoreOrders(false);
    }
  }, [loadingMoreOrders, ordersPagination.hasMore, ordersPagination.nextCursor]);

  useEffect(() => {
    setOnSessionExpired((msg) => {
      setUser(null);
      setMachines([]);
      setOrders([]);
      setSessionNotice(msg || 'Your session has expired. Please sign in again.');
    });

    const token = getStoredToken();
    if (!token) {
      setAuthChecking(false);
      return;
    }

    loadDashboardData(false).finally(() => {
      setAuthChecking(false);
    });
  }, [loadDashboardData]);

  // Poll every 30s for live machine connectivity (only while tab is visible);
  // refresh bounded recent orders & today's KPIs on every 60s cycle.
  useEffect(() => {
    if (!user) return undefined;
    const interval = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      pollTickRef.current += 1;
      loadDashboardData(true, { includeOrders: pollTickRef.current % 2 === 0 });
    }, PORTAL_POLL_INTERVAL_MS);

    const handleVisibilityChange = () => {
      if (
        document.visibilityState === 'visible' &&
        Date.now() - lastLiveSyncAtRef.current >= 15000
      ) {
        loadDashboardData(true, { includeOrders: true });
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [user, loadDashboardData]);

  const handleAuthenticated = async (jwtToken, userData, remember = true) => {
    setStoredToken(jwtToken, remember);
    setSessionNotice('');
    setUser(userData);
    await loadDashboardData(false);
  };

  const handleLogout = () => {
    clearStoredToken();
    setUser(null);
    setMachines([]);
    setOrders([]);
    setAnalyticsOverview({ today: null, all: null });
    setActiveTab('overview');
  };

  const handleToggleMachineMode = async (machineId, desiredMode) => {
    setGlobalError('');
    try {
      await ownerApi.updateMachineMode(machineId, desiredMode);
      await loadDashboardData(true);
    } catch (err) {
      setGlobalError(err.message || `Failed to update mode for ${machineId}`);
      throw err;
    }
  };

  const handleSelectMachineForDetails = (machineId) => {
    setSelectedMachineId(machineId);
    setActiveTab('machine-details');
  };

  const handleSelectMachineForPricing = (machineId) => {
    setSelectedMachineId(machineId);
    setActiveTab('pricing');
  };

  const handleChangePassword = async (e) => {
    e.preventDefault();
    setPasswordStatus({ error: '', success: '', loading: true });
    try {
      await ownerApi.changePassword({ currentPassword, newPassword });
      setPasswordStatus({
        error: '',
        success: 'Password updated successfully.',
        loading: false
      });
      setCurrentPassword('');
      setNewPassword('');
      setTimeout(() => {
        setPasswordModalOpen(false);
        setPasswordStatus({ error: '', success: '', loading: false });
      }, 1500);
    } catch (err) {
      setPasswordStatus({
        error: err.message || 'Failed to change password.',
        success: '',
        loading: false
      });
    }
  };

  if (authChecking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#FAF6F0]">
        <div className="flex items-center gap-3 px-6 py-4 rounded-2xl bg-white border border-[#EED9C4] shadow-sm">
          <RefreshCw className="w-5 h-5 text-[#4E3629] animate-spin" />
          <span className="text-sm font-semibold text-[#2C1E17]">
            Verifying CAFFIX Owner Session...
          </span>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <AuthPage
        onAuthenticated={handleAuthenticated}
        sessionNotice={sessionNotice}
      />
    );
  }

  const pageTitles = {
    overview: 'Fleet & Revenue Overview',
    machines: 'My Assigned Machines',
    'machine-details': 'Machine Details & Telemetry',
    pricing: 'Products & Machine-Specific Pricing',
    orders: 'Order History',
    reports: 'Sales & Revenue Analytics'
  };

  return (
    <div className="min-h-screen bg-[#FAF6F0] flex flex-col lg:flex-row">
      <Sidebar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        user={user}
        machinesCount={machines.length}
        onLogout={handleLogout}
        onRefresh={() => loadDashboardData(false)}
        refreshing={loadingData}
        onOpenPasswordModal={() => {
          setPasswordStatus({ error: '', success: '', loading: false });
          setPasswordModalOpen(true);
        }}
      />

      {/* Main Content Area */}
      <div className="flex-1 lg:pl-68 flex flex-col min-h-screen">
        {/* Desktop Top Header */}
        <header className="hidden lg:flex items-center justify-between px-8 py-5 bg-white/80 backdrop-blur-xs border-b border-[#EED9C4] sticky top-0 z-20">
          <div>
            <h1 className="font-display text-2xl font-bold text-[#2C1E17]">
              {pageTitles[activeTab] || 'CAFFIX Owner Portal'}
            </h1>
            <p className="text-xs text-slate-500 mt-0.5">
              Signed in as <span className="font-semibold text-[#4E3629]">{user.name}</span> (
              {user.email}) • {machines.length} machine(s) accessible
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => loadDashboardData(false)}
              disabled={loadingData}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold bg-[#FAF6F0] hover:bg-[#EED9C4] text-[#4E3629] border border-[#EED9C4] transition-colors cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loadingData ? 'animate-spin' : ''}`} />
              {loadingData ? 'Syncing...' : 'Refresh Live Data'}
            </button>
          </div>
        </header>

        {/* Page Body */}
        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl w-full mx-auto space-y-6">
          {globalError && (
            <div className="p-4 rounded-xl bg-red-50 border border-red-200 text-red-700 text-xs font-semibold flex items-center justify-between gap-3">
              <span className="flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                {globalError}
              </span>
              <button
                type="button"
                onClick={() => setGlobalError('')}
                className="text-red-500 hover:text-red-700"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {activeTab === 'overview' && (
            <OverviewPage
              machines={machines}
              orders={orders}
              analyticsOverview={analyticsOverview}
              onSelectMachineForDetails={handleSelectMachineForDetails}
              onSelectMachineForPricing={handleSelectMachineForPricing}
              onNavigateTab={setActiveTab}
            />
          )}

          {activeTab === 'machines' && (
            <MachinesPage
              machines={machines}
              onToggleMode={handleToggleMachineMode}
              onSelectMachineForDetails={handleSelectMachineForDetails}
              onSelectMachineForPricing={handleSelectMachineForPricing}
            />
          )}

          {activeTab === 'machine-details' && (
            <MachineDetailsPage
              machines={machines}
              selectedMachineId={selectedMachineId}
              onSelectMachineId={setSelectedMachineId}
              onToggleMode={handleToggleMachineMode}
              onNavigateToPricing={handleSelectMachineForPricing}
            />
          )}

          {activeTab === 'pricing' && (
            <ProductsPricingPage
              machines={machines}
              selectedMachineId={selectedMachineId}
              onSelectMachineId={setSelectedMachineId}
            />
          )}

          {activeTab === 'orders' && (
            <OrdersPage
              orders={orders}
              machines={machines}
              hasMoreOrders={ordersPagination.hasMore}
              loadingMoreOrders={loadingMoreOrders}
              onLoadMoreOrders={handleLoadMoreOrders}
            />
          )}

          {activeTab === 'reports' && (
            <SalesReportsPage orders={orders} machines={machines} />
          )}
        </main>
      </div>

      {/* Change Password Modal */}
      {passwordModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4">
          <div className="bg-white rounded-2xl border border-[#EED9C4] shadow-xl max-w-md w-full p-6">
            <div className="flex items-center justify-between pb-3 border-b border-[#EED9C4]">
              <h3 className="font-display text-lg font-bold text-[#2C1E17] flex items-center gap-2">
                <KeyRound className="w-4 h-4 text-[#4E3629]" />
                Change Account Password
              </h3>
              <button
                type="button"
                onClick={() => setPasswordModalOpen(false)}
                className="text-slate-400 hover:text-slate-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleChangePassword} className="mt-4 space-y-4">
              {passwordStatus.error && (
                <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-xs font-medium">
                  {passwordStatus.error}
                </div>
              )}
              {passwordStatus.success && (
                <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-medium flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4" />
                  {passwordStatus.success}
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-[#4E3629] mb-1">
                  Current Password
                </label>
                <input
                  type="password"
                  required
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  className="w-full px-3.5 py-2 rounded-xl border border-[#EED9C4] bg-[#FAF6F0]/50 text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#4E3629] mb-1">
                  New Password (min 8 characters)
                </label>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full px-3.5 py-2 rounded-xl border border-[#EED9C4] bg-[#FAF6F0]/50 text-sm"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setPasswordModalOpen(false)}
                  className="px-4 py-2 rounded-xl text-xs font-semibold bg-slate-100 text-slate-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={passwordStatus.loading}
                  className="px-4 py-2 rounded-xl text-xs font-semibold bg-[#4E3629] text-white"
                >
                  {passwordStatus.loading ? 'Updating...' : 'Update Password'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

