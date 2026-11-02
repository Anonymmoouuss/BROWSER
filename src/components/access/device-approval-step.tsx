"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Laptop, RefreshCw } from "lucide-react";
import { accessRequest } from "./access-client";

export default function DeviceApprovalStep({ receipt, onBack }: { receipt: string; onBack: () => void }) {
  const [approved, setApproved] = useState(false);
  const [message, setMessage] = useState("");
  const [checking, setChecking] = useState(false);
  const pending = useRef(false);
  const check = useCallback(async (signal?: AbortSignal) => {
    if (pending.current) return;
    pending.current = true;
    setChecking(true);
    try {
      const result = await accessRequest("device-status", { receipt }, false, signal);
      if (signal?.aborted) return;
      setApproved(result.status === "approved");
      setMessage("");
    } catch (error) {
      if (!signal?.aborted) setMessage(error instanceof Error ? error.message : "Could not check approval.");
    } finally { pending.current = false; if (!signal?.aborted) setChecking(false); }
  }, [receipt]);

  useEffect(() => {
    const controller = new AbortController();
    const poll = () => { if (document.visibilityState !== "hidden") void check(controller.signal); };
    queueMicrotask(() => { if (!controller.signal.aborted) poll(); });
    const timer = setInterval(poll, 15_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [check]);

  return (
    <div className="space-y-5">
      {approved ? <CheckCircle2 className="h-9 w-9 text-emerald-300" aria-hidden="true" /> : <Laptop className="h-9 w-9 text-zinc-500" aria-hidden="true" />}
      <h1 className="text-xl font-semibold text-zinc-100">{approved ? "Access approved" : "Owner approval required"}</h1>
      <p className="text-sm leading-relaxed text-zinc-400">{approved ? "Your passkey has been approved. Sign in again to open the workspace." : "Your identity was verified. The workspace owner must approve this passkey before browsing is allowed."}</p>
      {!approved && <button type="button" disabled={checking} onClick={() => void check()} className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-zinc-700 text-sm text-zinc-300 disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${checking ? "animate-spin" : ""}`} aria-hidden="true" /> Check approval</button>}
      {message && <p role="status" className="text-xs text-amber-200">{message}</p>}
      <button type="button" onClick={onBack} className="h-10 w-full rounded-lg bg-emerald-300 text-sm font-semibold text-zinc-950">Return to sign-in</button>
    </div>
  );
}