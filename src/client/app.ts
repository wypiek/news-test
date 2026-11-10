import { api, ApiError, type Article, type ArticleInput, type ArticleSummary, type Category, type Status, type User } from "./api.js";
import { badge, h, icon, img, isSafeImage, time, timeAgo, type Child } from "./dom.js";
import { renderMarkdown } from "./markdown.js";

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
}

const view = $("view");
const searchForm = $<HTMLFormElement>("search-form");
const searchInput = $<HTMLInputElement>("search-input");
const clearSearch = $<HTMLButtonElement>("clear-search");
const accountLink = $<HTMLAnchorElement>("account");
const snackbar = $("snackbar");

const app = {
  me: null as User | null,
  needsSetup: false,
  categories: [] as Category[],
  /** Aborted whenever the route changes, cancelling the old view's requests and listeners. */
  viewCtl: new AbortController(),
  /** Returns true if it's OK to leave the current view (e.g. no unsaved edits). */
  canLeave: (() => true) as () => boolean,
};

const MAX_UPLOAD = 5 * 1024 * 1024;
const PALETTES = [
  { name: "Violet", hue: 285 },
  { name: "Blue", hue: 250 },
  { name: "Teal", hue: 190 },
  { name: "Green", hue: 145 },
  { name: "Amber", hue: 70 },
  { name: "Rose", hue: 10 },
] as const;

