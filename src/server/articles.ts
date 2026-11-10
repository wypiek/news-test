import type { DB } from "./db.js";
import type { User } from "./auth.js";

export const CATEGORIES = [
  { id: "world", label: "World", icon: "public" },
  { id: "tech", label: "Tech", icon: "memory" },
  { id: "science", label: "Science", icon: "science" },
  { id: "business", label: "Business", icon: "trending_up" },
  { id: "culture", label: "Culture", icon: "palette" },
  { id: "sport", label: "Sport", icon: "sports_soccer" },
] as const;

export type CategoryId = (typeof CATEGORIES)[number]["id"];
const CATEGORY_IDS = new Set<string>(CATEGORIES.map((c) => c.id));

export type Status = "draft" | "published";

export const LIMITS = { title: 200, summary: 400, body: 100_000, cover: 1000 } as const;

export interface ArticleInput {
  title: string;
  summary: string;
  body: string;
  category: CategoryId;
  cover: string | null;
  status: Status;
}

export interface ArticleSummary {
  id: number;
  slug: string;
  title: string;
  summary: string;
  category: string;
  cover: string | null;
  status: Status;
  author: string | null;
  authorId: number | null;
  publishedAt: string | null;
  updatedAt: string;
  readingMinutes: number;
}

export interface ArticleFull extends ArticleSummary {
  body: string;
}

interface Row {
  id: number;
  slug: string;
  title: string;
  summary: string;
  body?: string;
  category: string;
  cover: string | null;
  status: Status;
  word_count: number;
  author_id: number | null;
  author: string | null;
  updated_at: number;
  published_at: number | null;
}

const UPLOAD_PATH = /^\/uploads\/[a-f0-9]{32}\.(?:jpg|png|webp|gif)$/;

/** Image URLs are either our own uploads or absolute https URLs. */
export function isAllowedImageUrl(url: string): boolean {
  if (UPLOAD_PATH.test(url)) return true;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && url.length <= LIMITS.cover;
  } catch {
    return false;
  }
}

export class ValidationError extends Error {}

function str(v: unknown, field: string, max: number, required = false): string {
  if (v == null) v = "";
  if (typeof v !== "string") throw new ValidationError(`${field} must be text.`);
  // Normalise newlines and drop control characters other than \n and \t.
  const s = v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  if (required && !s.trim()) throw new ValidationError(`${field} is required.`);
  if (s.length > max) throw new ValidationError(`${field} must be at most ${max.toLocaleString("en")} characters.`);
  return s;
}

export function validateArticle(input: unknown): ArticleInput {
  if (!input || typeof input !== "object") throw new ValidationError("Invalid article.");
  const o = input as Record<string, unknown>;
  const title = str(o.title, "Title", LIMITS.title, true).replace(/\s+/g, " ").trim();
  const summary = str(o.summary, "Summary", LIMITS.summary).trim();
  const body = str(o.body, "Body", LIMITS.body);
  const category = o.category;
  if (typeof category !== "string" || !CATEGORY_IDS.has(category)) throw new ValidationError("Pick a category.");
  let cover: string | null = null;
  if (o.cover != null && o.cover !== "") {
    if (typeof o.cover !== "string" || !isAllowedImageUrl(o.cover)) {
      throw new ValidationError("Cover must be an uploaded image or an https:// image URL.");
    }
    cover = o.cover;
  }
  const status = o.status;
  if (status !== "draft" && status !== "published") throw new ValidationError("Invalid status.");
  if (status === "published" && !body.trim()) throw new ValidationError("Write something before publishing.");
  return { title, summary, body, category: category as CategoryId, cover, status };
}

export function slugify(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
  return slug || "article";
}

function uniqueSlug(db: DB, base: string, excludeId?: number): string {
  const stmt = db.prepare("SELECT 1 FROM articles WHERE slug = ? AND id != ?");
  let slug = base;
  for (let i = 2; stmt.get(slug, excludeId ?? -1); i++) slug = `${base}-${i}`;
  return slug;
}

function countWords(s: string): number {
  return s.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
}

function toSummary(r: Row): ArticleSummary {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    summary: r.summary,
    category: r.category,
    cover: r.cover,
    status: r.status,
    author: r.author,
    authorId: r.author_id,
    publishedAt: r.published_at ? new Date(r.published_at).toISOString() : null,
    updatedAt: new Date(r.updated_at).toISOString(),
    readingMinutes: Math.max(1, Math.round(r.word_count / 220)),
  };
}

function toFull(r: Row): ArticleFull {
  return { ...toSummary(r), body: r.body ?? "" };
}

const SUMMARY_COLS = `a.id, a.slug, a.title, a.summary, a.category, a.cover, a.status, a.word_count,
  a.author_id, a.updated_at, a.published_at, u.display_name AS author`;

