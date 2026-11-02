"use client";

/**
 * AdminPanel — SCRM-style administration (port of auth/admin.ts +
 * auth/payments.ts): approve/reject/revoke/delete face enrollments and
 * confirm A$5 monthly payments. Rendered inside the access gate.
 */

import { useCallback, useEffect, useState } from "react";
import {
  BadgeCheck,
  Ban,
  CreditCard,
  Lock,
  Laptop,
  RefreshCw,
  ShieldOff,
  Trash2,
  Users,
} from "lucide-react";
import { accessAuthHeaders, accessRequest, downloadText } from "./access-client";
import { billingPeriodAt } from "@/lib/access/billing";
import DeviceAccessPanel from "./device-access-panel";

/** GET /api/admin with the header-token fallback (plain fetch would lose
 *  the session in the cookie-blocked preview iframe). */
async function adminList(): Promise<{ users?: Enrollment[]; error?: string }> {
  const response = await fetch("/api/admin", {
    cache: "no-store",
    credentials: "same-origin",
    headers: accessAuthHeaders(),
  });
  const body = (await response.json().catch(() => null)) as
    | { users?: Enrollment[]; error?: string }
    | null;
  if (!response.ok) throw new Error(body?.error ?? "Failed to load enrollments.");
  return { users: body?.users ?? [] };
}

type Enrollment = {
  id: string;
  name: string;
  status: string;
  created: string;
  preview: string | null;
};

type Payment = {
  period: number;
  start: string;
  end: string;
  amountCents: number;
  confirmedAt: string;
};

type Member = {
  id: string;
  name: string;
  status: string;
  created: string;
  payment: { period: number; start: string; end: string; paid: boolean };
  payments: Payment[];
};

const dateFmt = (value: string) =>
  new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const range = (p: { start: string; end: string }) => `${dateFmt(p.start)} - ${dateFmt(p.end)}`;