function load(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function save(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

function categoryLabel(id: string): string {
  return app.categories.find((c) => c.id === id)?.label ?? id;
}

let snackTimer = 0;
export function snack(message: string, tone: "info" | "error" = "info"): void {
  snackbar.textContent = message;
  snackbar.dataset.tone = tone;
  snackbar.hidden = false;
  snackbar.style.animation = "none";
  void snackbar.offsetWidth;
  snackbar.style.animation = "";
  clearTimeout(snackTimer);
  snackTimer = window.setTimeout(() => (snackbar.hidden = true), 4500);
}

function setTitle(title: string): void {
  document.title = title ? `${title} · Pulse` : "Pulse";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong.";
}

function confirmDialog(opts: { title: string; text: string; confirm: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    const dlg = h("dialog", { class: "dialog" },
      h("span", { class: "dialog-shape", "aria-hidden": "true" }),
      h("h2", { class: "dialog-title" }, opts.title),
      h("p", { class: "dialog-text" }, opts.text),
      h("form", { method: "dialog", class: "dialog-actions" },
        h("button", { class: "btn btn-text", value: "cancel" }, "Cancel"),
        h("button", { class: `btn ${opts.danger ? "btn-danger" : "btn-filled"}`, value: "ok" }, opts.confirm),
      ),
    );
    dlg.addEventListener("close", () => {
      resolve(dlg.returnValue === "ok");
      dlg.remove();
    });
    document.body.append(dlg);
    dlg.showModal();
  });
}

// ---------------------------------------------------------------------------
// Theme & dynamic color
// ---------------------------------------------------------------------------

function systemDark(): boolean {
  return matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyTheme(theme: "light" | "dark" | null): void {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  const dark = theme ? theme === "dark" : systemDark();
  $("theme-icon").textContent = dark ? "light_mode" : "dark_mode";
  $("theme").setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
}

function applyHue(hue: number): void {
  document.documentElement.style.setProperty("--h", String(hue));
  for (const sw of $("palette").querySelectorAll<HTMLButtonElement>(".swatch")) {
    sw.setAttribute("aria-checked", String(Number(sw.dataset.hue) === hue));
  }
}

function togglePalette(open?: boolean): void {
  const palette = $("palette");
  const next = open ?? palette.hidden;
  palette.hidden = !next;
  $("palette-btn").setAttribute("aria-expanded", String(next));
  if (next) palette.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
}

function initTheme(): void {
  const stored = load("pulse.theme");
  applyTheme(stored === "light" || stored === "dark" ? stored : null);

  const palette = $("palette");
  for (const p of PALETTES) {
    const sw = h("button", {
      type: "button", class: "swatch", role: "menuitemradio", "aria-label": p.name, title: p.name, "data-hue": p.hue,
      onclick: () => { applyHue(p.hue); save("pulse.hue", String(p.hue)); togglePalette(false); },
    });
    sw.style.setProperty("--sh", String(p.hue));
    palette.append(sw);
  }
  const hue = Number(load("pulse.hue"));
  applyHue(PALETTES.some((p) => p.hue === hue) ? hue : PALETTES[0].hue);

  $("theme").addEventListener("click", () => {
    const current = document.documentElement.dataset.theme ?? (systemDark() ? "dark" : "light");
    const next = current === "dark" ? "light" : "dark";
    applyTheme(next);
    save("pulse.theme", next);
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (!document.documentElement.dataset.theme) applyTheme(null);
  });
  $("palette-btn").addEventListener("click", (e) => { e.stopPropagation(); togglePalette(); });
  document.addEventListener("click", (e) => {
    if (!palette.hidden && !palette.contains(e.target as Node)) togglePalette(false);
  });
  $("to-top").addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
  $("write").addEventListener("click", () => navigate(app.me ? "/write" : "/login?next=/write"));
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

type ViewFn = (params: string[], url: URL, signal: AbortSignal) => Promise<void> | void;

const ROUTES: [RegExp, ViewFn][] = [
  [/^\/$/, homeView],
  [/^\/article\/([^/]+)$/, articleView],
  [/^\/login$/, loginView],
  [/^\/setup$/, setupView],
  [/^\/dashboard$/, dashboardView],
  [/^\/write$/, editorView],
  [/^\/write\/(\d+)$/, editorView],
  [/^\/account$/, accountView],
];

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  if (!app.canLeave()) return;
  const url = new URL(to, location.origin);
  if (opts.replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
  void render();
}

async function render(scrollTop = true): Promise<void> {
  app.viewCtl.abort();
  app.viewCtl = new AbortController();
  app.canLeave = () => true;
  togglePalette(false);

  const url = new URL(location.href);
  syncSearchBox(url);
  for (const [pattern, fn] of ROUTES) {
    const m = pattern.exec(url.pathname);
    if (!m) continue;
    view.replaceChildren();
    if (scrollTop) window.scrollTo(0, 0);
    try {
      await fn(m.slice(1).map(decodeURIComponent), url, app.viewCtl.signal);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      if (err instanceof ApiError && err.status === 401) {
        app.me = null;
        renderAccount();
        navigate(`/login?next=${encodeURIComponent(url.pathname + url.search)}`, { replace: true });
        return;
      }
      view.replaceChildren(emptyState("Something went wrong", errorMessage(err), true));
    }
    return;
  }
  notFound();
}

function notFound(): void {
  setTitle("Not found");
  view.replaceChildren(
    h("div", { class: "empty" },
      h("span", { class: "empty-shape", "aria-hidden": "true" }),
      h("h1", { class: "empty-title" }, "Page not found"),
      h("p", { class: "empty-text" }, "The page you're looking for doesn't exist or was unpublished."),
      h("a", { class: "btn btn-filled", href: "/" }, icon("home"), "Back to the front page"),
    ),
  );
}

function emptyState(title: string, text: string, retry = false, action?: Child): HTMLElement {
  return h("div", { class: "empty" },
    h("span", { class: "empty-shape", "aria-hidden": "true" }),
    h("p", { class: "empty-title" }, title),
    h("p", { class: "empty-text" }, text),
    retry ? h("button", { class: "btn btn-filled", type: "button", onclick: () => void render(false) }, icon("refresh"), "Try again") : null,
    action,
  );
}

function loader(): HTMLElement {
  return h("div", { class: "loader", role: "progressbar", "aria-label": "Loading" }, h("span", { class: "loader-shape" }));
}

// Intercept same-origin link clicks for client-side navigation.
document.addEventListener("click", (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = (e.target as Element).closest?.("a");
  if (!a || a.target || a.hasAttribute("download")) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || url.pathname.startsWith("/uploads/") || url.pathname.startsWith("/api/")) return;
  e.preventDefault();
  if (url.pathname + url.search !== location.pathname + location.search) navigate(url.pathname + url.search + url.hash);
});

window.addEventListener("popstate", () => void render(false));

// ---------------------------------------------------------------------------
// Top bar: search + account
// ---------------------------------------------------------------------------

function syncSearchBox(url: URL): void {
  const q = url.pathname === "/" ? url.searchParams.get("q") ?? "" : "";
  if (document.activeElement !== searchInput) searchInput.value = q;
  syncSearchUi();
}

function syncSearchUi(): void {
  const has = searchInput.value.length > 0;
  clearSearch.hidden = !has;
  searchForm.classList.toggle("has-value", has);
}

let searchTimer = 0;
function runSearch(value: string): void {
  clearTimeout(searchTimer);
  const q = value.trim().slice(0, 100);
  const current = new URL(location.href);
  if (current.pathname === "/" && (current.searchParams.get("q") ?? "") === q) return;
  const target = q ? `/?q=${encodeURIComponent(q)}` : "/";
  // Keep typing within one history entry when already on the results page.
  navigate(target, { replace: current.pathname === "/" && current.searchParams.has("q") && !!q });
}

function initSearch(): void {
  searchForm.addEventListener("submit", (e) => {
    e.preventDefault();
    runSearch(searchInput.value);
  });
  searchInput.addEventListener("input", () => {
    syncSearchUi();
    clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => runSearch(searchInput.value), 350);
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { searchInput.value = ""; syncSearchUi(); runSearch(""); searchInput.blur(); }
  });
  clearSearch.addEventListener("click", () => {
    searchInput.value = "";
    syncSearchUi();
    runSearch("");
    searchInput.focus();
  });
  document.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    if (e.key === "/" && !t.closest("input, textarea, [contenteditable]")) {
      e.preventDefault();
      searchInput.focus();
    }
    if (e.key === "Escape" && !$("palette").hidden) togglePalette(false);
  });
}

function renderAccount(): void {
  accountLink.replaceChildren();
  if (app.me) {
    accountLink.href = "/dashboard";
    accountLink.title = "Your newsroom";
    accountLink.setAttribute("aria-label", `Newsroom (${app.me.displayName})`);
    accountLink.classList.add("signed-in");
    accountLink.append(badge(app.me.displayName, "badge avatar"));
  } else {
    accountLink.href = "/login";
    accountLink.title = "Sign in";
    accountLink.setAttribute("aria-label", "Sign in");
    accountLink.classList.remove("signed-in");
    accountLink.append(icon("person"));
  }
}

// ---------------------------------------------------------------------------
// Story cards
// ---------------------------------------------------------------------------

type Variant = "hero" | "wide" | "tint" | "";

