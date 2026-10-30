// BookMap: work out where a book takes place by having Claude read about it.
// Used whenever Wikidata has no specific narrative location. Claude answers from what it knows about the
// book, plus the book's descriptions (Google Books, Open Library). Wikipedia text is not sent: it made
// prompts bigger and, when the search found the wrong article, misled Claude. Each answer is saved in
// book_settings, so a book is looked up once for everyone.
//
// Card summaries are not written here any more (2026-10-29): the book-summary function is their only
// writer, so every book gets the same kind of summary (fiction and non-fiction, Wikipedia first).
//
// Protections against running up the bill (every call is logged in ai_calls):
//   - only books that are on someone's map or in the shared catalogue are looked up;
//   - at most DAILY_CAP calls a day site-wide and USER_DAILY_CAP per reader;
//   - a book Claude couldn't place is never asked about again (a second try would cost money and say the same);
//   - a call that produced no usable answer (cut off, not JSON) is retried, but a book gets at most
//     MAX_FAILED_TRIES failed calls in total.
//
// Claude's full raw reply is saved with each call in ai_calls.raw.
//
// Replay (for inspecting what Claude writes): POST {key, title, ..., replay: "<ticket>", with_summary?: bool}
// with a single-use ticket from the private ai_replay_tokens table (made by hand, for that book). A replay
// ignores the saved pin and the limits, saves nothing to book_settings or book_summaries, and returns
// Claude's raw reply.
//
// Needs these Edge Function secrets (Supabase → Edge Functions → Secrets), shared with MovieMap:
//   ANTHROPIC_API_KEY   your key from console.anthropic.com
//   ANTHROPIC_MODEL     optional; defaults to claude-haiku-5-5
//   GOOGLE_BOOKS_API_KEY  optional; without it Google Books still answers, with a lower daily limit
// Deploy with "Verify JWT" on, so only signed-in members can call it.
//
// POST {key, title, author, year?, qid?, isbn?, overview?}  →  {setting, summary?} or {setting:null, reason, summary?}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODEL = Deno.env.get("ANTHROPIC_MODEL") || "claude-haiku-5-5";
const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const GBOOKS_KEY = Deno.env.get("GOOGLE_BOOKS_API_KEY") ?? "";
const DAILY_CAP = 3000;          // about $1.20 a day at most
const USER_DAILY_CAP = 400;      // enough for one reader importing a long Goodreads history
const MAX_FAILED_TRIES = 2;
const UA = { "User-Agent": "BookMap/1.0 (+https://dominicvhoule.github.io/thebookmap/)" };

const db = (path: string, init: RequestInit = {}) =>
  fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });

// ---------- Protections ----------
// The signed-in reader, from the token Supabase has already verified (Verify JWT is on).
function userId(req: Request): string | null {
  try {
    const tok = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const part = tok.split(".")[1];
    const payload = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=")));
    return payload?.role === "authenticated" && /^[0-9a-f-]{36}$/.test(payload?.sub ?? "") ? payload.sub : null;
  } catch { return null; }
}
// Claude is only asked about books that are really on someone's map or in the shared catalogue.
async function knownBook(key: string) {
  for (const t of ["book_logs", "book_matches"]) {
    try {
      const rows = await (await db(`${t}?book_key=eq.${encodeURIComponent(key)}&select=book_key&limit=1`)).json();
      if (Array.isArray(rows) && rows.length) return true;
    } catch { /* try the next */ }
  }
  return false;
}
async function countCalls(filter: string) {
  const r = await db(`ai_calls?${filter}&select=id`, { method: "HEAD", headers: { Prefer: "count=exact" } });
  if (!r.ok) throw new Error("ai_calls_missing");
  return Number((r.headers.get("content-range") ?? "").split("/")[1]) || 0;
}
const since = (days: number) => new Date(Date.now() - days * 86400_000).toISOString();
const logCall = (row: Record<string, unknown>) =>
  db("ai_calls", { method: "POST", body: JSON.stringify({ fn: "book-setting", ...row }) }).catch(() => {});
// A replay ticket is good once, for one book.
async function useReplayTicket(token: string, key: string) {
  if (!/^[A-Za-z0-9_-]{24,100}$/.test(token)) return false;
  const r = await db(`ai_replay_tokens?token=eq.${token}&book_key=eq.${encodeURIComponent(key)}`, {
    method: "DELETE", headers: { Prefer: "return=representation" } });
  const rows = r.ok ? await r.json() : [];
  return Array.isArray(rows) && rows.length === 1;
}

