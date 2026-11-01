"use client";

/**
 * useConsoleWs — websocket client for the browser-backend shell console.
 *
 * Connects only while `enabled` (the panel is open), reconnects with
 * backoff, merges streamed output chunks into console lines, tracks the
 * session cwd (updated from the server's done messages) and exposes
 * exec / signal / clear / appendLocal.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { BACKEND_PORT, serviceWebSocketUrl } from "@/lib/browser/shared";
import { engineGrant } from "@/lib/browser/engine-token";

export type ConsoleLineKind = "in" | "out" | "err" | "sys";
export interface ConsoleLine {
  id: number;
  kind: ConsoleLineKind;
  text: string;
}

export interface ConsoleApi {
  lines: ConsoleLine[];
  connected: boolean;
  running: boolean;
  cwd: string;
  exec: (command: string) => void;
  signal: (sig: "INT" | "KILL") => void;
  clear: () => void;
  appendLocal: (kind: ConsoleLineKind, text: string) => void;
}

const WELCOME =
  "Console ready. Commands run on the sandbox host as a non-root user.\nTry: ls, uname -a, df -h, free -m, curl ifconfig.me";

export function useConsoleWs(enabled: boolean): ConsoleApi {
  const [lines, setLines] = useState<ConsoleLine[]>([{ id: 0, kind: "sys", text: WELCOME }]);
  const [connected, setConnected] = useState(false);
  const [running, setRunning] = useState(false);
  const [cwd, setCwd] = useState("/home/z");
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptsRef = useRef(0);
  const idRef = useRef(1);
  const runningRef = useRef(false);

  const append = useCallback((kind: ConsoleLineKind, text: string) => {
    if (!text) return;
    if (kind === "out" || kind === "err") {
      // \r (no trailing \n) = overwrite the current line (progress bars)
      if (text.includes("\r")) {
        const i = text.lastIndexOf("\r");
        const tail = text.slice(i + 1);
        setLines((prev) => {
          const last = prev[prev.length - 1];
          if (last && (last.kind === "out" || last.kind === "err")) {
            return [...prev.slice(0, -1), { ...last, text: tail }];
          }
          return [...prev, { id: idRef.current++, kind, text: tail }];
        });
        return;
      }
      if (text.includes("\x08")) {
        text = text.replace(/.\x08/g, "").replace(/\x08/g, "");
      }
      setLines((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.kind === kind) {
          return [...prev.slice(0, -1), { ...last, text: last.text + text }];
        }
        return [...prev, { id: idRef.current++, kind, text }];
      });
      return;
    }
    setLines((prev) => [...prev, { id: idRef.current++, kind, text }]);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let closed = false;

    const connect = () => {
      if (closed) return;
      // sjt carries the signed session grant: the preview iframe blocks
      // third-party cookies, so the cookie alone cannot authenticate the WS.
      const grant = engineGrant();
      const sjt = grant ? `&sjt=${encodeURIComponent(grant)}` : "";
      const ws = new WebSocket(serviceWebSocketUrl(`/ws?XTransformPort=${BACKEND_PORT}${sjt}`));
      wsRef.current = ws;
      ws.onopen = () => {
        attemptsRef.current = 0;
        setConnected(true);
      };
      ws.onclose = () => {
        setConnected(false);
        runningRef.current = false;
        setRunning(false);
        if (!closed) {
          const delay = Math.min(1000 * 2 ** attemptsRef.current++, 10000);
          retryRef.current = setTimeout(connect, delay);
        }
      };
      ws.onerror = () => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string) as {
            type?: string;
            stream?: string;
            text?: string;
            message?: string;
            code?: number;
            cwd?: string;
          };
          if (msg.type === "out") {
            append(msg.stream === "stderr" ? "err" : "out", String(msg.text ?? ""));
          } else if (msg.type === "done") {
            const wasRunning = runningRef.current;
            runningRef.current = false;
            setRunning(false);
            if (typeof msg.cwd === "string" && msg.cwd) setCwd(msg.cwd);
            if (wasRunning && typeof msg.code === "number" && msg.code !== 0) {
              append("sys", `exit code ${msg.code}`);
            }
          } else if (msg.type === "error") {
            append("sys", String(msg.message ?? ""));
          } else if (msg.type === "hello") {
            if (msg.cwd) setCwd(msg.cwd);
          }
        } catch {
          /* malformed message */
        }
      };
    };

    connect();
    return () => {
      closed = true;
      if (retryRef.current) clearTimeout(retryRef.current);
      try {
        wsRef.current?.close();
      } catch {
        /* ignore */
      }
      setConnected(false);
    };
  }, [enabled, append]);

  const exec = useCallback(
    (command: string) => {
      append("in", command);
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        append("sys", "console is not connected — retrying");
        return;
      }
      if (runningRef.current) {
        append("sys", "a command is already running — press Ctrl+C to interrupt");
        return;
      }
      runningRef.current = true;
      setRunning(true);
      ws.send(JSON.stringify({ type: "exec", command }));
    },
    [append],
  );

  const signal = useCallback((sig: "INT" | "KILL") => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "signal", sig }));
  }, []);

  const clear = useCallback(() => setLines([]), []);

  const appendLocal = useCallback(
    (kind: ConsoleLineKind, text: string) => append(kind, text),
    [append],
  );

  return { lines, connected, running, cwd, exec, signal, clear, appendLocal };
}