function storyCard(a: ArticleSummary, index: number, variant: Variant): HTMLElement {
  const cover = a.cover ? img(a.cover, "", index === 0) : null;
  const card = h("article", { class: `card ${variant}`.trim() },
    h("a", { class: "card-link", href: `/article/${encodeURIComponent(a.slug)}` },
      cover ? h("div", { class: "card-media media" }, cover) : null,
      h("div", { class: "card-body" },
        h("div", { class: "card-meta" },
          h("span", { class: "card-category" }, categoryLabel(a.category)),
          a.publishedAt ? [h("span", { class: "dot", "aria-hidden": "true" }, "·"), time(a.publishedAt)] : null,
        ),
        h("h3", { class: "card-title" }, a.title),
        a.summary ? h("p", { class: "card-summary" }, a.summary) : null,
        h("div", { class: "card-byline" },
          badge(a.author ?? "Pulse"),
          h("span", null, a.author ?? "Pulse"),
          h("span", { class: "dot", "aria-hidden": "true" }, "·"),
          h("span", null, `${a.readingMinutes} min read`),
        ),
      ),
    ),
  );
  card.style.setProperty("--i", String(index));
  return card;
}

function variantFor(i: number, a: ArticleSummary, searching: boolean): Variant {
  if (i === 0 && !searching) return "hero";
  if (i % 9 === 4 && a.cover) return "wide";
  if (i % 7 === 3 && !a.cover) return "tint";
  return "";
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

async function homeView(_p: string[], url: URL, signal: AbortSignal): Promise<void> {
  const q = (url.searchParams.get("q") ?? "").trim();
  const cat = url.searchParams.get("c") ?? "";
  const category = app.categories.find((c) => c.id === cat);

  const title = q ? `Results for “${q}”` : category ? category.label : "Latest stories";
  setTitle(q ? q : category ? category.label : "");

  const sub = h("p", { class: "section-sub", "aria-live": "polite" });
  const grid = h("section", { class: "stories", "aria-label": "Stories" });
  const more = h("button", { class: "btn btn-tonal", type: "button", hidden: true }, icon("expand_more"), "Load more");
  const status = h("div");

  const chips = h("nav", { class: "button-group", "aria-label": "Categories" },
    [{ id: "", label: "All", icon: "bolt" }, ...app.categories].map((c) =>
      h("a", {
        class: "seg",
        href: c.id ? `/?c=${c.id}` : "/",
        "aria-current": !q && c.id === cat ? "page" : null,
      }, icon(c.icon), c.label),
    ),
  );

  view.append(
    h("div", { class: "page" },
      h("div", { class: "section-head" }, h("h1", { class: "headline" }, title), sub),
      chips,
      status,
      grid,
      h("div", { class: "more-wrap" }, more),
    ),
  );
  chips.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "center" });

  let page = 1;
  let rendered = 0;

  async function loadPage(): Promise<void> {
    const first = page === 1;
    if (first) status.replaceChildren(loader());
    else more.setAttribute("aria-busy", "true");
    try {
      const res = await api.articles({ category: cat || undefined, q: q || undefined, page }, signal);
      const frag = document.createDocumentFragment();
      res.items.forEach((a, i) => frag.append(storyCard(a, first ? i : i, variantFor(rendered + i, a, !!q))));
      grid.append(frag);
      rendered += res.items.length;
      more.hidden = !res.hasMore;
      sub.textContent = res.total === 1 ? "1 story" : `${res.total} stories`;
      status.replaceChildren();
      if (!rendered) {
        status.append(q
          ? emptyState("No matches", "Try fewer or different words.")
          : emptyState(
              "No stories yet",
              app.me ? "Your front page is waiting. Write the first story." : "Check back soon.",
              false,
              app.me ? h("a", { class: "btn btn-filled", href: "/write" }, icon("edit"), "Write a story") : null,
            ));
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      if (first) status.replaceChildren(emptyState("Couldn't load stories", errorMessage(err), true));
      else snack(errorMessage(err), "error");
    } finally {
      more.removeAttribute("aria-busy");
    }
  }

  more.addEventListener("click", () => { page++; void loadPage(); });
  await loadPage();
}

async function articleView([slug]: string[], _url: URL, signal: AbortSignal): Promise<void> {
  view.append(loader());
  const a = await api.article(slug!, signal).catch((err: unknown) => {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  });
  if (!a) return notFound();
  setTitle(a.title);
  view.replaceChildren(renderArticle(a, false));
}

function renderArticle(a: Article, preview: boolean): HTMLElement {
  const date = a.publishedAt ?? a.updatedAt;
  const cover = a.cover ? img(a.cover, "", true) : null;
  const prose = h("div", { class: "prose" });
  prose.append(renderMarkdown(a.body));

  const share = async () => {
    const url = location.origin + `/article/${encodeURIComponent(a.slug)}`;
    try {
      if (navigator.share) await navigator.share({ title: a.title, url });
      else { await navigator.clipboard.writeText(url); snack("Link copied"); }
    } catch { /* cancelled */ }
  };

  return h("article", { class: "article" },
    preview ? null : h("div", { class: "article-actions" },
      h("button", { class: "icon-btn", type: "button", "aria-label": "Back", title: "Back", onclick: () => (history.length > 1 ? history.back() : navigate("/")) }, icon("arrow_back")),
      h("span", { class: "spacer" }),
      a.status === "draft" ? h("span", { class: "chip chip-draft" }, icon("edit_note"), "Draft. Only editors can see this") : null,
      a.canEdit ? h("a", { class: "btn btn-tonal btn-sm", href: `/write/${a.id}` }, icon("edit"), "Edit") : null,
      h("button", { class: "icon-btn", type: "button", "aria-label": "Share", title: "Share", onclick: () => void share() }, icon("share")),
    ),
    h("header", { class: "article-head" },
      h("a", { class: "chip", href: `/?c=${a.category}` }, categoryLabel(a.category)),
      h("h1", { class: "article-title" }, a.title || "Untitled"),
      a.summary ? h("p", { class: "article-lede" }, a.summary) : null,
      h("div", { class: "byline" },
        badge(a.author ?? "Pulse", "badge badge-lg"),
        h("div", null,
          h("div", { class: "byline-name" }, a.author ?? "Pulse"),
          h("div", { class: "byline-meta" }, time(date, false), " · ", `${a.readingMinutes} min read`),
        ),
      ),
    ),
    cover ? h("figure", { class: "article-cover media" }, cover) : null,
    prose,
  );
}

