// A small, safe Markdown renderer that builds DOM nodes directly.
// Supported: headings, paragraphs, **bold**, *italic*, ~~strike~~, `code`,
// links, images, autolinks, > quotes, - / 1. lists, ``` code blocks, ---.
// Raw HTML is never interpreted; it is shown as text.

import { h, img, isSafeHref, type Child } from "./dom.js";

const INLINE = new RegExp(
  [
    "`([^`]+)`",                                   // 1 code
    "!\\[([^\\]]*)\\]\\(([^)\\s]+)\\)",            // 2,3 image
    "\\[([^\\]]+)\\]\\(([^)\\s]+)\\)",             // 4,5 link
    "\\*\\*(.+?)\\*\\*",                           // 6 bold
    "__(.+?)__",                                   // 7 bold
    "~~(.+?)~~",                                   // 8 strike
    "\\*([^*\\s](?:[^*]*[^*\\s])?)\\*",            // 9 italic
    "(?<![\\p{L}\\p{N}_])_([^_]+)_(?![\\p{L}\\p{N}_])", // 10 italic
    "(https?:\\/\\/[^\\s<]+[^\\s<.,;:!?)\\]'\"])", // 11 autolink
  ].join("|"),
  "gu",
);

function link(href: string, children: Child[]): Child {
  if (!isSafeHref(href)) return children;
  const external = !href.startsWith("/");
  return h("a", { href, ...(external ? { target: "_blank", rel: "noopener noreferrer nofollow ugc" } : {}) }, children);
}

export function inline(text: string): Child[] {
  const out: Child[] = [];
  let last = 0;
  // matchAll iterates over a private copy of the regex, so the recursive calls
  // below can't disturb this loop's position.
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1] !== undefined) out.push(h("code", null, m[1]));
    else if (m[3] !== undefined) out.push(img(m[3], m[2]) ?? m[0]);
    else if (m[5] !== undefined) out.push(link(m[5], inline(m[4]!)));
    else if (m[6] !== undefined || m[7] !== undefined) out.push(h("strong", null, inline((m[6] ?? m[7])!)));
    else if (m[8] !== undefined) out.push(h("s", null, inline(m[8])));
    else if (m[9] !== undefined || m[10] !== undefined) out.push(h("em", null, inline((m[9] ?? m[10])!)));
    else if (m[11] !== undefined) out.push(link(m[11], [m[11]]));
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const ONLY_IMAGE = /^!\[([^\]]*)\]\(([^)\s]+)\)$/;

export function renderMarkdown(src: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;

  const isBlockStart = (l: string) =>
    /^(#{1,6})\s/.test(l) || /^>\s?/.test(l) || /^\s*[-*+]\s+/.test(l) || /^\s*\d+[.)]\s+/.test(l) ||
    /^```/.test(l) || /^(?:-{3,}|\*{3,}|_{3,})\s*$/.test(l);

  while (i < lines.length) {
    const line = lines[i]!;

    if (!line.trim()) { i++; continue; }

    // Fenced code
    if (/^```/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) buf.push(lines[i++]!);
      i++;
      frag.append(h("pre", null, h("code", null, buf.join("\n"))));
      continue;
    }

    // Heading (# → h2 because the article title is the page's h1)
    const hm = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (hm) {
      const level = Math.min(4, hm[1]!.length + 1) as 2 | 3 | 4;
      frag.append(h(`h${level}`, null, inline(hm[2]!)));
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      frag.append(h("hr"));
      i++;
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) buf.push(lines[i++]!.replace(/^>\s?/, ""));
      const bq = h("blockquote");
      bq.append(renderMarkdown(buf.join("\n")));
      frag.append(bq);
      continue;
    }

    // Lists
    const ordered = /^\s*\d+[.)]\s+/.test(line);
    if (ordered || /^\s*[-*+]\s+/.test(line)) {
      const marker = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/;
      const list = h(ordered ? "ol" : "ul");
      if (ordered) {
        const start = Number.parseInt(line, 10);
        if (start > 1) list.setAttribute("start", String(start));
      }
      while (i < lines.length && marker.test(lines[i]!)) {
        let item = lines[i++]!.replace(marker, "");
        // Continuation lines (indented, not a new item)
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!) && !marker.test(lines[i]!)) item += " " + lines[i++]!.trim();
        list.append(h("li", null, inline(item)));
      }
      frag.append(list);
      continue;
    }

    // Paragraph
    const buf: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !isBlockStart(lines[i]!)) buf.push(lines[i++]!.trim());
    if (!buf.length) buf.push(lines[i++]!.trim()); // always make progress
    const text = buf.join(" ");
    const im = ONLY_IMAGE.exec(text);
    if (im) {
      const image = img(im[2]!, im[1]);
      if (image) {
        frag.append(h("figure", { class: "media" }, image, im[1] ? h("figcaption", null, im[1]) : null));
        continue;
      }
    }
    frag.append(h("p", null, inline(text)));
  }
  return frag;
}