export default function AdminPanel({
  onLock,
  recoveryCodes,
}: {
  onLock: () => void;
  recoveryCodes?: string[];
}) {
  const [tab, setTab] = useState<"enrollments" | "payments" | "devices">("enrollments");
  const [status, setStatus] = useState("");
  const [enrollments, setEnrollments] = useState<Enrollment[] | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | undefined>(recoveryCodes);

  const refreshEnrollments = useCallback(async () => {
    setBusy(true);
    setStatus("Loading enrollment requests...");
    try {
      const body = await adminList();
      setEnrollments(body.users ?? []);
      setStatus("");
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  const refreshPayments = useCallback(async () => {
    setBusy(true);
    setStatus("Loading payments...");
    try {
      const result = (await accessRequest("payments", {}, true)) as { users?: Member[] };
      setMembers(result.users ?? []);
      const due = (result.users ?? []).filter((u) => u.status === "approved" && !u.payment.paid);
      setStatus(
        `${due.length} approved member${due.length === 1 ? "" : "s"} need payment confirmation.`,
      );
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      if (tab === "enrollments" && enrollments === null) void refreshEnrollments();
      if (tab === "payments" && members === null) void refreshPayments();
    });
    return () => { active = false; };
  }, [tab, enrollments, members, refreshEnrollments, refreshPayments]);

  const act = async (action: string, id: string) => {
    if (
      ["revoke", "delete"].includes(action) &&
      !window.confirm(
        `${action === "delete" ? "Permanently delete" : "Revoke access for"} this member?`,
      )
    )
      return;
    setBusy(true);
    setStatus("Updating...");
    try {
      await accessRequest(action, { id }, true);
      setStatus("Saved.");
      setEnrollments(null);
      setMembers(null);
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      // never leave the action buttons permanently disabled after a success
      setBusy(false);
    }
  };

  const confirmPayment = async (id: string, period: number) => {
    setBusy(true);
    setStatus("Confirming payment...");
    try {
      await accessRequest("confirm-payment", { id, period }, true);
      await refreshPayments();
    } catch (error) {
      setStatus((error as Error).message);
      setBusy(false);
    }
  };

  const button =
    "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed";

  return (
    <div className="cw-scroll cw-backdrop min-h-screen w-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-6 py-10 sm:py-14">
        <header className="mb-6">
          <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-emerald-400">
            <ShieldOff className="h-3.5 w-3.5" aria-hidden="true" /> Secure workspace
          </p>
          <h1 className="text-2xl font-semibold text-zinc-100">Admin Panel</h1>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-zinc-500">
            Approve face enrollments here, then confirm each member&apos;s A$5 monthly payment in
            Payments. Both are required for access; names are self-reported.
          </p>
        </header>

        {codes && codes.length > 0 && (
          <section
            className="mb-6 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-5"
            aria-label="Recovery codes"
          >
            <h2 className="text-base font-semibold text-amber-200">Save your recovery codes</h2>
            <p className="mt-1 text-xs leading-relaxed text-amber-200/70">
              These codes are shown once. Each code can replace your admin face enrollment together
              with your admin password. Keep them offline.
            </p>
            <textarea
              readOnly
              value={codes.join("\n")}
              rows={8}
              aria-label="Recovery codes"
              className="mt-3 w-full rounded-xl border border-amber-500/30 bg-zinc-950/70 p-3 font-mono text-xs text-amber-100"
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => downloadText("scramjet-admin-recovery.txt", codes.join("\n"))}
                className={`${button} border-amber-500/40 text-amber-200 hover:bg-amber-500/10`}
              >
                Download recovery codes
              </button>
              <button
                type="button"
                onClick={() => {
                  setCodes(undefined);
                }}
                className={`${button} border-zinc-700 text-zinc-300 hover:bg-zinc-800/60`}
              >
                I have saved these codes
              </button>
            </div>
          </section>
        )}

        <nav className="mb-4 flex flex-wrap items-center gap-2" aria-label="Administration">
          <button
            type="button"
            onClick={() => setTab("enrollments")}
            aria-pressed={tab === "enrollments"}
            className={`${button} ${
              tab === "enrollments"
                ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300"
                : "border-zinc-700 text-zinc-400 hover:text-zinc-200"
            } px-4 py-2 text-sm`}
          >
            <Users className="h-4 w-4" aria-hidden="true" /> Enrollments
          </button>
          <button
            type="button"
            onClick={() => setTab("payments")}
            aria-pressed={tab === "payments"}
            className={`${button} ${
              tab === "payments"
                ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300"
                : "border-zinc-700 text-zinc-400 hover:text-zinc-200"
            } px-4 py-2 text-sm`}
          >
            <CreditCard className="h-4 w-4" aria-hidden="true" /> Payments
          </button>
          <button type="button" onClick={() => setTab("devices")} aria-pressed={tab === "devices"} className={`${button} ${tab === "devices" ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300" : "border-zinc-700 text-zinc-400 hover:text-zinc-200"} px-4 py-2 text-sm`}><Laptop className="h-4 w-4" aria-hidden="true" /> Devices</button>
          <span className="flex-1" />
          <button
            type="button"
            onClick={onLock}
            className={`${button} border-zinc-700 text-zinc-300 hover:bg-zinc-800/60 px-4 py-2 text-sm`}
          >
            <Lock className="h-4 w-4" aria-hidden="true" /> Lock Admin Panel
          </button>
        </nav>

        <p className="mb-4 min-h-5 text-sm text-amber-300/90" role="status" aria-live="polite">
          {status}
        </p>

        {tab === "devices" ? <DeviceAccessPanel /> : tab === "enrollments" ? (
          <div className="space-y-4">
            <button
              type="button"
              onClick={() => void refreshEnrollments()}
              disabled={busy}
              className={`${button} border-zinc-700 text-zinc-300 hover:bg-zinc-800/60`}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} aria-hidden="true" />
              Refresh requests
            </button>
            {enrollments !== null && enrollments.length === 0 && (
              <p className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-500">
                No enrollment requests yet.
              </p>
            )}
            {enrollments?.map((user) => (
              <section
                key={user.id}
                className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5"
              >
                <h2 className="text-base font-semibold text-zinc-100">{user.name}</h2>
                <p className="mt-1 text-xs text-zinc-500">
                  {user.status} · Requested {dateFmt(user.created)} ·{" "}
                  <span className="font-mono">{user.id}</span>
                </p>
                {user.status === "pending" && user.preview && (
                  <img
                    src={user.preview}
                    alt="Enrollment photo submitted for administrator identity review"
                    width={160}
                    height={120}
                    className="my-3 block rounded-lg border border-zinc-800 object-contain"
                  />
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  {user.status === "pending" && (
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void act("approve", user.id)}
                        className={`${button} border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10`}
                      >
                        <BadgeCheck className="h-3.5 w-3.5" aria-hidden="true" /> Approve
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void act("reject", user.id)}
                        className={`${button} border-zinc-700 text-zinc-300 hover:bg-zinc-800/60`}
                      >
                        <Ban className="h-3.5 w-3.5" aria-hidden="true" /> Reject
                      </button>
                    </>
                  )}
                  {user.status === "approved" && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void act("revoke", user.id)}
                      className={`${button} border-red-500/40 text-red-300 hover:bg-red-500/10`}
                    >
                      <ShieldOff className="h-3.5 w-3.5" aria-hidden="true" /> Revoke access
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void act("delete", user.id)}
                    className={`${button} border-red-500/40 text-red-300 hover:bg-red-500/10`}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> Delete enrollment
                  </button>
                </div>
              </section>
            ))}
          </div>
        ) : (
          <div className="space-y-4">
            <button
              type="button"
              onClick={() => void refreshPayments()}
              disabled={busy}
              className={`${button} border-zinc-700 text-zinc-300 hover:bg-zinc-800/60`}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} aria-hidden="true" />
              Refresh payments
            </button>
            <p className="text-sm leading-relaxed text-zinc-500">
              A$5 per month from registration. Confirm money you have received for the selected
              month. Access requires both an approved face and a paid current month.
            </p>
            {members !== null && members.length === 0 && (
              <p className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-500">
                No registered members yet.
              </p>
            )}
            {members?.map((user) => (
              <MemberRow
                key={user.id}
                user={user}
                busy={busy}
                onConfirm={(period) => void confirmPayment(user.id, period)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MemberRow({
  user,
  busy,
  onConfirm,
}: {
  user: Member;
  busy: boolean;
  onConfirm: (period: number) => void;
}) {
  const [period, setPeriod] = useState(user.payment.period);
  const alreadyPaid = user.payments.some((p) => p.period === period);
  const confirmable = ["pending", "approved"].includes(user.status) && !alreadyPaid;
  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-semibold text-zinc-100">{user.name}</h3>
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
            user.payment.paid
              ? "bg-emerald-500/15 text-emerald-300"
              : "bg-amber-500/15 text-amber-300"
          }`}
        >
          {user.payment.paid ? "Paid" : "Payment required"}
        </span>
      </div>
      <p className="mt-1 text-xs text-zinc-500">Registered {dateFmt(user.created)}</p>
      <p className="mt-1 text-xs text-zinc-500">
        Face enrollment: {user.status} ·{" "}
        {user.payment.paid && user.status === "approved"
          ? "Access active"
          : user.status !== "approved"
            ? "Access blocked: face approval required"
            : "Access blocked: payment unconfirmed"}
      </p>
      <p className="mt-1 text-xs text-zinc-500">Current A$5 month: {range(user.payment)}</p>
      {user.payment.paid && (
        <p className="mt-1 text-xs text-zinc-500">Next A$5 payment due {dateFmt(user.payment.end)}.</p>
      )}
      <form
        className="mt-3 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (confirmable) onConfirm(period);
        }}
      >
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          Payment month
          <select
            value={period}
            onChange={(e) => setPeriod(Number(e.target.value))}
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-200"
          >
            {Array.from({ length: user.payment.period + 1 }, (_, i) => user.payment.period - i).map(
              (p) => {
                const at = billingPeriodAt(user.created, p);
                const confirmed = user.payments.some((x) => x.period === p);
                return (
                  <option key={p} value={p}>
                    {p === user.payment.period ? "Current month" : "Earlier month"}:{" "}
                    {range(at)}
                    {confirmed ? " · confirmed" : ""}
                  </option>
                );
              },
            )}
          </select>
        </label>
        <button
          type="submit"
          disabled={busy || !confirmable}
          className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-300 transition-colors hover:bg-emerald-500/20 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <CreditCard className="h-3.5 w-3.5" aria-hidden="true" /> Confirm A$5 received
        </button>
      </form>
      <details className="mt-3 text-xs text-zinc-500">
        <summary className="cursor-pointer select-none">
          Payment history ({user.payments.length})
        </summary>
        {user.payments.length === 0 ? (
          <p className="mt-2">No payments confirmed yet.</p>
        ) : (
          <ul className="mt-2 list-inside list-disc space-y-1">
            {user.payments.map((payment) => (
              <li key={payment.period}>
                A$5 confirmed {dateFmt(payment.confirmedAt)} · {range(payment)}
              </li>
            ))}
          </ul>
        )}
      </details>
    </section>
  );
}