// ---------- Wikipedia ----------
async function wikiTitle(qid: string, title: string, author: string) {
  if (/^Q\d+$/.test(qid)) {
    try {
      const r = await fetch(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${qid}&props=sitelinks&sitefilter=enwiki&format=json`, { headers: UA });
      const t = (await r.json())?.entities?.[qid]?.sitelinks?.enwiki?.title;
      if (t) return t as string;
    } catch { /* fall through to search */ }
  }
  // No linked article: search, but only accept an article about this book (same title). Otherwise a
  // search for "My Search for Ramanujan" hands Claude the article on Ramanujan as if it were the book's.
  try {
    const r = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(`${title} ${author} novel book`)}&srlimit=5&format=json`, { headers: UA });
    const hits: { title: string }[] = (await r.json())?.query?.search ?? [];
    return hits.map((h) => h.title).find((t) => sameTitle(t, title)) ?? null;
  } catch { return null; }
}
// Does this book already have a card summary, or a Wikipedia article book-summary can take one from for free?
const sameTitle = (page: string, title: string) => {
  const base = norm(page.replace(/\s*\([^)]*\)\s*$/, "")), want = norm(title.replace(/\s*[:;(].*$/, ""));
  return !!base && !!want && (base === want || base.startsWith(want) || want.startsWith(base));
};
// Since 2026-10-29 card summaries have one writer, the book-summary function (one prompt for fiction and
// non-fiction, Wikipedia first). This function no longer writes them; the code is kept for replays.
const WRITE_SUMMARIES = false;
async function summaryNeeded(key: string, page: string | null, title: string) {
  if (!WRITE_SUMMARIES) return false;
  if (page && sameTitle(page, title)) return false;
  try {
    const rows = await (await db(`book_summaries?book_key=eq.${encodeURIComponent(key)}&select=source,summary`)).json();
    const s = Array.isArray(rows) && rows[0];
    if (s && s.summary && (s.source === "ai" || s.source === "wikipedia")) return false;
  } catch { return false; }
  return true;
}

// ---------- Google Books ----------
// The publisher's description, which Google gets from publishers' own catalogue feeds. Found by ISBN when
// we have one, else by title and author, and only accepted when the title and author match.
const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "");
const stripHtml = (s: string) => s.replace(/<br\s*\/?>|<\/p>/gi, "\n").replace(/<[^>]+>/g, "")
  .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
  .replace(/\n{2,}/g, "\n").trim();
