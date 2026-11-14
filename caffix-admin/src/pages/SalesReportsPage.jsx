import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  BarChart3,
  IndianRupee,
  ShoppingBag,
  TrendingUp,
  Cpu,
  Coffee,
  AlertTriangle,
  AlertCircle,
  RefreshCw,
  Package,
  Layers,
  RotateCcw,
  CheckCircle2,
  Clock,
  Wrench,
  Calendar
} from 'lucide-react';
import { adminApi, getStoredToken } from '../services/api';
import {
  formatINR,
  formatSignedINR,
  formatDateTime,
  getKolkataDateString,
  getKolkataDaysAgo,
  getKolkataMonthStart,
  validateDateRange
} from '../utils/formatters';
import { SoftwareEstimatedBadge, UntrackedBadge } from '../components/StatusBadges';

function formatSyncTime(date) {
  if (!date) return 'Not yet synchronized';
  return (
    date.toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    }) + ' IST'
  );
}

function SectionError({ title, message, onRetry, retrying }) {
  return (
    <div className="p-4 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-2xs">
      <div className="flex items-start gap-2.5">
        <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
        <div>
          <div className="font-bold text-xs uppercase tracking-wide text-rose-900">
            {title}
          </div>
          <p className="text-xs text-rose-700 mt-0.5">
            {message || 'Unable to load section data from the analytics service.'}
          </p>
        </div>
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-white hover:bg-rose-100 text-rose-800 border border-rose-300 shadow-2xs transition-colors cursor-pointer shrink-0 self-start sm:self-auto"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${retrying ? 'animate-spin' : ''}`} />
          {retrying ? 'Retrying...' : 'Retry'}
        </button>
      )}
    </div>
  );
}

function SectionLoading({ label = 'Loading analytics data...' }) {
  return (
    <div className="py-10 flex flex-col items-center justify-center gap-2 text-slate-400">
      <RefreshCw className="w-5 h-5 animate-spin text-[#C9A66B]" />
      <span className="text-xs font-medium">{label}</span>
    </div>
  );
}

