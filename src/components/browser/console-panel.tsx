"use client";

/**
 * ConsolePanel — the integrated console: resizable height, Shell mode
 * (server commands over the websocket) and Page JS mode (evaluated inside
 * the active proxied page, same-origin), command history, ANSI rendering.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Loader2, Square, Terminal, Trash2, X } from "lucide-react";
import AnsiText from "./ansi";
import { shortenPath } from "@/lib/browser/shared";
import type { ConsoleLine, ConsoleLineKind } from "@/hooks/use-console-ws";

interface ConsolePanelProps {
  lines: ConsoleLine[];
  connected: boolean;
  running: boolean;
  cwd: string;
  onExec: (command: string) => void;
  onSignal: (sig: "INT" | "KILL") => void;
  onClear: () => void;
  onAppend: (kind: ConsoleLineKind, text: string) => void;
  onClose: () => void;
  getFrameWindow: () => (Window & typeof globalThis) | null;
  targetTitle: string;
}

type Mode = "shell" | "js";

function formatResult(v: unknown): string {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  const t = typeof v;
  if (t === "string") return JSON.stringify(v);
  if (t === "number" || t === "boolean" || t === "bigint") return String(v);
  if (t === "function") return `\u0192 ${(v as { name?: string }).name || "anonymous"}()`;
  if (t === "symbol") return String(v);
  try {
    const seen = new Set<unknown>();
    const out = JSON.stringify(
      v,
      (_k, val) => {
        if (typeof val === "function") return `\u0192 ${val.name || "anonymous"}()`;
        if (typeof val === "object" && val !== null) {
          if (seen.has(val)) return "[Circular]";
          seen.add(val);
        }
        return val;
      },
      2,
    );
    return out ?? String(v);
  } catch {
    return String(v);
  }
}

function LineView({ line }: { line: ConsoleLine }) {
  if (line.kind === "in") {
    return (
      <div className="text-zinc-300">
        <span className="text-emerald-400/80">$ </span>
        {line.text}
      </div>
    );
  }
  if (line.kind === "sys") return <div className="italic text-zinc-500">{line.text}</div>;
  if (line.kind === "err") return <AnsiText text={line.text} className="text-red-300" />;
  return <AnsiText text={line.text} />;
}

export default function ConsolePanel(props: ConsolePanelProps) {
  const { lines, connected, running, cwd, onExec, onSignal, onClear, onAppend, onClose, getFrameWindow, targetTitle } = props;
  const [mode, setMode] = useState<Mode>("shell");
  const [input, setInput] = useState("");
  const [height, setHeight] = useState(280);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const historyRef = useRef<string[]>([]);
  const histIdxRef = useRef(-1);
  const dragStartRef = useRef({ y: 0, h: 280 });

  // stick to bottom unless the user scrolled up
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  // focus the input when the panel opens or the mode changes
  useEffect(() => {
    inputRef.current?.focus();
  }, [mode]);

  // drag-to-resize
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const { y, h } = dragStartRef.current;
      const next = Math.min(Math.max(h + (y - e.clientY), 140), Math.floor(window.innerHeight * 0.75));
      setHeight(next);
    };
    const onUp = () => setDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  const runJs = useCallback(
    (code: string) => {
      onAppend("in", `js> ${code}`);
      const win = getFrameWindow();
      if (!win) {
        onAppend("sys", "no page is loaded in the active tab — navigate somewhere first");
        return;
      }
      try {
        const result: unknown = win.eval(code);
        onAppend("out", formatResult(result));
      } catch (err) {
        onAppend("err", err instanceof Error ? `${err.name}: ${err.message}` : String(err));
      }
    },
    [getFrameWindow, onAppend],
  );

  const submit = () => {
    const command = input;
    if (!command.trim()) return;
    setInput("");
    histIdxRef.current = -1;
    historyRef.current = [command, ...historyRef.current.filter((c) => c !== command)].slice(0, 100);
    if (mode === "shell") onExec(command);
    else runJs(command);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    } else if (e.ctrlKey && e.key.toLowerCase() === "c" && running) {
      e.preventDefault();
      onSignal("INT");
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const h = historyRef.current;
      if (h.length) {
        const idx = Math.min(histIdxRef.current + 1, h.length - 1);
        histIdxRef.current = idx;
        setInput(h[idx]);
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const h = historyRef.current;
      if (histIdxRef.current > 0) {
        const idx = histIdxRef.current - 1;
        histIdxRef.current = idx;
        setInput(h[idx]);
      } else {
        histIdxRef.current = -1;
        setInput("");
      }
    }
  };

  const prompt = `z@sandbox:${shortenPath(cwd)}$`;

  return (
    <section
      aria-label="Console panel"
      className="flex shrink-0 select-none flex-col border-t border-zinc-800 bg-zinc-950"
      style={{ height }}
    >
      {/* drag handle */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize console"
        onMouseDown={(e) => {
          dragStartRef.current = { y: e.clientY, h: height };
          setDragging(true);
        }}
        className="group flex h-2 shrink-0 cursor-row-resize items-center justify-center"
      >
        <div className={`h-0.5 w-10 rounded-full transition-colors ${dragging ? "bg-emerald-400" : "bg-zinc-700 group-hover:bg-emerald-500/60"}`} />
      </div>

      {/* header */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-zinc-800 px-3">
        <Terminal className="h-3.5 w-3.5 shrink-0 text-emerald-400" aria-hidden="true" />
        <span className="shrink-0 text-xs font-semibold text-zinc-200">Console</span>
        <div className="ml-1 flex shrink-0 items-center rounded-lg border border-zinc-800 bg-zinc-900 p-0.5 text-[11px]" role="tablist" aria-label="Console mode">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "shell"}
            onClick={() => setMode("shell")}
            className={`rounded-md px-2 py-0.5 font-medium transition-colors ${
              mode === "shell" ? "bg-zinc-700/70 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            Shell
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "js"}
            onClick={() => setMode("js")}
            className={`rounded-md px-2 py-0.5 font-medium transition-colors ${
              mode === "js" ? "bg-zinc-700/70 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            Page JS
          </button>
        </div>
        {mode === "js" && (
          <span className="min-w-0 truncate text-[11px] text-zinc-500">in: {targetTitle}</span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {running && (
            <>
              <span className="flex items-center gap-1 text-[11px] text-amber-300">
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> running
              </span>
              <button
                type="button"
                onClick={() => onSignal("INT")}
                title="Send Ctrl+C (interrupt)"
                aria-label="Interrupt running command"
                className="flex h-6 items-center gap-1 rounded-md border border-zinc-700 px-1.5 text-[11px] text-zinc-300 transition-colors hover:border-red-500/50 hover:text-red-300"
              >
                <Square className="h-2.5 w-2.5 fill-current" aria-hidden="true" /> Ctrl+C
              </button>
            </>
          )}
          <span
            role="status"
            title={connected ? "Console connected" : "Console offline"}
            className={`h-2 w-2 rounded-full ${connected ? "bg-emerald-400" : "bg-red-400"} ${connected ? "" : "cw-pulse"}`}
          />
          <button
            type="button"
            onClick={onClear}
            aria-label="Clear console"
            title="Clear console"
            className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close console"
            title="Close console (`)"
            className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* scrollback */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="cw-scroll min-h-0 flex-1 select-text overflow-y-auto px-3 py-2 font-mono text-[13px] leading-relaxed"
        role="log"
        aria-label="Console output"
      >
        {lines.map((line) => (
          <LineView key={line.id} line={line} />
        ))}
      </div>

      {/* input row */}
      <div className="flex shrink-0 items-center gap-2 border-t border-zinc-800 px-3 py-2 font-mono text-[13px]">
        {mode === "shell" ? (
          <span className="shrink-0 whitespace-nowrap text-emerald-400" title={cwd}>
            {prompt}
          </span>
        ) : (
          <span className="shrink-0 text-amber-300">js&gt;</span>
        )}
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          aria-label={mode === "shell" ? "Shell command input" : "JavaScript evaluation input"}
          placeholder={mode === "shell" ? "type a command — try ls, uname -a, df -h" : "evaluate JavaScript in the active page — try document.title"}
          className="min-w-0 flex-1 bg-transparent text-zinc-100 caret-emerald-400 outline-none placeholder:text-zinc-600"
        />
        <span className="hidden shrink-0 text-[10px] text-zinc-600 sm:inline">
          {mode === "shell" ? "Enter runs · ↑ history · Ctrl+C interrupts" : "Enter evaluates"}
        </span>
      </div>
    </section>
  );
}
