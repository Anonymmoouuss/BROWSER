import type { Bookmark } from "./shared";

const MAX_SOURCE_LENGTH = 100_000;

export function isBookmarklet(url: string): boolean {
  return /^javascript:/i.test(url.trim());
}

export function bookmarkletSource(value: string): string {
  let source = value.trim();
  if (isBookmarklet(source)) {
    source = source.slice(source.indexOf(":") + 1);
    try {
      source = decodeURIComponent(source);
    } catch {
      source = source.trim();
    }
  }
  if (!source.trim()) throw new Error("Enter JavaScript to run.");
  if (source.length > MAX_SOURCE_LENGTH) throw new Error("Bookmarklet code must be under 100,000 characters.");
  return source;
}

export function createBookmarklet(title: string, value: string): Bookmark {
  const name = title.trim();
  if (!name) throw new Error("Enter a bookmarklet name.");
  const source = bookmarkletSource(value);
  return { title: name, url: `javascript:${encodeURIComponent(source)}` };
}

export function pageScriptError(error: unknown): string {
  try {
    const message = (error as { message?: unknown } | null)?.message;
    if (typeof message === "string" && message.trim()) return message;
    if (typeof error === "string" && error.trim()) return error;
    if (error !== null && error !== undefined) {
      const description = String(error);
      if (description && description !== "[object Object]") return description;
    }
  } catch {
    return "The page rejected this bookmarklet.";
  }
  return "The page rejected this bookmarklet.";
}

export function runPageScript(frame: HTMLIFrameElement | null, source: string): unknown {
  if (!frame?.contentWindow) throw new Error("Open a web page before running JavaScript.");
  const location = new URL(frame.src, "http://workspace.invalid");
  if (location.pathname !== "/api/proxy" && !location.pathname.startsWith("/~/sj/")) {
    throw new Error("JavaScript can run only in a loaded web page, not the workspace interface.");
  }
  const page = frame.contentWindow as Window & typeof globalThis;
  const script = bookmarkletSource(source);
  return page.eval(`(() => {
    const describe = (reason) => {
      try {
        if (typeof reason?.message === "string" && reason.message.trim()) return reason.message;
        if (typeof reason === "string" && reason.trim()) return reason;
        if (reason !== null && reason !== undefined) {
          const description = String(reason);
          if (description && description !== "[object Object]") return description;
        }
      } catch {}
      return "The page rejected this bookmarklet.";
    };
    try {
      const result = (0, eval)(${JSON.stringify(script)});
      if (result && typeof result.then === "function") {
        return Promise.resolve(result).catch((reason) => { throw describe(reason); });
      }
      return result;
    } catch (reason) {
      throw describe(reason);
    }
  })()`);
}