/**
 * Turns free text into a safe FTS5 query: every word becomes a quoted prefix
 * term, so user input can never use FTS operators or break the syntax.
 */
export function toFtsQuery(q: string): string | null {
  const terms = q.match(/[\p{L}\p{N}]+/gu)?.slice(0, 8);
  if (!terms?.length) return null;
  return terms.map((t) => `"${t}"*`).join(" ");
}

export interface ListOptions {
  category?: string;
  query?: string;
  page: number;
  pageSize: number;
  /** Public listing shows published articles only. */
  scope: { kind: "public" } | { kind: "editor"; user: User; status?: Status };
}

export function listArticles(db: DB, opts: ListOptions): { items: ArticleSummary[]; total: number } {
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (opts.scope.kind === "public") {
    where.push("a.status = 'published'");
  } else {
    if (opts.scope.user.role !== "admin") {
      where.push("a.author_id = ?");
      params.push(opts.scope.user.id);
    }
    if (opts.scope.status) {
      where.push("a.status = ?");
      params.push(opts.scope.status);
    }
  }
  if (opts.category && CATEGORY_IDS.has(opts.category)) {
    where.push("a.category = ?");
    params.push(opts.category);
  }

  const fts = opts.query ? toFtsQuery(opts.query) : null;
  if (opts.query && !fts) return { items: [], total: 0 };

  let from = "articles a";
  let order = opts.scope.kind === "public" ? "a.published_at DESC" : "a.updated_at DESC";
  if (fts) {
    from = "articles_fts JOIN articles a ON a.id = articles_fts.rowid";
    where.unshift("articles_fts MATCH ?");
    params.unshift(fts);
    order = "bm25(articles_fts, 10.0, 4.0, 1.0), a.published_at DESC";
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${from} ${whereSql}`).get(...params) as { n: number };
  const rows = db.prepare(
    `SELECT ${SUMMARY_COLS} FROM ${from} LEFT JOIN users u ON u.id = a.author_id
     ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`,
  ).all(...params, opts.pageSize, (opts.page - 1) * opts.pageSize) as unknown as Row[];

  return { items: rows.map(toSummary), total: n };
}

export function canEdit(user: User | null, article: { authorId: number | null }): boolean {
  return !!user && (user.role === "admin" || article.authorId === user.id);
}

export function getArticleBySlug(db: DB, slug: string): ArticleFull | null {
  const row = db.prepare(
    `SELECT ${SUMMARY_COLS}, a.body FROM articles a LEFT JOIN users u ON u.id = a.author_id WHERE a.slug = ?`,
  ).get(slug) as Row | undefined;
  return row ? toFull(row) : null;
}

export function getArticleById(db: DB, id: number): ArticleFull | null {
  const row = db.prepare(
    `SELECT ${SUMMARY_COLS}, a.body FROM articles a LEFT JOIN users u ON u.id = a.author_id WHERE a.id = ?`,
  ).get(id) as Row | undefined;
  return row ? toFull(row) : null;
}

export function createArticle(db: DB, input: ArticleInput, author: User): ArticleFull {
  const now = Date.now();
  const slug = uniqueSlug(db, slugify(input.title));
  const result = db.prepare(
    `INSERT INTO articles (slug, title, summary, body, category, cover, status, word_count, author_id, created_at, updated_at, published_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    slug, input.title, input.summary, input.body, input.category, input.cover, input.status,
    countWords(input.body), author.id, now, now, input.status === "published" ? now : null,
  );
  return getArticleById(db, Number(result.lastInsertRowid))!;
}

export function updateArticle(db: DB, existing: ArticleFull, input: ArticleInput): ArticleFull {
  const now = Date.now();
  // The slug follows the title until the article is first published, then stays put so links never break.
  const slug = existing.publishedAt ? existing.slug : uniqueSlug(db, slugify(input.title), existing.id);
  const publishedAt = input.status === "published"
    ? (existing.publishedAt ? Date.parse(existing.publishedAt) : now)
    : existing.publishedAt ? Date.parse(existing.publishedAt) : null;
  db.prepare(
    `UPDATE articles SET slug = ?, title = ?, summary = ?, body = ?, category = ?, cover = ?, status = ?,
       word_count = ?, updated_at = ?, published_at = ? WHERE id = ?`,
  ).run(
    slug, input.title, input.summary, input.body, input.category, input.cover, input.status,
    countWords(input.body), now, publishedAt, existing.id,
  );
  return getArticleById(db, existing.id)!;
}

export function deleteArticle(db: DB, id: number): void {
  db.prepare("DELETE FROM articles WHERE id = ?").run(id);
}
