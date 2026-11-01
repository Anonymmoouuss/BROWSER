"use client";

/**
 * AnsiText — minimal ANSI escape renderer for console output.
 * Supports SGR (bold/faint/italic/underline, 8/16 colors, 256-color cube,
 * truecolor), strips other CSI/OSC sequences so raw output stays readable.
 */

import { useMemo } from "react";

interface Seg {
  text: string;
  color?: string;
  bg?: string;
  bold?: boolean;
  underline?: boolean;
  italic?: boolean;
  faint?: boolean;
}

const BASIC = [
  "#52525b", "#ef4444", "#22c55e", "#eab308",
  "#60a5fa", "#c084fc", "#22d3ee", "#e4e4e7",
];
const BRIGHT = [
  "#71717a", "#f87171", "#4ade80", "#facc15",
  "#93c5fd", "#d8b4fe", "#67e8f9", "#fafafa",
];
const CUBE = [0, 95, 135, 175, 215, 255];

function color256(n: number): string {
  if (n < 8) return BASIC[n];
  if (n < 16) return BRIGHT[n - 8];
  if (n < 232) {
    const i = n - 16;
    const r = CUBE[Math.floor(i / 36) % 6];
    const g = CUBE[Math.floor(i / 6) % 6];
    const b = CUBE[i % 6];
    return `rgb(${r}, ${g}, ${b})`;
  }
  const gray = 8 + (n - 232) * 10;
  return `rgb(${gray}, ${gray}, ${gray})`;
}

interface StyleState {
  color?: string;
  bg?: string;
  bold: boolean;
  underline: boolean;
  italic: boolean;
  faint: boolean;
}

function applySgr(params: string, st: StyleState): void {
  const list = params === "" ? [0] : params.split(";").map((p) => parseInt(p, 10) || 0);
  let k = 0;
  while (k < list.length) {
    const p = list[k];
    if (p === 0) {
      st.color = undefined;
      st.bg = undefined;
      st.bold = false;
      st.underline = false;
      st.italic = false;
      st.faint = false;
    } else if (p === 1) st.bold = true;
    else if (p === 2) st.faint = true;
    else if (p === 3) st.italic = true;
    else if (p === 4) st.underline = true;
    else if (p === 22) {
      st.bold = false;
      st.faint = false;
    } else if (p === 23) st.italic = false;
    else if (p === 24) st.underline = false;
    else if (p >= 30 && p <= 37) st.color = BASIC[p - 30];
    else if (p >= 90 && p <= 97) st.color = BRIGHT[p - 90];
    else if (p >= 40 && p <= 47) st.bg = BASIC[p - 40];
    else if (p >= 100 && p <= 107) st.bg = BRIGHT[p - 100];
    else if (p === 39) st.color = undefined;
    else if (p === 49) st.bg = undefined;
    else if (p === 38 || p === 48) {
      const mode = list[k + 1];
      if (mode === 5 && list[k + 2] !== undefined) {
        const c = color256(list[k + 2]);
        if (p === 38) st.color = c;
        else st.bg = c;
        k += 2;
      } else if (mode === 2 && list[k + 4] !== undefined) {
        const c = `rgb(${list[k + 2]}, ${list[k + 3]}, ${list[k + 4]})`;
        if (p === 38) st.color = c;
        else st.bg = c;
        k += 4;
      }
    }
    k += 1;
  }
}

function parseAnsi(text: string): Seg[] {
  const out: Seg[] = [];
  const st: StyleState = { bold: false, underline: false, italic: false, faint: false };
  let buf = "";
  const push = () => {
    if (buf) out.push({ text: buf, ...st });
    buf = "";
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\x1b") {
      const next = text[i + 1];
      if (next === "[") {
        // CSI sequence: params then a final byte
        let j = i + 2;
        while (j < text.length && /[0-9;?<>!=]/.test(text[j])) j += 1;
        if (j < text.length && /[A-Za-z]/.test(text[j])) {
          const params = text.slice(i + 2, j);
          const fin = text[j];
          push();
          if (fin === "m") applySgr(params, st);
          i = j + 1;
          continue;
        }
      } else if (next === "]") {
        // OSC sequence: until BEL or ST (ESC \)
        const rest = text.slice(i);
        const bel = rest.indexOf("\x07");
        const stEnd = rest.indexOf("\x1b\\");
        let len = -1;
        if (bel >= 0 && (stEnd < 0 || bel < stEnd)) len = bel + 1;
        else if (stEnd >= 0) len = stEnd + 2;
        if (len > 0) {
          push();
          i += len;
          continue;
        }
      }
      // lone escape or malformed sequence: drop it
      push();
      i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  push();
  return out;
}

export default function AnsiText({ text, className }: { text: string; className?: string }) {
  const segs = useMemo(() => parseAnsi(text), [text]);
  return (
    <span className={className} style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
      {segs.map((s, i) => (
        <span
          key={i}
          style={{
            color: s.color,
            backgroundColor: s.bg,
            fontWeight: s.bold ? 600 : undefined,
            fontStyle: s.italic ? "italic" : undefined,
            textDecorationLine: s.underline ? "underline" : undefined,
            opacity: s.faint ? 0.6 : undefined,
          }}
        >
          {s.text}
        </span>
      ))}
    </span>
  );
}
