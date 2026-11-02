"use client";

import { useSyncExternalStore } from "react";
import { strFromU8, unzipSync } from "fflate";
import { pageScriptError, runPageScript } from "./bookmarklets";

export const EXTENSIONS_KEY = "cw.extensions.v1";
const MAX_SOURCE_BYTES = 750_000;
const MAX_STORE_BYTES = 2_500_000;

interface ContentRule {
  matches: string[];
  excludeMatches: string[];
  javascript: string;
  css: string;
}

export interface ExtensionPackage {
  name: string;
  version: string;
  description: string;
  manifest: Record<string, unknown>;
  files: Record<string, string>;
  rules: ContentRule[];
}

export interface InstalledExtension extends ExtensionPackage {
  id: string;
  enabled: boolean;
  installedAt: number;
}

const EMPTY: InstalledExtension[] = [];
let cache: InstalledExtension[] | null = null;
const listeners = new Set<() => void>();
const injected = new WeakMap<Document, Set<string>>();

function safePath(path: string): boolean {
  return !!path && !path.startsWith("/") && !path.includes("\\") && !path.split("/").some((part) => part === ".." || part === ".");
}

function patternExpression(pattern: string): { scheme: string; host: string; path: RegExp } {
  if (pattern === "<all_urls>") return { scheme: "*", host: "*", path: /^\/.*$/ };
  const parsed = /^(\*|https?):\/\/(\*|\*\.[a-z0-9.-]+|[a-z0-9.-]+)(\/[^#]*)$/i.exec(pattern);
  if (!parsed || pattern.length > 500) throw new Error("Use HTTP(S) content-script match patterns.");
  const host = parsed[2].toLowerCase();
  if (host !== "*") {
    const literal = host.startsWith("*.") ? host.slice(2) : host;
    if (new URL(`https://${literal}`).hostname !== literal || literal.startsWith(".") || literal.endsWith(".")) {
      throw new Error("The extension contains an invalid site-match pattern.");
    }
  }
  const escaped = parsed[3].split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return { scheme: parsed[1].toLowerCase(), host, path: new RegExp(`^${escaped}$`) };
}

export function extensionMatches(pattern: string, target: string): boolean {
  try {
    const rule = patternExpression(pattern);
    const url = new URL(target);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return false;
    if (rule.scheme !== "*" && `${rule.scheme}:` !== url.protocol) return false;
    const hostMatches = rule.host === "*" || (rule.host.startsWith("*.")
      ? url.hostname === rule.host.slice(2) || url.hostname.endsWith(`.${rule.host.slice(2)}`)
      : url.hostname === rule.host);
    return hostMatches && rule.path.test(url.pathname + url.search);
  } catch {
    return false;
  }
}

function parsePackage(manifestValue: unknown, files: Record<string, string>): ExtensionPackage {
  if (!manifestValue || typeof manifestValue !== "object" || Array.isArray(manifestValue)) throw new Error("The extension manifest is invalid.");
  const manifest = manifestValue as Record<string, unknown>;
  if (manifest.manifest_version !== 3) throw new Error("Only Manifest V3 page-script extensions are supported.");
  if (typeof manifest.name !== "string" || !manifest.name.trim() || manifest.name.length > 100 ||
    typeof manifest.version !== "string" || !/^\d+(?:\.\d+){0,3}$/.test(manifest.version)) {
    throw new Error("The extension needs a valid name and version.");
  }
  for (const field of ["background", "action", "browser_action", "page_action", "web_accessible_resources", "declarative_net_request", "devtools_page", "oauth2", "sandbox", "commands", "options_page", "options_ui", "chrome_url_overrides", "content_security_policy"]) {
    if (manifest[field] !== undefined) throw new Error(`Chrome-only feature is not supported: ${field}.`);
  }
  for (const field of ["permissions", "host_permissions", "optional_permissions", "optional_host_permissions"]) {
    if (manifest[field] !== undefined && (!Array.isArray(manifest[field]) || manifest[field].length)) {
      throw new Error(`Chrome browser permissions are not supported: ${field}.`);
    }
  }
  if (!Array.isArray(manifest.content_scripts) || !manifest.content_scripts.length || manifest.content_scripts.length > 20) {
    throw new Error("This package has no supported content scripts.");
  }
  let total = 0;
  const usedFiles: Record<string, string> = {};
  const loadFiles = (value: unknown, suffix: string): string => {
    if (value === undefined) return "";
    if (!Array.isArray(value) || value.length > 20) throw new Error("The content-script file list is invalid.");
    return value.map((path) => {
      if (typeof path !== "string" || !safePath(path) || !path.toLowerCase().endsWith(suffix) || !Object.hasOwn(files, path)) {
        throw new Error("A content-script file is missing or has an unsafe path.");
      }
      const source = files[path];
      if (typeof source !== "string" || source.length > 250_000) throw new Error("Each content-script file must be under 250 KB.");
      total += source.length;
      if (total > MAX_SOURCE_BYTES) throw new Error("Extension source must be under 750 KB.");
      usedFiles[path] = source;
      return source;
    }).join(suffix === ".js" ? "\n;\n" : "\n");
  };
  const rules = manifest.content_scripts.map((entry: unknown): ContentRule => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("The content-script rule is invalid.");
    const rule = entry as Record<string, unknown>;
    if ((rule.run_at !== undefined && rule.run_at !== "document_idle" && rule.run_at !== "document_end") ||
      (rule.world !== undefined && rule.world !== "MAIN") || rule.all_frames || rule.match_about_blank ||
      rule.include_globs || rule.exclude_globs || rule.match_origin_as_fallback) {
      throw new Error("Only top-page, document-end/idle scripts in page context are supported.");
    }
    const patterns = (value: unknown, required: boolean): string[] => {
      if (value === undefined && !required) return [];
      if (!Array.isArray(value) || (required && !value.length) || value.length > 20 || value.some((pattern) => typeof pattern !== "string")) {
        throw new Error("The extension needs valid site-match patterns.");
      }
      for (const pattern of value) patternExpression(pattern);
      return value;
    };
    const javascript = loadFiles(rule.js, ".js");
    const css = loadFiles(rule.css, ".css");
    if (!javascript && !css) throw new Error("A content-script rule must contain JavaScript or CSS.");
    return { matches: patterns(rule.matches, true), excludeMatches: patterns(rule.exclude_matches, false), javascript, css };
  });
  return { name: manifest.name.trim(), version: manifest.version, description: typeof manifest.description === "string" ? manifest.description.slice(0, 500) : "", manifest, files: usedFiles, rules };
}

export function parseExtensionArchive(bytes: Uint8Array): ExtensionPackage {
  if (!bytes.length || bytes.length > 3 * 1024 * 1024) throw new Error("Choose an extension ZIP under 3 MB.");
  let count = 0;
  let expanded = 0;
  const archive = unzipSync(bytes, { filter(file) {
    count++;
    expanded += file.originalSize;
    if (!safePath(file.name) || count > 100 || file.originalSize > 1_000_000 || expanded > 4_000_000) {
      throw new Error("The extension ZIP is too large or contains unsafe paths.");
    }
    return /\.(json|js|css)$/i.test(file.name);
  } });
  const manifests = Object.keys(archive).filter((path) => /(^|\/)manifest\.json$/.test(path));
  const manifestPath = Object.hasOwn(archive, "manifest.json") ? "manifest.json" : manifests.length === 1 ? manifests[0] : null;
  if (!manifestPath) throw new Error("The ZIP must contain one extension manifest.json.");
  const base = manifestPath.slice(0, -"manifest.json".length);
  const files = Object.fromEntries(Object.entries(archive).filter(([path]) => path.startsWith(base)).map(([path, value]) => [path.slice(base.length), strFromU8(value)]));
  return parsePackage(JSON.parse(files["manifest.json"]), files);
}

export function parseUserscript(source: string): ExtensionPackage {
  if (!source.trim() || source.length > 250_000) throw new Error("Choose a userscript under 250 KB.");
  const header = /^\s*\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/.exec(source);
  if (!header || header[1].length > 20_000) throw new Error("A userscript must start with a valid ==UserScript== metadata header.");
  const metadata = new Map<string, string[]>();
  for (const line of header[1].split(/\r?\n/)) {
    const entry = /^\s*\/\/\s*@([\w-]+)\s+(.+?)\s*$/.exec(line);
    if (entry) metadata.set(entry[1], [...(metadata.get(entry[1]) ?? []), entry[2]]);
  }
  if ((metadata.get("grant") ?? []).some((grant) => grant !== "none") || metadata.has("require") || metadata.has("resource") || metadata.has("connect") || metadata.has("include")) {
    throw new Error("Only page-context userscripts with @match and @grant none are supported. Manager APIs and external dependencies are not available.");
  }
  const runAt = metadata.get("run-at")?.[0] ?? "document-idle";
  if (runAt !== "document-idle" && runAt !== "document-end") throw new Error("Only document-end or document-idle userscripts are supported.");
  return parsePackage({
    manifest_version: 3,
    name: metadata.get("name")?.[0],
    version: metadata.get("version")?.[0] ?? "1.0",
    description: metadata.get("description")?.[0] ?? "",
    content_scripts: [{
      matches: metadata.get("match") ?? [], exclude_matches: metadata.get("exclude-match") ?? [],
      world: "MAIN", run_at: runAt.replace("-", "_"), js: ["content.js"],
    }],
  }, { "content.js": source });
}

export function getExtensions(): InstalledExtension[] {
  if (typeof window === "undefined") return EMPTY;
  if (cache) return cache;
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(EXTENSIONS_KEY) ?? "[]");
    if (!Array.isArray(stored) || stored.length > 10) return cache = EMPTY;
    cache = stored.flatMap((item) => {
      try {
        if (!item || typeof item.id !== "string" || !/^[a-f0-9-]{36}$/.test(item.id) || typeof item.enabled !== "boolean" || !item.files || typeof item.files !== "object") return [];
        return [{ ...parsePackage(item.manifest, item.files), id: item.id, enabled: item.enabled, installedAt: Number(item.installedAt) || 0 }];
      } catch { return []; }
    });
  } catch { cache = EMPTY; }
  return cache;
}

