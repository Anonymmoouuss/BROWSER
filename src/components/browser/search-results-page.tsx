"use client";

/**
 * SearchResultsPage — the app's own Bing results page (an internal page like
 * about:history). The omnibox routes every web search here.
 *
 * Results come from the browser-backend /api/search endpoint (Bing's RSS
 * output — a separate pipeline that is immune to the anti-bot "junk SERP"
 * path Bing's edge serves to proxied HTML requests on this sandbox's
 * Asian-geo IP). Result links are explicit app navigations, so the clicked
 * site loads through the full-fidelity Scramjet engine.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ExternalLink, RefreshCw, Search } from "lucide-react";
import { BACKEND_PORT, faviconUrl, hostOf } from "@/lib/browser/shared";
import { sjtQuery } from "@/lib/browser/engine-token";

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

interface SearchResultsPageProps {
  query: string;
  onNavigate: (input: string) => void;
  onOpenTab?: (url: string, background: boolean) => void;
}

function skeletonRows() {
  return (
    <div className="space-y-9" aria-label="Loading search results" role="status">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="animate-pulse space-y-2">
          <div className="flex items-center gap-2">
            <div className="h-4 w-4 rounded-sm bg-zinc-800" />
            <div className="h-3 w-44 rounded bg-zinc-800" />
          </div>
          <div className="h-5 w-2/3 rounded bg-zinc-800/80" />
          <div className="h-3 w-full rounded bg-zinc-900" />
          <div className="h-3 w-5/6 rounded bg-zinc-900" />
        </div>
      ))}
    </div>
  );
}

/** Host breadcrumb like Chrome's result URLs: "www.youtube.com › watch". */
function breadcrumbOf(url: string): string {
  try {
    const u = new URL(url);
    const segs = u.pathname.split("/").filter(Boolean).slice(0, 3);
    return [u.hostname.replace(/^www\./, ""), ...segs].join(" › ");
  } catch {
    return url;
  }
}

export default function SearchResultsPage({ query, onNavigate, onOpenTab }: SearchResultsPageProps) {
  const [results, setResults] = useState<SearchResultItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadSeq, setReloadSeq] = useState(0);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const startedRef = useRef(0);

  const load = useCallback(async (signal: AbortSignal) => {
    setError(null);
    setResults(null);
    startedRef.current = performance.now();
    setElapsed(null);
    try {
      const res = await fetch(`/api/search?XTransformPort=${BACKEND_PORT}${sjtQuery()}&q=${encodeURIComponent(query)}`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]),
      });
      if (!res.headers.get("content-type")?.includes("application/json")) {
        throw new Error("Search is temporarily unavailable. Please try again.");
      }
      const data = (await res.json()) as
        | { ok: true; results: SearchResultItem[] }
        | { ok: false; error: string };
      if (signal.aborted) return;
      setElapsed(Math.round(performance.now() - startedRef.current));
      if (!res.ok || !data.ok) throw new Error(!data.ok ? data.error || "Search failed." : "Search failed.");
      setResults(data.results);
    } catch (err) {
      if (signal.aborted) return;
      setElapsed(null);
      setError(err instanceof DOMException && err.name === "TimeoutError"
        ? "Search took too long. Please try again."
        : err instanceof Error ? err.message : "Search failed.");
    }
  }, [query]);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) void load(controller.signal);
    });
    return () => controller.abort();
  }, [load, reloadSeq]);

  const go = (url: string) => onNavigate(url);

  return (
    <div className="cw-scroll cw-backdrop h-full overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-5 py-7 sm:px-8 sm:py-10">
        {/* summary header */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-zinc-800/70 pb-5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-900">
            <Search className="h-4 w-4 text-zinc-300" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="break-words text-lg font-semibold text-zinc-100">{query}</h1>
            <p className="text-xs text-zinc-500">
              {results
                ? `${results.length} results`
                : error
                  ? "Search failed"
                  : "Searching…"}
              {elapsed !== null && results ? ` · ${elapsed} ms` : ""}
              {" · Web search"}
            </p>
          </div>
        </div>

        {/* body */}
        <div className="pt-6">
          {error ? (
            <div className="border-b border-zinc-800 py-6">
              <p className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                <AlertTriangle className="h-4 w-4 text-amber-400" aria-hidden="true" />
                Results could not be loaded
              </p>
              <p className="mt-1.5 text-sm text-zinc-500">{error}</p>
              <button
                type="button"
                onClick={() => setReloadSeq((n) => n + 1)}
                className="mt-4 inline-flex items-center gap-2 rounded-lg bg-emerald-400 px-4 py-2 text-sm font-semibold text-emerald-950 transition-colors hover:bg-emerald-300"
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                Try again
              </button>
            </div>
          ) : results === null ? (
            skeletonRows()
          ) : results.length === 0 ? (
            <div className="border-b border-zinc-800 py-6 text-sm text-zinc-500">
              No results for this query.
            </div>
          ) : (
            <ol className="space-y-9" aria-label="Search results">
              {results.map((r) => {
                const host = hostOf(r.url) ?? "";
                return (
                  <li key={r.url}>
                    <a
                      href={r.url}
                      onClick={(e) => {
                        if (e.metaKey || e.ctrlKey) {
                          e.preventDefault();
                          onOpenTab?.(r.url, !e.shiftKey);
                          return;
                        }
                        e.preventDefault();
                        go(r.url);
                      }}
                      onAuxClick={(e) => {
                        if (e.button === 1) {
                          e.preventDefault();
                          onOpenTab?.(r.url, true);
                        }
                      }}
                      className="group block"
                    >
                      <span className="flex items-center gap-2">
                        <img
                          src={faviconUrl(host)}
                          alt=""
                          width={18}
                          height={18}
                          className="h-[18px] w-[18px] shrink-0 rounded-sm"
                          onError={(e) => {
                            (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
                          }}
                        />
                        <span className="truncate text-xs text-zinc-500">{breadcrumbOf(r.url)}</span>
                        <ExternalLink
                          className="h-3 w-3 shrink-0 text-zinc-700 opacity-0 transition-opacity group-hover:opacity-100"
                          aria-hidden="true"
                        />
                      </span>
                      <span className="mt-1 block text-[17px] font-medium leading-snug text-emerald-200 group-hover:underline">
                        {r.title}
                      </span>
                      {r.snippet && (
                        <span className="mt-1 block text-sm leading-relaxed text-zinc-400 line-clamp-3">
                          {r.snippet}
                        </span>
                      )}
                    </a>
                  </li>
                );
              })}
            </ol>
          )}
        </div>

      </div>
    </div>
  );
}
