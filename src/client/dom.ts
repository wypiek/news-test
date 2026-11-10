// Tiny DOM builder. Text is always inserted as text nodes, never parsed as HTML.

export type Child = Node | string | number | null | undefined | false | Child[];
type Handler = (e: never) => void;
export type Props = Record<string, string | number | boolean | null | undefined | Handler>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (typeof value === "function") {
        el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      } else if (key === "class") {
        el.className = String(value);
      } else if (key === "value" && "value" in el) {
        (el as HTMLInputElement).value = String(value);
      } else {
        el.setAttribute(key, value === true ? "" : String(value));
      }
    }
  }
  append(el, children);
  return el;
}

export function append(parent: Node, children: Child[]): void {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(parent, c);
    else parent.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function icon(name: string, extra = ""): HTMLSpanElement {
  return h("span", { class: `msr ${extra}`.trim(), "aria-hidden": "true" }, name);
}

const SVG = "http://www.w3.org/2000/svg";

function hash(s: string): number {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619);
  return x >>> 0;
}

const shapeCache = new Map<string, string>();

/** An SVG path for an M3 Expressive "cookie" shape; the lobe count is picked from the seed. */
export function cookiePath(seed: string): string {
  const cached = shapeCache.get(seed);
  if (cached) return cached;
  const options = [[4, 0.14], [5, 0.11], [6, 0.09], [7, 0.08], [8, 0.07], [9, 0.06], [12, 0.05]] as const;
  const [lobes, amp] = options[hash(seed) % options.length]!;
  const pts: string[] = [];
  for (let i = 0; i < 96; i++) {
    const t = (i / 96) * Math.PI * 2;
    const r = (1 + amp * Math.cos(lobes * t)) / (1 + amp);
    pts.push(`${(r * Math.cos(t - Math.PI / 2)).toFixed(3)} ${(r * Math.sin(t - Math.PI / 2)).toFixed(3)}`);
  }
  const d = `M${pts.join("L")}Z`;
  shapeCache.set(seed, d);
  return d;
}

/** A shaped avatar badge with an initial, e.g. for authors. */
export function badge(name: string, cls = "badge"): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", cls);
  svg.setAttribute("viewBox", "-1.25 -1.25 2.5 2.5");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", cookiePath(name));
  const text = document.createElementNS(SVG, "text");
  text.setAttribute("x", "0");
  text.setAttribute("y", "0.04");
  text.textContent = (name.trim()[0] ?? "?").toUpperCase();
  svg.append(path, text);
  return svg;
}

export function isSafeHref(url: string): boolean {
  if (url.startsWith("/") && !url.startsWith("//")) return true;
  try {
    const u = new URL(url);
    return ["https:", "http:", "mailto:"].includes(u.protocol);
  } catch {
    return false;
  }
}

export function isSafeImage(url: string): boolean {
  if (/^\/uploads\/[a-f0-9]{32}\.(?:jpg|png|webp|gif)$/.test(url)) return true;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

export function img(src: string, alt = "", eager = false): HTMLImageElement | null {
  if (!isSafeImage(src)) return null;
  const el = h("img", { src, alt, loading: eager ? "eager" : "lazy", decoding: "async" });
  el.addEventListener("error", () => el.closest(".media")?.classList.add("broken"), { once: true });
  return el;
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" });
export const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
export const dateTimeFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function timeAgo(iso: string): string {
  const diff = (Date.parse(iso) - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return "just now";
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), "day");
  return dateFmt.format(new Date(iso));
}

export function time(iso: string, relative = true): HTMLTimeElement {
  return h("time", { datetime: iso, title: dateTimeFmt.format(new Date(iso)) }, relative ? timeAgo(iso) : dateFmt.format(new Date(iso)));
}
