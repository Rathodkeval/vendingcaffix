import React, { useState } from 'react';
import {
  LayoutDashboard,
  Layers,
  Cpu,
  Receipt,
  BarChart3,
  Settings,
  LogOut,
  Droplet,
  Coffee,
  Flame,
  Wrench,
  Search,
  CheckCircle2,
  AlertTriangle,
  User,
  Activity,
  Plus
} from 'lucide-react';

export default function AdminDashboard({
  prices,
  onUpdatePrices,
  maintenanceMode,
  onToggleMaintenance,
  orderHistory,
  inventory,
  onRefillInventory,
  onExit
}) {
  const [activeTab, setActiveTab] = useState('OVERVIEW');
  const [orderQuery, setOrderQuery] = useState('');
  const [tempPrices, setTempPrices] = useState({ ...prices });
  const [settingsSuccess, setSettingsSuccess] = useState(false);

  // Inventories setup
  const refillItem = (key) => {
    onRefillInventory(key);
  };

  const refillAll = () => {
    onRefillInventory('ALL');
  };

  // Prices save handler
  const handleSavePrices = (e) => {
    e.preventDefault();
    onUpdatePrices(tempPrices);
    setSettingsSuccess(true);
    setTimeout(() => setSettingsSuccess(false), 3000);
  };

  // Mock analytics charts data
  const weeklyData = [
    { day: 'Mon', sales: 450, cups: 15 },
    { day: 'Tue', sales: 600, cups: 18 },
    { day: 'Wed', sales: 520, cups: 16 },
    { day: 'Thu', sales: 780, cups: 22 },
    { day: 'Fri', sales: 900, cups: 26 },
    { day: 'Sat', sales: 1100, cups: 30 },
    { day: 'Sun', sales: 850, cups: 25 }
  ];

  const monthlyData = [
    { month: 'Jan', sales: 12400 },
    { month: 'Feb', sales: 15200 },
    { month: 'Mar', sales: 14800 },
    { month: 'Apr', sales: 18900 },
    { month: 'May', sales: 21000 },
    { month: 'Jun', sales: 24800 }
  ];

  const bestSellers = [
    { name: 'Classic Coffee', sales: 68, percentage: 48, color: 'bg-coffee' },
    { name: 'Vanilla Coffee', sales: 42, percentage: 30, color: 'bg-coffee-light' },
    { name: 'Hazelnut Coffee', sales: 31, percentage: 22, color: 'bg-gold' }
  ];

  // Calculated Stats based on order history
  const totalSalesToday = orderHistory.length;
  const totalRevenueToday = orderHistory.reduce((sum, item) => sum + item.price, 0);

  // Search filtered orders
  const filteredOrders = orderHistory.filter(
    (order) =>
      order.id.toLowerCase().includes(orderQuery.toLowerCase()) ||
      order.name.toLowerCase().includes(orderQuery.toLowerCase())
  );

  return (
    <div className="flex h-full w-full bg-slate-50 text-slate-800 font-sans overflow-hidden">
      {/* Sidebar Navigation */}
      <aside className="w-64 bg-coffee-dark text-cream-light flex flex-col justify-between shrink-0 shadow-lg border-r border-coffee/20">
        <div>
          {/* Header branding */}
          <div className="p-6 border-b border-coffee/30 flex items-center gap-3">
            <svg className="w-7 h-7 fill-gold" viewBox="0 0 24 24">
              <path d="M2 21h18v-2H2v2zM20 8h-2V5h2V2h-2v3H4v8c0 3.31 2.69 6 6 6h4c3.31 0 6-2.69 6-6v-3h2c1.1 0 2-.9 2-2V9c0-1.1-.9-2-2-2zm-2 5c0 2.21-1.79 4-4 4h-4c-2.21 0-4-1.79-4-4V7h12v6zm2-3h-2V9h2v1z" />
            </svg>
            <span className="font-extrabold text-xl tracking-wider text-gold">CAFFIX ADMIN</span>
          </div>

          {/* Navigation Links */}
          <nav className="p-4 space-y-1">
            {[
              { id: 'OVERVIEW', label: 'Dashboard', icon: LayoutDashboard },
              { id: 'INVENTORY', label: 'Inventory', icon: Layers },
              { id: 'MACHINE', label: 'Machine Status', icon: Cpu },
              { id: 'ORDERS', label: 'Order History', icon: Receipt },
              { id: 'ANALYTICS', label: 'Analytics', icon: BarChart3 },
              { id: 'SETTINGS', label: 'Settings', icon: Settings }
            ].map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-semibold tracking-wide transition-all ${activeTab === tab.id
                      ? 'bg-gold text-coffee-dark shadow-md'
                      : 'hover:bg-coffee/40 text-cream/70 hover:text-cream-light'
                    }`}
                >
                  <Icon className="w-4 h-4" />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        {/* Exit admin */}
        <div className="p-4 border-t border-coffee/30">
          <button
            onClick={onExit}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-red-950/40 text-red-300 hover:text-red-200 border border-red-900/30 hover:bg-red-900/40 rounded-xl text-sm font-bold transition-all active:scale-95"
          >
            <LogOut className="w-4 h-4" />
            <span>Exit Dashboard</span>
          </button>
        </div>
      </aside>

      {/* Main Panel Content container */}
      <div className="flex-grow flex flex-col overflow-hidden">
        {/* Top Navbar */}
        <header className="h-16 bg-white border-b border-slate-200/80 px-6 flex justify-between items-center shrink-0 shadow-sm">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Current View</span>
            <span className="text-xs font-black text-coffee-dark uppercase tracking-wider bg-cream px-2 py-0.5 rounded-md border border-gold/15">
              {activeTab}
            </span>
          </div>

          <div className="flex items-center gap-6">
            {/* Quick indicators */}
            <div className="flex items-center gap-1 bg-emerald-50 px-2.5 py-1 rounded-full border border-emerald-100 text-emerald-700 text-xs font-bold">
              <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse mr-1"></span>
              <span>Machine: Online</span>
            </div>

            {/* Profile */}
            <div className="flex items-center gap-2 border-l border-slate-200 pl-6">
              <div className="w-8 h-8 rounded-full bg-cream flex items-center justify-center border border-gold/25 text-coffee-dark font-bold text-sm">
                <User className="w-4 h-4 text-coffee" />
              </div>
              <div className="text-left leading-none">
                <div className="text-xs font-bold text-slate-800">Caffix Admin</div>
                <span className="text-[10px] text-slate-400 font-semibold uppercase">Superuser</span>
              </div>
            </div>
          </div>
        </header>

        {/* Dynamic viewport contents */}
        <div className="flex-grow p-6 overflow-y-auto">
          {/* TAB 1: OVERVIEW */}
          {activeTab === 'OVERVIEW' && (
            <div className="space-y-6">
              {/* Summary Cards */}
              <div className="grid grid-cols-4 gap-6">
                {[
                  { title: 'Total Sales (Today)', value: `${totalSalesToday} cups`, desc: 'Beverages dispensed', color: 'border-l-4 border-coffee' },
                  { title: 'Total Revenue (Today)', value: `₹${totalRevenueToday}`, desc: 'Gross UPI collection', color: 'border-l-4 border-emerald-600' },
                  { title: 'Historical Cups Sold', value: '132 cups', desc: 'Cumulative total sales', color: 'border-l-4 border-gold' },
                  { title: 'Active Orders', value: '0 active', desc: 'No queue in progress', color: 'border-l-4 border-blue-600' }
                ].map((card, i) => (
                  <div key={i} className={`bg-white rounded-2xl p-4 shadow-sm border border-slate-200/60 ${card.color} flex flex-col justify-between`}>
                    <div>
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{card.title}</span>
                      <div className="text-2xl font-black text-slate-800 mt-1">{card.value}</div>
                    </div>
                    <span className="text-[10px] text-slate-400 font-medium mt-2 block">{card.desc}</span>
                  </div>
                ))}
              </div>

              {/* Lower Section Grid */}
              <div className="grid grid-cols-5 gap-6">
                {/* Left panel: Quick Inventory status */}
                <div className="col-span-3 bg-white border border-slate-200/60 rounded-2xl p-5 shadow-sm space-y-4">
                  <div className="flex justify-between items-center">
                    <h3 className="font-extrabold text-sm text-slate-800 uppercase tracking-tight">Kiosk Inventory</h3>
                    <button onClick={refillAll} className="text-xs font-bold text-gold-dark hover:underline flex items-center gap-1">
                      <Plus className="w-3.5 h-3.5" />
                      <span>Refill All</span>
                    </button>
                  </div>
                  <div className="space-y-3">
                    {[
                      { label: 'Water Level', value: inventory.water, color: 'bg-blue-500' },
                      { label: 'Milk Level', value: inventory.coffee, color: 'bg-amber-800' },
                      { label: 'Classic Coffee', value: inventory.milk, color: 'bg-orange-400' },
                      { label: 'Vanilla Coffee', value: inventory.vanilla, color: 'bg-yellow-400' },
                      { label: 'Hazelnut Coffee', value: inventory.hazelnut, color: 'bg-amber-600' }
                    ].map((item, idx) => (
                      <div key={idx} className="space-y-1">
                        <div className="flex justify-between text-xs font-semibold">
                          <span className="text-slate-600">{item.label}</span>
                          <span className={`${item.value < 20 ? 'text-red-600 font-bold' : 'text-slate-800'}`}>{item.value}%</span>
                        </div>
                        <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                          <div className={`h-full ${item.color} rounded-full`} style={{ width: `${item.value}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Right panel: Telemetry stats */}
                <div className="col-span-2 bg-white border border-slate-200/60 rounded-2xl p-5 shadow-sm flex flex-col justify-between">
                  <h3 className="font-extrabold text-sm text-slate-800 uppercase tracking-tight mb-4">Diagnostics Overview</h3>
                  <div className="space-y-3 flex-grow">
                    <div className="flex justify-between items-center text-xs font-semibold py-1.5 border-b border-slate-100">
                      <span className="text-slate-500">Boiler Boiler Temp</span>
                      <span className="text-slate-800 font-bold font-mono">92°C</span>
                    </div>
                    <div className="flex justify-between items-center text-xs font-semibold py-1.5 border-b border-slate-100">
                      <span className="text-slate-500">Dispenser Pressure</span>
                      <span className="text-slate-800 font-bold font-mono">9.0 Bar</span>
                    </div>
                    <div className="flex justify-between items-center text-xs font-semibold py-1.5 border-b border-slate-100">
                      <span className="text-slate-500">Telemetry Status</span>
                      <span className="text-emerald-600 font-bold uppercase text-[10px]">Connected</span>
                    </div>
                    <div className="flex justify-between items-center text-xs font-semibold py-1.5">
                      <span className="text-slate-500">Error Status</span>
                      <span className="text-emerald-600 font-bold uppercase text-[10px]">0 Warnings</span>
                    </div>
                  </div>
                  <div className="bg-cream-light/60 p-2.5 rounded-xl border border-cream text-center text-xs text-coffee font-semibold">
                    System health index: <span className="text-emerald-700 font-bold">100%</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: INVENTORY */}
          {activeTab === 'INVENTORY' && (
            <div className="bg-white border border-slate-200/60 rounded-2xl p-6 shadow-sm">
              <div className="flex justify-between items-center mb-6">
                <div>
                  <h3 className="font-extrabold text-lg text-slate-800">Ingredients Inventory</h3>
                  <p className="text-xs text-slate-400 mt-1">Live status monitor for fluids and beans inside the vending chambers</p>
                </div>
                <button
                  onClick={refillAll}
                  className="py-2 px-4 bg-coffee text-cream-light text-xs font-bold rounded-xl shadow-md hover:bg-coffee-dark active:scale-95 transition-all"
                >
                  Refill All Ingredients
                </button>
              </div>

              <div className="space-y-6">
                {[
                  { key: 'water', label: 'Water Level', icon: Droplet, value: inventory.water, color: 'bg-blue-500' },
                  { key: 'coffee', label: 'Milk Level', icon: Coffee, value: inventory.coffee, color: 'bg-amber-800' },
                  { key: 'milk', label: 'Classic Coffee', icon: Activity, value: inventory.milk, color: 'bg-orange-400' },
                  { key: 'vanilla', label: 'Vanilla Coffee', icon: Layers, value: inventory.vanilla, color: 'bg-yellow-400' },
                  { key: 'hazelnut', label: 'Hazelnut Coffee', icon: Layers, value: inventory.hazelnut, color: 'bg-amber-600' }
                ].map((item) => {
                  const Icon = item.icon;
                  return (
                    <div key={item.key} className="flex items-center gap-6 p-4 rounded-2xl border border-slate-100 bg-slate-50/50">
                      <div className="p-3 bg-white border border-slate-200/80 rounded-xl shadow-sm">
                        <Icon className="w-6 h-6 text-coffee" />
                      </div>
                      <div className="flex-grow space-y-1.5">
                        <div className="flex justify-between items-center text-sm font-bold">
                          <span className="text-slate-700">{item.label}</span>
                          <span className={`${item.value < 20 ? 'text-red-600 animate-pulse' : 'text-slate-800'}`}>{item.value}%</span>
                        </div>
                        <div className="w-full h-3 bg-slate-200/60 rounded-full overflow-hidden border border-slate-200">
                          <div className={`h-full ${item.color} rounded-full`} style={{ width: `${item.value}%` }} />
                        </div>
                        {item.value < 20 && (
                          <div className="text-[10px] text-red-600 font-bold flex items-center gap-1">
                            <AlertTriangle className="w-3.5 h-3.5" />
                            <span>Warning: Fluid level critically low! Refill recommended.</span>
                          </div>
                        )}
                      </div>
                      <button
                        onClick={() => refillItem(item.key)}
                        disabled={item.value >= 100}
                        className={`py-2 px-3 rounded-lg text-xs font-bold transition-all ${item.value >= 100
                            ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                            : 'bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100'
                          }`}
                      >
                        Refill
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* TAB 3: MACHINE */}
          {activeTab === 'MACHINE' && (
            <div className="space-y-6">
              {/* Telemetry metrics */}
              <div className="grid grid-cols-3 gap-6">
                {[
                  { label: 'Extraction Boiler', value: '92°C', detail: 'Normal operating range 90-96', icon: Flame },
                  { label: 'Pump Pressure', value: '9.0 Bar', detail: 'Consistent extraction force', icon: Activity },
                  { label: 'Maintenance Cycle', value: '15 Days Left', detail: 'Last: 2026-06-15', icon: Wrench }
                ].map((item, idx) => {
                  const Icon = item.icon;
                  return (
                    <div key={idx} className="bg-white rounded-2xl p-5 border border-slate-200/60 shadow-sm flex items-center gap-4">
                      <div className="p-3 bg-cream border border-gold/20 rounded-2xl">
                        <Icon className="w-6 h-6 text-coffee" />
                      </div>
                      <div className="text-left leading-tight">
                        <span className="text-[10px] uppercase font-bold text-slate-400 block">{item.label}</span>
                        <span className="text-xl font-black text-slate-800 block mt-1">{item.value}</span>
                        <span className="text-[10px] text-slate-400 font-medium block mt-1">{item.detail}</span>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Error logs */}
              <div className="bg-white border border-slate-200/60 rounded-2xl shadow-sm p-5">
                <h3 className="font-extrabold text-sm text-slate-800 uppercase tracking-tight mb-4">Diagnostics Machine Logs</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200 text-xs font-bold text-slate-400 uppercase">
                        <th className="pb-3 font-semibold">Log Code</th>
                        <th className="pb-3 font-semibold">Severity</th>
                        <th className="pb-3 font-semibold">Message</th>
                        <th className="pb-3 font-semibold">Timestamp</th>
                      </tr>
                    </thead>
                    <tbody className="text-xs font-medium text-slate-600 divide-y divide-slate-100">
                      {[
                        { code: 'ERR-024', level: 'Info', msg: 'Grinder burrs auto-calibration successfully executed', time: 'Today, 14:32' },
                        { code: 'ERR-011', level: 'Warning', msg: 'Milk refrigeration cycle high threshold temp trigger (4.5°C)', time: 'Yesterday, 19:10' },
                        { code: 'ERR-005', level: 'Info', msg: 'System self-rinse cycles finished successfully', time: 'Yesterday, 08:00' },
                        { code: 'ERR-001', level: 'System', msg: 'Telemetry module heartbeat reconnected successfully', time: '2026-06-19, 11:24' }
                      ].map((log, idx) => (
                        <tr key={idx} className="hover:bg-slate-50/50">
                          <td className="py-3 font-mono font-bold text-slate-800">{log.code}</td>
                          <td className="py-3">
                            <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider ${log.level === 'Warning' ? 'bg-amber-50 text-amber-700 border border-amber-200' :
                                log.level === 'System' ? 'bg-blue-50 text-blue-700 border border-blue-200' :
                                  'bg-slate-50 text-slate-600 border border-slate-200'
                              }`}>
                              {log.level}
                            </span>
                          </td>
                          <td className="py-3 text-slate-700">{log.msg}</td>
                          <td className="py-3 font-mono text-slate-400">{log.time}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: ORDERS */}
          {activeTab === 'ORDERS' && (
            <div className="bg-white border border-slate-200/60 rounded-2xl shadow-sm p-6 space-y-4">
              <div className="flex justify-between items-center">
                <div>
                  <h3 className="font-extrabold text-lg text-slate-800">Order Logs & History</h3>
                  <p className="text-xs text-slate-400 mt-1">Full transaction database from local kiosk operations</p>
                </div>

                {/* Search query */}
                <div className="relative w-64">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 transform -translate-y-1/2" />
                  <input
                    type="text"
                    value={orderQuery}
                    onChange={(e) => setOrderQuery(e.target.value)}
                    placeholder="Search by ID or Drink..."
                    className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-xl text-xs font-semibold placeholder:text-slate-400 focus:outline-none focus:border-coffee"
                  />
                </div>
              </div>

              {/* Data Table */}
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 text-xs font-bold text-slate-400 uppercase">
                      <th className="pb-3 font-semibold">Order ID</th>
                      <th className="pb-3 font-semibold">Beverage</th>
                      <th className="pb-3 font-semibold">Size</th>
                      <th className="pb-3 font-semibold">Price</th>
                      <th className="pb-3 font-semibold">Payment</th>
                      <th className="pb-3 font-semibold">Order Status</th>
                      <th className="pb-3 font-semibold">Timestamp</th>
                    </tr>
                  </thead>
                  <tbody className="text-xs font-medium text-slate-600 divide-y divide-slate-100">
                    {filteredOrders.length > 0 ? (
                      filteredOrders.map((order) => (
                        <tr key={order.id} className="hover:bg-slate-50/50">
                          <td className="py-3 font-mono font-bold text-slate-800">{order.id}</td>
                          <td className="py-3 text-slate-900 font-bold">{order.name}</td>
                          <td className="py-3">{order.size}</td>
                          <td className="py-3 font-bold text-slate-800">₹{order.price}</td>
                          <td className="py-3">
                            <span className="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider bg-emerald-50 text-emerald-700 border border-emerald-200">
                              Paid
                            </span>
                          </td>
                          <td className="py-3">
                            <span className="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider bg-blue-50 text-blue-700 border border-blue-200">
                              Completed
                            </span>
                          </td>
                          <td className="py-3 font-mono text-slate-400">{order.time}</td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan="7" className="py-8 text-center text-slate-400 font-bold">
                          No transactions found matching query.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* TAB 5: ANALYTICS */}
          {activeTab === 'ANALYTICS' && (
            <div className="space-y-6">
              {/* Top Row: Weekly and Best Seller Distribution */}
              <div className="grid grid-cols-3 gap-6">
                {/* Weekly Sales Chart */}
                <div className="col-span-2 bg-white border border-slate-200/60 rounded-2xl p-5 shadow-sm space-y-4">
                  <div>
                    <h3 className="font-extrabold text-sm text-slate-800 uppercase tracking-tight">Weekly Sales Trend</h3>
                    <p className="text-[10px] text-slate-400 font-medium">Gross revenue generated per weekday</p>
                  </div>
                  {/* SVG Custom Responsive Bar Chart */}
                  <div className="h-48 flex items-end justify-between px-2 pt-4 relative">
                    {/* Background Grid Lines */}
                    <div className="absolute inset-x-0 top-4 bottom-8 flex flex-col justify-between pointer-events-none opacity-40">
                      <div className="border-t border-dashed border-slate-200 w-full" />
                      <div className="border-t border-dashed border-slate-200 w-full" />
                      <div className="border-t border-dashed border-slate-200 w-full" />
                    </div>

                    {weeklyData.map((d, i) => {
                      // Max sales is 1100, height scaling factor
                      const barHeight = (d.sales / 1100) * 100;
                      return (
                        <div key={i} className="flex flex-col items-center gap-1.5 flex-grow relative z-10 group">
                          {/* Hover Tooltip tooltip */}
                          <div className="absolute -top-6 bg-coffee-dark text-cream-light text-[9px] font-bold px-1.5 py-0.5 rounded shadow-md opacity-0 group-hover:opacity-100 transition-opacity">
                            ₹{d.sales}
                          </div>
                          {/* Bar Track */}
                          <div className="w-8 bg-cream hover:bg-gold-light rounded-t-md transition-colors relative flex items-end overflow-hidden" style={{ height: '120px' }}>
                            <div
                              className="w-full bg-gradient-to-t from-coffee to-coffee-light rounded-t-md transition-all duration-700"
                              style={{ height: `${barHeight}%` }}
                            />
                          </div>
                          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{d.day}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Best Selling Beverages */}
                <div className="col-span-1 bg-white border border-slate-200/60 rounded-2xl p-5 shadow-sm flex flex-col justify-between">
                  <h3 className="font-extrabold text-sm text-slate-800 uppercase tracking-tight mb-4">Beverages Share</h3>
                  <div className="space-y-4 flex-grow">
                    {bestSellers.map((item, idx) => (
                      <div key={idx} className="space-y-1.5">
                        <div className="flex justify-between items-center text-xs font-bold text-slate-600">
                          <span>{item.name}</span>
                          <span className="text-slate-800">{item.percentage}%</span>
                        </div>
                        <div className="w-full h-2.5 bg-slate-100 rounded-full overflow-hidden border border-slate-200">
                          <div className={`h-full ${item.color} rounded-full`} style={{ width: `${item.percentage}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="bg-cream-light/60 p-2.5 rounded-xl border border-cream text-center text-xs text-coffee font-semibold mt-4">
                    Top item: <span className="text-coffee-dark font-black">Classic Coffee</span>
                  </div>
                </div>
              </div>

              {/* Monthly Revenue History */}
              <div className="bg-white border border-slate-200/60 rounded-2xl p-5 shadow-sm space-y-4">
                <div>
                  <h3 className="font-extrabold text-sm text-slate-800 uppercase tracking-tight">Monthly Vending Revenue</h3>
                  <p className="text-[10px] text-slate-400 font-medium">Monthly gross collection overview (H1 2026)</p>
                </div>
                {/* SVG Line Chart representing monthly trends */}
                <div className="h-32 flex items-end justify-between px-2 pt-4 relative">
                  {/* Background grid */}
                  <div className="absolute inset-x-0 top-2 bottom-8 flex flex-col justify-between pointer-events-none opacity-40">
                    <div className="border-t border-dashed border-slate-200 w-full" />
                    <div className="border-t border-dashed border-slate-200 w-full" />
                  </div>

                  {monthlyData.map((d, i) => {
                    // Max is 25000
                    const barHeight = (d.sales / 25000) * 100;
                    return (
                      <div key={i} className="flex flex-col items-center gap-1.5 flex-grow relative z-10 group">
                        <div className="absolute -top-6 bg-coffee-dark text-cream-light text-[9px] font-bold px-1.5 py-0.5 rounded shadow-md opacity-0 group-hover:opacity-100 transition-opacity">
                          ₹{d.sales}
                        </div>
                        <div className="w-12 bg-slate-50 hover:bg-slate-100 rounded-t-md transition-colors relative flex items-end overflow-hidden" style={{ height: '80px' }}>
                          <div
                            className="w-full bg-gradient-to-t from-emerald-700 to-emerald-500 rounded-t-sm transition-all duration-700"
                            style={{ height: `${barHeight}%` }}
                          />
                        </div>
                        <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{d.month}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* TAB 6: SETTINGS */}
          {activeTab === 'SETTINGS' && (
            <div className="grid grid-cols-3 gap-6">
              {/* Left Panel: Pricing Adjustments */}
              <div className="col-span-2 bg-white border border-slate-200/60 rounded-2xl p-5 shadow-sm space-y-6">
                <div>
                  <h3 className="font-extrabold text-sm text-slate-800 uppercase tracking-tight">Kiosk Beverage Pricing</h3>
                  <p className="text-xs text-slate-400 mt-1">Configure base retail prices. Changes reflect instantly on customer screens.</p>
                </div>

                <form onSubmit={handleSavePrices} className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-xs font-bold text-slate-500 block mb-1">Classic Coffee Base Price (₹)</label>
                      <input
                        type="number"
                        value={tempPrices.classic}
                        onChange={(e) => setTempPrices({ ...tempPrices, classic: parseInt(e.target.value) || 0 })}
                        className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm font-semibold focus:outline-none focus:border-coffee"
                      />
                    </div>

                    <div>
                      <label className="text-xs font-bold text-slate-500 block mb-1">Vanilla Coffee Base Price (₹)</label>
                      <input
                        type="number"
                        value={tempPrices.vanilla}
                        onChange={(e) => setTempPrices({ ...tempPrices, vanilla: parseInt(e.target.value) || 0 })}
                        className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm font-semibold focus:outline-none focus:border-coffee"
                      />
                    </div>

                    <div>
                      <label className="text-xs font-bold text-slate-500 block mb-1">Hazelnut Coffee Base Price (₹)</label>
                      <input
                        type="number"
                        value={tempPrices.hazelnut}
                        onChange={(e) => setTempPrices({ ...tempPrices, hazelnut: parseInt(e.target.value) || 0 })}
                        className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm font-semibold focus:outline-none focus:border-coffee"
                      />
                    </div>
                  </div>

                  {settingsSuccess && (
                    <div className="p-3 bg-emerald-50 text-emerald-700 text-xs font-bold rounded-xl border border-emerald-100 flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4" />
                      <span>Beverage retail pricing updated successfully!</span>
                    </div>
                  )}

                  <button
                    type="submit"
                    className="py-2.5 px-6 bg-coffee text-cream-light font-bold text-xs rounded-xl shadow-md hover:bg-coffee-dark transition-all active:scale-95 active-touch-feedback"
                  >
                    Save Price Configurations
                  </button>
                </form>
              </div>

              {/* Right Panel: Vending Locks & Modes */}
              <div className="col-span-1 bg-white border border-slate-200/60 rounded-2xl p-5 shadow-sm flex flex-col justify-between">
                <div>
                  <h3 className="font-extrabold text-sm text-slate-800 uppercase tracking-tight mb-4">System Overrides</h3>

                  <div className="space-y-4">
                    {/* Maintenance mode switch */}
                    <div className="flex justify-between items-center p-3 bg-amber-50 rounded-xl border border-amber-100">
                      <div className="text-left">
                        <span className="text-xs font-bold text-amber-800 block">Maintenance Mode</span>
                        <span className="text-[10px] text-amber-700/80 block mt-0.5">Locks client screen</span>
                      </div>
                      <button
                        onClick={onToggleMaintenance}
                        className={`w-11 h-6 flex items-center rounded-full p-0.5 cursor-pointer transition-all duration-300 border ${maintenanceMode
                            ? 'bg-amber-600 border-amber-600 justify-end'
                            : 'bg-slate-200 border-slate-300 justify-start'
                          }`}
                      >
                        <span className="w-5 h-5 rounded-full bg-white shadow-md block" />
                      </button>
                    </div>

                    {/* Auto rinse override toggle */}
                    <div className="flex justify-between items-center p-3 bg-slate-50 rounded-xl border border-slate-100">
                      <div className="text-left">
                        <span className="text-xs font-bold text-slate-700 block">Eco Idle Saver</span>
                        <span className="text-[10px] text-slate-400 block mt-0.5">Reduces boiler power</span>
                      </div>
                      <button className="w-11 h-6 flex items-center rounded-full p-0.5 cursor-not-allowed bg-slate-200 border border-slate-300 justify-start">
                        <span className="w-5 h-5 rounded-full bg-white shadow-md block" />
                      </button>
                    </div>
                  </div>
                </div>

                <div className="text-[10px] text-slate-400 text-center font-semibold pt-4 mt-4 border-t border-slate-100 uppercase tracking-wider">
                  Firmware version: v1.4.12-Rpi
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
