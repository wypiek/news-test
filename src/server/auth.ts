import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";
import type { DB } from "./db.js";

const scrypt = (pw: string, salt: Buffer, len: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCb(pw, salt, len, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );

const PARAMS = { N: 2 ** 15, r: 8, p: 1, keylen: 64 };
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const MIN_PASSWORD = 10;
export const MAX_PASSWORD = 200;

export type Role = "admin" | "author";

export interface User {
  id: number;
  username: string;
  displayName: string;
  role: Role;
}

/** Hashes a password with scrypt; format: scrypt$N$r$p$salt$hash (base64). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const { N, r, p, keylen } = PARAMS;
  const key = await scrypt(password, salt, keylen, { N, r, p, maxmem: 128 * N * r * 2 });
  return ["scrypt", N, r, p, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, saltB64, hashB64] = stored.split("$");
  if (algo !== "scrypt" || !saltB64 || !hashB64) return false;
  const N = Number(n), R = Number(r), P = Number(p);
  const expected = Buffer.from(hashB64, "base64");
  const key = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length, {
    N, r: R, p: P, maxmem: 128 * N * R * 2,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

// A real hash of a random password, so a login for an unknown user costs the
// same as one for a known user (no username enumeration through timing).
let dummyHash: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  return (dummyHash ??= hashPassword(randomBytes(16).toString("hex")));
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

interface UserRow {
  id: number;
  username: string;
  display_name: string;
  role: Role;
  password_hash: string;
}

function toUser(row: UserRow): User {
  return { id: row.id, username: row.username, displayName: row.display_name, role: row.role };
}

export async function authenticate(db: DB, username: string, password: string): Promise<User | null> {
  const row = db.prepare("SELECT * FROM users WHERE username = ?").get(username) as UserRow | undefined;
  if (!row) {
    await verifyPassword(password, await getDummyHash());
    return null;
  }
  return (await verifyPassword(password, row.password_hash)) ? toUser(row) : null;
}

/** Creates a session and returns the raw token. Only its SHA-256 is stored. */
export function createSession(db: DB, userId: number): string {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .run(sha256(token), userId, now, now + SESSION_TTL_MS);
  return token;
}

export function getSessionUser(db: DB, token: string | undefined): User | null {
  if (!token || token.length > 100) return null;
  const row = db.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
  ).get(sha256(token), Date.now()) as UserRow | undefined;
  return row ? toUser(row) : null;
}

export function deleteSession(db: DB, token: string | undefined): void {
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
}

export function deleteUserSessions(db: DB, userId: number, exceptToken?: string): void {
  db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").run(userId, exceptToken ? sha256(exceptToken) : "");
}

export function purgeExpiredSessions(db: DB): void {
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
}

export function validateUsername(username: string): string | null {
  return /^[a-zA-Z0-9_.-]{3,32}$/.test(username) ? null : "Username must be 3–32 letters, digits, dots, dashes or underscores.";
}

export function validatePassword(password: string): string | null {
  if (password.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters.`;
  if (password.length > MAX_PASSWORD) return `Password must be at most ${MAX_PASSWORD} characters.`;
  return null;
}

export async function createUser(db: DB, input: { username: string; password: string; displayName?: string; role: Role }): Promise<User> {
  const err = validateUsername(input.username) ?? validatePassword(input.password);
  if (err) throw new Error(err);
  const displayName = (input.displayName ?? input.username).trim().slice(0, 60) || input.username;
  const hash = await hashPassword(input.password);
  const result = db.prepare(
    "INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(input.username, displayName, hash, input.role, Date.now());
  return { id: Number(result.lastInsertRowid), username: input.username, displayName, role: input.role };
}

export async function setPassword(db: DB, userId: number, password: string): Promise<void> {
  const err = validatePassword(password);
  if (err) throw new Error(err);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(await hashPassword(password), userId);
}

export async function checkPassword(db: DB, userId: number, password: string): Promise<boolean> {
  const row = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(userId) as { password_hash: string } | undefined;
  return row ? verifyPassword(password, row.password_hash) : false;
}
