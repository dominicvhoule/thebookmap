// TheBookMap: a short summary of what a book is about, worked out once per book and saved for everyone.
//
//   1. If the book has a Wikipedia article (the site sends its title, or this function finds it: Wikidata's
//      link from the Open Library work, else a Wikipedia search checked against title and author), the summary is the
//      story sentences from that article, credited on the site as "From Wikipedia … (CC BY-SA 4.0), adapted".
//   2. If there's no article, Claude writes two or three sentences in its own words, from the library
//      catalogue's description and what it knows about the book. No credit is needed for those.
//
// Every answer is saved in book_summaries (readable by everyone; only this function writes), so each
// book costs at most one lookup. Claude is only asked about books someone has actually added, and at
// most DAILY_AI_CAP times a day, so the site can't be used to run up the bill.
//
// Secrets (Supabase → Edge Functions → Secrets):
//   ANTHROPIC_API_KEY   your key from console.anthropic.com (without it, step 2 is skipped)
//   ANTHROPIC_MODEL     optional; defaults to claude-haiku-5-5
// Deploy with "Verify JWT" on (the site's public key is enough; visitors don't need to sign in).
//
// POST {key, title, author?, year?, ol?, page?, lang?}  →  {summary, source, page?, lang?}
// POST {ticket, action:"prefill", books:[{key,title,author,year,ol}]}  → fills in up to 8 books ahead of time
//   (private: the ticket comes from SQL _fn_call), so cards open with their summary already there.

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
const UA = { "User-Agent": "TheBookMap/1.0 (+https://dominicvhoule.github.io/thebookmap/)" };
const DAILY_AI_CAP = 3000;
const WIKI_FILTER_SINCE = "2026-10-26T00:30:00Z";   // when the story-sentence filter last changed
const PROMPT_SINCE = "2026-10-30T01:05:00Z";        // when the prompt learned to summarise non-fiction
const NONE_RETRY_DAYS = 30;                          // a book Claude couldn't summarise is asked again after this

const db = (path: string, init: RequestInit = {}) =>
  fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
const clip = (s: unknown, n: number) => String(s ?? "").trim().slice(0, n);
const norm = (s: string) => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/&/g, "and").replace(/[^a-z0-9]/g, "");

// ---------- Wikipedia: keep the sentences about the story ----------
const META = /\b(published|publication|publish|reprint|considered|regarded|acclaimed|hailed|bestsell|best-sell|best sell|award|prize|nominat|adapted|adaptation|translated|translation|installments?|instalments?|serial|serialized|edition|sold|copies|praised|critic|review|banned|film|movie|television|miniseries|ranked|greatest|masterpiece|classic|landmark|debut|sequel|trilogy|series of|volume|imprint|publisher|author of|written by|wrote|his (first|second|third|last|final)|her (first|second|third|last|final)|literary|literature|genre|bestseller|nominee|Wikipedia|magazine|newspaper|list of|depiction|depicts|portrayal|portrays|helped|influence|influential|popular|popularity|audience|reception|Pulitzer|Nobel|best known|best-known|inspired|controversy|controversial)(s|es|ed|ing)?\b/i;
const IS_A = /^[^.]{0,160}\b(is|was) an? ([\w-]+ ){0,6}(novel|novella|book|memoir|autobiography|biography|collection|work|story|play|poem|treatise|account|history|study|essay)s?\b/i;
function sentences(text: string) {
  const t = String(text || "").replace(/\[(\d+|[a-z])\]/g, "")
    .replace(/\s*\((?:[^()]*?)(?:Russian|French|German|Spanish|Italian|Japanese|Chinese|Swedish|Portuguese|Arabic|Hebrew|IPA|tr\.|lit\.|pronounced|born|died|\d{4}[–-]\d{4})[^()]*\)/g, "")
    .replace(/\s+/g, " ").trim();
  const out: string[] = [];
  for (const s of t.split(/(?<=[.!?]["”’)]?)\s+(?=["“(]?[A-Z0-9])/)) {
    const prev = out[out.length - 1];
    if (prev && /\b(Mr|Mrs|Ms|Dr|St|Jr|Sr|vs|Lt|Col|Gen|Sgt|Capt|[A-Z])\.$/.test(prev)) out[out.length - 1] = prev + " " + s; else out.push(s);
  }
  return out.map((s) => s.trim()).filter((s) => s.length > 20);
}
const story = (text: string, keepIsA = false) => sentences(text).filter((s) => !META.test(s) && (keepIsA || !IS_A.test(s)));
function trimTo(list: string[]) {
  let out = "";
  for (const s of list) { if (out && (out + " " + s).length > 430) break; out = out ? out + " " + s : s; if (out.length > 300) break; }
  return out.length > 430 ? out.slice(0, 427).replace(/\s+\S*$/, "") + "…" : out;
}
// Titles compared loosely: no leading "A/An/The", British and American spellings alike.
const titleNorm = (t: string) => norm(t.replace(/\s*\([^)]*\)\s*$/, "").replace(/\s*[:;].*$/, "").replace(/^(a|an|the)\s+/i, ""))
  .replace(/centre/g, "center").replace(/colour/g, "color").replace(/favour/g, "favor").replace(/honour/g, "honor");