function write(extensions: InstalledExtension[]) {
  const serialized = JSON.stringify(extensions.map(({ id, enabled, installedAt, manifest, files }) => ({ id, enabled, installedAt, manifest, files })));
  if (serialized.length > MAX_STORE_BYTES) throw new Error("Extension storage is full. Remove an extension before installing another.");
  try { localStorage.setItem(EXTENSIONS_KEY, serialized); } catch { throw new Error("The browser could not save this extension. Free some local storage and retry."); }
  cache = extensions;
  for (const listener of listeners) listener();
}

export function installExtension(extension: ExtensionPackage): void {
  const current = getExtensions();
  if (current.length >= 10) throw new Error("Remove an extension before installing another (limit 10).");
  if (current.some((item) => item.name === extension.name)) throw new Error("An extension with this name is already installed. Remove it before installing a replacement.");
  write([...current, { ...extension, id: crypto.randomUUID(), enabled: true, installedAt: Date.now() }]);
}

export function setExtensionEnabled(id: string, enabled: boolean): void {
  write(getExtensions().map((extension) => extension.id === id ? { ...extension, enabled } : extension));
}

export function removeExtension(id: string): void {
  write(getExtensions().filter((extension) => extension.id !== id));
}

function onStorage(event: StorageEvent) {
  if (event.key !== EXTENSIONS_KEY && event.key !== null) return;
  cache = null;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener("storage", onStorage);
  };
}

