// BookMap: read a member's public Goodreads shelf and return it as JSON.
// Browsers can't read goodreads.com directly, so the site asks this function instead.
// It only fetches goodreads.com pages built from a validated user id or username, so it can't reach other sites.
// Deploy: Supabase dashboard → Edge Functions → goodreads-feed → Code, paste this file, Deploy ("Verify JWT" on).
//
// Request bodies (POST, JSON):
//   {user}          who this is (a Goodreads profile link, user id or username) → {id, name}, plus the
//                   first page of their Read shelf, newest first, up to 100 books
//   {user, page:N}  page N of the Read shelf. Pages go back through the whole shelf; an empty page
//                   means the end. This covers a reader's full history, not just their latest books.
//
// Each book: {gid, title, author, isbn, isbn13, year, pages, rating, read, added, reviewed, cover}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const UA = { "User-Agent": "Mozilla/5.0 (compatible; BookMap/1.0; +https://dominicvhoule.github.io/bookmap/)", "Accept-Language": "en-US,en;q=0.9" };
const GR = "https://www.goodreads.com";

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " " };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENT[e.toLowerCase()] ?? m;
  });
const strip = (s: string) => decode(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const tag = (s: string, t: string) => {
  const m = s.match(new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}>`));
  return m ? decode(m[1].replace(/^\s*<!\[CDATA\[/, "").replace(/\]\]>\s*$/, "")).trim() : "";
};
const thisYear = new Date().getUTCFullYear();
const okYear = (y: number) => y >= -3000 && y <= thisYear + 2 && y !== 0;
const isbnOk = (s: string) => { const d = String(s || "").replace(/[^0-9X]/gi, "").toUpperCase(); return /^[0-9]{9}[0-9X]$|^[0-9]{13}$/.test(d) ? d : ""; };
// "Sat, 05 Mar 2022 00:00:00 -0800" or "Mar 05, 2022" or "2022/03/05" → "2022-03-05"
function day(s: string) {
  s = String(s || "").trim(); if (!s) return "";
  const iso = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/); if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  const d = new Date(s.replace(/\s+[-+]\d{4}$/, "")); if (isNaN(+d)) { const y = s.match(/\b(1[5-9]\d\d|20\d\d)\b/); return y ? `${y[1]}-01-01` : ""; }
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
// Goodreads cover links point at a small size; ask for the full image instead.
const bigCover = (u: string) => {
  u = String(u || "").trim();
  if (!/^https:\/\/[a-z0-9.-]*(gr-assets\.com|amazon\.com|media-amazon\.com)\//i.test(u) || /nophoto/i.test(u)) return "";
  return u.replace(/\._S[XY]\d+_\./, ".").replace(/\._S[XY]\d+(_S[XY]\d+)?_\./, ".");
};

async function get(url: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: UA, redirect: "follow" });
    if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 800 * (attempt + 1))); continue; }
    return res;
  }
  return fetch(url, { headers: UA, redirect: "follow" });
}

// ---------- who: profile link, id or username → numeric id ----------
async function resolve(raw: string): Promise<{ id: string; name: string } | { error: string }> {
  let s = String(raw || "").trim();
  s = s.replace(/^@/, "").replace(/^https?:\/\/(www\.|m\.)?goodreads\.com\/?/i, "");
  let m = s.match(/^(?:user\/show\/|review\/list\/|review\/list_rss\/)?(\d{1,15})(?:[-_?/#.].*)?$/i);
  if (m) return { id: m[1], name: "" };
  m = s.match(/^([A-Za-z0-9_.-]{2,40})\/?$/);
  if (!m) return { error: "bad_user" };
  // A vanity username: goodreads.com/<name> redirects to the numeric profile.
  const res = await get(`${GR}/${encodeURIComponent(m[1])}`);
  const at = res.url || "";
  const id = (at.match(/\/user\/show\/(\d{1,15})/) ?? [])[1];
  if (id) return { id, name: "" };
  if (res.ok) {
    const html = await res.text();
    const h = html.match(/\/user\/show\/(\d{1,15})/) || html.match(/\/review\/list\/(\d{1,15})/);
    if (h) return { id: h[1], name: "" };
  }
  return { error: "not_found" };
}

// ---------- the profile's name: "Reader (dominicvhoule) - Nicoya…" → the username, else the display name ----------
async function profileName(id: string) {
  try {
    const res = await get(`${GR}/user/show/${id}`);
    if (!res.ok) return "";
    const html = await res.text();
    const t = decode((html.match(/<title>([\s\S]*?)<\/title>/) ?? [])[1] ?? "").trim();
    const m = t.match(/^(.+?)\s*\(([A-Za-z0-9_.-]{2,40})\)/);
    if (m) return m[2];
    const og = (html.match(/property="og:title" content="([^"]*)"/) ?? [])[1];
    return og ? decode(og).trim() : "";
  } catch { return ""; }
}

// ---------- the Read shelf feed (RSS) ----------
async function feed(id: string, page: number) {
  const res = await get(`${GR}/review/list_rss/${id}?shelf=read${page > 1 ? `&page=${page}` : ""}`);
  if (res.status === 404) return { error: "not_found", status: 404 };
  if (res.status === 403 || res.status === 401) return { error: "private", status: 403 };
  if (!res.ok) return { error: "upstream", status: 502 };
  const xml = await res.text();
  if (!/<rss[\s>]/.test(xml)) return { error: /sign_in|sign in/i.test(xml) ? "private" : "layout", status: 502 };
  const ch = xml.split(/<item>/)[0];
  const name = tag(ch, "title").replace(/[’']s bookshelf:.*$/i, "").replace(/^Goodreads:\s*/i, "").trim();
  const books = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]).map((s) => {
    const bookBlock = (s.match(/<book\s[^>]*>([\s\S]*?)<\/book>/) ?? [])[1] ?? "";
    const y = Number(tag(s, "book_published"));
    const isbn = isbnOk(tag(s, "isbn"));
    return {
      gid: tag(s, "book_id"),
      title: tag(s, "title"),
      author: tag(s, "author_name"),
      isbn: isbn.length === 10 ? isbn : "",
      isbn13: isbn.length === 13 ? isbn : "",
      year: okYear(y) ? y : null,
      pages: Number(tag(bookBlock, "num_pages")) || null,
      rating: Math.min(5, Math.max(0, Number(tag(s, "user_rating")) || 0)) || null,
      read: day(tag(s, "user_read_at")),
      added: day(tag(s, "user_date_added")),
      reviewed: !!strip(tag(s, "user_review")),
      cover: bigCover(tag(s, "book_large_image_url") || tag(s, "book_image_url")),
    };
  }).filter((b) => b.title && /^\d+$/.test(b.gid));
  return { name, books };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body */ }
  try {
    const who = await resolve(String(body.user ?? ""));
    if ("error" in who) return json({ error: who.error }, who.error === "bad_user" ? 400 : 404);
    const page = Math.max(1, Math.min(300, Math.floor(Number(body.page) || 1)));
    const [r, profile] = await Promise.all([feed(who.id, page), page === 1 ? profileName(who.id) : Promise.resolve("")]);
    if ("error" in r) return json({ error: r.error, id: who.id }, r.status);
    return json({ id: who.id, name: profile || r.name || who.name, page, books: r.books, more: r.books.length >= 100 });
  } catch {
    return json({ error: "unreachable" }, 502);
  }
});