const titleOk = (page: string, title: string) => {
  const base = titleNorm(page), want = titleNorm(title);
  return !!base && !!want && (base === want || base.startsWith(want) || want.startsWith(base));
};
async function wikiSummary(page: string, title: string, trusted = false) {
  // Only accept an article that is this book (its title, optionally with "(novel)" and the like), unless
  // Wikidata linked it to the book's Open Library record.
  if (!trusted && !titleOk(page, title)) return "";
  const r = await fetch(`https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&exsectionformat=wiki&redirects=1&format=json&formatversion=2&titles=${encodeURIComponent(page)}`, { headers: UA });
  if (!r.ok) throw new Error("wiki_" + r.status);
  const text: string = (await r.json())?.query?.pages?.[0]?.extract ?? "";
  const lead = text.split(/\n==[^=]/)[0];
  const sec = text.match(/\n==\s*(Plot|Plot summary|Synopsis|Summary|Premise|Story|Storyline|Overview|Content|Contents)\s*==\n([\s\S]*?)(?=\n==[^=]|$)/i);
  const plot = sec ? sec[2].replace(/\n===[^=]+===\n/g, " ") : "";
  const pick = [story(lead), story(plot, true)].find((l) => l.join(" ").length >= 80) ?? [];
  return trimTo(pick);
}

// ---------- finding the book's article when the site didn't send one ----------
const getJson = (url: string) => fetch(url, { headers: UA, signal: AbortSignal.timeout(8000) }).then((r) => r.ok ? r.json() : null).catch(() => null);
async function findPage(title: string, author: string, ol: string): Promise<{ page: string; trusted: boolean }> {
  // 1. Wikidata: the item that carries this Open Library work ID, and its English Wikipedia article.
  if (/^OL\d+W$/.test(ol)) {
    const s = await getJson(`https://www.wikidata.org/w/api.php?action=query&list=search&srsearch=haswbstatement:P648=${ol}&srlimit=1&format=json`);
    const qid = s?.query?.search?.[0]?.title;
    if (/^Q\d+$/.test(qid || "")) {
      const e = await getJson(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${qid}&props=sitelinks&sitefilter=enwiki&format=json`);
      const page = e?.entities?.[qid]?.sitelinks?.enwiki?.title;
      if (page) return { page, trusted: true };
    }
  }
  // 2. A Wikipedia search: the article's title must be the book's, and its opening must name the author.
  const surname = norm(String(author || "").split(/,| and | & /)[0].trim().split(/\s+/).pop() || "");
  const q = `${title.replace(/\s*[:;(].*$/, "")} ${author.split(/,| and | & /)[0]}`;
  const r = await getJson(`https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(q)}&gsrlimit=5&prop=extracts&exintro=1&explaintext=1&exlimit=5&redirects=1&format=json&formatversion=2`);
  const pages = (r?.query?.pages ?? []).sort((a: { index: number }, b: { index: number }) => a.index - b.index);
  for (const p of pages) {
    const intro = norm(String(p.extract || "").slice(0, 600));
    if (titleOk(p.title, title) && surname.length > 2 && intro.includes(surname) && !/may refer to/i.test(p.extract || "")) return { page: p.title, trusted: false };
  }
  return { page: "", trusted: false };
}

// ---------- Claude: a summary in its own words ----------
async function olDescription(ol: string) {
  if (!/^OL\d+W$/.test(ol)) return "";
  try {
    const r = await fetch(`https://openlibrary.org/works/${ol}.json`, { headers: UA });
    if (!r.ok) return "";
    const d = await r.json();
    const v = typeof d.description === "string" ? d.description : d.description?.value ?? "";
    return String(v).replace(/\s+/g, " ").slice(0, 2000);
  } catch { return ""; }
}
async function askClaude(title: string, author: string, year: number | null, description: string) {
  const prompt = `Write the short summary shown on a book's card on a website about where books take place.

Book: ${title}${author ? ` by ${author}` : ""}${year ? ` (${year})` : ""}
Catalogue description (may be a publisher's blurb, possibly in another language): ${description || "(none)"}

Using the description and what you know about this book, write 2 or 3 sentences (under 70 words) saying what it is about.
- A novel, story, play or poem: who it follows, where, and the situation they're in. No spoilers past the opening.
- Non-fiction (history, science, self-help, philosophy, business, religion, a memoir or biography): what it covers and its main idea or argument; for a memoir or biography, whose life and which part of it.
Write entirely in your own words in English; don't copy phrases from the description. No praise, no mention of awards, sales, adaptations or the author's life outside the book.

Only if you don't know this book at all and the description doesn't say enough to summarise it accurately, reply with exactly: UNKNOWN`;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 300, messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) throw new Error(`anthropic_${r.status}`);
  const text = ((await r.json())?.content ?? []).map((c: { text?: string }) => c.text ?? "").join("").trim();
  if (!text || /^UNKNOWN\b/i.test(text)) return "";
  return text.replace(/^["“]|["”]$/g, "").replace(/\s+/g, " ").slice(0, 700);
}
// Claude is only asked about books that are really on someone's map or in the shared catalogue.
async function knownBook(key: string) {
  for (const t of ["book_logs", "book_matches", "book_settings", "book_vectors"]) {
    try {
      const rows = await (await db(`${t}?book_key=eq.${encodeURIComponent(key)}&select=book_key&limit=1`)).json();
      if (Array.isArray(rows) && rows.length) return true;
    } catch { /* try the next */ }
  }
  return false;
}
async function aiToday() {
  const since = new Date(Date.now() - 86400_000).toISOString();
  const r = await db(`book_summaries?source=eq.ai&created_at=gte.${since}&select=book_key`, { method: "HEAD", headers: { Prefer: "count=exact" } });
  return Number((r.headers.get("content-range") ?? "").split("/")[1]) || 0;
}
const save = (row: Record<string, unknown>) =>
  db("book_summaries?on_conflict=book_key", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: JSON.stringify({ ...row, created_at: new Date().toISOString() }) }).catch(() => {});

