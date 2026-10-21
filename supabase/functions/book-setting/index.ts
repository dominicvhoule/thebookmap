// BookMap: work out where a book takes place by having Claude read about it.
// Used only when Wikidata, the library catalogue and Wikipedia's links have no setting. Each answer is
// saved in book_settings, so a book is looked up once for everyone.
//
// Needs these Edge Function secrets (Supabase → Edge Functions → Secrets), shared with MovieMap:
//   ANTHROPIC_API_KEY   your key from console.anthropic.com
//   ANTHROPIC_MODEL     optional; defaults to claude-haiku-5-5
// Deploy with "Verify JWT" on, so only signed-in members can call it.
//
// POST {key, title, author, year?, qid?, overview?, places?}  →  {setting} or {setting:null, reason}

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
const UA = { "User-Agent": "BookMap/1.0 (+https://dominicvhoule.github.io/bookmap/)" };

const db = (path: string, init: RequestInit = {}) =>
  fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });

// ---------- Wikipedia ----------
async function wikiTitle(qid: string, title: string, author: string) {
  if (/^Q\d+$/.test(qid)) {
    try {
      const r = await fetch(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${qid}&props=sitelinks&sitefilter=enwiki&format=json`, { headers: UA });
      const t = (await r.json())?.entities?.[qid]?.sitelinks?.enwiki?.title;
      if (t) return t as string;
    } catch { /* fall through to search */ }
  }
  try {
    const r = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(`${title} ${author} novel book`)}&srlimit=1&format=json`, { headers: UA });
    return ((await r.json())?.query?.search?.[0]?.title as string) ?? null;
  } catch { return null; }
}
async function wikiText(page: string) {
  const r = await fetch(`https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&titles=${encodeURIComponent(page)}`, { headers: UA });
  const pages = (await r.json())?.query?.pages ?? {};
  const text: string = (Object.values(pages)[0] as { extract?: string })?.extract ?? "";
  if (!text) return "";
  const pick = (re: RegExp) => (text.match(re) ?? [])[2] ?? "";
  const setting = pick(/\n==\s*(Setting)\s*==\n([\s\S]*?)(?=\n==[^=]|$)/i);
  const plot = pick(/\n==\s*(Plot|Plot summary|Synopsis|Summary|Story|Premise|Overview)\s*==\n([\s\S]*?)(?=\n==[^=]|$)/i);
  const intro = text.split(/\n==/)[0];
  return (intro.slice(0, 1500) + "\n\n" + setting.slice(0, 2000) + "\n\n" + plot).slice(0, 7000);
}

// ---------- Claude ----------
async function askClaude(title: string, author: string, year: number | null, overview: string, places: string[], wiki: string) {
  const prompt = `You help a website pin each book a reader has finished on a world map at the place where its story takes place.

Book: ${title}${author ? ` by ${author}` : ""}${year ? ` (${year})` : ""}
Publisher's description: ${overview || "(none)"}
Library catalogue subject places: ${places.length ? places.join("; ") : "(none)"}

Wikipedia text:
${wiki || "(none found)"}

Where does this book mainly take place? For fiction, use the setting inside the story, not where the author lived. For nonfiction (history, travel, memoir, biography, reportage), use the place it is mainly about. If it moves around, choose the place where most of it happens.

Reply with only a JSON object:
{"place": "most specific place where most of the book happens (a city, town, region, or an invented place's name)",
 "country": "modern country containing it, in English",
 "continent": "Africa, Asia, Europe, North America, South America, Oceania or Antarctica",
 "lat": latitude of that place as a number, "lon": longitude as a number,
 "precision": "city" | "region" | "country" | "fictional",
 "note": "one short sentence about where the book is set, under 25 words"}
For an invented town in a real country, give the coordinates of the real region it stands in for. If the book is set in an invented world (Middle-earth, a far planet) or has no physical setting (self-help, philosophy, poetry), or you genuinely can't tell, reply {"unknown": true}.`;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 400, messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) throw new Error(`anthropic_${r.status}`);
  const text: string = ((await r.json())?.content ?? []).map((c: { text?: string }) => c.text ?? "").join("");
  const m = text.match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : null;
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

  // Already worked out for someone else? Reuse it.
  try {
    const hit = await (await db(`book_settings?book_key=eq.${encodeURIComponent(key)}&source=eq.ai&select=*`)).json();
    if (Array.isArray(hit) && hit[0]) {
      const s = hit[0];
      return json({ setting: { p: s.place, c: s.country, cont: s.continent ?? "", lat: s.lat, lon: s.lon, ap: s.approx ? 1 : 0, n: s.note ?? "", src: "ai" }, cached: true });
    }
  } catch { /* carry on */ }

  try {
    const page = await wikiTitle(clip(b.qid, 20), title, author);
    const wiki = page ? await wikiText(page) : "";
    const places = (Array.isArray(b.places) ? b.places : []).map((p) => clip(p, 80)).filter(Boolean).slice(0, 12);
    const a = await askClaude(title, author, year, clip(b.overview, 1500), places, wiki);
    if (!a || a.unknown) return json({ setting: null, reason: "unknown" });
    const lat = Number(a.lat), lon = Number(a.lon);
    if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return json({ setting: null, reason: "bad_answer" });
    const approx = a.precision === "country" || a.precision === "fictional";
    const row = {
      book_key: key, place: clip(a.place, 120), country: clip(a.country, 60), continent: clip(a.continent, 20) || null,
      lat: +lat.toFixed(3), lon: +lon.toFixed(3), approx, note: clip(a.note, 300) || null, source: "ai", updated_at: new Date().toISOString(),
    };
    await db("book_settings?on_conflict=book_key", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: JSON.stringify(row) }).catch(() => {});
    return json({ setting: { p: row.place, c: row.country, cont: row.continent ?? "", lat: row.lat, lon: row.lon, ap: approx ? 1 : 0, n: row.note ?? "", src: "ai" } });
  } catch (e) {
    return json({ setting: null, reason: String((e as Error).message || "failed") });
  }
});