async function loginView(_p: string[], url: URL): Promise<void> {
  setTitle("Sign in");
  const next = url.searchParams.get("next");
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";
  if (app.me) return navigate(safeNext, { replace: true });

  const error = h("p", { class: "form-error", role: "alert", hidden: true });
  const submit = h("button", { class: "btn btn-filled btn-block", type: "submit" }, "Sign in");
  const form = h("form", { class: "form" },
    field("Username", h("input", { name: "username", autocomplete: "username", required: true, maxlength: 64, autocapitalize: "none", spellcheck: "false" })),
    field("Password", h("input", { name: "password", type: "password", autocomplete: "current-password", required: true, maxlength: 256 })),
    error,
    submit,
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    submit.disabled = true;
    error.hidden = true;
    try {
      const { user } = await api.login(String(data.get("username")), String(data.get("password")));
      app.me = user;
      renderAccount();
      snack(`Welcome back, ${user.displayName}`);
      navigate(safeNext, { replace: true });
    } catch (err) {
      error.textContent = errorMessage(err);
      error.hidden = false;
      submit.disabled = false;
    }
  });

  view.append(authCard("Sign in", "Write and publish stories in your newsroom.", form,
    app.needsSetup ? h("p", { class: "hint" }, icon("info"), "No accounts yet. Use the one-time setup link printed in the server console.") : null,
  ));
  form.querySelector("input")?.focus();
}

async function setupView(): Promise<void> {
  setTitle("Set up");
  const token = new URLSearchParams(location.hash.slice(1)).get("token") ?? "";
  if (!app.needsSetup) {
    view.append(emptyState("Already set up", "This newsroom already has an admin account.", false,
      h("a", { class: "btn btn-filled", href: "/login" }, "Sign in")));
    return;
  }
  const error = h("p", { class: "form-error", role: "alert", hidden: true });
  const submit = h("button", { class: "btn btn-filled btn-block", type: "submit" }, "Create admin account");
  const form = h("form", { class: "form" },
    field("Your name", h("input", { name: "displayName", autocomplete: "name", maxlength: 60, required: true })),
    field("Username", h("input", { name: "username", autocomplete: "username", required: true, pattern: "[A-Za-z0-9_.\\-]{3,32}", maxlength: 32, autocapitalize: "none", spellcheck: "false" }), "3–32 letters, digits, . _ -"),
    field("Password", h("input", { name: "password", type: "password", autocomplete: "new-password", required: true, minlength: 10, maxlength: 200 }), "At least 10 characters"),
    field("Repeat password", h("input", { name: "confirm", type: "password", autocomplete: "new-password", required: true })),
    error,
    submit,
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = new FormData(form);
    error.hidden = true;
    if (d.get("password") !== d.get("confirm")) {
      error.textContent = "Passwords don't match.";
      error.hidden = false;
      return;
    }
    submit.disabled = true;
    try {
      const { user } = await api.setup({
        token,
        username: String(d.get("username")),
        displayName: String(d.get("displayName")),
        password: String(d.get("password")),
      });
      app.me = user;
      app.needsSetup = false;
      renderAccount();
      history.replaceState(null, "", "/setup"); // drop the token from the address bar
      snack("You're all set. Write your first story!");
      navigate("/write", { replace: true });
    } catch (err) {
      error.textContent = errorMessage(err);
      error.hidden = false;
      submit.disabled = false;
    }
  });
  view.append(authCard("Welcome to Pulse", token ? "Create the admin account for your newsroom." : "Open the full setup link from the server console.", form));
}

function authCard(title: string, sub: string, ...content: Child[]): HTMLElement {
  return h("div", { class: "auth" },
    h("div", { class: "auth-card" },
      h("span", { class: "auth-shape", "aria-hidden": "true" }),
      h("h1", { class: "auth-title" }, title),
      h("p", { class: "auth-sub" }, sub),
      content,
    ),
  );
}

function field(label: string, control: HTMLInputElement | HTMLTextAreaElement, help?: string): HTMLElement {
  const id = `f-${Math.random().toString(36).slice(2, 9)}`;
  control.id = id;
  control.classList.add("field-input");
  if (!control.placeholder) control.placeholder = " ";
  return h("div", { class: "field" },
    control,
    h("label", { for: id, class: "field-label" }, label),
    help ? h("p", { class: "field-help" }, help) : null,
  );
}

function requireLogin(url: URL): boolean {
  if (app.me) return true;
  navigate(`/login?next=${encodeURIComponent(url.pathname + url.search)}`, { replace: true });
  return false;
}

