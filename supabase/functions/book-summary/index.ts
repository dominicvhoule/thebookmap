// TheBookMap: a short summary of what a book is about, worked out once per book and saved for everyone.
//
//   1. If the book has a Wikipedia article (the site finds it and sends its title), the summary is the
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
const norm = (s: string) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/&/g, "and").replace(/[^a-z0-9]/g, "");

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
async function wikiSummary(page: string, title: string) {
  // Only accept an article that is this book (its title, optionally with "(novel)" and the like).
  const base = norm(page.replace(/\s*\([^)]*\)\s*$/, "")), want = norm(title.replace(/\s*[:;(].*$/, ""));
  if (!base || !want || (base !== want && !base.startsWith(want) && !want.startsWith(base))) return "";
  const r = await fetch(`https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&exsectionformat=wiki&redirects=1&format=json&formatversion=2&titles=${encodeURIComponent(page)}`, { headers: UA });
  if (!r.ok) throw new Error("wiki_" + r.status);
  const text: string = (await r.json())?.query?.pages?.[0]?.extract ?? "";
  const lead = text.split(/\n==[^=]/)[0];
  const sec = text.match(/\n==\s*(Plot|Plot summary|Synopsis|Summary|Premise|Story|Storyline|Overview|Content|Contents)\s*==\n([\s\S]*?)(?=\n==[^=]|$)/i);
  const plot = sec ? sec[2].replace(/\n===[^=]+===\n/g, " ") : "";
  const pick = [story(lead), story(plot, true)].find((l) => l.join(" ").length >= 80) ?? [];
  return trimTo(pick);
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  let b: Record<string, unknown> = {};
  try { b = await req.json(); } catch { /* empty */ }
  const key = clip(b.key, 300), title = clip(b.title, 300), author = clip(b.author, 200), page = clip(b.page, 300);
  const year = Number(b.year) || null;
  if (!key || !title) return json({ error: "bad_request" }, 400);

  // Already worked out? A saved "none" is tried again only if it's from before the current prompt or more
  // than NONE_RETRY_DAYS old, so opening the card again doesn't pay for the same "unknown" every time.
  try {
    const hit = await (await db(`book_summaries?book_key=eq.${encodeURIComponent(key)}&select=*`)).json();
    const s = Array.isArray(hit) && hit[0];
    // Wikipedia summaries picked before the sentence filter was tightened are picked again.
    const stale = s && s.source === "wikipedia" && String(s.created_at || "") < WIKI_FILTER_SINCE;
    const at = String(s && s.created_at || "");
    const retryNone = s && s.source === "none" && ANTHROPIC_KEY && (at < PROMPT_SINCE || Date.now() - Date.parse(at) > NONE_RETRY_DAYS * 86400_000);
    if (s && !stale && !retryNone) return json({ summary: s.summary ?? "", source: s.source, page: s.wiki_page ?? null, lang: s.wiki_lang ?? null, cached: true });
  } catch { /* carry on */ }

  try {
    if (page) {
      const text = await wikiSummary(page, title);
      if (text) {
        await save({ book_key: key, summary: text, source: "wikipedia", wiki_page: page, wiki_lang: "en" });
        return json({ summary: text, source: "wikipedia", page, lang: "en" });
      }
    }
    if (!ANTHROPIC_KEY) return json({ summary: "", source: "none", reason: "no_api_key" });
    if (!(await knownBook(key))) return json({ summary: "", source: "none", reason: "not_on_a_map" });
    if ((await aiToday()) >= DAILY_AI_CAP) return json({ summary: "", source: "none", reason: "daily_cap" });
    const text = await askClaude(title, author, year, await olDescription(clip(b.ol, 20)));
    await save({ book_key: key, summary: text || null, source: text ? "ai" : "none" });
    return json({ summary: text, source: text ? "ai" : "none" });
  } catch (e) {
    return json({ summary: "", source: "none", reason: String((e as Error).message || "failed") });
  }
});
