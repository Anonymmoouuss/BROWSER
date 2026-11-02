"use client";

/**
 * AccessGate — SCRM-style private-access gate around the browser app.
 *
 * State machine (port of SCRM auth/login.ts): first-run setup wizard
 * (two workspace passwords -> one-time setup secret -> administrator face
 * enrollment -> recovery codes), then password + face-scan login, user
 * enrollment with admin approval, and the Admin Panel. Only an approved,
 * paid user session unlocks the BrowserApp; a 30 s recheck locks the
 * workspace again when access is revoked or payment lapses.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Camera,
  Copy,
  Eye,
  EyeOff,
  Fingerprint,
  KeyRound,
  Lock,
  RefreshCw,
  ScanFace,
  ShieldCheck,
  ShieldOff,
  UserRound,
  UserPlus,
} from "lucide-react";
import BrowserApp from "@/components/browser/browser-app";
import FaceCapture from "./face-capture";
import AdminPanel from "./admin-panel";
import PasskeyStep from "./passkey-step";
import DeviceApprovalStep from "./device-approval-step";
import {
  accessRequest,
  accessSession,
  downloadText,
  lockWorkspace,
} from "./access-client";

type Phase =
  | "loading"
  | "unavailable"
  | "init"
  | "secret"
  | "password"
  | "face"
  | "enroll-form"
  | "setup-form"
  | "recover-form"
  | "capture"
  | "passkey"
  | "device-pending"
  | "pending"
  | "admin"
  | "app";

type ScanPurpose = "login" | "enroll" | "setup" | "recover";

const RECEIPT_KEY = "scramjet-enrollment-receipt";
const DEVICE_RECEIPT_KEY = "scramjet-device-approval-receipt";

const inputClass =
  "w-full rounded-lg border border-zinc-700 bg-zinc-950/70 px-4 py-3 text-sm text-zinc-100 outline-none transition-colors placeholder:text-zinc-600 focus:border-emerald-400/70 focus:ring-2 focus:ring-emerald-400/15";
const primaryButton =
  "inline-flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-400 px-4 py-3 text-sm font-semibold text-emerald-950 transition-colors hover:bg-emerald-300 disabled:opacity-40 disabled:cursor-not-allowed";
const secondaryButton =
  "inline-flex w-full items-center justify-center gap-2 rounded-lg border border-zinc-700 px-4 py-3 text-sm font-medium text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100 disabled:opacity-40";

function Card({ children }: { children: React.ReactNode }) {
  return (
    <main className="cw-backdrop flex min-h-screen w-full items-center justify-center px-4 py-10">
      <section className="w-full max-w-md overflow-hidden rounded-lg border border-[var(--browser-border)] bg-[var(--card)] shadow-[0_24px_80px_-24px_rgba(0,0,0,0.7)]">
        <header className="flex items-center justify-between border-b border-[var(--browser-border)] bg-[var(--browser-toolbar)] px-5 py-3">
          <span className="flex items-center gap-2.5 text-sm font-semibold text-zinc-100">
            <img src="/logo.svg" alt="" width={24} height={24} className="h-6 w-6" /> Browser
          </span>
          <Lock className="h-3.5 w-3.5 text-zinc-500" aria-hidden="true" />
        </header>
        <div className="p-5 sm:p-7">{children}</div>
      </section>
    </main>
  );
}

function Brand() {
  return (
    <p className="mb-4 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-emerald-400">
      <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" /> Secure workspace
    </p>
  );
}

export default function AccessGate() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [role, setRole] = useState<"user" | "admin">("user");
  const [setupRequired, setSetupRequired] = useState(false);
  const [adminEnrolled, setAdminEnrolled] = useState(true);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [setupSecret, setSetupSecret] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | undefined>();
  const [receipt, setReceipt] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [formValue, setFormValue] = useState("");
  const [consent, setConsent] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetPassword, setResetPassword] = useState("");
  const [scanPurpose, setScanPurpose] = useState<ScanPurpose>("login");
  const [passkeyStage, setPasskeyStage] = useState("");
  const [deviceReceipt, setDeviceReceipt] = useState("");
  const sessionRequestPending = useRef(false);
  // pending scan descriptor set when the camera finishes capturing
  const scanRef = useRef<{
    purpose: ScanPurpose;
    extra: Record<string, unknown>;
    images: string[];
  } | null>(null);

  const loadSession = useCallback(async () => {
    if (sessionRequestPending.current) return;
    sessionRequestPending.current = true;
    try {
      const session = await accessSession();
      setMessage("");
      if (!session.initialized) setPhase("init");
      else if (session.unlocked) setPhase("app");
      else if (session.role === "admin") setPhase("admin");
      else setPhase("password");
      setAdminEnrolled(session.adminEnrolled);
      try {
        setReceipt(sessionStorage.getItem(RECEIPT_KEY));
        const approval = sessionStorage.getItem(DEVICE_RECEIPT_KEY);
        if (!session.unlocked && session.role !== "admin" && approval && /^[a-f0-9]{64}$/.test(approval)) {
          setDeviceReceipt(approval);
          setPhase("device-pending");
        }
      } catch {
        setReceipt(null);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The sign-in service is unavailable.");
      setPhase("unavailable");
    } finally {
      sessionRequestPending.current = false;
    }
  }, []);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) void loadSession();
    });
    return () => { active = false; };
  }, [loadSession]);

  useEffect(() => {
    if (phase !== "unavailable") return;
    const retry = () => {
      if (document.visibilityState !== "hidden") void loadSession();
    };
    const timer = setInterval(retry, 10_000);
    window.addEventListener("online", retry);
    window.addEventListener("focus", retry);
    document.addEventListener("visibilitychange", retry);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", retry);
      window.removeEventListener("focus", retry);
      document.removeEventListener("visibilitychange", retry);
    };
  }, [phase, loadSession]);

  /* 30 s access recheck while unlocked (revocation / payment lapse). */
  useEffect(() => {
    if (phase !== "app") return;
    const timer = setInterval(() => {
      void accessSession().then((session) => {
        if (!session.unlocked) void lockWorkspace();
      }).catch(() => void lockWorkspace());
    }, 30_000);
    return () => clearInterval(timer);
  }, [phase]);

  const errorText = useCallback((e: unknown) => {
    setMessage((e as Error).name === "AbortError" ? "Scan cancelled." : (e as Error).message);
  }, []);

  /* -------------------------- first-run wizard -------------------------- */

  const [initForm, setInitForm] = useState({
    userPassword: "",
    userPassword2: "",
    adminPassword: "",
    adminPassword2: "",
  });

  const submitInit = async () => {
    const f = initForm;
    setMessage("");
    if (
      f.userPassword.length < 12 ||
      f.adminPassword.length < 12 ||
      f.userPassword !== f.userPassword2 ||
      f.adminPassword !== f.adminPassword2 ||
      f.userPassword === f.adminPassword
    ) {
      setMessage(
        "Choose two different passwords of at least 12 characters, typed correctly twice each.",
      );
      return;
    }
    setBusy(true);
    try {
      const result = (await accessRequest("init", {
        userPassword: f.userPassword,
        adminPassword: f.adminPassword,
      })) as { setupSecret?: string };
      setSetupSecret(result.setupSecret ?? "");
      setPhase("secret");
    } catch (e) {
      errorText(e);
    } finally {
      setBusy(false);
    }
  };

  /* ---------------------------- password step --------------------------- */

  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);

  const submitPassword = async () => {
    setMessage("");
    setBusy(true);
    try {
      const result = (await accessRequest("password", { password, role })) as {
        role?: "user" | "admin";
        setupRequired?: boolean;
      };
      setPassword("");
      setRole(result.role ?? "user");
      setSetupRequired(Boolean(result.setupRequired));
      setPhase("face");
    } catch (e) {
      errorText(e);
    } finally {
      setBusy(false);
    }
  };

  const checkReceipt = async () => {
    if (!receipt) return;
    setMessage("Checking...");
    try {
      const result = (await accessRequest("status", { receipt })) as {
        name?: string;
        status?: string;
      };
      setMessage(`Enrollment for ${result.name}: ${result.status}.`);
      if (result.status === "approved") {
        sessionStorage.removeItem(RECEIPT_KEY);
        setReceipt(null);
      }
    } catch (e) {
      errorText(e);
    }
  };

  /* -------------------- workspace reset (bootstrap rescue) -------------------- */

  const submitReset = async () => {
    if (!resetPassword) return;
    if (
      !window.confirm(
        "Reset this workspace? Both passwords, every face enrollment, session and payment record is erased and the first-run wizard starts again. This cannot be undone.",
      )
    )
      return;
    setMessage("");
    setBusy(true);
    try {
      await accessRequest("reset", { adminPassword: resetPassword });
      setResetPassword("");
      setResetOpen(false);
      setAdminEnrolled(false);
      setPhase("init");
      setMessage("");
    } catch (e) {
      errorText(e);
    } finally {
      setBusy(false);
    }
  };

  /* ------------------------------ scanning ------------------------------ */

  const startScan = (purpose: ScanPurpose, extra: Record<string, unknown> = {}) => {
    scanRef.current = { purpose, extra, images: [] };
    setScanPurpose(purpose);
    setMessage("");
    setVerifying(false);
    setPhase("capture");
  };

  const onCapture = async (images: string[]) => {
    const scan = scanRef.current;
    if (!scan) {
      setPhase("face");
      return;
    }
    setVerifying(true);
    try {
      // One-use server challenge requested AFTER camera capture, so
      // permission prompts and positioning never expire the scan nonce.
      const challenge = (await accessRequest("challenge", {
        purpose: scan.purpose,
        ...scan.extra,
      })) as { challengeId?: string };
      setMessage("Verifying scan...");
      const result = (await accessRequest(scan.purpose, {
        challengeId: challenge.challengeId,
        images,
        ...scan.extra,
      })) as {
        status?: string;
        receipt?: string;
        role?: string;
        unlocked?: boolean;
        recoveryCodes?: string[];
        passkeyRequired?: boolean;
        passkeyStageToken?: string;
      };
      scanRef.current = null;
      if (result.recoveryCodes?.length) setRecoveryCodes(result.recoveryCodes);
      if (result.passkeyRequired && result.passkeyStageToken) {
        setPasskeyStage(result.passkeyStageToken);
        setVerifying(false);
        setMessage("");
        setPhase("passkey");
        return;
      }
      if (scan.purpose === "enroll" && result.status === "pending" && result.receipt) {
        sessionStorage.setItem(RECEIPT_KEY, result.receipt);
        setReceipt(result.receipt);
        setPhase("pending");
        setMessage("");
        return;
      }
      if (result.recoveryCodes?.length) setRecoveryCodes(result.recoveryCodes);
      if (result.role === "admin") {
        setPhase("admin");
        setMessage("");
        return;
      }
      if (result.unlocked) {
        setPhase("app");
        setMessage("");
        return;
      }
      throw new Error("No access was granted.");
    } catch (e) {
      scanRef.current = null;
      setVerifying(false);
      setPhase("face");
      errorText(e);
    }
  };

  /* ------------------------------ rendering ----------------------------- */

  if (phase === "device-pending") {
    return <Card><Brand /><DeviceApprovalStep receipt={deviceReceipt} onBack={() => {
      try { sessionStorage.removeItem(DEVICE_RECEIPT_KEY); } catch {}
      setDeviceReceipt("");
      setPhase("password");
    }} /></Card>;
  }

  if (phase === "passkey") {
    return (
      <Card>
        <Brand />
        <PasskeyStep stage={passkeyStage} onComplete={(result) => {
          setPasskeyStage("");
          setMessage("");
          if (result.deviceApprovalRequired === true && typeof result.receipt === "string") {
            try { sessionStorage.setItem(DEVICE_RECEIPT_KEY, result.receipt); } catch {}
            setDeviceReceipt(result.receipt);
            setPhase("device-pending");
          } else if (result.status === "pending" && typeof result.receipt === "string") {
            try { sessionStorage.setItem(RECEIPT_KEY, result.receipt); } catch {}
            setReceipt(result.receipt);
            setPhase("pending");
          } else if (result.role === "admin") setPhase("admin");
          else if (result.unlocked === true) setPhase("app");
          else { setPhase("password"); setMessage("Sign-in was not completed. Please retry."); }
        }} onBack={() => {
          void accessRequest("logout", { passkeyStageToken: passkeyStage }).catch(() => undefined);
          setPasskeyStage("");
          setPhase("password");
        }} />
      </Card>
    );
  }

  if (phase === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-950">
        <p className="text-sm text-zinc-500">Checking access...</p>
      </div>
    );
  }

  if (phase === "unavailable") {
    return (
      <Card>
        <Brand />
        <h1 className="text-xl font-semibold text-zinc-100">Sign-in unavailable</h1>
        <p className="mt-3 text-sm text-zinc-400" role="status">{message}</p>
        <button type="button" className={`${primaryButton} mt-5`} onClick={() => {
          setPhase("loading");
          setMessage("");
          void loadSession();
        }}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" /> Retry sign-in
        </button>
      </Card>
    );
  }

  if (phase === "app") {
    return <BrowserApp onLock={() => void lockWorkspace()} />;
  }

  if (phase === "admin") {
    return (
      <AdminPanel
        recoveryCodes={recoveryCodes}
        onLock={() => {
          setRecoveryCodes(undefined);
          setPhase("password");
          void accessRequest("logout").catch(() => undefined);
        }}
      />
    );
  }

  const inFrame = typeof window !== "undefined" && window.self !== window.top;

  if (phase === "secret") {
    return (
      <Card>
        <Brand />
        <h1 className="text-xl font-semibold text-zinc-100">One-time setup secret</h1>
        <p className="mt-2 text-sm leading-relaxed text-zinc-500">
          Shown once. Enter it together with the admin password to enroll the administrator face
          and open the Admin Panel. Keep it offline until then.
        </p>
        <textarea
          readOnly
          value={setupSecret}
          rows={3}
          aria-label="One-time setup secret"
          className="mt-4 w-full rounded-xl border border-amber-500/30 bg-zinc-950/70 p-3 font-mono text-xs break-all text-amber-100"
        />
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={() => void navigator.clipboard?.writeText(setupSecret)}
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-zinc-700 px-4 py-2.5 text-sm font-medium text-zinc-300 transition-colors hover:border-zinc-500"
          >
            <Copy className="h-4 w-4" aria-hidden="true" /> Copy
          </button>
          <button
            type="button"
            onClick={() => downloadText("scramjet-setup-secret.txt", setupSecret)}
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-zinc-700 px-4 py-2.5 text-sm font-medium text-zinc-300 transition-colors hover:border-zinc-500"
          >
            <KeyRound className="h-4 w-4" aria-hidden="true" /> Download
          </button>
        </div>
        <button
          type="button"
          onClick={() => {
            setSetupSecret("");
            setPhase("password");
          }}
          className={`${primaryButton} mt-4`}
        >
          Continue to administrator setup <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </button>
        <p className="mt-3 text-center text-xs text-zinc-600">
          The secret is deleted from the server after the administrator face is enrolled.
        </p>
      </Card>
    );
  }

  if (phase === "init") {
    return (
      <Card>
        <Brand />
        <h1 className="text-xl font-semibold text-zinc-100">Set up this workspace</h1>
        <p className="mt-2 text-sm leading-relaxed text-zinc-500">
          Choose two different workspace passwords: one for members, one for the administrator.
          Each needs at least 12 characters. Both are required with an approved face to sign in.
        </p>
        <form
          className="mt-5 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submitInit();
          }}
        >
          <label className="block text-xs font-medium text-zinc-400">
            Workspace passcode (members)
            <input
              type="password"
              autoComplete="new-password"
              value={initForm.userPassword}
              onChange={(e) => setInitForm({ ...initForm, userPassword: e.target.value })}
              className={`${inputClass} mt-1`}
              required
              minLength={12}
            />
          </label>
          <label className="block text-xs font-medium text-zinc-400">
            Repeat passcode
            <input
              type="password"
              autoComplete="new-password"
              value={initForm.userPassword2}
              onChange={(e) => setInitForm({ ...initForm, userPassword2: e.target.value })}
              className={`${inputClass} mt-1`}
              required
              minLength={12}
            />
          </label>
          <label className="block text-xs font-medium text-zinc-400">
            Administrator passcode
            <input
              type="password"
              autoComplete="new-password"
              value={initForm.adminPassword}
              onChange={(e) => setInitForm({ ...initForm, adminPassword: e.target.value })}
              className={`${inputClass} mt-1`}
              required
              minLength={12}
            />
          </label>
          <label className="block text-xs font-medium text-zinc-400">
            Repeat administrator passcode
            <input
              type="password"
              autoComplete="new-password"
              value={initForm.adminPassword2}
              onChange={(e) => setInitForm({ ...initForm, adminPassword2: e.target.value })}
              className={`${inputClass} mt-1`}
              required
              minLength={12}
            />
          </label>
          <button type="submit" disabled={busy} className={primaryButton}>
            <Lock className="h-4 w-4" aria-hidden="true" /> Create workspace passwords
          </button>
        </form>
      </Card>
    );
  }

  if (phase === "password") {
    return (
      <Card>
        <Brand />
        <h1 className="text-xl font-semibold text-zinc-100">Private access</h1>
        <p className="mt-2 text-sm leading-relaxed text-zinc-500">
          {role === "admin" ? "Administrator sign-in" : "Member sign-in"}
        </p>
        <div className="mt-5 grid grid-cols-2 gap-1 rounded-lg border border-zinc-800 bg-zinc-950 p-1" role="tablist" aria-label="Sign-in role">
          {(["user", "admin"] as const).map((choice) => {
            const Icon = choice === "admin" ? ShieldCheck : UserRound;
            return (
              <button
                key={choice}
                type="button"
                role="tab"
                aria-label={choice === "admin" ? "Administrator" : "Member"}
                aria-selected={role === choice}
                disabled={busy}
                onClick={() => {
                  setRole(choice);
                  setPassword("");
                  setMessage("");
                  setShowPassword(false);
                  setCapsLock(false);
                }}
                className={`inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${role === choice ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-200"}`}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                {choice === "admin" ? "Admin" : "Member"}
              </button>
            );
          })}
        </div>
        <form
          className="mt-5 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submitPassword();
          }}
        >
          <input type="text" name="username" autoComplete="username" value={role === "admin" ? "administrator" : "member"} readOnly className="sr-only" tabIndex={-1} aria-hidden="true" />
          <label className="block text-xs font-medium text-zinc-400">
            {role === "admin" ? "Administrator passcode" : "Member passcode"}
            <span className="relative mt-1 block">
              <input
                key={role}
                type={showPassword ? "text" : "password"}
                name="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                onKeyDown={(event) => setCapsLock(event.getModifierState("CapsLock"))}
                onKeyUp={(event) => setCapsLock(event.getModifierState("CapsLock"))}
                onBlur={() => setCapsLock(false)}
                placeholder="Enter passcode"
                className={`${inputClass} pr-12`}
                required
                maxLength={512}
                autoFocus
              />
              <button type="button" onClick={() => setShowPassword((visible) => !visible)} aria-label={showPassword ? "Hide passcode" : "Show passcode"} title={showPassword ? "Hide passcode" : "Show passcode"} className="absolute inset-y-0 right-1 inline-flex w-10 items-center justify-center text-zinc-500 hover:text-zinc-200">
                {showPassword ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
              </button>
            </span>
          </label>
          {capsLock && <p className="text-xs text-amber-300" role="status">Caps Lock is on.</p>}
          <button type="submit" disabled={busy} className={primaryButton}>
            {role === "admin" ? "Verify administrator" : "Unlock workspace"}
          </button>
        </form>
        {receipt && (
          <button type="button" onClick={() => void checkReceipt()} className={`${secondaryButton} mt-3`}>
            Check enrollment status
          </button>
        )}
        {!adminEnrolled && (
          <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
            <p className="text-xs font-semibold text-amber-200">
              Administrator setup incomplete
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-amber-200/70">
              No administrator face is enrolled yet. Continue with your one-time setup
              secret, or — if the secret was lost — reset the workspace and run the
              first-run wizard again.
            </p>
            {resetOpen ? (
              <form
                className="mt-3 space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submitReset();
                }}
              >
                <input
                  type="password"
                  value={resetPassword}
                  onChange={(e) => setResetPassword(e.target.value)}
                  placeholder="Administrator passcode"
                  autoComplete="current-password"
                  maxLength={512}
                  required
                  className={inputClass}
                />
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={busy || !resetPassword}
                    className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-2.5 text-sm font-medium text-red-300 transition-colors hover:bg-red-500/20 disabled:opacity-40"
                  >
                    <ShieldOff className="h-4 w-4" aria-hidden="true" /> Reset workspace
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setResetOpen(false);
                      setResetPassword("");
                    }}
                    className="inline-flex flex-1 items-center justify-center rounded-xl border border-zinc-700 px-4 py-2.5 text-sm text-zinc-400 transition-colors hover:text-zinc-200"
                  >
                    Keep passwords
                  </button>
                </div>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => setResetOpen(true)}
                className="mt-2 text-xs font-medium text-amber-300 underline decoration-amber-500/40 underline-offset-2 transition-colors hover:text-amber-200"
              >
                Lost the setup secret? Reset the workspace
              </button>
            )}
          </div>
        )}
        <p className="mt-4 text-xs leading-relaxed text-zinc-600" role="status" aria-live="polite">
          {busy ? "Checking access..." : message}
        </p>
        <details className="group mt-4 rounded-xl border border-zinc-800 bg-zinc-950/50 px-4 py-3">
          <summary className="cursor-pointer select-none text-xs font-medium text-zinc-400 transition-colors hover:text-zinc-200">
            How this workspace works
          </summary>
          <ol className="mt-2 list-inside list-decimal space-y-1.5 text-[11px] leading-relaxed text-zinc-500">
            <li>
              First visit? Choose <span className="text-zinc-300">Enrol your face</span> after
              entering the member passcode — an administrator then approves it and confirms the A$5
              monthly payment before access opens.
            </li>
            <li>
              Returning members: enter the member passcode and{" "}
              <span className="text-zinc-300">Scan my face</span> to unlock the browser.
            </li>
            <li>
              Administrators: use the admin passcode and your enrolled admin face to open the Admin
              Panel (enrollments, payments, recovery codes).
            </li>
            <li>
              Every page you visit loads through the server-side Scramjet interception proxy; the
              tunnel itself only accepts unlocked sessions.
            </li>
          </ol>
        </details>
        <p className="mt-4 border-t border-zinc-800 pt-4 text-[11px] leading-relaxed text-zinc-600">
          Face scans are checked by this app. Webcam checks are not hardware-backed Face ID and
          cannot guarantee protection against photo/video spoofing.
        </p>
      </Card>
    );
  }

  if (phase === "capture") {
    return (
      <Card>
        <Brand />
        <h1 className="text-xl font-semibold text-zinc-100">
          {scanPurpose === "enroll"
            ? "Enrol your face"
            : scanPurpose === "setup"
              ? "Set up Admin Panel"
              : scanPurpose === "recover"
                ? "Recover admin access"
                : "Verify your face"}
        </h1>
        <p className="mt-2 text-sm text-zinc-500">
          {scanPurpose === "login"
            ? "Scan your approved face — a few quick photos are captured and checked together."
            : "Twenty clear photos are captured."}
        </p>
        <div className="mt-5">
          {verifying ? (
            <div className="flex flex-col items-center gap-3 py-10">
              <Fingerprint className="h-8 w-8 animate-pulse text-emerald-400" aria-hidden="true" />
              <p className="text-sm text-zinc-400" role="status" aria-live="polite">
                {message || "Verifying scan..."}
              </p>
            </div>
          ) : (
            <FaceCapture
              single={scanPurpose === "login"}
              onCapture={(images) => void onCapture(images)}
              onCancel={() => setPhase("face")}
              onError={(m) => {
                setPhase("face");
                setMessage(m);
              }}
            />
          )}
        </div>
        {inFrame && !verifying && (
          <p className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-[11px] leading-relaxed text-amber-200/80">
            Camera access can be blocked inside a preview frame. If the camera does not start, open
            this page in its own browser tab (Open in New Tab above the preview) and retry.
          </p>
        )}
      </Card>
    );
  }

  if (phase === "pending") {
    return (
      <Card>
        <Brand />
        <h1 className="text-xl font-semibold text-zinc-100">Awaiting approval</h1>
        <p className="mt-2 text-sm leading-relaxed text-zinc-500">
          Your face enrollment was submitted. The workspace stays locked until the administrator
          approves it and confirms your A$5 monthly payment.
        </p>
        <div className="mt-5 space-y-3">
          <button type="button" onClick={() => void checkReceipt()} className={primaryButton}>
            Check approval
          </button>
          <button
            type="button"
            onClick={() => setPhase("password")}
            className={secondaryButton}
          >
            Return to login
          </button>
        </div>
        <p className="mt-4 text-xs text-zinc-500" role="status" aria-live="polite">
          {message}
        </p>
      </Card>
    );
  }

  /* ------------------- face step + its entry forms ---------------------- */

  if (phase === "enroll-form" || phase === "setup-form" || phase === "recover-form") {
    const isEnroll = phase === "enroll-form";
    const isSetup = phase === "setup-form";
    return (
      <Card>
        <Brand />
        <h1 className="text-xl font-semibold text-zinc-100">
          {isEnroll ? "Enrol your face" : isSetup ? "Set up Admin Panel" : "Recover admin access"}
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-zinc-500">
          {isEnroll
            ? "Your request must be approved in the Admin Panel before you can log in."
            : "Only use this on a private device. You will receive replacement recovery codes after enrollment."}
        </p>
        <form
          className="mt-5 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!consent) return;
            const value = formValue;
            setFormValue("");
            if (isEnroll) startScan("enroll", { name: value, consent: true });
            else if (isSetup) startScan("setup", { setupToken: value, consent: true });
            else startScan("recover", { recoveryCode: value, consent: true });
          }}
        >
          <label className="block text-xs font-medium text-zinc-400">
            {isEnroll ? "Your name" : isSetup ? "One-time setup secret" : "Unused recovery code"}
            <input
              type={isEnroll ? "text" : "password"}
              value={formValue}
              onChange={(e) => setFormValue(e.target.value)}
              maxLength={isEnroll ? 80 : 256}
              autoComplete={isEnroll ? "name" : "off"}
              className={`${inputClass} mt-1`}
              required
              autoFocus
            />
          </label>
          <label className="flex items-start gap-2.5 text-xs leading-relaxed text-zinc-500">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              required
              className="mt-0.5 h-4 w-4 shrink-0 accent-emerald-500"
            />
            <span>
              {isEnroll
                ? "I consent to encrypted storage of my face template and one review photo, shown only to the administrator while approval is pending. The review photo is deleted when approved, rejected or expired; other camera images are not stored."
                : "I consent to encrypted storage of my face template for login. Camera images are not stored."}
            </span>
          </label>
          <button type="submit" disabled={!consent} className={primaryButton}>
            <ScanFace className="h-4 w-4" aria-hidden="true" /> Start face enrollment
          </button>
        </form>
        <button
          type="button"
          onClick={() => setPhase("face")}
          className={`${secondaryButton} mt-3`}
        >
          Back
        </button>
        <p className="mt-4 text-xs text-zinc-500" role="status" aria-live="polite">
          {message}
        </p>
      </Card>
    );
  }

  /* phase === "face" */
  return (
    <Card>
      <Brand />
      <h1 className="text-xl font-semibold text-zinc-100">
        {role === "admin" ? "Admin verification" : "Verify your face"}
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-zinc-500">
        {setupRequired
          ? "Enter your one-time setup secret to enroll the administrator face."
          : role === "admin"
            ? "Scan your administrator face to open the Admin Panel."
            : "Scan your approved face, or request enrollment if this is your first visit."}
      </p>
      <div className="mt-5 space-y-3">
        {setupRequired ? (
          <button type="button" onClick={() => setPhase("setup-form")} className={primaryButton}>
            <UserPlus className="h-4 w-4" aria-hidden="true" /> Enroll administrator face
          </button>
        ) : (
          <button type="button" onClick={() => startScan("login")} className={primaryButton}>
            <Camera className="h-4 w-4" aria-hidden="true" /> Scan my face
          </button>
        )}
        {role === "user" ? (
          <button type="button" onClick={() => setPhase("enroll-form")} className={secondaryButton}>
            <UserPlus className="h-4 w-4" aria-hidden="true" /> Enrol your face
          </button>
        ) : (
          !setupRequired && (
            <button
              type="button"
              onClick={() => setPhase("recover-form")}
              className={secondaryButton}
            >
              <KeyRound className="h-4 w-4" aria-hidden="true" /> Use a recovery code
            </button>
          )
        )}
        <button
          type="button"
          onClick={() => setPhase("password")}
          className={secondaryButton}
        >
          Use a different password
        </button>
      </div>
      <p className="mt-4 text-xs text-zinc-500" role="status" aria-live="polite">
        {message}
      </p>
      <p className="mt-4 border-t border-zinc-800 pt-4 text-[11px] leading-relaxed text-zinc-600">
        Webcam checks are not hardware-backed Face ID and cannot guarantee protection against
        photo/video spoofing. Recognition runs on this app&apos;s own server with bundled
        open-source models; no external biometric service.
      </p>
    </Card>
  );
}
