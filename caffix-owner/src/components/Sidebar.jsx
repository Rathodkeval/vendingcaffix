import React, { useState } from 'react';
import {
  LayoutDashboard,
  Cpu,
  Sliders,
  Tag,
  ShoppingBag,
  BarChart3,
  ShieldCheck,
  LogOut,
  Menu,
  X,
  KeyRound,
  RefreshCw
} from 'lucide-react';

export default function Sidebar({
  activeTab,
  setActiveTab,
  user,
  machinesCount,
  onLogout,
  onRefresh,
  refreshing,
  onOpenPasswordModal
}) {
  const [mobileOpen, setMobileOpen] = useState(false);

  const navItems = [
    { id: 'overview', label: 'Overview', icon: LayoutDashboard },
    { id: 'machines', label: 'My Machines', icon: Cpu, badge: machinesCount },
    { id: 'machine-details', label: 'Machine Details', icon: Sliders },
    { id: 'pricing', label: 'Products & Pricing', icon: Tag },
    { id: 'orders', label: 'Orders', icon: ShoppingBag },
    { id: 'reports', label: 'Sales Reports', icon: BarChart3 }
  ];

  if (user?.role === 'admin') {
    navItems.push({
      id: 'admin',
      label: 'Fleet & Owners (Admin)',
      icon: ShieldCheck
    });
  }

  const handleSelect = (id) => {
    setActiveTab(id);
    setMobileOpen(false);
  };

  return (
    <>
      {/* Mobile Header Bar */}
      <header className="lg:hidden sticky top-0 z-30 flex items-center justify-between px-4 py-3 bg-[#2C1E17] text-white border-b border-[#4E3629]">
        <div className="flex items-center gap-2.5">
          <img
            src="/assets/logo.png"
            alt="CAFFIX"
            className="w-8 h-8 rounded-lg object-contain bg-[#FAF6F0] p-0.5"
          />
          <div>
            <span className="font-display font-bold tracking-wide text-base text-[#FAF6F0]">
              CAFFIX
            </span>
            <span className="ml-1.5 text-[11px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-[#C9A66B]/20 text-[#DCC39A] font-semibold">
              {user?.role === 'admin' ? 'Admin' : 'Owner'}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="p-2 rounded-lg text-[#EED9C4] hover:bg-[#4E3629]/60"
            title="Refresh live data"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
          <button
            type="button"
            onClick={() => setMobileOpen(!mobileOpen)}
            className="p-2 rounded-lg text-[#FAF6F0] hover:bg-[#4E3629]"
            aria-label="Toggle navigation"
          >
            {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </header>

      {/* Mobile Backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar Drawer (Mobile) & Fixed Sidebar (Desktop) */}
      <aside
        className={`fixed top-0 left-0 z-50 h-screen w-68 bg-[#2C1E17] text-[#FAF6F0] flex flex-col justify-between border-r border-[#4E3629] transition-transform duration-200 lg:translate-x-0 ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div>
          {/* Brand Header */}
          <div className="px-6 py-5 flex items-center justify-between border-b border-[#4E3629]/80">
            <div className="flex items-center gap-3">
              <img
                src="/assets/logo.png"
                alt="CAFFIX Logo"
                className="w-10 h-10 rounded-xl object-contain bg-[#FAF6F0] p-1 shadow-sm"
              />
              <div>
                <div className="font-display font-extrabold text-lg tracking-wider text-white">
                  CAFFIX
                </div>
                <div className="text-xs text-[#DCC39A] font-medium">
                  Owner Management Portal
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              className="lg:hidden text-[#DCC39A] hover:text-white p-1"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Navigation Links */}
          <nav className="p-4 space-y-1.5">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleSelect(item.id)}
                  className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-sm font-medium transition-all ${
                    isActive
                      ? 'bg-[#C9A66B] text-[#2C1E17] font-semibold shadow-sm'
                      : 'text-[#EED9C4] hover:bg-[#4E3629]/60 hover:text-white'
                  }`}
                >
                  <span className="flex items-center gap-3">
                    <Icon className="w-4 h-4 shrink-0" />
                    <span>{item.label}</span>
                  </span>
                  {item.badge !== undefined && (
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full font-semibold ${
                        isActive
                          ? 'bg-[#2C1E17] text-[#FAF6F0]'
                          : 'bg-[#4E3629] text-[#DCC39A]'
                      }`}
                    >
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        {/* User Footer */}
        <div className="p-4 border-t border-[#4E3629]/80 space-y-3 bg-[#241812]">
          <div className="px-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-white truncate">
                {user?.name || 'CAFFIX Partner'}
              </span>
              <span className="text-[11px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-[#C9A66B]/20 text-[#DCC39A] font-semibold">
                {user?.role || 'owner'}
              </span>
            </div>
            <div className="text-xs text-[#DCC39A]/80 truncate mt-0.5">{user?.email}</div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={onOpenPasswordModal}
              className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold text-[#EED9C4] bg-[#4E3629]/50 hover:bg-[#4E3629] transition-colors"
            >
              <KeyRound className="w-3.5 h-3.5" />
              Password
            </button>
            <button
              type="button"
              onClick={onLogout}
              className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold text-rose-200 bg-rose-950/50 hover:bg-rose-900/70 transition-colors"
            >
              <LogOut className="w-3.5 h-3.5" />
              Sign Out
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}

