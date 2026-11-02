export interface ProxyPageFailure {
  code: number | null;
  message: string;
}

export function proxyPageFailure(text: string, contentType: string): ProxyPageFailure | null {
  const body = text.trim();
  if (!contentType.toLowerCase().startsWith("text/plain") || body.length > 8192 || !/^Internal Service Worker Error:/i.test(body)) return null;
  const match = /Request failed with error code (\d+)/i.exec(body);
  const code = match ? Number(match[1]) : null;
  const message = code === 6
    ? "The website address could not be resolved. Check the address and try again."
    : code === 7
      ? "The browsing engine could not connect to this website. The destination or network may be unavailable."
      : code === 28
        ? "This website took too long to respond."
        : "The browsing engine could not load this page. Retry or use another browsing mode.";
  return { code, message };
}