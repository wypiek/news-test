import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { openDb } from "./db.js";
import { createApp } from "./app.js";
import { json } from "./http.js";
import { purgeExpiredSessions } from "./auth.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));
const secureCookies = (process.env.SECURE_COOKIES ?? "auto") as "auto" | "always" | "never";

const db = openDb(path.join(DATA_DIR, "pulse.db"));
const app = await createApp({
  db,
  publicDir: path.join(ROOT, "public"),
  dataDir: DATA_DIR,
  trustProxy: process.env.TRUST_PROXY === "1",
  secureCookies,
});

const server = createServer((req, res) => {
  app.handle(req, res).catch((err: unknown) => {
    console.error("[server] unhandled error", err);
    if (!res.headersSent) json(res, 500, { error: "Something went wrong." });
    else res.destroy();
  });
});

server.headersTimeout = 15_000;
server.requestTimeout = 60_000;

server.listen(PORT, HOST, () => {
  const base = `http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`;
  console.log(`Pulse is running at ${base}`);
  const token = app.setupToken();
  if (token) {
    console.log("\nNo accounts exist yet. Open this one-time link to create the admin account:");
    console.log(`  ${base}/setup#token=${token}\n`);
  }
});

purgeExpiredSessions(db);
setInterval(() => purgeExpiredSessions(db), 60 * 60 * 1000).unref();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
