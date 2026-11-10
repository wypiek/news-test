import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { openDb, type DB } from "./db.js";
import { createApp, type App } from "./app.js";
import { createUser } from "./auth.js";
import { slugify, toFtsQuery } from "./articles.js";
import { sniffImage } from "./uploads.js";
import { RateLimiter } from "./rate-limit.js";

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../public");

let server: Server;
let base: string;
let db: DB;
let app: App;
let dataDir: string;

before(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "pulse-test-"));
  db = openDb(":memory:");
  app = await createApp({ db, publicDir: PUBLIC, dataDir, apiRateLimit: 10_000 });
  server = createServer((req, res) => void app.handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

after(() => {
  server.close();
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

interface Res { status: number; body: any; headers: Headers; cookie?: string }

async function call(method: string, p: string, opts: { body?: unknown; cookie?: string; headers?: Record<string, string>; raw?: Buffer } = {}): Promise<Res> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.cookie) headers.cookie = opts.cookie;
  let body: Uint8Array | string | undefined;
  if (opts.raw) {
    body = new Uint8Array(opts.raw);
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers["content-type"] ??= "application/json";
  }
  const res = await fetch(base + p, { method, headers, body, redirect: "manual" });
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* not json */ }
  const setCookie = res.headers.get("set-cookie");
  return { status: res.status, body: parsed, headers: res.headers, cookie: setCookie?.split(";")[0] };
}

let adminCookie = "";
let authorCookie = "";
const article = { title: "Hello, Wörld!", summary: "First story", body: "Some **bold** text about pelicans.", category: "science", cover: null, status: "draft" };

test("first-run setup requires the one-time token", async () => {
  const me = await call("GET", "/api/auth/me");
  assert.equal(me.body.needsSetup, true);
  assert.equal((await call("POST", "/api/auth/setup", { body: { token: "nope", username: "admin", password: "correct horse battery" } })).status, 403);

  const ok = await call("POST", "/api/auth/setup", {
    body: { token: app.setupToken(), username: "admin", displayName: "Ada", password: "correct horse battery" },
  });
  assert.equal(ok.status, 201);
  assert.match(ok.headers.get("set-cookie") ?? "", /HttpOnly; SameSite=Strict/);
  adminCookie = ok.cookie!;
  assert.equal(app.setupToken(), null);
  assert.equal((await call("POST", "/api/auth/setup", { body: { token: "x", username: "evil", password: "0123456789" } })).status, 409);
});