async function dashboardView(_p: string[], url: URL, signal: AbortSignal): Promise<void> {
  if (!requireLogin(url)) return;
  setTitle("Newsroom");
  const me = app.me!;
  const filter = (url.searchParams.get("status") ?? "") as Status | "";
  const list = h("div", { class: "rows" });
  const count = h("p", { class: "section-sub" });

  const filters = h("nav", { class: "button-group compact", "aria-label": "Filter" },
    ([["", "All", "stacks"], ["published", "Published", "public"], ["draft", "Drafts", "edit_note"]] as const).map(([id, label, ic]) =>
      h("a", { class: "seg", href: id ? `/dashboard?status=${id}` : "/dashboard", "aria-current": filter === id ? "page" : null }, icon(ic), label),
    ),
  );

  view.append(
    h("div", { class: "page narrow" },
      h("div", { class: "dash-head" },
        h("div", null,
          h("h1", { class: "headline" }, "Newsroom"),
          h("p", { class: "section-sub" }, `Signed in as ${me.displayName}${me.role === "admin" ? " · admin" : ""}`),
        ),
        h("div", { class: "dash-actions" },
          h("a", { class: "btn btn-text", href: "/account" }, icon("manage_accounts"), "Account"),
          h("a", { class: "btn btn-fab-ext", href: "/write" }, icon("edit"), "New story"),
        ),
      ),
      h("div", { class: "dash-filters" }, filters, count),
      list,
    ),
  );

  list.append(loader());
  const res = await api.myArticles({ status: filter || undefined }, signal);
  list.replaceChildren();
  count.textContent = res.total === 1 ? "1 story" : `${res.total} stories`;
  if (!res.items.length) {
    list.append(emptyState(
      filter === "draft" ? "No drafts" : filter === "published" ? "Nothing published yet" : "No stories yet",
      "Stories you write show up here.",
      false,
      h("a", { class: "btn btn-filled", href: "/write" }, icon("edit"), "Write a story"),
    ));
    return;
  }

  res.items.forEach((a, i) => {
    const thumb = a.cover ? img(a.cover) : null;
    const row: HTMLElement = h("div", { class: "row" },
      h("a", { class: "row-main", href: `/write/${a.id}` },
        h("div", { class: "row-thumb media" }, thumb ?? badge(a.title, "badge")),
        h("div", { class: "row-text" },
          h("div", { class: "row-title" }, a.title || "Untitled"),
          h("div", { class: "row-meta" },
            h("span", { class: `chip chip-sm ${a.status === "published" ? "chip-live" : "chip-draft"}` }, a.status === "published" ? "Published" : "Draft"),
            h("span", null, categoryLabel(a.category)),
            h("span", { class: "dot" }, "·"),
            h("span", null, `Edited ${timeAgo(a.updatedAt)}`),
            me.role === "admin" && a.author ? [h("span", { class: "dot" }, "·"), h("span", null, a.author)] : null,
          ),
        ),
      ),
      h("div", { class: "row-actions" },
        h("a", { class: "icon-btn", href: `/article/${encodeURIComponent(a.slug)}`, title: a.status === "published" ? "View" : "Preview", "aria-label": `View “${a.title}”` }, icon("visibility")),
        h("button", {
          class: "icon-btn danger", type: "button", title: "Delete", "aria-label": `Delete “${a.title}”`,
          onclick: async () => {
            const ok = await confirmDialog({ title: "Delete this story?", text: `“${a.title}” will be permanently deleted.`, confirm: "Delete", danger: true });
            if (!ok) return;
            try {
              await api.remove(a.id);
              row.classList.add("leaving");
              row.addEventListener("animationend", () => row.remove(), { once: true });
              snack("Story deleted");
            } catch (err) {
              snack(errorMessage(err), "error");
            }
          },
        }, icon("delete")),
      ),
    );
    row.style.setProperty("--i", String(i));
    list.append(row);
  });
}