export default function SalesReportsPage({ machines = [] }) {
  // Preset filters: 'today' | '7days' | '30days' | 'month' | 'all' | 'custom'
  const [preset, setPreset] = useState('7days');
  const [machineFilter, setMachineFilter] = useState('ALL');
  const [customStart, setCustomStart] = useState(() => getKolkataDaysAgo(6));
  const [customEnd, setCustomEnd] = useState(() => getKolkataDateString());
  const [dateError, setDateError] = useState('');

  // Time-series interval: 'hour' | 'day' | 'week' | 'month'
  const [timeInterval, setTimeInterval] = useState('day');

  // Analytics API data state
  const [overview, setOverview] = useState(null);
  const [timeSeries, setTimeSeries] = useState([]);
  const [machineAnalytics, setMachineAnalytics] = useState([]);
  const [productAnalytics, setProductAnalytics] = useState([]);
  const [inventoryAnalytics, setInventoryAnalytics] = useState([]);
  const [refundsAnalytics, setRefundsAnalytics] = useState(null);

  // Section-specific loading and error states (W-1 Fix)
  const [sectionLoading, setSectionLoading] = useState({
    overview: true,
    timeSeries: true,
    machines: true,
    products: true,
    inventory: true,
    refunds: true
  });
  const [sectionErrors, setSectionErrors] = useState({
    overview: '',
    timeSeries: '',
    machines: '',
    products: '',
    inventory: '',
    refunds: ''
  });
  // Section-specific synchronization timestamps (A-2)
  const [sectionLastUpdated, setSectionLastUpdated] = useState({
    overview: null,
    timeSeries: null,
    machines: null,
    products: null,
    inventory: null,
    refunds: null
  });
  const [lastFullSync, setLastFullSync] = useState(null);

  // Monotonic request sequence IDs for concurrency protection (A-1)
  const requestIdRef = useRef(0);
  const sectionRequestIdsRef = useRef({
    overview: 0,
    timeSeries: 0,
    machines: 0,
    products: 0,
    inventory: 0,
    refunds: 0
  });
  const isMountedRef = useRef(true);

  // Filter context tracking to differentiate filter changes from manual refresh (C-1.2)
  const prevFilterContextRef = useRef(null);

  // Stale request protection
  const abortControllerRef = useRef(null);
  const sectionAbortControllersRef = useRef({});

  // Compute query parameters from active presets
  const queryParams = useMemo(() => {
    let start_date;
    let end_date;

    const todayStr = getKolkataDateString();

    if (preset === 'today') {
      start_date = todayStr;
      end_date = todayStr;
    } else if (preset === '7days') {
      start_date = getKolkataDaysAgo(6);
      end_date = todayStr;
    } else if (preset === '30days') {
      start_date = getKolkataDaysAgo(29);
      end_date = todayStr;
    } else if (preset === 'month') {
      start_date = getKolkataMonthStart();
      end_date = todayStr;
    } else if (preset === 'custom') {
      start_date = customStart;
      end_date = customEnd;
    }
    // 'all' leaves start_date and end_date undefined

    const params = {
      time_zone: 'Asia/Kolkata'
    };
    if (start_date) params.start_date = start_date;
    if (end_date) params.end_date = end_date;
    if (machineFilter && machineFilter !== 'ALL') {
      params.machine_id = machineFilter;
    }
    return params;
  }, [preset, machineFilter, customStart, customEnd]);

  // Section-specific retry action (calls only the affected endpoint without reloading others)
  const retrySection = useCallback(
    async (sectionKey) => {
      if (sectionAbortControllersRef.current[sectionKey]) {
        sectionAbortControllersRef.current[sectionKey].abort();
      }
      const controller = new AbortController();
      sectionAbortControllersRef.current[sectionKey] = controller;

      // Increment request identity for this specific section (A-1)
      const currentSectionId = (sectionRequestIdsRef.current[sectionKey] || 0) + 1;
      sectionRequestIdsRef.current[sectionKey] = currentSectionId;

      const isSectionObsolete = () =>
        !isMountedRef.current || sectionRequestIdsRef.current[sectionKey] !== currentSectionId;

      setSectionLoading((prev) => ({ ...prev, [sectionKey]: true }));
      setSectionErrors((prev) => ({ ...prev, [sectionKey]: '' }));

      const token = getStoredToken();
      const requestOptions = { token, signal: controller.signal };

      try {
        let resData = null;
        if (sectionKey === 'overview') {
          const res = await adminApi.getAnalyticsOverview(queryParams, requestOptions);
          resData = res?.data || null;
        } else if (sectionKey === 'timeSeries') {
          const res = await adminApi.getAnalyticsTimeSeries(
            { ...queryParams, interval: timeInterval },
            requestOptions
          );
          resData = res?.data || [];
        } else if (sectionKey === 'machines') {
          const res = await adminApi.getAnalyticsMachines(queryParams, requestOptions);
          resData = res?.data || [];
        } else if (sectionKey === 'products') {
          const res = await adminApi.getAnalyticsProducts(queryParams, requestOptions);
          resData = res?.data || [];
        } else if (sectionKey === 'inventory') {
          const res = await adminApi.getAnalyticsInventory(queryParams, requestOptions);
          resData = res?.data || [];
        } else if (sectionKey === 'refunds') {
          const res = await adminApi.getAnalyticsRefunds(queryParams, requestOptions);
          resData = res?.data || null;
        }

        // Before applying response to React state, confirm request ID is still current (A-1)
        if (isSectionObsolete()) return;

        if (sectionKey === 'overview') setOverview(resData);
        else if (sectionKey === 'timeSeries') setTimeSeries(resData);
        else if (sectionKey === 'machines') setMachineAnalytics(resData);
        else if (sectionKey === 'products') setProductAnalytics(resData);
        else if (sectionKey === 'inventory') setInventoryAnalytics(resData);
        else if (sectionKey === 'refunds') setRefundsAnalytics(resData);

        // A-2: Update ONLY this section's timestamp. Do NOT update lastFullSync!
        const now = new Date();
        setSectionLastUpdated((prev) => ({ ...prev, [sectionKey]: now }));
      } catch (err) {
        if (isSectionObsolete()) return;
        if (err?.name !== 'AbortError') {
          const msg = err?.message || `Failed to reload ${sectionKey} analytics`;
          setSectionErrors((prev) => ({ ...prev, [sectionKey]: msg }));
          // Clear stale data if retry failed
          if (sectionKey === 'overview') setOverview(null);
          else if (sectionKey === 'timeSeries') setTimeSeries([]);
          else if (sectionKey === 'machines') setMachineAnalytics([]);
          else if (sectionKey === 'products') setProductAnalytics([]);
          else if (sectionKey === 'inventory') setInventoryAnalytics([]);
          else if (sectionKey === 'refunds') setRefundsAnalytics(null);
          // Note: Failed retry does not advance section timestamp
        }
      } finally {
        if (!isSectionObsolete()) {
          setSectionLoading((prev) => ({ ...prev, [sectionKey]: false }));
        }
      }
    },
    [queryParams, timeInterval]
  );

  // Dedicated interval switcher that only reloads time-series analytics
  const handleIntervalChange = useCallback(
    (newInterval) => {
      setTimeInterval(newInterval);
      if (sectionAbortControllersRef.current.timeSeries) {
        sectionAbortControllersRef.current.timeSeries.abort();
      }
      const controller = new AbortController();
      sectionAbortControllersRef.current.timeSeries = controller;

      // Increment request identity for time-series section (A-1)
      const currentSectionId = (sectionRequestIdsRef.current.timeSeries || 0) + 1;
      sectionRequestIdsRef.current.timeSeries = currentSectionId;

      const isTimeSeriesObsolete = () =>
        !isMountedRef.current || sectionRequestIdsRef.current.timeSeries !== currentSectionId;

      setSectionLoading((prev) => ({ ...prev, timeSeries: true }));
      setSectionErrors((prev) => ({ ...prev, timeSeries: '' }));

      const token = getStoredToken();
      adminApi
        .getAnalyticsTimeSeries(
          { ...queryParams, interval: newInterval },
          { token, signal: controller.signal }
        )
        .then((res) => {
          if (isTimeSeriesObsolete()) return;
          setTimeSeries(res?.data || []);
          // A-2: Update only timeSeries timestamp. Do NOT update lastFullSync!
          const now = new Date();
          setSectionLastUpdated((prev) => ({ ...prev, timeSeries: now }));
        })
        .catch((err) => {
          if (isTimeSeriesObsolete()) return;
          if (err?.name !== 'AbortError') {
            setTimeSeries([]);
            setSectionErrors((prev) => ({
              ...prev,
              timeSeries: err?.message || 'Failed to load time-series revenue trends'
            }));
          }
        })
        .finally(() => {
          if (!isTimeSeriesObsolete()) {
            setSectionLoading((prev) => ({ ...prev, timeSeries: false }));
          }
        });
    },
    [queryParams]
  );

  // Full analytics fetch across all 6 sections (used on filter changes or manual full refresh)
  const fetchAnalytics = useCallback(async () => {
    if (preset === 'custom') {
      const validation = validateDateRange(customStart, customEnd);
      if (!validation.valid) {
        setDateError(validation.error || 'Invalid date range');
        return;
      }
    }
    setDateError('');

    // Detect actual filter context change vs same-filter manual refresh (C-1.2)
    const filterContextKey = `${preset}:${preset === 'custom' ? `${customStart}:${customEnd}` : ''}:${machineFilter}`;
    const isFilterChange = prevFilterContextRef.current !== null && prevFilterContextRef.current !== filterContextKey;
    prevFilterContextRef.current = filterContextKey;

    if (isFilterChange) {
      // Clear section timestamps and full sync timestamp on filter change so old timestamps are not displayed as current
      setSectionLastUpdated({
        overview: null,
        timeSeries: null,
        machines: null,
        products: null,
        inventory: null,
        refunds: null
      });
      setLastFullSync(null);
    }

    // Cancel previous in-flight requests (both main and individual retries) to avoid race conditions
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    Object.values(sectionAbortControllersRef.current).forEach((ctrl) => {
      if (ctrl && typeof ctrl.abort === 'function') ctrl.abort();
    });
    sectionAbortControllersRef.current = {};

    const controller = new AbortController();
    abortControllerRef.current = controller;

    // A-1: Increment monotonic request sequence ID for full refresh
    const currentRequestId = ++requestIdRef.current;

    // Invalidate any active or pending individual retries across all sections
    const capturedSectionIds = {};
    for (const key of ['overview', 'timeSeries', 'machines', 'products', 'inventory', 'refunds']) {
      const nextSectionId = (sectionRequestIdsRef.current[key] || 0) + 1;
      sectionRequestIdsRef.current[key] = nextSectionId;
      capturedSectionIds[key] = nextSectionId;
    }

    const isFullRefreshObsolete = () =>
      !isMountedRef.current || requestIdRef.current !== currentRequestId;

    // Reset all sections to loading and clear errors to prevent presenting stale data as fresh
    setSectionLoading({
      overview: true,
      timeSeries: true,
      machines: true,
      products: true,
      inventory: true,
      refunds: true
    });
    setSectionErrors({
      overview: '',
      timeSeries: '',
      machines: '',
      products: '',
      inventory: '',
      refunds: ''
    });

    const token = getStoredToken();
    const requestOptions = { token, signal: controller.signal };

    try {
      const results = await Promise.allSettled([
        adminApi.getAnalyticsOverview(queryParams, requestOptions),
        adminApi.getAnalyticsTimeSeries({ ...queryParams, interval: timeInterval }, requestOptions),
        adminApi.getAnalyticsMachines(queryParams, requestOptions),
        adminApi.getAnalyticsProducts(queryParams, requestOptions),
        adminApi.getAnalyticsInventory(queryParams, requestOptions),
        adminApi.getAnalyticsRefunds(queryParams, requestOptions)
      ]);

      // If aborted or obsolete generation, discard results completely (A-1)
      if (controller.signal.aborted || isFullRefreshObsolete()) return;

      const [ovRes, tsRes, mcRes, prRes, invRes, rfRes] = results;
      const now = new Date();
      const updatedSectionTimestamps = {};
      let allSectionsSucceeded = true;

      // 1. Overview
      if (sectionRequestIdsRef.current.overview === capturedSectionIds.overview) {
        if (ovRes.status === 'fulfilled') {
          setOverview(ovRes.value?.data || null);
          updatedSectionTimestamps.overview = now;
        } else {
          allSectionsSucceeded = false;
          if (ovRes.reason?.name !== 'AbortError') {
            setOverview(null);
            setSectionErrors((prev) => ({
              ...prev,
              overview: ovRes.reason?.message || 'Failed to load financial overview and KPI metrics'
            }));
          }
        }
      } else {
        allSectionsSucceeded = false;
      }

      // 2. Time Series
      if (sectionRequestIdsRef.current.timeSeries === capturedSectionIds.timeSeries) {
        if (tsRes.status === 'fulfilled') {
          setTimeSeries(tsRes.value?.data || []);
          updatedSectionTimestamps.timeSeries = now;
        } else {
          allSectionsSucceeded = false;
          if (tsRes.reason?.name !== 'AbortError') {
            setTimeSeries([]);
            setSectionErrors((prev) => ({
              ...prev,
              timeSeries: tsRes.reason?.message || 'Failed to load time-series revenue trends'
            }));
          }
        }
      } else {
        allSectionsSucceeded = false;
      }

      // 3. Machines
      if (sectionRequestIdsRef.current.machines === capturedSectionIds.machines) {
        if (mcRes.status === 'fulfilled') {
          setMachineAnalytics(mcRes.value?.data || []);
          updatedSectionTimestamps.machines = now;
        } else {
          allSectionsSucceeded = false;
          if (mcRes.reason?.name !== 'AbortError') {
            setMachineAnalytics([]);
            setSectionErrors((prev) => ({
              ...prev,
              machines: mcRes.reason?.message || 'Failed to load machine performance records'
            }));
          }
        }
      } else {
        allSectionsSucceeded = false;
      }

      // 4. Products
      if (sectionRequestIdsRef.current.products === capturedSectionIds.products) {
        if (prRes.status === 'fulfilled') {
          setProductAnalytics(prRes.value?.data || []);
          updatedSectionTimestamps.products = now;
        } else {
          allSectionsSucceeded = false;
          if (prRes.reason?.name !== 'AbortError') {
            setProductAnalytics([]);
            setSectionErrors((prev) => ({
              ...prev,
              products: prRes.reason?.message || 'Failed to load product sales analytics'
            }));
          }
        }
      } else {
        allSectionsSucceeded = false;
      }

      // 5. Inventory
      if (sectionRequestIdsRef.current.inventory === capturedSectionIds.inventory) {
        if (invRes.status === 'fulfilled') {
          setInventoryAnalytics(invRes.value?.data || []);
          updatedSectionTimestamps.inventory = now;
        } else {
          allSectionsSucceeded = false;
          if (invRes.reason?.name !== 'AbortError') {
            setInventoryAnalytics([]);
            setSectionErrors((prev) => ({
              ...prev,
              inventory: invRes.reason?.message || 'Failed to load ingredient telemetry and balances'
            }));
          }
        }
      } else {
        allSectionsSucceeded = false;
      }

      // 6. Refunds
      if (sectionRequestIdsRef.current.refunds === capturedSectionIds.refunds) {
        if (rfRes.status === 'fulfilled') {
          setRefundsAnalytics(rfRes.value?.data || null);
          updatedSectionTimestamps.refunds = now;
        } else {
          allSectionsSucceeded = false;
          if (rfRes.reason?.name !== 'AbortError') {
            setRefundsAnalytics(null);
            setSectionErrors((prev) => ({
              ...prev,
              refunds: rfRes.reason?.message || 'Failed to load refund ledger records'
            }));
          }
        }
      } else {
        allSectionsSucceeded = false;
      }

      // A-2: Update timestamps for sections that successfully refreshed in this generation
      if (Object.keys(updatedSectionTimestamps).length > 0) {
        setSectionLastUpdated((prev) => ({ ...prev, ...updatedSectionTimestamps }));
      }

      // A-2: Update global dashboard synchronization timestamp ONLY if all 6 sections succeeded
      if (allSectionsSucceeded) {
        setLastFullSync(now);
      }
    } catch (err) {
      if (isFullRefreshObsolete()) return;
      if (err?.name !== 'AbortError') {
        const fallbackMsg = err?.message || 'Unable to communicate with analytics service';
        setSectionErrors({
          overview: fallbackMsg,
          timeSeries: fallbackMsg,
          machines: fallbackMsg,
          products: fallbackMsg,
          inventory: fallbackMsg,
          refunds: fallbackMsg
        });
      }
    } finally {
      if (!isFullRefreshObsolete()) {
        setSectionLoading((prev) => {
          const next = { ...prev };
          for (const key of ['overview', 'timeSeries', 'machines', 'products', 'inventory', 'refunds']) {
            if (sectionRequestIdsRef.current[key] === capturedSectionIds[key]) {
              next[key] = false;
            }
          }
          return next;
        });
      }
    }
  }, [queryParams, timeInterval, preset, customStart, customEnd, machineFilter]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      requestIdRef.current += 1;
      for (const key of ['overview', 'timeSeries', 'machines', 'products', 'inventory', 'refunds']) {
        sectionRequestIdsRef.current[key] = (sectionRequestIdsRef.current[key] || 0) + 1;
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      Object.values(sectionAbortControllersRef.current).forEach((ctrl) => {
        if (ctrl && typeof ctrl.abort === 'function') ctrl.abort();
      });
    };
  }, []);

  useEffect(() => {
    fetchAnalytics();
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      Object.values(sectionAbortControllersRef.current).forEach((ctrl) => {
        if (ctrl && typeof ctrl.abort === 'function') ctrl.abort();
      });
    };
  }, [fetchAnalytics]);

  const presetTabs = [
    { id: 'today', label: 'Today' },
    { id: '7days', label: 'Last 7 Days' },
    { id: '30days', label: 'Last 30 Days' },
    { id: 'month', label: 'This Month' },
    { id: 'all', label: 'All-Time' },
    { id: 'custom', label: 'Custom Range' }
  ];

  const maxBucketRevenue = useMemo(() => {
    if (!timeSeries.length) return 1;
    return Math.max(...timeSeries.map((b) => Number(b.gross_sales_inr || 0)), 1);
  }, [timeSeries]);

  const isAnyLoading = Object.values(sectionLoading).some(Boolean);

  return (
    <div className="space-y-6">
      {/* 1. Header & Controls Bar */}
      <div className="bg-white rounded-2xl border border-[#EED9C4] p-5 flex flex-col xl:flex-row xl:items-center justify-between gap-4 shadow-xs">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="font-display text-xl font-bold text-[#2C1E17]">
              Fleet Analytics & Financial Ledger
            </h2>
            <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-[#FAF6F0] text-[#4E3629] border border-[#EED9C4]">
              Super Admin
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            Real-time multi-machine financial KPIs, refund accounting, and ingredient telemetry in Asia/Kolkata time.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Preset Buttons */}
          <div className="inline-flex p-1 rounded-xl bg-[#FAF6F0] border border-[#EED9C4]">
            {presetTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setPreset(tab.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                  preset === tab.id
                    ? 'bg-[#4E3629] text-white shadow-xs'
                    : 'text-[#8C6246] hover:text-[#2C1E17]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Machine Filter Dropdown */}
          <select
            value={machineFilter}
            onChange={(e) => setMachineFilter(e.target.value)}
            className="px-3.5 py-2 rounded-xl border border-[#EED9C4] bg-[#FAF6F0] text-xs font-semibold text-[#2C1E17] cursor-pointer"
          >
            <option value="ALL">All Fleet Machines</option>
            {machines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.machine_name} ({m.id})
              </option>
            ))}
          </select>

          {/* Refresh Button */}
          <button
            type="button"
            onClick={fetchAnalytics}
            disabled={isAnyLoading}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold bg-[#FAF6F0] hover:bg-[#EED9C4] text-[#4E3629] border border-[#EED9C4] transition-colors cursor-pointer"
            title="Refresh analytics data"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isAnyLoading ? 'animate-spin' : ''}`} />
            {isAnyLoading ? 'Updating...' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Custom Date Range Picker */}
      {preset === 'custom' && (
        <div className="bg-[#FAF6F0] rounded-2xl border border-[#EED9C4] p-4 flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2 text-xs font-semibold text-[#4E3629]">
            <Calendar className="w-4 h-4" />
            <span>Select Custom Range (Max 366 Days):</span>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-500 font-medium">From:</label>
            <input
              type="date"
              value={customStart}
              onChange={(e) => setCustomStart(e.target.value)}
              className="px-3 py-1.5 rounded-xl border border-[#EED9C4] bg-white text-xs font-medium text-[#2C1E17]"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-500 font-medium">To:</label>
            <input
              type="date"
              value={customEnd}
              onChange={(e) => setCustomEnd(e.target.value)}
              className="px-3 py-1.5 rounded-xl border border-[#EED9C4] bg-white text-xs font-medium text-[#2C1E17]"
            />
          </div>
          <button
            type="button"
            onClick={fetchAnalytics}
            className="px-4 py-1.5 rounded-xl text-xs font-semibold bg-[#4E3629] text-white hover:bg-[#2C1E17] transition-colors"
          >
            Apply Range
          </button>
          {dateError && (
            <span className="text-xs font-semibold text-rose-600 flex items-center gap-1">
              <AlertCircle className="w-3.5 h-3.5" />
              {dateError}
            </span>
          )}
        </div>
      )}

      {/* 2. Financial Overview & Primary KPI Cards Section */}
      {sectionLoading.overview ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            'Gross Captured Sales',
            'Processed Refunds',
            'Net Revenue',
            'Paid Orders',
            'Average Order Value',
            'Dispense Fulfillment',
            'Dispensing Failures',
            'In-Flight / Pending'
          ].map((title) => (
            <div
              key={title}
              className="bg-white rounded-2xl border border-[#EED9C4] p-5 shadow-xs animate-pulse flex items-start justify-between"
            >
              <div className="space-y-2 w-2/3">
                <div className="h-3 w-24 bg-slate-200 rounded" />
                <div className="h-7 w-20 bg-slate-300 rounded" />
                <div className="h-2.5 w-32 bg-slate-100 rounded" />
              </div>
              <div className="w-11 h-11 rounded-xl bg-slate-200" />
            </div>
          ))}
        </div>
      ) : sectionErrors.overview ? (
        <SectionError
          title="Financial Overview & KPI Metrics Unavailable"
          message={sectionErrors.overview}
          onRetry={() => retrySection('overview')}
          retrying={sectionLoading.overview}
        />
      ) : (
        <>
          {/* Financial Warning & Invariant Anomaly Banners */}
          {overview?.over_refund_detected && (
            <div className="p-4 rounded-xl bg-rose-50 border-2 border-rose-400 text-rose-900 text-xs shadow-xs flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
              <div>
                <div className="font-bold text-sm uppercase tracking-wide text-rose-800">
                  Critical Financial Invariant Violation Detected
                </div>
                <p className="mt-0.5 font-medium text-rose-700">
                  Total cumulative processed refunds exceed the authoritative captured amount for one or more orders. Immediate reconciliation audit required across payment gateway logs.
                </p>
              </div>
            </div>
          )}

          {overview?.refunds_exceed_period_sales && (
            <div className="p-4 rounded-xl bg-amber-50 border border-amber-300 text-amber-900 text-xs shadow-xs flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <div className="font-bold text-xs uppercase tracking-wide text-amber-800">
                  Period Net Revenue Deficit
                </div>
                <p className="mt-0.5 font-medium text-amber-700">
                  Total settled refunds exceed gross captured sales during this specific reporting period. Net revenue is negative.
                </p>
              </div>
            </div>
          )}

          {/* Primary Financial & Operational KPI Cards (8 Cards) */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between text-xs text-slate-500 mb-1 gap-1">
            <span className="font-semibold uppercase tracking-wider text-slate-400">
              Financial & Operational KPIs
            </span>
            <span className="text-[11px] text-slate-400 font-medium">
              Updated: {formatSyncTime(sectionLastUpdated.overview)}
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Card 1: Gross Captured Sales */}
            <div className="bg-white rounded-2xl border border-[#EED9C4] p-5 shadow-xs flex items-start justify-between">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Gross Captured Sales
                </div>
                <div className="font-display text-2xl font-extrabold text-[#2C1E17] mt-1">
                  {overview ? formatINR(overview.gross_sales_inr) : '—'}
                </div>
                <div className="text-[11px] text-slate-400 mt-1">
                  Exact captured gateway paise
                </div>
              </div>
              <div className="p-3 rounded-xl bg-[#4E3629] text-white">
                <IndianRupee className="w-5 h-5" />
              </div>
            </div>

            {/* Card 2: Processed Refunds */}
            <div className="bg-white rounded-2xl border border-[#EED9C4] p-5 shadow-xs flex items-start justify-between">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Processed Refunds
                </div>
                <div className="font-display text-2xl font-extrabold text-rose-700 mt-1">
                  {overview ? formatINR(overview.processed_refunds_inr) : '—'}
                </div>
                <div className="text-[11px] text-slate-400 mt-1">
                  {refundsAnalytics
                    ? `${refundsAnalytics.processed_refunds_count} settled refunds`
                    : 'Authoritative refunds'}
                </div>
              </div>
              <div className="p-3 rounded-xl bg-rose-100 text-rose-800">
                <RotateCcw className="w-5 h-5" />
              </div>
            </div>

            {/* Card 3: Net Revenue (Signed INR) */}
            <div className="bg-white rounded-2xl border border-[#EED9C4] p-5 shadow-xs flex items-start justify-between">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Net Revenue
                </div>
                <div
                  className={`font-display text-2xl font-extrabold mt-1 ${
                    overview && overview.net_revenue_inr < 0 ? 'text-rose-700' : 'text-emerald-700'
                  }`}
                >
                  {overview ? formatSignedINR(overview.net_revenue_inr) : '—'}
                </div>
                <div className="text-[11px] text-slate-400 mt-1">
                  Gross minus settled refunds
                </div>
              </div>
              <div
                className={`p-3 rounded-xl ${
                  overview && overview.net_revenue_inr < 0
                    ? 'bg-rose-100 text-rose-800'
                    : 'bg-emerald-100 text-emerald-800'
                }`}
              >
                <TrendingUp className="w-5 h-5" />
              </div>
            </div>

            {/* Card 4: Paid Orders */}
            <div className="bg-white rounded-2xl border border-[#EED9C4] p-5 shadow-xs flex items-start justify-between">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Paid Orders
                </div>
                <div className="font-display text-2xl font-extrabold text-[#2C1E17] mt-1">
                  {overview ? overview.paid_orders_count : '—'}
                </div>
                <div className="text-[11px] text-slate-400 mt-1">
                  Verified payment transactions
                </div>
              </div>
              <div className="p-3 rounded-xl bg-[#C9A66B] text-[#2C1E17]">
                <ShoppingBag className="w-5 h-5" />
              </div>
            </div>

            {/* Card 5: Average Order Value */}
            <div className="bg-white rounded-2xl border border-[#EED9C4] p-5 shadow-xs flex items-start justify-between">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Average Order Value
                </div>
                <div className="font-display text-2xl font-extrabold text-[#2C1E17] mt-1">
                  {overview ? formatINR(overview.average_order_value_inr) : '—'}
                </div>
                <div className="text-[11px] text-slate-400 mt-1">
                  Gross sales per paid order
                </div>
              </div>
              <div className="p-3 rounded-xl bg-[#8C6246] text-white">
                <Coffee className="w-5 h-5" />
              </div>
            </div>

            {/* Card 6: Dispense Fulfillment Rate */}
            <div className="bg-white rounded-2xl border border-[#EED9C4] p-5 shadow-xs flex items-start justify-between">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Dispense Fulfillment
                </div>
                <div className="font-display text-2xl font-extrabold text-teal-800 mt-1">
                  {overview
                    ? `${(Number(overview.dispense_fulfillment_rate || 0) * 100).toFixed(1)}%`
                    : '—'}
                </div>
                <div className="text-[11px] text-slate-400 mt-1">
                  {overview ? `${overview.dispensed_count} poured successfully` : '—'}
                </div>
              </div>
              <div className="p-3 rounded-xl bg-teal-100 text-teal-800">
                <CheckCircle2 className="w-5 h-5" />
              </div>
            </div>

            {/* Card 7: Dispense Failures */}
            <div className="bg-white rounded-2xl border border-[#EED9C4] p-5 shadow-xs flex items-start justify-between">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Dispensing Failures
                </div>
                <div className="font-display text-2xl font-extrabold text-rose-700 mt-1">
                  {overview ? overview.dispense_failed_count : '—'}
                </div>
                <div className="text-[11px] text-slate-400 mt-1">
                  Hardware pour errors recorded
                </div>
              </div>
              <div className="p-3 rounded-xl bg-rose-50 text-rose-700">
                <Wrench className="w-5 h-5" />
              </div>
            </div>

            {/* Card 8: In-Flight & Pending */}
            <div className="bg-white rounded-2xl border border-[#EED9C4] p-5 shadow-xs flex items-start justify-between">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  In-Flight / Pending
                </div>
                <div className="font-display text-2xl font-extrabold text-amber-700 mt-1">
                  {overview ? overview.dispense_in_flight_count : '—'}
                </div>
                <div className="text-[11px] text-slate-400 mt-1">
                  {overview ? `${overview.pending_orders_count} awaiting payment` : '—'}
                </div>
              </div>
              <div className="p-3 rounded-xl bg-amber-100 text-amber-800">
                <Clock className="w-5 h-5" />
              </div>
            </div>
          </div>
        </>
      )}

      {/* 3. Time-Series Revenue Trend Chart */}
      <div className="bg-white rounded-2xl border border-[#EED9C4] p-6 shadow-xs space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h3 className="font-display text-base font-bold text-[#2C1E17] flex items-center gap-2 flex-wrap">
              <span className="flex items-center gap-2">
                <BarChart3 className="w-4 h-4 text-[#4E3629]" />
                Time-Series Revenue & Refund Breakdown
              </span>
              <span className="text-[11px] font-normal text-slate-400">
                • Updated: {formatSyncTime(sectionLastUpdated.timeSeries)}
              </span>
            </h3>
            <p className="text-xs text-slate-500">
              Calendar-bucketed gross captured sales, processed refunds, and net revenue in Asia/Kolkata timezone.
            </p>
          </div>

          <div className="inline-flex p-1 rounded-xl bg-[#FAF6F0] border border-[#EED9C4]">
            {['hour', 'day', 'week', 'month'].map((iv) => (
              <button
                key={iv}
                type="button"
                onClick={() => handleIntervalChange(iv)}
                className={`px-3 py-1 rounded-lg text-xs font-semibold capitalize transition-all cursor-pointer ${
                  timeInterval === iv
                    ? 'bg-[#4E3629] text-white shadow-xs'
                    : 'text-[#8C6246] hover:text-[#2C1E17]'
                }`}
              >
                {iv}ly
              </button>
            ))}
          </div>
        </div>

        {sectionLoading.timeSeries ? (
          <SectionLoading label="Loading time-series revenue trends..." />
        ) : sectionErrors.timeSeries ? (
          <SectionError
            title="Time-Series Analytics Unavailable"
            message={sectionErrors.timeSeries}
            onRetry={() => retrySection('timeSeries')}
            retrying={sectionLoading.timeSeries}
          />
        ) : timeSeries.length === 0 ? (
          <div className="py-12 text-center text-xs text-slate-400">
            No sales or refund transactions recorded in this period.
          </div>
        ) : (
          <div className="space-y-3 pt-2">
            {timeSeries.map((bucket) => {
              const grossInr = Number(bucket.gross_sales_inr || 0);
              const refundInr = Number(bucket.processed_refunds_inr || 0);
              const netInr = Number(bucket.net_revenue_inr || 0);
              const widthPct = Math.max(4, Math.round((grossInr / maxBucketRevenue) * 100));

              return (
                <div key={bucket.bucket_key} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-[#2C1E17]">{bucket.label}</span>
                    <div className="flex items-center gap-3">
                      <span className="font-bold text-[#4E3629]">
                        Gross: {formatINR(grossInr)}
                      </span>
                      {refundInr > 0 && (
                        <span className="font-semibold text-rose-700">
                          Refunds: -{formatINR(refundInr)}
                        </span>
                      )}
                      <span
                        className={`font-bold ${netInr < 0 ? 'text-rose-700' : 'text-emerald-700'}`}
                      >
                        Net: {formatSignedINR(netInr)}
                      </span>
                      <span className="text-slate-400 font-normal">
                        ({bucket.paid_orders_count} paid)
                      </span>
                    </div>
                  </div>
                  <div className="h-3 w-full bg-[#FAF6F0] rounded-full overflow-hidden border border-[#EED9C4]/70">
                    <div
                      className="h-full bg-gradient-to-r from-[#4E3629] to-[#C9A66B] rounded-full transition-all duration-300"
                      style={{ width: `${widthPct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 4. Revenue by Machine & Product Mix Tables */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Machine Performance Matrix */}
        <div className="bg-white rounded-2xl border border-[#EED9C4] shadow-xs overflow-hidden">
          <div className="px-6 py-4 border-b border-[#EED9C4] flex items-center justify-between">
            <div>
              <h3 className="font-display text-base font-bold text-[#2C1E17] flex items-center gap-2 flex-wrap">
                <span className="flex items-center gap-2">
                  <Cpu className="w-4 h-4 text-[#4E3629]" />
                  Machine Performance Matrix
                </span>
                <span className="text-[11px] font-normal text-slate-400">
                  • Updated: {formatSyncTime(sectionLastUpdated.machines)}
                </span>
              </h3>
              <p className="text-xs text-slate-500">
                Machine-level gross sales, refunds, fulfillment, and net revenue
              </p>
            </div>
          </div>

          {sectionLoading.machines ? (
            <SectionLoading label="Loading machine performance records..." />
          ) : sectionErrors.machines ? (
            <div className="p-6">
              <SectionError
                title="Machine Performance Data Unavailable"
                message={sectionErrors.machines}
                onRetry={() => retrySection('machines')}
                retrying={sectionLoading.machines}
              />
            </div>
          ) : machineAnalytics.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-400">
              No machine performance records available.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-[#FAF6F0] text-[#4E3629] font-bold border-b border-[#EED9C4]">
                  <tr>
                    <th className="px-4 py-3">Machine</th>
                    <th className="px-4 py-3 text-right">Gross Sales</th>
                    <th className="px-4 py-3 text-right">Refunds</th>
                    <th className="px-4 py-3 text-right">Net Revenue</th>
                    <th className="px-4 py-3 text-right">Fulfillment</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#EED9C4]/50">
                  {machineAnalytics.map((m) => (
                    <tr key={m.machine_id} className="hover:bg-[#FAF6F0]/40 transition-colors">
                      <td className="px-4 py-3">
                        <div className="font-bold text-[#2C1E17]">{m.machine_name}</div>
                        <div className="text-[11px] text-slate-400">
                          {m.machine_id} • {m.location || 'Unknown'}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right font-bold text-[#4E3629]">
                        {formatINR(m.gross_sales_inr)}
                        <div className="text-[10px] text-slate-400 font-normal">
                          {m.paid_orders_count} orders
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right font-semibold text-rose-700">
                        {formatINR(m.processed_refunds_inr)}
                      </td>
                      <td
                        className={`px-4 py-3 text-right font-bold ${
                          m.net_revenue_inr < 0 ? 'text-rose-700' : 'text-emerald-700'
                        }`}
                      >
                        {formatSignedINR(m.net_revenue_inr)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className="font-bold text-teal-800">
                          {(Number(m.dispense_fulfillment_rate || 0) * 100).toFixed(0)}%
                        </span>
                        <div className="text-[10px] text-slate-400">
                          {m.dispensed_count}/{m.paid_orders_count}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Product Mix & Volume Breakdown */}
        <div className="bg-white rounded-2xl border border-[#EED9C4] shadow-xs overflow-hidden">
          <div className="px-6 py-4 border-b border-[#EED9C4] flex items-center justify-between">
            <div>
              <h3 className="font-display text-base font-bold text-[#2C1E17] flex items-center gap-2 flex-wrap">
                <span className="flex items-center gap-2">
                  <Coffee className="w-4 h-4 text-[#4E3629]" />
                  Product Mix & Revenue Contribution
                </span>
                <span className="text-[11px] font-normal text-slate-400">
                  • Updated: {formatSyncTime(sectionLastUpdated.products)}
                </span>
              </h3>
              <p className="text-xs text-slate-500">
                Units sold and percentage share of gross sales
              </p>
            </div>
          </div>

          {sectionLoading.products ? (
            <SectionLoading label="Loading product sales analytics..." />
          ) : sectionErrors.products ? (
            <div className="p-6">
              <SectionError
                title="Product Sales Analytics Unavailable"
                message={sectionErrors.products}
                onRetry={() => retrySection('products')}
                retrying={sectionLoading.products}
              />
            </div>
          ) : productAnalytics.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-400">
              No product sales recorded in this period.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-[#FAF6F0] text-[#4E3629] font-bold border-b border-[#EED9C4]">
                  <tr>
                    <th className="px-4 py-3">Recipe / Beverage</th>
                    <th className="px-4 py-3 text-right">Units Sold</th>
                    <th className="px-4 py-3 text-right">Gross Sales</th>
                    <th className="px-4 py-3 text-right">Revenue Share</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#EED9C4]/50">
                  {productAnalytics.map((p) => (
                    <tr key={p.product_id} className="hover:bg-[#FAF6F0]/40 transition-colors">
                      <td className="px-4 py-3 font-bold text-[#2C1E17]">
                        {p.product_name}
                      </td>
                      <td className="px-4 py-3 text-right font-semibold text-slate-700">
                        {p.units_sold} cups
                        {p.refunded_units > 0 && (
                          <div className="text-[10px] text-rose-600">
                            {p.refunded_units} refunded
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right font-bold text-[#4E3629]">
                        {formatINR(p.gross_sales_inr)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="font-bold text-[#C9A66B]">
                          {Number(p.revenue_share_percent || 0).toFixed(1)}%
                        </div>
                        <div className="w-16 h-1.5 bg-[#FAF6F0] rounded-full overflow-hidden ml-auto mt-1 border border-[#EED9C4]">
                          <div
                            className="h-full bg-[#C9A66B] rounded-full"
                            style={{
                              width: `${Math.min(100, Math.max(5, p.revenue_share_percent))}%`
                            }}
                          />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* 5. Ingredient Consumption & Real Inventory Balances */}
      <div className="bg-white rounded-2xl border border-[#EED9C4] shadow-xs overflow-hidden">
        <div className="px-6 py-4 border-b border-[#EED9C4] flex items-center justify-between">
          <div>
            <h3 className="font-display text-base font-bold text-[#2C1E17] flex items-center gap-2 flex-wrap">
              <span className="flex items-center gap-2">
                <Layers className="w-4 h-4 text-[#4E3629]" />
                Ingredient Consumption & Inventory Ledger Balances
              </span>
              <span className="text-[11px] font-normal text-slate-400">
                • Updated: {formatSyncTime(sectionLastUpdated.inventory)}
              </span>
            </h3>
            <p className="text-xs text-slate-500">
              Recorded inventory balances across machines with consumption, refills, waste, and calibration movements
            </p>
          </div>
        </div>

        {sectionLoading.inventory ? (
          <SectionLoading label="Loading ingredient telemetry and balances..." />
        ) : sectionErrors.inventory ? (
          <div className="p-6">
            <SectionError
              title="Inventory Telemetry Unavailable"
              message={sectionErrors.inventory}
              onRetry={() => retrySection('inventory')}
              retrying={sectionLoading.inventory}
            />
          </div>
        ) : inventoryAnalytics.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-400">
            No ingredient telemetry available.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#FAF6F0] text-[#4E3629] font-bold border-b border-[#EED9C4]">
                <tr>
                  <th className="px-4 py-3">Ingredient</th>
                  <th className="px-4 py-3">Current Balance</th>
                  <th className="px-4 py-3 text-right">Total Consumed</th>
                  <th className="px-4 py-3 text-right">Total Refilled</th>
                  <th className="px-4 py-3 text-right">Waste</th>
                  <th className="px-4 py-3 text-right">Adjustments</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#EED9C4]/50">
                {inventoryAnalytics.map((inv) => (
                  <tr key={inv.ingredient} className="hover:bg-[#FAF6F0]/40 transition-colors">
                    <td className="px-4 py-3 font-bold text-[#2C1E17] capitalize">
                      {inv.ingredient}
                    </td>
                    <td className="px-4 py-3">
                      {inv.current_balance !== null && inv.current_balance !== undefined ? (
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-[#4E3629] text-sm">
                            {inv.current_balance}%
                          </span>
                          {inv.inventory_source === 'software_estimated' && (
                            <SoftwareEstimatedBadge />
                          )}
                        </div>
                      ) : (
                        <UntrackedBadge />
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-slate-700">
                      {inv.total_consumed} units
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-emerald-700">
                      +{inv.total_refilled} units
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-rose-700">
                      {inv.total_waste > 0 ? `-${inv.total_waste} units` : '0'}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-amber-700">
                      {inv.total_adjustments !== 0 ? `${inv.total_adjustments} units` : '0'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 6. Refund Audit & Recent Movements */}
      <div className="bg-white rounded-2xl border border-[#EED9C4] p-6 shadow-xs space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-[#EED9C4] pb-4">
          <div>
            <h3 className="font-display text-base font-bold text-[#2C1E17] flex items-center gap-2 flex-wrap">
              <span className="flex items-center gap-2">
                <RotateCcw className="w-4 h-4 text-rose-700" />
                Refund Audit & Reason Classification
              </span>
              <span className="text-[11px] font-normal text-slate-400">
                • Updated: {formatSyncTime(sectionLastUpdated.refunds)}
              </span>
            </h3>
            <p className="text-xs text-slate-500">
              Authoritative root refund ledger entries with settlement reasons and timestamps
            </p>
          </div>
          {refundsAnalytics && (
            <div className="flex items-center gap-2">
              <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-rose-50 text-rose-800 border border-rose-200">
                {refundsAnalytics.total_refunds_count} Total Refund Events
              </span>
            </div>
          )}
        </div>

        {sectionLoading.refunds ? (
          <SectionLoading label="Loading refund ledger records..." />
        ) : sectionErrors.refunds ? (
          <SectionError
            title="Refund Analytics Unavailable"
            message={sectionErrors.refunds}
            onRetry={() => retrySection('refunds')}
            retrying={sectionLoading.refunds}
          />
        ) : !refundsAnalytics || refundsAnalytics.total_refunds_count === 0 ? (
          <div className="py-8 text-center text-xs text-slate-400">
            No refund records available for this reporting window.
          </div>
        ) : (
          <>
            {/* Refund Status Breakdown Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="p-3.5 rounded-xl bg-purple-50 border border-purple-200">
                <div className="text-[11px] font-bold text-purple-900 uppercase">Settled (PROCESSED)</div>
                <div className="text-xl font-extrabold text-purple-800 mt-0.5">
                  {formatINR(refundsAnalytics.processed_refunds_inr)}
                </div>
                <div className="text-[10px] text-purple-700 mt-0.5">
                  {refundsAnalytics.processed_refunds_count} settled transactions
                </div>
              </div>

              <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200">
                <div className="text-[11px] font-bold text-amber-900 uppercase">Pending Gateway (PENDING)</div>
                <div className="text-xl font-extrabold text-amber-800 mt-0.5">
                  {formatINR(refundsAnalytics.pending_refunds_inr)}
                </div>
                <div className="text-[10px] text-amber-700 mt-0.5">
                  {refundsAnalytics.pending_refunds_count} reservations awaiting capture/gateway
                </div>
              </div>

              <div className="p-3.5 rounded-xl bg-rose-50 border border-rose-200">
                <div className="text-[11px] font-bold text-rose-900 uppercase">Failed / Rejected (FAILED)</div>
                <div className="text-xl font-extrabold text-rose-800 mt-0.5">
                  {formatINR(refundsAnalytics.failed_refunds_inr)}
                </div>
                <div className="text-[10px] text-rose-700 mt-0.5">
                  {refundsAnalytics.failed_refunds_count} rejected gateway attempts
                </div>
              </div>
            </div>

            {/* Refund Reasons Pills */}
            {refundsAnalytics.refund_reasons && Object.keys(refundsAnalytics.refund_reasons).length > 0 && (
              <div className="space-y-1.5 pt-2">
                <div className="text-xs font-semibold text-[#4E3629]">Refund Reasons Breakdown:</div>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(refundsAnalytics.refund_reasons).map(([reason, count]) => (
                    <span
                      key={reason}
                      className="inline-flex items-center gap-1.5 px-3 py-1 rounded-xl text-xs font-semibold bg-[#FAF6F0] text-[#2C1E17] border border-[#EED9C4]"
                    >
                      <span>{reason}</span>
                      <span className="px-1.5 py-0.2 rounded-full bg-[#4E3629] text-white text-[10px]">
                        {count}
                      </span>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Recent Refund Records Table */}
            {refundsAnalytics.recent_refunds && refundsAnalytics.recent_refunds.length > 0 && (
              <div className="pt-2">
                <div className="text-xs font-semibold text-[#4E3629] mb-2">Recent Refund Ledger Records:</div>
                <div className="overflow-x-auto rounded-xl border border-[#EED9C4]">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-[#FAF6F0] text-[#4E3629] font-bold border-b border-[#EED9C4]">
                      <tr>
                        <th className="px-3 py-2">Refund ID / Order</th>
                        <th className="px-3 py-2">Machine</th>
                        <th className="px-3 py-2 text-right">Amount</th>
                        <th className="px-3 py-2">Status</th>
                        <th className="px-3 py-2">Reason</th>
                        <th className="px-3 py-2 text-right">Timestamp</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#EED9C4]/50">
                      {refundsAnalytics.recent_refunds.map((r) => (
                        <tr key={r.id} className="hover:bg-[#FAF6F0]/40">
                          <td className="px-3 py-2 font-mono text-[11px] text-[#2C1E17]">
                            <div className="font-bold">{r.id}</div>
                            <div className="text-slate-400">{r.order_id}</div>
                          </td>
                          <td className="px-3 py-2 font-semibold text-slate-700">{r.machine_id}</td>
                          <td className="px-3 py-2 text-right font-bold text-rose-700">
                            {formatINR(r.amount_inr)}
                          </td>
                          <td className="px-3 py-2">
                            <span
                              className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                                r.status === 'PROCESSED'
                                  ? 'bg-purple-50 text-purple-800 border-purple-200'
                                  : r.status === 'PENDING'
                                  ? 'bg-amber-50 text-amber-800 border-amber-200'
                                  : 'bg-rose-50 text-rose-800 border-rose-200'
                              }`}
                            >
                              {r.status}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-slate-600">{r.reason}</td>
                          <td className="px-3 py-2 text-right text-slate-400 whitespace-nowrap">
                            {formatDateTime(r.created_at)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Sync Footer (C-1.1 Precedence: 1. Loading, 2. Errors, 3. Last full sync, 4. Partial count, 5. Ready) */}
      <div className="text-center text-xs text-slate-500 py-2">
        {isAnyLoading ? (
          <div className="flex items-center justify-center gap-1.5 text-slate-400">
            <RefreshCw className="w-3.5 h-3.5 animate-spin text-[#C9A66B]" />
            <span>Synchronizing dashboard analytics...</span>
          </div>
        ) : Object.values(sectionErrors).some(Boolean) ? (
          <div className="flex items-center justify-center gap-1.5 text-amber-700 font-medium">
            <AlertCircle className="w-3.5 h-3.5 text-amber-600" />
            <span>
              Partial sync • {Object.values(sectionErrors).filter(Boolean).length} section(s) require attention
            </span>
          </div>
        ) : lastFullSync ? (
          <div className="flex items-center justify-center gap-1.5 text-slate-500">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
            <span>
              Last full dashboard sync at{' '}
              <strong className="text-slate-700 font-semibold">{formatSyncTime(lastFullSync)}</strong>
            </span>
          </div>
        ) : Object.values(sectionLastUpdated).filter(Boolean).length > 0 ? (
          <div className="flex items-center justify-center gap-1.5 text-slate-500">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
            <span>
              {Object.values(sectionLastUpdated).filter(Boolean).length} of 6 sections synchronized
            </span>
          </div>
        ) : (
          <div className="text-slate-400">
            Ready to synchronize
          </div>
        )}
      </div>
    </div>
  );
}
