# Pulse

A minimalist, self-hosted news engine. You write and publish your own stories,
and readers browse them on a front page styled with **Material 3 Expressive**.

Built with **TypeScript on Node.js**, with SQLite for storage. It has a single
runtime dependency: Node itself.

## Features

**For readers**
- Front page with a hero story, category filters and "load more" paging.
- Full-text search (SQLite FTS5) with prefix matching that ignores accents. Press `/` to search.
- Clean article pages with emphasized typography, cover images and sharing.
- Light and dark themes, plus six dynamic color palettes.

**For writers**
- Sign in, then work from a **Newsroom** dashboard that lists drafts and published stories.
- Distraction-free editor:
  - Headline, summary, category and cover image fields.
  - Markdown body with a formatting toolbar and shortcuts (Ctrl+B, Ctrl+I, Ctrl+K, Ctrl+S).
  - Paste or drag images into the body to upload them.
  - Live **Preview**, then **Save draft**, **Publish**, **Update** or **Unpublish**.
- Warns before you leave the page with unsaved changes.
- Multiple writers: an **admin** can edit everything, an **author** only their own stories.

**Material 3 Expressive design**
- **Spring motion:** CSS `linear()` easings that model M3's spatial springs, which overshoot slightly, and its effects springs, which don't.
- **Shapes:** the expanded shape scale (up to 48px corners) and the shape library:
  - The loading indicator morphs between cookie, clover, burst and pentagon shapes.
  - Author avatars are cookie shapes.
  - Buttons and cards change shape when hovered or pressed.
- **Components:**
  - Connected button groups.
  - A floating toolbar with a FAB.
  - An extended FAB.
  - Filled text fields with floating labels.
  - Chips, a dialog and a snackbar.
- **Emphasized type:** Roboto Flex, using its weight, width and optical-size axes.
- **Dynamic color:** every color role comes from one seed hue, in OKLCH.

## Getting started

Requires **Node.js 22.13 or newer**, which includes the built-in `node:sqlite`.

```bash
npm install
npm run build
npm start
```

On first start the server prints a **one-time setup link**:

```
No accounts exist yet. Open this one-time link to create the admin account:
  http://127.0.0.1:3000/setup#token=…
```

Open it and create your admin account. You'll land straight in the editor.
If you'd rather use the terminal, `npm run user -- create yourname --admin`
does the same.

### Managing users

```bash
npm run user -- create alice --name "Alice Smith"   # an author
npm run user -- create bob --admin                  # an admin
npm run user -- password alice                      # reset a password (signs out their sessions)
npm run user -- list
npm run user -- delete alice                        # their stories remain, without an author
```

### Configuration (environment variables)

| Variable         | Default       | Purpose                                                              |
|------------------|---------------|----------------------------------------------------------------------|
| `PORT`           | `3000`        | HTTP port                                                            |
| `HOST`           | `127.0.0.1`   | Bind address. Use `0.0.0.0` only behind a reverse proxy or firewall. |
| `DATA_DIR`       | `./data`      | Database (`pulse.db`) and uploaded images                            |
| `TRUST_PROXY`    | unset         | Set to `1` behind nginx or Caddy so client IPs and HTTPS are detected |
| `SECURE_COOKIES` | `auto`        | `always` forces the `Secure` flag (recommended in production)        |

### Production

Run it behind a TLS-terminating reverse proxy, for example Caddy:

```
news.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

with `TRUST_PROXY=1 SECURE_COOKIES=always npm start`. To back up, copy `DATA_DIR`.

## Writing: Markdown cheat sheet

| You type                  | You get                  |
|---------------------------|--------------------------|
| `## Heading`              | Section heading          |
| `**bold**`, `*italic*`    | **bold**, *italic*       |
| `[text](https://…)`       | Link                     |
| `> quote`                 | Pull quote               |
| `- item` / `1. item`      | Lists                    |
| `![caption](url)`         | Image with caption       |
| `---`                     | Divider                  |
| `` `code` `` / ```` ``` ```` | Code                 |

## Security

Here is what is in place:

- **Passwords** are hashed with scrypt (N=2¹⁵) and a per-user salt, and compared in constant time. Logins for unknown usernames take as long as logins for real ones, so timing doesn't reveal which usernames exist.
- **Sessions:**
  - Each session is a 256-bit random token in an `HttpOnly`, `SameSite=Strict` cookie, with the `Secure` flag over HTTPS.
  - Only the token's SHA-256 is stored, and sessions expire after 14 days.
  - Changing a password signs out your other devices.
- **CSRF:** on top of SameSite cookies, write requests need a JSON body and must come from the site's own origin.
- **Brute force:** rate limits apply per IP to sign-in (10 tries per 15 min), to the whole API and to uploads.
- **XSS:**
  - The client never uses `innerHTML`. All content, including Markdown, is built as DOM nodes and text.
  - Links and images only allow `http(s)` and `mailto` URLs, plus the site's own uploads.
  - A strict Content-Security-Policy allows `script-src 'self'` only and no inline scripts.
- **Uploads:**
  - The file type is checked from the file's own bytes; only JPEG, PNG, WebP and GIF are accepted (no SVG).
  - Files are stored under random names, with a 5 MB limit.
  - They are served with `nosniff` and a `sandbox` CSP.
- **SQL:** all queries are parameterised. Search input is rewritten into quoted FTS terms, so it can't inject FTS syntax.
- **Files:** static files are loaded from a fixed folder at startup, and request paths never reach the filesystem, so path traversal isn't possible.
- **Headers:** CSP, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `COOP` and `Permissions-Policy`. Optional HSTS can be added at your proxy.
- **First run:** setting up the admin account needs a random token that is shown only in the server console and works once.

## Development

```bash
npm run dev        # build, then restart the server on changes to dist/
npm run typecheck
npm test           # integration tests: auth, CSRF, permissions, uploads, search, traversal
```

Project layout:

```
src/server/   HTTP server, auth, articles, uploads, SQLite (TypeScript → dist/server)
src/client/   Front end: router, views, editor, Markdown (TypeScript → public/*.js)
public/       index.html, styles.css (M3 Expressive tokens & components), favicon
```

### Why Node.js over PHP?

Both can be secure. Node with TypeScript lets the server and the browser share
one strictly typed language. Built-in SQLite and crypto mean no framework or
ORM is needed, so there is less third-party code to audit, and
`npm audit` reports 0 vulnerabilities.
