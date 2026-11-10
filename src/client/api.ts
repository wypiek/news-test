export type Status = "draft" | "published";

export interface User {
  id: number;
  username: string;
  displayName: string;
  role: "admin" | "author";
}

export interface Category {
  id: string;
  label: string;
  icon: string;
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

export interface Article extends ArticleSummary {
  body: string;
  canEdit?: boolean;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  hasMore: boolean;
}

export interface ArticleInput {
  title: string;
  summary: string;
  body: string;
  category: string;
  cover: string | null;
  status: Status;
}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const init: RequestInit = { method, signal, headers: { accept: "application/json" }, credentials: "same-origin" };
  if (body instanceof Blob) {
    init.body = body;
    (init.headers as Record<string, string>)["content-type"] = body.type || "application/octet-stream";
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["content-type"] = "application/json";
  }
  const res = await fetch(url, init);
  let data: unknown = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error ?? `Request failed (${res.status}).`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

const qs = (params: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") p.set(k, String(v));
  return p.size ? `?${p}` : "";
};

export const api = {
  categories: () => request<Category[]>("GET", "/api/categories"),
  articles: (o: { category?: string; q?: string; page?: number }, signal?: AbortSignal) =>
    request<Page<ArticleSummary>>("GET", `/api/articles${qs(o)}`, undefined, signal),
  article: (slug: string, signal?: AbortSignal) =>
    request<Article>("GET", `/api/articles/${encodeURIComponent(slug)}`, undefined, signal),

  me: () => request<{ user: User | null; needsSetup: boolean }>("GET", "/api/auth/me"),
  login: (username: string, password: string) => request<{ user: User }>("POST", "/api/auth/login", { username, password }),
  logout: () => request<{ ok: true }>("POST", "/api/auth/logout", {}),
  setup: (b: { token: string; username: string; displayName: string; password: string }) =>
    request<{ user: User }>("POST", "/api/auth/setup", b),
  changePassword: (current: string, next: string) => request<{ ok: true }>("POST", "/api/auth/password", { current, next }),

  myArticles: (o: { status?: Status; page?: number }, signal?: AbortSignal) =>
    request<Page<ArticleSummary>>("GET", `/api/admin/articles${qs(o)}`, undefined, signal),
  getForEdit: (id: number) => request<Article>("GET", `/api/admin/articles/${id}`),
  create: (a: ArticleInput) => request<Article>("POST", "/api/admin/articles", a),
  update: (id: number, a: ArticleInput) => request<Article>("PUT", `/api/admin/articles/${id}`, a),
  remove: (id: number) => request<{ ok: true }>("DELETE", `/api/admin/articles/${id}`),
  upload: (file: Blob) => request<{ url: string }>("POST", "/api/admin/uploads", file),
};
