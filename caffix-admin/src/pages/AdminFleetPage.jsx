import React, { useState, useEffect } from 'react';
import {
  UserPlus,
  Users,
  Cpu,
  Copy,
  Check,
  AlertCircle,
  CheckCircle2,
  PlusCircle
} from 'lucide-react';
import {
  adminApi,
  buildInviteSetupUrl,
  resolveOwnerPortalUrl
} from '../services/api';

export default function AdminFleetPage({ machines, owners: initialOwners, onRefreshAll }) {
  const [owners, setOwners] = useState(initialOwners || []);
  const [loadingOwners, setLoadingOwners] = useState(false);
  const [inviteName, setInviteName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [selectedMachines, setSelectedMachines] = useState([]);
  const [inviting, setInviting] = useState(false);
  const [inviteResult, setInviteResult] = useState(null);
  const [copied, setCopied] = useState(false);

  // New Machine Registration
  const [newMachId, setNewMachId] = useState('');
  const [newMachName, setNewMachName] = useState('');
  const [newMachLocation, setNewMachLocation] = useState('');
  const [registeringMach, setRegisteringMach] = useState(false);
  const [registeredMachineResult, setRegisteredMachineResult] = useState(null);
  const [copiedKioskLink, setCopiedKioskLink] = useState(false);

  const [assigningMachineId, setAssigningMachineId] = useState('');
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  const ownerPortalBase = resolveOwnerPortalUrl();

  useEffect(() => {
    if (Array.isArray(initialOwners)) {
      setOwners(initialOwners);
    }
  }, [initialOwners]);

  const fetchOwners = async () => {
    setLoadingOwners(true);
    try {
      const res = await adminApi.getOwners();
      setOwners(res.data || []);
    } catch (err) {
      setError(err.message || 'Failed to load owners list.');
    } finally {
      setLoadingOwners(false);
    }
  };

  useEffect(() => {
    fetchOwners();
  }, []);

  const toggleMachineCheckbox = (mId) => {
    setSelectedMachines((prev) =>
      prev.includes(mId) ? prev.filter((id) => id !== mId) : [...prev, mId]
    );
  };

  const handleInviteSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccessMsg('');
    setInviteResult(null);
    setInviting(true);

    try {
      const res = await adminApi.inviteOwner({
        name: inviteName.trim(),
        email: inviteEmail.trim(),
        machine_ids: selectedMachines
      });

      setInviteResult(res.data);
      setSuccessMsg(`Invited ${res.data.user.email} and generated a single-use 24-hour setup token.`);
      setInviteName('');
      setInviteEmail('');
      setSelectedMachines([]);
      await fetchOwners();
      await onRefreshAll();
    } catch (err) {
      setError(err.message || 'Failed to invite owner.');
    } finally {
      setInviting(false);
    }
  };

  const handleAssignOwner = async (machineId, ownerId) => {
    setAssigningMachineId(machineId);
    setError('');
    setSuccessMsg('');
    try {
      await adminApi.assignMachineOwner(machineId, ownerId || null);
      setSuccessMsg(
        ownerId
          ? `Assigned machine ${machineId} to owner ${ownerId}.`
          : `Unassigned machine ${machineId}.`
      );
      await fetchOwners();
      await onRefreshAll();
    } catch (err) {
      setError(err.message || `Failed to update owner for ${machineId}.`);
    } finally {
      setAssigningMachineId('');
    }
  };

  const handleRegisterMachine = async (e) => {
    e.preventDefault();
    setError('');
    setSuccessMsg('');
    setRegisteredMachineResult(null);
    setRegisteringMach(true);
    try {
      const registeredId = newMachId.trim().toUpperCase();
      const res = await adminApi.registerMachine({
        id: registeredId,
        machine_name: newMachName.trim(),
        location: newMachLocation.trim()
      });
      const kioskToken = res?.data?.kiosk_token;
      setRegisteredMachineResult(res?.data || null);
      setSuccessMsg(`Registered new vending machine ${registeredId}.${kioskToken ? ' Dedicated kiosk token generated.' : ''}`);
      setNewMachId('');
      setNewMachName('');
      setNewMachLocation('');
      await onRefreshAll();
    } catch (err) {
      setError(err.message || 'Failed to register machine.');
    } finally {
      setRegisteringMach(false);
    }
  };

  const handleCopyKioskLaunchLink = () => {
    if (!registeredMachineResult?.kiosk_token) return;
    const kioskBase =
      typeof window !== 'undefined' &&
      (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
        ? 'http://localhost:5173'
        : 'https://vendingcaffix.vercel.app';
    const launchUrl = `${kioskBase}/?kiosk=${encodeURIComponent(
      registeredMachineResult.kiosk_token
    )}&machine_id=${encodeURIComponent(registeredMachineResult.id)}`;
    navigator.clipboard?.writeText(launchUrl);
    setCopiedKioskLink(true);
    setTimeout(() => setCopiedKioskLink(false), 2500);
  };

  const handleCopyInviteLink = () => {
    if (!inviteResult?.invite_token) return;
    const url = buildInviteSetupUrl(
      ownerPortalBase,
      inviteResult.invite_token,
      inviteResult.user?.email || ''
    );
    navigator.clipboard?.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  const ownerMap = new Map(owners.map((o) => [String(o.id), o]));

  return (
    <div className="space-y-8">
      <div>
        <h2 className="font-display text-xl font-bold text-[#2C1E17]">
          Fleet & Owner Administration
        </h2>
        <p className="text-xs text-slate-500 mt-0.5">
          Super Admin controls: invite customer owners with single-use SHA-256 tokens, assign or
          unassign machines in real time, and register new vending kiosks.
        </p>
      </div>

      {error && (
        <div className="p-4 rounded-xl bg-red-50 border border-red-200 text-red-700 text-xs font-semibold flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {successMsg && (
        <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-semibold flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{successMsg}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Invite Customer Owner Form */}
        <div className="bg-white rounded-2xl border border-[#EED9C4] p-6 shadow-xs space-y-4">
          <div className="flex items-center gap-2.5">
            <div className="p-2.5 rounded-xl bg-[#4E3629] text-white">
              <UserPlus className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-display text-base font-bold text-[#2C1E17]">
                Invite Customer Owner
              </h3>
              <p className="text-xs text-slate-500">
                Generates a single-use 24-hour invitation token targeting the Owner Portal
              </p>
            </div>
          </div>

          <form onSubmit={handleInviteSubmit} className="space-y-3.5 pt-2">
            <div>
              <label className="block text-xs font-semibold text-[#4E3629] mb-1">
                Owner / Company Name
              </label>
              <input
                type="text"
                required
                value={inviteName}
                onChange={(e) => setInviteName(e.target.value)}
                placeholder="e.g. Apex Corporate Cafes"
                className="w-full px-3.5 py-2 rounded-xl border border-[#EED9C4] bg-[#FAF6F0]/50 text-sm"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#4E3629] mb-1">
                Owner Email Address
              </label>
              <input
                type="email"
                required
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="partner@company.com"
                className="w-full px-3.5 py-2 rounded-xl border border-[#EED9C4] bg-[#FAF6F0]/50 text-sm"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#4E3629] mb-1.5">
                Assign Initial Machines (Optional)
              </label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {machines.map((m) => (
                  <label
                    key={m.id}
                    className={`flex items-center gap-2 p-2.5 rounded-xl border text-xs font-semibold cursor-pointer ${
                      selectedMachines.includes(m.id)
                        ? 'border-[#4E3629] bg-[#FAF6F0] text-[#2C1E17]'
                        : 'border-[#EED9C4] text-slate-600'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedMachines.includes(m.id)}
                      onChange={() => toggleMachineCheckbox(m.id)}
                    />
                    <span>{m.id}</span>
                  </label>
                ))}
              </div>
            </div>

            <button
              type="submit"
              disabled={inviting}
              className="w-full py-2.5 px-4 rounded-xl bg-[#4E3629] hover:bg-[#2C1E17] text-white text-xs font-semibold transition-colors cursor-pointer"
            >
              {inviting ? 'Generating Invite Token...' : 'Create Owner & Generate Invite Token'}
            </button>
          </form>

          {inviteResult && (
            <div className="mt-4 p-4 rounded-xl bg-amber-50 border border-amber-200 space-y-2 text-xs">
              <div className="font-bold text-amber-900">
                Single-Use Invitation Token (Expires in 24h):
              </div>
              <div className="font-mono text-[11px] break-all bg-white p-2.5 rounded-lg border border-amber-200 text-[#2C1E17]">
                {inviteResult.invite_token}
              </div>
              <div className="text-[11px] text-amber-800">
                Setup link target: <span className="font-mono font-semibold">{ownerPortalBase}</span>
              </div>
              <button
                type="button"
                onClick={handleCopyInviteLink}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#4E3629] text-white font-semibold text-xs cursor-pointer"
              >
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? 'Copied Setup URL!' : 'Copy Owner Setup Link'}
              </button>
            </div>
          )}
        </div>

        {/* Register New Machine Form */}
        <div className="bg-white rounded-2xl border border-[#EED9C4] p-6 shadow-xs space-y-4">
          <div className="flex items-center gap-2.5">
            <div className="p-2.5 rounded-xl bg-[#C9A66B] text-[#2C1E17]">
              <PlusCircle className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-display text-base font-bold text-[#2C1E17]">
                Register New Vending Machine
              </h3>
              <p className="text-xs text-slate-500">
                Add a new CAFFIX kiosk unit to Firestore and initialize its estimated inventory
              </p>
            </div>
          </div>

          <form onSubmit={handleRegisterMachine} className="space-y-3.5 pt-2">
            <div>
              <label className="block text-xs font-semibold text-[#4E3629] mb-1">
                Machine ID (Format: CFX-MC-XX)
              </label>
              <input
                type="text"
                required
                value={newMachId}
                onChange={(e) => setNewMachId(e.target.value)}
                placeholder="e.g. CFX-MC-05"
                className="w-full px-3.5 py-2 rounded-xl border border-[#EED9C4] bg-[#FAF6F0]/50 text-sm font-mono"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#4E3629] mb-1">
                Machine Display Name
              </label>
              <input
                type="text"
                required
                value={newMachName}
                onChange={(e) => setNewMachName(e.target.value)}
                placeholder="e.g. Kiosk-Five"
                className="w-full px-3.5 py-2 rounded-xl border border-[#EED9C4] bg-[#FAF6F0]/50 text-sm"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#4E3629] mb-1">
                Installation Location
              </label>
              <input
                type="text"
                required
                value={newMachLocation}
                onChange={(e) => setNewMachLocation(e.target.value)}
                placeholder="e.g. Cyber Hub Tower B"
                className="w-full px-3.5 py-2 rounded-xl border border-[#EED9C4] bg-[#FAF6F0]/50 text-sm"
              />
            </div>

            <button
              type="submit"
              disabled={registeringMach}
              className="w-full py-2.5 px-4 rounded-xl bg-[#C9A66B] hover:bg-[#B08E55] text-[#2C1E17] text-xs font-bold transition-colors cursor-pointer"
            >
              {registeringMach ? 'Registering Machine...' : 'Register Vending Machine'}
            </button>
          </form>

          {registeredMachineResult && (
            <div className="mt-4 p-4 rounded-xl bg-emerald-50 border border-emerald-200 space-y-2 text-xs">
              <div className="font-bold text-emerald-900 flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>Machine {registeredMachineResult.id} Registered Successfully</span>
              </div>
              {registeredMachineResult.kiosk_token && (
                <>
                  <div className="text-[11px] text-emerald-800">
                    Dedicated Kiosk Token (Stored in Firestore):
                  </div>
                  <div className="font-mono text-[11px] break-all bg-white p-2 rounded-lg border border-emerald-200 text-[#2C1E17]">
                    {registeredMachineResult.kiosk_token}
                  </div>
                  <button
                    type="button"
                    onClick={handleCopyKioskLaunchLink}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#2C1E17] text-[#FAF6F0] font-semibold text-xs cursor-pointer hover:bg-[#4E3629]"
                  >
                    {copiedKioskLink ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    {copiedKioskLink ? 'Copied Launch Link!' : 'Copy Kiosk Launch Link'}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Live Machine Ownership Assignment Table */}
      <div className="bg-white rounded-2xl border border-[#EED9C4] shadow-xs overflow-hidden">
        <div className="px-6 py-4 border-b border-[#EED9C4] flex items-center justify-between">
          <div>
            <h3 className="font-display text-base font-bold text-[#2C1E17] flex items-center gap-2">
              <Cpu className="w-4 h-4 text-[#4E3629]" />
              Machine Ownership Assignments
            </h3>
            <p className="text-xs text-slate-500">
              Reassigning or unassigning a machine takes effect immediately on the next API call.
            </p>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-[#FAF6F0] text-[11px] font-semibold uppercase tracking-wider text-[#8C6246] border-b border-[#EED9C4]">
                <th className="py-3.5 px-5">Machine</th>
                <th className="py-3.5 px-5">Location</th>
                <th className="py-3.5 px-5">Current Owner</th>
                <th className="py-3.5 px-5">Assign / Unassign Owner</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#EED9C4]/60 text-sm">
              {machines.map((m) => {
                const matchedOwner = m.owner_id ? ownerMap.get(String(m.owner_id)) : null;
                return (
                  <tr key={m.id} className="hover:bg-[#FAF6F0]/50">
                    <td className="py-3.5 px-5">
                      <div className="font-bold text-[#2C1E17]">{m.machine_name}</div>
                      <div className="text-xs font-mono text-[#8C6246]">{m.id}</div>
                    </td>
                    <td className="py-3.5 px-5 text-xs text-slate-600">{m.location}</td>
                    <td className="py-3.5 px-5 text-xs">
                      {m.owner_id ? (
                        <div>
                          <div className="font-semibold text-[#2C1E17]">
                            {matchedOwner ? matchedOwner.name : 'Assigned Owner'}
                          </div>
                          <div className="font-mono text-[11px] text-slate-500">{m.owner_id}</div>
                        </div>
                      ) : (
                        <span className="text-slate-400 italic">Unassigned</span>
                      )}
                    </td>
                    <td className="py-3.5 px-5">
                      <select
                        disabled={assigningMachineId === m.id}
                        value={m.owner_id || ''}
                        onChange={(e) => handleAssignOwner(m.id, e.target.value || null)}
                        className="px-3 py-1.5 rounded-xl border border-[#EED9C4] bg-[#FAF6F0] text-xs font-semibold text-[#2C1E17]"
                      >
                        <option value="">— Unassigned —</option>
                        {owners.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.name} ({o.email})
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Registered Owners Directory */}
      <div className="bg-white rounded-2xl border border-[#EED9C4] shadow-xs overflow-hidden">
        <div className="px-6 py-4 border-b border-[#EED9C4]">
          <h3 className="font-display text-base font-bold text-[#2C1E17] flex items-center gap-2">
            <Users className="w-4 h-4 text-[#4E3629]" />
            Registered Owner Accounts ({owners.length})
          </h3>
        </div>

        {loadingOwners && owners.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-500">Loading owners...</div>
        ) : owners.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-500">
            No customer owner accounts created yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-[#FAF6F0] text-[11px] font-semibold uppercase tracking-wider text-[#8C6246] border-b border-[#EED9C4]">
                  <th className="py-3 px-5">Owner Name</th>
                  <th className="py-3 px-5">Email</th>
                  <th className="py-3 px-5">Account Status</th>
                  <th className="py-3 px-5">Assigned Machines</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#EED9C4]/60 text-sm">
                {owners.map((owner) => (
                  <tr key={owner.id} className="hover:bg-[#FAF6F0]/50">
                    <td className="py-3 px-5">
                      <div className="font-bold text-[#2C1E17]">{owner.name}</div>
                      <div className="text-[11px] font-mono text-slate-400">{owner.id}</div>
                    </td>
                    <td className="py-3 px-5 text-xs text-slate-600">{owner.email}</td>
                    <td className="py-3 px-5">
                      <span
                        className={`inline-flex px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                          owner.must_change_password || owner.setup_pending
                            ? 'bg-amber-50 text-amber-800 border border-amber-200'
                            : 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                        }`}
                      >
                        {owner.must_change_password || owner.setup_pending
                          ? 'Invite Pending Setup'
                          : 'Active'}
                      </span>
                    </td>
                    <td className="py-3 px-5 text-xs font-mono text-[#4E3629]">
                      {(owner.assigned_machines || []).length > 0
                        ? owner.assigned_machines.join(', ')
                        : 'None'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