async function accountView(_p: string[], url: URL): Promise<void> {
  if (!requireLogin(url)) return;
  setTitle("Account");
  const me = app.me!;
  const error = h("p", { class: "form-error", role: "alert", hidden: true });
  const submit = h("button", { class: "btn btn-filled", type: "submit" }, "Change password");
  const form = h("form", { class: "form" },
    field("Current password", h("input", { name: "current", type: "password", autocomplete: "current-password", required: true })),
    field("New password", h("input", { name: "next", type: "password", autocomplete: "new-password", required: true, minlength: 10, maxlength: 200 }), "At least 10 characters. Other devices will be signed out."),
    field("Repeat new password", h("input", { name: "confirm", type: "password", autocomplete: "new-password", required: true })),
    error,
    h("div", { class: "form-actions" }, submit),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = new FormData(form);
    error.hidden = true;
    if (d.get("next") !== d.get("confirm")) {
      error.textContent = "Passwords don't match.";
      error.hidden = false;
      return;
    }
    submit.disabled = true;
    try {
      await api.changePassword(String(d.get("current")), String(d.get("next")));
      form.reset();
      snack("Password changed");
    } catch (err) {
      error.textContent = errorMessage(err);
      error.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });

  const signOut = async () => {
    await api.logout().catch(() => undefined);
    app.me = null;
    renderAccount();
    snack("Signed out");
    navigate("/", { replace: true });
  };

  view.append(
    h("div", { class: "page narrow" },
      h("div", { class: "article-actions" },
        h("a", { class: "icon-btn", href: "/dashboard", "aria-label": "Back to newsroom", title: "Back" }, icon("arrow_back")),
      ),
      h("div", { class: "account-head" },
        badge(me.displayName, "badge badge-xl"),
        h("div", null,
          h("h1", { class: "headline" }, me.displayName),
          h("p", { class: "section-sub" }, `@${me.username} · ${me.role}`),
        ),
      ),
      h("section", { class: "panel" }, h("h2", { class: "panel-title" }, "Password"), form),
      h("section", { class: "panel" },
        h("h2", { class: "panel-title" }, "Session"),
        h("p", { class: "section-sub" }, "Sign out of Pulse on this device."),
        h("div", { class: "form-actions" }, h("button", { class: "btn btn-tonal", type: "button", onclick: () => void signOut() }, icon("logout"), "Sign out")),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

async function editorView([idParam]: string[], url: URL, signal: AbortSignal): Promise<void> {
  if (!requireLogin(url)) return;
  let article: Article | null = null;
  if (idParam) {
    view.append(loader());
    article = await api.getForEdit(Number(idParam));
    view.replaceChildren();
  }
  setTitle(article ? `Edit: ${article.title}` : "New story");

  const state: ArticleInput & { id: number | null; slug: string | null; savedStatus: Status | null } = {
    id: article?.id ?? null,
    slug: article?.slug ?? null,
    savedStatus: article?.status ?? null,
    title: article?.title ?? "",
    summary: article?.summary ?? "",
    body: article?.body ?? "",
    category: article?.category ?? app.categories[0]?.id ?? "world",
    cover: article?.cover ?? null,
    status: article?.status ?? "draft",
  };
  let savedSnapshot = JSON.stringify(snapshot());
  let saving = false;

  function snapshot() {
    return { t: state.title, s: state.summary, b: state.body, c: state.category, v: state.cover };
  }
  const dirty = () => JSON.stringify(snapshot()) !== savedSnapshot;

  // ---- Controls ----
  const titleInput = h("textarea", { class: "title-input", rows: 1, maxlength: 200, placeholder: "Headline", "aria-label": "Headline", value: state.title });
  const summaryInput = h("textarea", { class: "summary-input", rows: 1, maxlength: 400, placeholder: "A short summary that appears on the front page", "aria-label": "Summary", value: state.summary });
  const bodyInput = h("textarea", {
    class: "body-input", rows: 14, maxlength: 100000, spellcheck: "true", "aria-label": "Story",
    placeholder: "Tell the story…\n\nMarkdown works: **bold**, *italic*, ## headings, > quotes, - lists, [links](https://…). Paste or drop images to upload them.",
    value: state.body,
  });
  const fileInput = h("input", { type: "file", accept: "image/jpeg,image/png,image/webp,image/gif", hidden: true });
  const stats = h("span", { class: "editor-stats" });
  const saveState = h("span", { class: "save-state", "aria-live": "polite" });
  const statusChip = h("span", { class: "chip chip-sm" });

  const categoryGroup = h("div", { class: "button-group compact wrap", role: "radiogroup", "aria-label": "Category" },
    app.categories.map((c) =>
      h("button", {
        type: "button", class: "seg", role: "radio", "data-id": c.id,
        onclick: () => { state.category = c.id; syncCategory(); changed(); },
      }, icon(c.icon), c.label),
    ),
  );
  function syncCategory(): void {
    for (const b of categoryGroup.querySelectorAll<HTMLButtonElement>(".seg")) {
      b.setAttribute("aria-checked", String(b.dataset.id === state.category));
    }
  }

  const coverBox = h("div", { class: "cover-box" });
  function renderCover(): void {
    coverBox.replaceChildren();
    const image = state.cover ? img(state.cover) : null;
    if (image) {
      coverBox.append(
        h("div", { class: "cover-preview media" }, image),
        h("div", { class: "cover-actions" },
          h("button", { class: "btn btn-tonal btn-sm", type: "button", onclick: () => pickFile("cover") }, icon("swap_horiz"), "Replace"),
          h("button", { class: "btn btn-text btn-sm", type: "button", onclick: () => { state.cover = null; renderCover(); changed(); } }, icon("delete"), "Remove"),
        ),
      );
    } else {
      const urlInput = h("input", { class: "url-input", type: "url", placeholder: "…or paste an https:// image URL", "aria-label": "Cover image URL" });
      urlInput.addEventListener("change", () => {
        const v = urlInput.value.trim();
        if (!v) return;
        if (!isSafeImage(v)) return snack("Use an https:// image URL.", "error");
        state.cover = v;
        renderCover();
        changed();
      });
      coverBox.append(
        h("button", { class: "cover-drop", type: "button", onclick: () => pickFile("cover") },
          icon("add_photo_alternate"), h("span", null, "Add a cover image"), h("small", null, "JPEG, PNG, WebP or GIF · up to 5 MB"),
        ),
        urlInput,
      );
    }
  }

  // ---- Uploads ----
  let fileTarget: "cover" | "body" = "cover";
  function pickFile(target: "cover" | "body"): void {
    fileTarget = target;
    fileInput.value = "";
    fileInput.click();
  }
  async function uploadFile(file: File): Promise<string | null> {
    if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type)) { snack("Only JPEG, PNG, WebP and GIF images are supported.", "error"); return null; }
    if (file.size > MAX_UPLOAD) { snack("Images must be 5 MB or smaller.", "error"); return null; }
    snack("Uploading image…");
    try {
      const { url: u } = await api.upload(file);
      snack("Image uploaded");
      return u;
    } catch (err) {
      snack(errorMessage(err), "error");
      return null;
    }
  }
  async function insertImages(files: File[]): Promise<void> {
    for (const f of files) {
      const u = await uploadFile(f);
      if (u) insertAtCursor(`\n\n![${f.name.replace(/\.[^.]+$/, "").replace(/[[\]]/g, "")}](${u})\n\n`);
    }
  }
  fileInput.addEventListener("change", async () => {
    const files = [...(fileInput.files ?? [])];
    if (!files.length) return;
    if (fileTarget === "cover") {
      const u = await uploadFile(files[0]!);
      if (u) { state.cover = u; renderCover(); changed(); }
    } else {
      await insertImages(files);
    }
  });
  bodyInput.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
    if (files.length) { e.preventDefault(); void insertImages(files); }
  });
  bodyInput.addEventListener("dragover", (e) => { e.preventDefault(); bodyInput.classList.add("drag"); });
  bodyInput.addEventListener("dragleave", () => bodyInput.classList.remove("drag"));
  bodyInput.addEventListener("drop", (e) => {
    bodyInput.classList.remove("drag");
    const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/"));
    if (files.length) { e.preventDefault(); void insertImages(files); }
  });

  // ---- Markdown toolbar ----
  function insertAtCursor(text: string): void {
    bodyInput.focus();
    const { selectionStart: s, selectionEnd: e } = bodyInput;
    bodyInput.setRangeText(text, s, e, "end");
    bodyInput.dispatchEvent(new Event("input"));
  }
  function wrap(before: string, after = before, placeholder = "text"): void {
    bodyInput.focus();
    const { selectionStart: s, selectionEnd: e, value } = bodyInput;
    const sel = value.slice(s, e) || placeholder;
    bodyInput.setRangeText(before + sel + after, s, e, "select");
    bodyInput.setSelectionRange(s + before.length, s + before.length + sel.length);
    bodyInput.dispatchEvent(new Event("input"));
  }
  function prefixLines(prefix: (i: number) => string): void {
    bodyInput.focus();
    const { selectionStart: s, selectionEnd: e, value } = bodyInput;
    const start = value.lastIndexOf("\n", s - 1) + 1;
    const block = value.slice(start, e);
    const out = block.split("\n").map((l, i) => prefix(i) + l).join("\n");
    bodyInput.setRangeText(out, start, e, "end");
    bodyInput.dispatchEvent(new Event("input"));
  }
  const tools: [string, string, () => void][] = [
    ["format_bold", "Bold (Ctrl+B)", () => wrap("**")],
    ["format_italic", "Italic (Ctrl+I)", () => wrap("*")],
    ["title", "Heading", () => prefixLines(() => "## ")],
    ["format_quote", "Quote", () => prefixLines(() => "> ")],
    ["format_list_bulleted", "Bulleted list", () => prefixLines(() => "- ")],
    ["format_list_numbered", "Numbered list", () => prefixLines((i) => `${i + 1}. `)],
    ["link", "Link (Ctrl+K)", () => wrap("[", "](https://)", "link text")],
    ["code", "Code", () => wrap("`")],
    ["image", "Insert image", () => pickFile("body")],
    ["horizontal_rule", "Divider", () => insertAtCursor("\n\n---\n\n")],
  ];
  const mdToolbar = h("div", { class: "md-toolbar", role: "toolbar", "aria-label": "Formatting" },
    tools.map(([ic, label, fn]) => h("button", { class: "icon-btn sm", type: "button", title: label, "aria-label": label, onclick: fn }, icon(ic))),
  );
  bodyInput.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === "b") { e.preventDefault(); wrap("**"); }
    else if (k === "i") { e.preventDefault(); wrap("*"); }
    else if (k === "k") { e.preventDefault(); wrap("[", "](https://)", "link text"); }
  });

  // ---- Write / preview ----
  const writePane = h("div", { class: "editor-write" },
    titleInput,
    summaryInput,
    h("div", { class: "editor-section" }, h("h2", { class: "editor-label" }, "Category"), categoryGroup),
    h("div", { class: "editor-section" }, h("h2", { class: "editor-label" }, "Cover"), coverBox),
    h("div", { class: "editor-section body-section" },
      h("div", { class: "body-head" }, h("h2", { class: "editor-label" }, "Story"), stats),
      mdToolbar,
      bodyInput,
    ),
    fileInput,
  );
  const previewPane = h("div", { class: "editor-preview", hidden: true });

  const modeGroup = h("div", { class: "button-group compact", role: "tablist", "aria-label": "Mode" },
    h("button", { type: "button", class: "seg", role: "tab", "aria-selected": "true", onclick: () => setMode("write") }, icon("edit"), "Write"),
    h("button", { type: "button", class: "seg", role: "tab", "aria-selected": "false", onclick: () => setMode("preview") }, icon("visibility"), "Preview"),
  );
  function setMode(mode: "write" | "preview"): void {
    const [w, p] = modeGroup.querySelectorAll<HTMLButtonElement>(".seg");
    w!.setAttribute("aria-selected", String(mode === "write"));
    p!.setAttribute("aria-selected", String(mode === "preview"));
    writePane.hidden = mode !== "write";
    previewPane.hidden = mode !== "preview";
    if (mode === "preview") {
      previewPane.replaceChildren(renderArticle({
        id: state.id ?? 0, slug: state.slug ?? "", title: state.title, summary: state.summary, body: state.body,
        category: state.category, cover: state.cover, status: state.status, author: app.me?.displayName ?? null,
        authorId: app.me?.id ?? null, publishedAt: article?.publishedAt ?? null, updatedAt: new Date().toISOString(),
        readingMinutes: Math.max(1, Math.round(wordCount(state.body) / 220)),
      }, true));
    }
    window.scrollTo({ top: 0 });
  }

  // ---- Save / publish ----
  const draftBtn = h("button", { class: "btn btn-tonal", type: "button", onclick: () => void persist("draft") });
  const publishBtn = h("button", { class: "btn btn-filled", type: "button", onclick: () => void persist("published") });
  const viewLink = h("a", { class: "icon-btn", title: "View live story", "aria-label": "View live story" }, icon("open_in_new"));
  const deleteBtn = h("button", { class: "icon-btn danger", type: "button", title: "Delete", "aria-label": "Delete story", onclick: () => void destroy() }, icon("delete"));

  function syncBar(): void {
    const live = state.savedStatus === "published";
    statusChip.className = `chip chip-sm ${live ? "chip-live" : "chip-draft"}`;
    statusChip.textContent = live ? "Published" : state.id ? "Draft" : "New";
    draftBtn.replaceChildren(icon(live ? "unpublished" : "save"), live ? "Unpublish" : "Save draft");
    publishBtn.replaceChildren(icon(live ? "check" : "send"), live ? "Update" : "Publish");
    viewLink.hidden = !live || !state.slug;
    if (state.slug) viewLink.setAttribute("href", `/article/${encodeURIComponent(state.slug)}`);
    deleteBtn.hidden = !state.id;
    saveState.textContent = saving ? "Saving…" : dirty() ? "Unsaved changes" : state.id ? "All changes saved" : "";
  }

  function wordCount(s: string): number {
    return s.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  }

  function autoGrow(t: HTMLTextAreaElement): void {
    t.style.height = "auto";
    t.style.height = `${t.scrollHeight}px`;
  }

  function changed(): void {
    state.title = titleInput.value;
    state.summary = summaryInput.value;
    state.body = bodyInput.value;
    const words = wordCount(state.body);
    stats.textContent = `${words.toLocaleString()} words · ${Math.max(1, Math.round(words / 220))} min read`;
    syncBar();
  }

  for (const t of [titleInput, summaryInput, bodyInput]) {
    t.addEventListener("input", () => { autoGrow(t); changed(); });
  }
  titleInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); summaryInput.focus(); } });
  summaryInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); bodyInput.focus(); } });

  async function persist(status: Status): Promise<void> {
    if (saving) return;
    changed();
    if (!state.title.trim()) { setMode("write"); titleInput.focus(); return snack("Give your story a headline first.", "error"); }
    if (status === "published" && !state.body.trim()) { setMode("write"); bodyInput.focus(); return snack("Write something before publishing.", "error"); }
    if (status === "draft" && state.savedStatus === "published") {
      const ok = await confirmDialog({ title: "Unpublish this story?", text: "It will be removed from the front page and become a draft again.", confirm: "Unpublish" });
      if (!ok) return;
    }
    saving = true;
    syncBar();
    draftBtn.disabled = publishBtn.disabled = true;
    const input: ArticleInput = {
      title: state.title, summary: state.summary, body: state.body,
      category: state.category, cover: state.cover, status,
    };
    try {
      const wasLive = state.savedStatus === "published";
      const saved = state.id ? await api.update(state.id, input) : await api.create(input);
      const isNew = !state.id;
      article = saved;
      state.id = saved.id;
      state.slug = saved.slug;
      state.status = saved.status;
      state.savedStatus = saved.status;
      savedSnapshot = JSON.stringify(snapshot());
      if (isNew) history.replaceState(null, "", `/write/${saved.id}`);
      setTitle(`Edit: ${saved.title}`);
      snack(status === "published" ? (wasLive ? "Story updated" : "Published! It's on the front page.") : wasLive ? "Story unpublished" : "Draft saved");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        snack("Your session expired. Sign in again in a new tab, then save.", "error");
      } else {
        snack(errorMessage(err), "error");
      }
    } finally {
      saving = false;
      draftBtn.disabled = publishBtn.disabled = false;
      syncBar();
    }
  }

  async function destroy(): Promise<void> {
    if (!state.id) return;
    const ok = await confirmDialog({ title: "Delete this story?", text: "This can't be undone.", confirm: "Delete", danger: true });
    if (!ok) return;
    try {
      await api.remove(state.id);
      savedSnapshot = JSON.stringify(snapshot());
      app.canLeave = () => true;
      snack("Story deleted");
      navigate("/dashboard", { replace: true });
    } catch (err) {
      snack(errorMessage(err), "error");
    }
  }

  // ---- Leave guards & shortcuts ----
  app.canLeave = () => !dirty() || confirm("You have unsaved changes. Leave anyway?");
  window.addEventListener("beforeunload", (e) => { if (dirty()) e.preventDefault(); }, { signal });
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void persist(state.savedStatus === "published" ? "published" : "draft");
    }
  }, { signal });

  view.append(
    h("div", { class: "editor" },
      h("div", { class: "editor-bar" },
        h("a", { class: "icon-btn", href: "/dashboard", title: "Back to newsroom", "aria-label": "Back to newsroom" }, icon("arrow_back")),
        statusChip,
        saveState,
        h("span", { class: "spacer" }),
        modeGroup,
        h("div", { class: "editor-buttons" }, viewLink, deleteBtn, draftBtn, publishBtn),
      ),
      writePane,
      previewPane,
    ),
  );

  syncCategory();
  renderCover();
  changed();
  requestAnimationFrame(() => {
    for (const t of [titleInput, summaryInput, bodyInput]) autoGrow(t);
    if (!state.id) titleInput.focus();
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function init(): Promise<void> {
  initTheme();
  initSearch();
  const [me, categories] = await Promise.all([
    api.me().catch(() => ({ user: null, needsSetup: false })),
    api.categories().catch(() => [] as Category[]),
  ]);
  app.me = me.user;
  app.needsSetup = me.needsSetup;
  app.categories = categories;
  renderAccount();
  await render();
}

void init();