export function useExtensions(): InstalledExtension[] {
  return useSyncExternalStore(subscribe, getExtensions, () => EMPTY);
}

export async function applyPageExtensions(frame: HTMLIFrameElement, target: string): Promise<string[]> {
  const document = frame.contentDocument;
  if (!document || !/^https?:\/\//i.test(target) || new URL(target).origin === window.location.origin) return [];
  let applied = injected.get(document);
  if (!applied) { applied = new Set(); injected.set(document, applied); }
  const errors: string[] = [];
  for (const extension of getExtensions()) {
    if (!extension.enabled || applied.has(extension.id)) continue;
    const rules = extension.rules.filter((rule) => rule.matches.some((pattern) => extensionMatches(pattern, target)) && !rule.excludeMatches.some((pattern) => extensionMatches(pattern, target)));
    if (!rules.length) continue;
    applied.add(extension.id);
    try {
      const css = rules.map((rule) => rule.css).join("\n");
      const javascript = rules.map((rule) => rule.javascript).filter(Boolean).join("\n;\n");
      if (css) {
        runPageScript(frame, `(() => { const style = document.createElement("style"); style.dataset.workspaceExtension = ${JSON.stringify(extension.id)}; style.textContent = ${JSON.stringify(css)}; (document.head || document.documentElement).appendChild(style); })();`);
      }
      if (javascript) await runPageScript(frame, javascript);
    } catch (error) {
      errors.push(`${extension.name}: ${pageScriptError(error)}`);
    }
  }
  return errors;
}