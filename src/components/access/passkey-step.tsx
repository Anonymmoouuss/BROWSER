"use client";

import { useState } from "react";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { ExternalLink, Fingerprint, KeyRound, Loader2 } from "lucide-react";
import { accessRequest } from "./access-client";

export default function PasskeyStep({ stage, onComplete, onBack }: {
  stage: string;
  onComplete: (result: Record<string, unknown>) => void;
  onBack: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const inFrame = typeof window !== "undefined" && window.self !== window.top;
  const verify = async () => {
    setBusy(true);
    setMessage("");
    try {
      if (!window.isSecureContext || !window.PublicKeyCredential) {
        throw new Error("Passkeys need HTTPS and a supported browser. Use Touch ID, Windows Hello, a passkey, or a security key on another supported device.");
      }
      const options = await accessRequest("passkey-options", { passkeyStageToken: stage });
      const response = options.mode === "register"
        ? await startRegistration({ optionsJSON: options.options as Parameters<typeof startRegistration>[0]["optionsJSON"] })
        : await startAuthentication({ optionsJSON: options.options as Parameters<typeof startAuthentication>[0]["optionsJSON"] });
      onComplete(await accessRequest("passkey-verify", {
        passkeyStageToken: stage, challengeId: options.challengeId, response,
      }));
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      setMessage(name === "NotAllowedError" || name === "AbortError"
        ? "Passkey verification was cancelled or timed out. Retry and unlock your authenticator when prompted."
        : error instanceof Error ? error.message : "Passkey verification failed. Please retry.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-5">
      <div className="flex h-12 w-12 items-center justify-center rounded-lg border border-cyan-400/25 bg-cyan-400/10">
        <Fingerprint className="h-6 w-6 text-cyan-300" aria-hidden="true" />
      </div>
      <div>
        <h1 className="text-xl font-semibold text-zinc-100">Verify your passkey</h1>
        <p className="mt-2 text-sm leading-relaxed text-zinc-400">Password and face verified. Continue with Touch ID, Windows Hello, a device passkey, or a security key.</p>
        <p className="mt-2 text-xs leading-relaxed text-zinc-500">If this account has no passkey yet, your browser will ask you to create one. Your fingerprint is not sent to this website.</p>
      </div>
      {inFrame ? (
        <a href={window.location.origin} target="_blank" rel="noopener noreferrer" className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-cyan-300 px-4 py-3 text-sm font-semibold text-zinc-950">
          <ExternalLink className="h-4 w-4" aria-hidden="true" /> Open workspace in its own tab
        </a>
      ) : (
        <button type="button" disabled={busy} onClick={() => void verify()} className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-cyan-300 px-4 py-3 text-sm font-semibold text-zinc-950 hover:bg-cyan-200 disabled:opacity-50">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <KeyRound className="h-4 w-4" aria-hidden="true" />}
          {busy ? "Waiting for your device..." : "Continue with passkey"}
        </button>
      )}
      {message && <p className="text-sm text-amber-200" role="alert">{message}</p>}
      <button type="button" disabled={busy} onClick={onBack} className="w-full text-sm text-zinc-400 hover:text-zinc-100 disabled:opacity-50">Return to sign-in</button>
    </div>
  );
}