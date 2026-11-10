import type { IncomingMessage, ServerResponse } from "node:http";
import { readdir, readFile } from "node:fs/promises";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import type { DB } from "./db.js";
import {
  authenticate, checkPassword, createSession, createUser, deleteSession, deleteUserSessions,
  getSessionUser, setPassword, validatePassword, SESSION_TTL_MS, type User,
} from "./auth.js";
import {
  CATEGORIES, ValidationError, canEdit, createArticle, deleteArticle, getArticleById, getArticleBySlug,
  listArticles, updateArticle, validateArticle, type Status,
} from "./articles.js";
import { HttpError, SECURITY_HEADERS, cookie, json, parseCookies, readBody, readJson, send } from "./http.js";
import { RateLimiter } from "./rate-limit.js";
import { MAX_UPLOAD_BYTES, Uploads } from "./uploads.js";

export interface AppOptions {
  db: DB;
  publicDir: string;
  dataDir: string;
  /** Trust X-Forwarded-For / X-Forwarded-Proto from a reverse proxy. */
  trustProxy?: boolean;
  /** "auto" sets Secure on cookies when the request arrived over HTTPS. */
  secureCookies?: "auto" | "always" | "never";
  apiRateLimit?: number;
}

const SESSION_COOKIE = "pulse_session";
const PAGE_SIZE = 18;
const MAX_PAGE = 500;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

/** Client-side routes; each serves the app shell. */
const SPA_ROUTES = [/^\/$/, /^\/article\/[^/]+$/, /^\/login$/, /^\/setup$/, /^\/dashboard$/, /^\/write(?:\/\d+)?$/, /^\/account$/];

interface Asset { body: Buffer; type: string; etag: string }

async function loadAssets(dir: string): Promise<Map<string, Asset>> {
  const assets = new Map<string, Asset>();
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const type = MIME[path.extname(entry.name)];
    if (!type) continue;
    const body = await readFile(path.join(dir, entry.name));
    const etag = `"${createHash("sha1").update(body).digest("base64url").slice(0, 20)}"`;
    assets.set(`/${entry.name}`, { body, type, etag });
  }
  if (!assets.has("/index.html")) throw new Error(`index.html missing from ${dir}`);
  return assets;
}

export interface App {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** One-time token that allows creating the first admin from the browser; null once a user exists. */
  setupToken(): string | null;
}