async function useTicket(token: unknown) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{24,100}$/.test(token)) return false;
  const r = await db(`loc_test_tickets?token=eq.${token}`, { method: "DELETE", headers: { Prefer: "return=representation" } });
  const rows = r.ok ? await r.json() : [];
  return Array.isArray(rows) && rows.length === 1;
}

type Ask = { key: string; title: string; author: string; year: number | null; ol: string; page: string };
async function summarise(a: Ask) {
  const { key, title, author, year, ol } = a;
  // Already worked out? A saved "none" is tried again only if it's from before the current prompt or more
  // than NONE_RETRY_DAYS old, so opening the card again doesn't pay for the same "unknown" every time.
  try {
    const hit = await (await db(`book_summaries?book_key=eq.${encodeURIComponent(key)}&select=*`)).json();
    const s = Array.isArray(hit) && hit[0];
    // Wikipedia summaries picked before the sentence filter was tightened are picked again.
    const stale = s && s.source === "wikipedia" && String(s.created_at || "") < WIKI_FILTER_SINCE;
    const at = String(s && s.created_at || "");
    const retryNone = s && s.source === "none" && ANTHROPIC_KEY && (at < PROMPT_SINCE || Date.now() - Date.parse(at) > NONE_RETRY_DAYS * 86400_000);
    if (s && !stale && !retryNone) return { summary: s.summary ?? "", source: s.source, page: s.wiki_page ?? null, lang: s.wiki_lang ?? null, cached: true };
  } catch { /* carry on */ }

  try {
    const found = a.page ? { page: a.page, trusted: false } : await findPage(title, author, ol).catch(() => ({ page: "", trusted: false }));
    const page = found.page;
    if (page) {
      const text = await wikiSummary(page, title, found.trusted);
      if (text) {
        await save({ book_key: key, summary: text, source: "wikipedia", wiki_page: page, wiki_lang: "en" });
        return { summary: text, source: "wikipedia", page, lang: "en" };
      }
    }
    if (!ANTHROPIC_KEY) return { summary: "", source: "none", reason: "no_api_key" };
    if (!(await knownBook(key))) return { summary: "", source: "none", reason: "not_on_a_map" };
    if ((await aiToday()) >= DAILY_AI_CAP) return { summary: "", source: "none", reason: "daily_cap" };
    // A catalogue description from the wrong edition can make Claude unsure of a book it knows well, so an
    // "unknown" is asked once more on the title and author alone.
    const desc = await olDescription(ol);
    let text = await askClaude(title, author, year, desc);
    if (!text && desc) text = await askClaude(title, author, year, "");
    await save({ book_key: key, summary: text || null, source: text ? "ai" : "none" });
    return { summary: text, source: text ? "ai" : "none" };
  } catch (e) {
    return { summary: "", source: "none", reason: String((e as Error).message || "failed") };
  }
}
const askFrom = (b: Record<string, unknown>): Ask => ({
  key: clip(b.key, 300), title: clip(b.title, 300), author: clip(b.author, 200), year: Number(b.year) || null, ol: clip(b.ol, 20), page: clip(b.page, 300),
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  let b: Record<string, unknown> = {};
  try { b = await req.json(); } catch { /* empty */ }
  if (b.action === "prefill") {
    if (!(await useTicket(b.ticket))) return json({ error: "bad_ticket" }, 403);
    const list = (Array.isArray(b.books) ? b.books : []).slice(0, 8).map((x) => askFrom(x as Record<string, unknown>)).filter((x) => x.key && x.title);
    const done: Record<string, string> = {};
    for (const x of list) done[x.key] = String((await summarise(x)).source);
    return json({ done });
  }
  const a = askFrom(b);
  if (!a.key || !a.title) return json({ error: "bad_request" }, 400);
  return json(await summarise(a));
});
