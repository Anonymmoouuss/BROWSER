"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Laptop, RefreshCw, ShieldOff } from "lucide-react";
import { accessRequest } from "./access-client";

interface DeviceRequest {
  id: string;
  rpId: string;
  approved: boolean;
  owner: boolean;
  backedUp: boolean;
  requestAddress: string | null;
  requestAgent: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  user: { name: string; role: string; status: string };
}

export default function DeviceAccessPanel() {
  const [devices, setDevices] = useState<DeviceRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const result = await accessRequest("devices", {}, true);
      setDevices(Array.isArray(result.devices) ? result.devices as DeviceRequest[] : []);
      setMessage("");
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { queueMicrotask(() => void refresh()); }, [refresh]);

  const change = async (device: DeviceRequest, approve: boolean) => {
    if (!approve && !window.confirm(`Revoke this passkey for ${device.user.name}? Existing member sessions will be revoked.`)) return;
    setBusy(true);
    try {
      await accessRequest(approve ? "approve-device" : "revoke-device", { id: device.id }, true);
      await refresh();
    } catch (error) { setMessage((error as Error).message); setBusy(false); }
  };

  return (
    <section aria-label="Device access" className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-zinc-100">Device access</h2>
        <button type="button" onClick={() => void refresh()} disabled={busy} className="inline-flex h-9 items-center gap-2 rounded-lg border border-zinc-700 px-3 text-xs text-zinc-300 disabled:opacity-50"><RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} aria-hidden="true" /> Refresh devices</button>
      </div>
      <p className="text-xs leading-relaxed text-zinc-500">Approval belongs to the passkey, not an IP address. Synced passkeys may work on more than one device; network addresses can change or be shared.</p>
      {message && <p role="status" className="text-sm text-amber-200">{message}</p>}
      {!devices.length && !busy && <p className="py-6 text-sm text-zinc-500">No passkeys have been registered.</p>}
      <div className="divide-y divide-zinc-800">
        {devices.map((device) => <article key={device.id} className="py-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3"><Laptop className="h-5 w-5 shrink-0 text-zinc-500" aria-hidden="true" /><div className="min-w-0"><h3 className="break-words text-sm font-medium text-zinc-100">{device.user.name}</h3><p className="mt-1 text-xs text-zinc-500">{device.rpId} · {device.owner ? "Owner" : device.approved ? "Approved" : "Approval required"} · {device.backedUp ? "Synced passkey" : "Device credential"}</p></div></div>
            {!device.owner && <button type="button" disabled={busy || (device.user.status !== "pending" && device.user.status !== "approved")} onClick={() => void change(device, !device.approved)} className={`inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-xs disabled:opacity-40 ${device.approved ? "border-red-500/30 text-red-300" : "border-emerald-400/30 text-emerald-300"}`}>{device.approved ? <ShieldOff className="h-3.5 w-3.5" aria-hidden="true" /> : <Check className="h-3.5 w-3.5" aria-hidden="true" />}{device.approved ? "Revoke passkey" : "Approve passkey"}</button>}
          </div>
          <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2"><div><dt className="text-zinc-600">Observed IP</dt><dd className="mt-1 break-all font-mono text-zinc-400">{device.requestAddress || "Not recorded"}</dd></div><div><dt className="text-zinc-600">Last verified</dt><dd className="mt-1 text-zinc-400">{new Date(device.lastUsedAt ?? device.createdAt).toLocaleString()}</dd></div></dl>
          {device.requestAgent && <p className="mt-3 break-words text-[11px] leading-relaxed text-zinc-600">{device.requestAgent}</p>}
        </article>)}
      </div>
    </section>
  );
}