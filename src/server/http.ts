import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly headers: Record<string, string> = {}) {
    super(message);
  }
}

export const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' https: blob:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

export function send(
  res: ServerResponse,
  status: number,
  body: string | Buffer,
  type: string,
  extra: Record<string, string> = {},
): void {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "content-type": type,
    "content-length": Buffer.byteLength(body).toString(),
    ...extra,
  });
  res.end(res.req.method === "HEAD" ? undefined : body);
}

export function json(res: ServerResponse, status: number, data: unknown, extra: Record<string, string> = {}): void {
  send(res, status, JSON.stringify(data), "application/json; charset=utf-8", { "cache-control": "no-store", ...extra });
}

export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"]);
  if (declared > limit) throw new HttpError(413, "Request body is too large.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "Request body is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req: IncomingMessage, limit = 512 * 1024): Promise<Record<string, unknown>> {
  const type = req.headers["content-type"] ?? "";
  if (!/^application\/json\b/i.test(type)) throw new HttpError(415, "Expected application/json.");
  const raw = await readBody(req, limit);
  let data: unknown;
  try {
    data = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new HttpError(400, "Malformed JSON.");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new HttpError(400, "Expected a JSON object.");
  return data as Record<string, unknown>;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (key && !(key in out)) {
      try { out[key] = decodeURIComponent(value); } catch { /* skip malformed */ }
    }
  }
  return out;
}

export function cookie(name: string, value: string, opts: { maxAgeSec: number; secure: boolean }): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.max(0, Math.floor(opts.maxAgeSec))}`,
    ...(opts.secure ? ["Secure"] : []),
  ].join("; ");
}