async function googleBooksDescription(isbn: string, title: string, author: string) {
  const keyParam = GBOOKS_KEY ? `&key=${GBOOKS_KEY}` : "";
  const get = async (q: string) => {
    const r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=5&printType=books&fields=items(volumeInfo(title,authors,description))${keyParam}`);
    if (!r.ok) return [];
    return ((await r.json())?.items ?? []).map((i: { volumeInfo?: Record<string, unknown> }) => i.volumeInfo ?? {});
  };
  const want = norm(title.replace(/\s*[:(].*$/, ""));
  const surname = norm(author.split(/,| & | and /)[0].trim().split(" ").pop() ?? "");
  const matches = (v: Record<string, unknown>) =>
    norm(String(v.title ?? "")).startsWith(want) && (!surname || ((v.authors as string[]) ?? []).some((a) => norm(a).includes(surname)));
  try {
    let items: Record<string, unknown>[] = [];
    if (/^[0-9X]{10,13}$/i.test(isbn)) items = (await get(`isbn:${isbn}`)).filter((v: Record<string, unknown>) => v.description);
    if (!items.length) {
      const q = `intitle:${title.replace(/\s*[:(].*$/, "")}${surname ? ` inauthor:${author.split(/,| & | and /)[0].trim().split(" ").pop()}` : ""}`;
      items = (await get(q)).filter((v: Record<string, unknown>) => v.description && matches(v));
    }
    // The longest matching description tends to be the full jacket copy rather than a one-liner.
    const best = items.map((v) => stripHtml(String(v.description))).sort((a, b) => b.length - a.length)[0];
    return best ? best.slice(0, 2500) : "";
  } catch { return ""; }
}

// ---------- Claude ----------
async function askClaude(title: string, author: string, year: number | null, gbooks: string, overview: string, wantSummary: boolean) {
  const prompt = `You help a website pin each book a reader has finished on a world map at the place where its story takes place.

Book: ${title}${author ? ` by ${author}` : ""}${year ? ` (${year})` : ""}
Publisher's description (Google Books): ${gbooks || "(none)"}
Open Library description: ${overview && overview !== gbooks ? overview : "(none)"}

Use what you know about this book as well as the descriptions. Where does this book mainly take place? For fiction, use the setting inside the story, not where the author lived. For nonfiction (history, travel, memoir, biography, reportage), use the place it is mainly about. If it moves around, choose the place where most of it happens.

Reply with only a JSON object:
{"place": "most specific place where most of the book happens (a city, town, region, or an invented place's name)",
 "country": "modern country containing it, in English",
 "continent": "Africa, Asia, Europe, North America, South America, Oceania or Antarctica",
 "lat": latitude of that place as a number, "lon": longitude as a number,
 "precision": "city" | "region" | "country" | "fictional",
 "note": "one short sentence about where the book is set, under 25 words"${wantSummary ? `,
 "summary": "2 or 3 sentences (under 70 words) saying what the book is about: who it follows, where, and the situation they're in"` : ""}}
For an invented town in a real country, give the coordinates of the real region it stands in for. If the book is set in an invented world (Middle-earth, a far planet) or has no physical setting (self-help, philosophy, poetry), or you genuinely can't tell, reply {"unknown": true${wantSummary ? `, "summary": "..."` : ""}}.${wantSummary ? `

For the summary: write entirely in your own words in English and don't copy phrases from the descriptions. No spoilers past the opening, no praise, no mention of awards, sales, adaptations or the author's life. If you don't know the book well enough to summarise it accurately, use "" for the summary.` : ""}`;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: wantSummary ? 1000 : 800, messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) throw new Error(`anthropic_${r.status}`);
  const res = await r.json();
  const text: string = (res?.content ?? []).map((c: { text?: string }) => c.text ?? "").join("");
  const m = text.match(/\{[\s\S]*\}/);
  let answer: Record<string, unknown> | null = null;
  try { answer = m ? JSON.parse(m[0]) : null; } catch { answer = null; }
  // A reply cut off by the length limit, or one that isn't JSON, is a failed call (retried, up to
  // MAX_FAILED_TRIES in total), not an "unknown" (which stops the book being asked about for good).
  const broken = res?.stop_reason === "max_tokens" || !answer;
  return { answer: broken ? null : answer, broken, raw: text.slice(0, 20000), stop_reason: res?.stop_reason ?? null,
    usage: { in_tokens: res?.usage?.input_tokens ?? null, out_tokens: res?.usage?.output_tokens ?? null } };
}

const clip = (s: unknown, n: number) => String(s ?? "").trim().slice(0, n);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  if (!ANTHROPIC_KEY) return json({ setting: null, reason: "no_api_key" });

  let b: Record<string, unknown> = {};
  try { b = await req.json(); } catch { /* empty */ }
  const key = clip(b.key, 300), title = clip(b.title, 300), author = clip(b.author, 200);
  const year = Number(b.year) || null;
  if (!key || !title) return json({ error: "bad_request" }, 400);

  // Replay: run the lookup again and hand back Claude's raw reply, saving nothing but the call log.
  if (typeof b.replay === "string") {
    if (!(await useReplayTicket(b.replay, key))) return json({ error: "bad_ticket" }, 403);
    try {
      const [page, gbooks] = await Promise.all([
        wikiTitle(clip(b.qid, 20), title, author).catch(() => null),
        googleBooksDescription(clip(b.isbn, 13).replace(/[^0-9X]/gi, ""), title, author),
      ]);
      const wantSummary = b.with_summary === true;
      const asked = await askClaude(title, author, year, gbooks, clip(b.overview, 1500), wantSummary);
      await logCall({ fn: "book-setting-replay", book_key: key, result: asked.broken ? "error" : asked.answer?.unknown ? "unknown" : "ok",
        raw: asked.raw, ...asked.usage });
      return json({ raw: asked.raw, stop_reason: asked.stop_reason, usage: asked.usage, with_summary: wantSummary,
        inputs: { wikipedia_page: page, google_books_chars: gbooks.length, open_library_chars: clip(b.overview, 1500).length } });
    } catch (e) {
      return json({ error: String((e as Error).message || "failed") }, 500);
    }
  }

  // Already worked out for someone else? Reuse it.
  try {
    const hit = await (await db(`book_settings?book_key=eq.${encodeURIComponent(key)}&source=eq.ai&select=*`)).json();
    if (Array.isArray(hit) && hit[0]) {
      const s = hit[0];
      return json({ setting: { p: s.place, c: s.country, cont: s.continent ?? "", lat: s.lat, lon: s.lon, ap: s.approx ? 1 : 0, n: s.note ?? "", src: "ai" }, cached: true });
    }
  } catch { /* carry on */ }

  // Protections, before anything costs money.
  const uid = userId(req);
  try {
    if (!(await knownBook(key))) return json({ setting: null, reason: "not_on_a_map" });
    if (await countCalls(`book_key=eq.${encodeURIComponent(key)}&result=eq.unknown`)) {
      return json({ setting: null, reason: "unknown", cached: true });
    }
    // Only failed calls that were billed (had output) count; an outage at Anthropic costs nothing.
    if ((await countCalls(`book_key=eq.${encodeURIComponent(key)}&result=eq.error&out_tokens=gt.0`)) >= MAX_FAILED_TRIES) {
      return json({ setting: null, reason: "unknown", cached: true });
    }
    if ((await countCalls(`created_at=gte.${since(1)}`)) >= DAILY_CAP) return json({ setting: null, reason: "daily_cap" });
    if (uid && (await countCalls(`user_id=eq.${uid}&created_at=gte.${since(1)}`)) >= USER_DAILY_CAP) return json({ setting: null, reason: "user_cap" });
  } catch {
    // Without the call log the limits can't be checked, so don't spend anything.
    return json({ setting: null, reason: "limits_unavailable" });
  }

  try {
    const [page, gbooks] = await Promise.all([
      wikiTitle(clip(b.qid, 20), title, author).catch(() => null),
      googleBooksDescription(clip(b.isbn, 13).replace(/[^0-9X]/gi, ""), title, author),
    ]);
    // The book's own Wikipedia article, if it has one, only decides whether a card summary is needed
    // (book-summary takes one from the article for free).
    const wantSummary = await summaryNeeded(key, page, title);
    let asked;
    try {
      asked = await askClaude(title, author, year, gbooks, clip(b.overview, 1500), wantSummary);
    } catch (e) {
      await logCall({ book_key: key, user_id: uid, result: "error" });
      throw e;
    }
    if (asked.broken) {
      await logCall({ book_key: key, user_id: uid, result: "error", raw: asked.raw, ...asked.usage });
      return json({ setting: null, reason: "bad_answer" });
    }
    const a = asked.answer;
    // The card summary, when one was asked for.
    const summary = wantSummary && a && typeof a.summary === "string" ? clip(a.summary.replace(/^["“]|["”]$/g, "").replace(/\s+/g, " "), 700) : "";
    if (summary) {
      await db("book_summaries?on_conflict=book_key", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ book_key: key, summary, source: "ai" }) }).catch(() => {});
    }
    const lat = Number(a?.lat), lon = Number(a?.lon);
    const placed = a && !a.unknown && isFinite(lat) && isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
    await logCall({ book_key: key, user_id: uid, result: placed ? "ok" : a?.unknown ? "unknown" : "error", raw: asked.raw, ...asked.usage });
    if (!a || a.unknown) return json({ setting: null, reason: "unknown", summary: summary || undefined });
    if (!placed) return json({ setting: null, reason: "bad_answer", summary: summary || undefined });
    const approx = a.precision === "country" || a.precision === "fictional";
    const row = {
      book_key: key, place: clip(a.place, 120), country: clip(a.country, 60), continent: clip(a.continent, 20) || null,
      lat: +lat.toFixed(3), lon: +lon.toFixed(3), approx, note: clip(a.note, 300) || null, source: "ai", updated_at: new Date().toISOString(),
    };
    await db("book_settings?on_conflict=book_key", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: JSON.stringify(row) }).catch(() => {});
    return json({ setting: { p: row.place, c: row.country, cont: row.continent ?? "", lat: row.lat, lon: row.lon, ap: approx ? 1 : 0, n: row.note ?? "", src: "ai" }, summary: summary || undefined });
  } catch (e) {
    return json({ setting: null, reason: String((e as Error).message || "failed") });
  }
});