test("login rejects wrong passwords and accepts right ones", async () => {
  assert.equal((await call("POST", "/api/auth/login", { body: { username: "admin", password: "wrong password" } })).status, 401);
  assert.equal((await call("POST", "/api/auth/login", { body: { username: "ghost", password: "wrong password" } })).status, 401);
  const ok = await call("POST", "/api/auth/login", { body: { username: "ADMIN", password: "correct horse battery" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.displayName, "Ada");
  assert.equal(ok.body.user.password_hash, undefined);

  await createUser(db, { username: "writer", password: "another long password", role: "author" });
  authorCookie = (await call("POST", "/api/auth/login", { body: { username: "writer", password: "another long password" } })).cookie!;
});

test("editor endpoints need a session", async () => {
  assert.equal((await call("POST", "/api/admin/articles", { body: article })).status, 401);
  assert.equal((await call("GET", "/api/admin/articles", { cookie: "pulse_session=forged" })).status, 401);
});

test("cross-origin writes are blocked (CSRF)", async () => {
  const r = await call("POST", "/api/admin/articles", { body: article, cookie: adminCookie, headers: { origin: "https://evil.example" } });
  assert.equal(r.status, 403);
  const form = await call("POST", "/api/admin/articles", { body: article, cookie: adminCookie, headers: { "content-type": "text/plain" } });
  assert.equal(form.status, 415);
});

test("drafts stay private until published, then become searchable", async () => {
  const created = await call("POST", "/api/admin/articles", { body: article, cookie: adminCookie, headers: { origin: base } });
  assert.equal(created.status, 201);
  const { id, slug } = created.body;
  assert.equal(slug, "hello-world");

  assert.equal((await call("GET", "/api/articles")).body.total, 0);
  assert.equal((await call("GET", `/api/articles/${slug}`)).status, 404);
  assert.equal((await call("GET", `/api/articles/${slug}`, { cookie: adminCookie })).status, 200);

  const pub = await call("PUT", `/api/admin/articles/${id}`, { body: { ...article, status: "published" }, cookie: adminCookie });
  assert.equal(pub.status, 200);
  assert.ok(pub.body.publishedAt);

  const list = await call("GET", "/api/articles?category=science");
  assert.equal(list.body.total, 1);
  assert.equal(list.body.items[0].body, undefined, "listing omits bodies");
  assert.equal((await call("GET", "/api/articles?q=pelic")).body.total, 1);
  assert.equal((await call("GET", "/api/articles?q=world")).body.total, 1, "diacritics are folded");
  assert.equal((await call("GET", "/api/articles?q=giraffe")).body.total, 0);
  for (const q of ['"', "NEAR(a b)", "a OR", "*", "title:x", "'; DROP TABLE articles; --"]) {
    assert.equal((await call("GET", `/api/articles?q=${encodeURIComponent(q)}`)).status, 200, q);
  }

  // Slug stays fixed after publishing, so links never break.
  const renamed = await call("PUT", `/api/admin/articles/${id}`, { body: { ...article, title: "New title", status: "published" }, cookie: adminCookie });
  assert.equal(renamed.body.slug, "hello-world");
});

test("authors can only edit their own stories", async () => {
  const mine = (await call("GET", "/api/admin/articles", { cookie: adminCookie })).body.items[0];
  assert.equal((await call("PUT", `/api/admin/articles/${mine.id}`, { body: article, cookie: authorCookie })).status, 403);
  assert.equal((await call("DELETE", `/api/admin/articles/${mine.id}`, { cookie: authorCookie })).status, 403);
  assert.equal((await call("GET", "/api/admin/articles", { cookie: authorCookie })).body.total, 0);
});

test("article input is validated", async () => {
  const bad = [
    { ...article, title: "  " },
    { ...article, category: "nope" },
    { ...article, cover: "javascript:alert(1)" },
    { ...article, cover: "http://insecure.example/a.jpg" },
    { ...article, status: "published", body: "" },
    { ...article, body: "x".repeat(100_001) },
  ];
  for (const b of bad) {
    const r = await call("POST", "/api/admin/articles", { body: b, cookie: adminCookie });
    assert.equal(r.status, 400, JSON.stringify(b).slice(0, 80));
  }
});

test("uploads accept real images only and are served safely", async () => {
  const fakeSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const rejected = await call("POST", "/api/admin/uploads", { raw: fakeSvg, cookie: adminCookie, headers: { "content-type": "image/png" } });
  assert.equal(rejected.status, 415);

  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b60000000049454e44ae426082", "hex");
  const ok = await call("POST", "/api/admin/uploads", { raw: png, cookie: adminCookie, headers: { "content-type": "image/png" } });
  assert.equal(ok.status, 201);
  assert.match(ok.body.url, /^\/uploads\/[a-f0-9]{32}\.png$/);

  const served = await fetch(base + ok.body.url);
  assert.equal(served.headers.get("content-type"), "image/png");
  assert.match(served.headers.get("content-security-policy") ?? "", /sandbox/);
  assert.equal(served.headers.get("x-content-type-options"), "nosniff");

  const tooBig = await call("POST", "/api/admin/uploads", { raw: Buffer.alloc(5 * 1024 * 1024 + 1), cookie: adminCookie });
  assert.equal(tooBig.status, 413);
});

test("no path traversal and strict security headers", async () => {
  for (const p of ["/uploads/../pulse.db", "/uploads/..%2f..%2fpackage.json", "/../package.json", "/%2e%2e/package.json", "/src/server/app.ts", "/index.html"]) {
    assert.equal((await fetch(base + p)).status, 404, p);
  }
  const home = await fetch(base + "/");
  assert.equal(home.status, 200);
  const csp = home.headers.get("content-security-policy") ?? "";
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal((await fetch(base + "/article/anything")).status, 200, "SPA routes serve the shell");
});

test("logout ends the session", async () => {
  const r = await call("POST", "/api/auth/logout", { body: {}, cookie: authorCookie });
  assert.equal(r.status, 200);
  assert.equal((await call("GET", "/api/admin/articles", { cookie: authorCookie })).status, 401);
});

test("helpers", () => {
  assert.equal(slugify("  Ça va? Über-cool!! "), "ca-va-uber-cool");
  assert.equal(slugify("!!!"), "article");
  assert.equal(toFtsQuery('foo "bar" NEAR(*)'), '"foo"* "bar"* "NEAR"*');
  assert.equal(toFtsQuery("***"), null);
  assert.equal(sniffImage(Buffer.from("GIF89a000000")), "gif");
  assert.equal(sniffImage(Buffer.from("<html>hello</html>")), null);
  const rl = new RateLimiter(2, 1000);
  assert.ok(rl.hit("ip", 0).allowed);
  assert.ok(rl.hit("ip", 1).allowed);
  assert.ok(!rl.hit("ip", 2).allowed);
  assert.ok(rl.hit("ip", 1001).allowed);
});