export async function createApp(opts: AppOptions): Promise<App> {
  const { db } = opts;
  // Static files are loaded into memory from a fixed folder at startup; request
  // paths are looked up in this map and never touch the filesystem.
  const assets = await loadAssets(opts.publicDir);
  const uploads = new Uploads(path.join(opts.dataDir, "uploads"));
  const apiLimiter = new RateLimiter(opts.apiRateLimit ?? 300, 60_000);
  const loginLimiter = new RateLimiter(10, 15 * 60_000);
  const uploadLimiter = new RateLimiter(60, 60 * 60_000);

  const userCount = () => (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
  let setupToken: string | null = userCount() === 0 ? randomBytes(24).toString("base64url") : null;

  function clientIp(req: IncomingMessage): string {
    if (opts.trustProxy) {
      const fwd = req.headers["x-forwarded-for"];
      const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? "unknown";
  }

  function isHttps(req: IncomingMessage): boolean {
    if ("encrypted" in req.socket && req.socket.encrypted) return true;
    return !!opts.trustProxy && req.headers["x-forwarded-proto"] === "https";
  }

  function secure(req: IncomingMessage): boolean {
    const mode = opts.secureCookies ?? "auto";
    return mode === "always" || (mode === "auto" && isHttps(req));
  }

  function limit(limiter: RateLimiter, key: string, message: string): void {
    const r = limiter.hit(key);
    if (!r.allowed) throw new HttpError(429, message, { "retry-after": String(Math.ceil(r.retryAfterMs / 1000)) });
  }

  /**
   * CSRF defence in depth: on top of SameSite=Strict cookies and JSON-only
   * bodies, state-changing requests must come from our own origin.
   */
  function checkOrigin(req: IncomingMessage): void {
    const origin = req.headers.origin;
    if (origin) {
      let host: string;
      try { host = new URL(origin).host; } catch { throw new HttpError(403, "Bad origin."); }
      if (host !== req.headers.host) throw new HttpError(403, "Cross-origin request blocked.");
      return;
    }
    const site = req.headers["sec-fetch-site"];
    if (site && site !== "same-origin" && site !== "none") throw new HttpError(403, "Cross-site request blocked.");
  }

  function sessionToken(req: IncomingMessage): string | undefined {
    return parseCookies(req.headers.cookie)[SESSION_COOKIE];
  }

  function requireUser(req: IncomingMessage): User {
    const user = getSessionUser(db, sessionToken(req));
    if (!user) throw new HttpError(401, "Please sign in.");
    return user;
  }

  function startSession(req: IncomingMessage, res: ServerResponse, user: User): void {
    const token = createSession(db, user.id);
    res.setHeader("set-cookie", cookie(SESSION_COOKIE, token, { maxAgeSec: SESSION_TTL_MS / 1000, secure: secure(req) }));
  }

  function pageParam(url: URL): number {
    return Math.min(MAX_PAGE, Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1));
  }

  function idParam(raw: string): number {
    const id = Number(raw);
    if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(404, "Not found.");
    return id;
  }

  function editable(user: User, id: number) {
    const article = getArticleById(db, id);
    if (!article) throw new HttpError(404, "Article not found.");
    if (!canEdit(user, article)) throw new HttpError(403, "You can't edit this article.");
    return article;
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? "GET";
    const p = url.pathname;
    let m: RegExpExecArray | null;

    limit(apiLimiter, clientIp(req), "Too many requests. Slow down a little.");
    if (method !== "GET" && method !== "HEAD") checkOrigin(req);

    // ---- Public ----
    if (method === "GET" && p === "/api/categories") {
      return json(res, 200, CATEGORIES, { "cache-control": "public, max-age=300" });
    }

    if (method === "GET" && p === "/api/articles") {
      const query = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
      const page = pageParam(url);
      const { items, total } = listArticles(db, {
        category: url.searchParams.get("category") ?? undefined,
        query,
        page,
        pageSize: PAGE_SIZE,
        scope: { kind: "public" },
      });
      return json(res, 200, { items, total, page, hasMore: page * PAGE_SIZE < total });
    }

    if (method === "GET" && (m = /^\/api\/articles\/([a-z0-9\p{L}-]{1,100})$/u.exec(decodeURIComponentSafe(p)))) {
      const article = getArticleBySlug(db, m[1]!);
      const user = getSessionUser(db, sessionToken(req));
      // Drafts are only visible to people who can edit them (for previewing).
      if (!article || (article.status !== "published" && !canEdit(user, article))) {
        throw new HttpError(404, "Article not found.");
      }
      return json(res, 200, { ...article, canEdit: canEdit(user, article) });
    }

    // ---- Auth ----
    if (method === "GET" && p === "/api/auth/me") {
      const user = getSessionUser(db, sessionToken(req));
      return json(res, 200, { user, needsSetup: setupToken !== null });
    }

    if (method === "POST" && p === "/api/auth/login") {
      limit(loginLimiter, clientIp(req), "Too many sign-in attempts. Try again in a few minutes.");
      const body = await readJson(req, 4096);
      const username = typeof body.username === "string" ? body.username.trim().slice(0, 64) : "";
      const password = typeof body.password === "string" ? body.password.slice(0, 256) : "";
      const user = username && password ? await authenticate(db, username, password) : null;
      if (!user) throw new HttpError(401, "Wrong username or password.");
      startSession(req, res, user);
      return json(res, 200, { user });
    }

    if (method === "POST" && p === "/api/auth/logout") {
      deleteSession(db, sessionToken(req));
      res.setHeader("set-cookie", cookie(SESSION_COOKIE, "", { maxAgeSec: 0, secure: secure(req) }));
      return json(res, 200, { ok: true });
    }

    if (method === "POST" && p === "/api/auth/setup") {
      limit(loginLimiter, clientIp(req), "Too many attempts. Try again in a few minutes.");
      const body = await readJson(req, 4096);
      const token = typeof body.token === "string" ? body.token : "";
      if (!setupToken || userCount() > 0) throw new HttpError(409, "Setup is already complete.");
      const a = Buffer.from(token), b = Buffer.from(setupToken);
      if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(403, "Invalid setup link.");
      let user: User;
      try {
        user = await createUser(db, {
          username: String(body.username ?? "").trim(),
          password: String(body.password ?? ""),
          displayName: typeof body.displayName === "string" ? body.displayName : undefined,
          role: "admin",
        });
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
      setupToken = null;
      startSession(req, res, user);
      return json(res, 201, { user });
    }

    if (method === "POST" && p === "/api/auth/password") {
      const user = requireUser(req);
      limit(loginLimiter, `pw:${user.id}`, "Too many attempts. Try again in a few minutes.");
      const body = await readJson(req, 4096);
      const current = typeof body.current === "string" ? body.current : "";
      const next = typeof body.next === "string" ? body.next : "";
      if (!(await checkPassword(db, user.id, current))) throw new HttpError(400, "Current password is wrong.");
      const err = validatePassword(next);
      if (err) throw new HttpError(400, err);
      await setPassword(db, user.id, next);
      deleteUserSessions(db, user.id, sessionToken(req)); // sign out other devices
      return json(res, 200, { ok: true });
    }

    // ---- Editor ----
    if (p.startsWith("/api/admin/")) {
      const user = requireUser(req);

      if (method === "GET" && p === "/api/admin/articles") {
        const status = url.searchParams.get("status");
        const page = pageParam(url);
        const { items, total } = listArticles(db, {
          query: (url.searchParams.get("q") ?? "").trim().slice(0, 100),
          page,
          pageSize: 50,
          scope: { kind: "editor", user, status: status === "draft" || status === "published" ? (status as Status) : undefined },
        });
        return json(res, 200, { items, total, page, hasMore: page * 50 < total });
      }

      if (method === "POST" && p === "/api/admin/articles") {
        const input = validateArticle(await readJson(req));
        return json(res, 201, createArticle(db, input, user));
      }

      if ((m = /^\/api\/admin\/articles\/(\d+)$/.exec(p))) {
        const id = idParam(m[1]!);
        if (method === "GET") return json(res, 200, editable(user, id));
        if (method === "PUT") {
          const existing = editable(user, id);
          const input = validateArticle(await readJson(req));
          return json(res, 200, updateArticle(db, existing, input));
        }
        if (method === "DELETE") {
          editable(user, id);
          deleteArticle(db, id);
          return json(res, 200, { ok: true });
        }
      }

      if (method === "POST" && p === "/api/admin/uploads") {
        limit(uploadLimiter, `up:${user.id}`, "Upload limit reached. Try again later.");
        const buf = await readBody(req, MAX_UPLOAD_BYTES);
        const url = await uploads.save(buf);
        if (!url) throw new HttpError(415, "Only JPEG, PNG, WebP and GIF images are allowed.");
        return json(res, 201, { url });
      }
    }

    throw new HttpError(404, "Not found.");
  }

  function serveAsset(req: IncomingMessage, res: ServerResponse, asset: Asset, cache: string): void {
    if (req.headers["if-none-match"] === asset.etag) {
      res.writeHead(304, { ...SECURITY_HEADERS, etag: asset.etag, "cache-control": cache });
      res.end();
      return;
    }
    send(res, 200, asset.body, asset.type, { etag: asset.etag, "cache-control": cache });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      return json(res, 400, { error: "Bad request." });
    }

    try {
      if (url.pathname.startsWith("/api/")) return await api(req, res, url);

      if (req.method !== "GET" && req.method !== "HEAD") {
        throw new HttpError(405, "Method not allowed.", { allow: "GET, HEAD" });
      }

      if (url.pathname.startsWith("/uploads/")) {
        const file = await uploads.read(url.pathname.slice("/uploads/".length));
        if (!file) return send(res, 404, "Not found", "text/plain; charset=utf-8");
        return send(res, 200, file.body, file.type, {
          "cache-control": "public, max-age=31536000, immutable",
          "content-security-policy": "default-src 'none'; sandbox",
        });
      }

      if (SPA_ROUTES.some((r) => r.test(url.pathname))) {
        return serveAsset(req, res, assets.get("/index.html")!, "no-cache");
      }

      const asset = assets.get(url.pathname);
      if (asset && url.pathname !== "/index.html") return serveAsset(req, res, asset, "no-cache");

      return send(res, 404, "Not found", "text/plain; charset=utf-8");
    } catch (err) {
      if (err instanceof HttpError) return json(res, err.status, { error: err.message }, err.headers);
      if (err instanceof ValidationError) return json(res, 400, { error: err.message });
      throw err;
    }
  }

  return { handle, setupToken: () => setupToken };
}

function decodeURIComponentSafe(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}
