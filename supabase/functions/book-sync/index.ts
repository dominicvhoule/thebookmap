// BookMap: keep every linked Goodreads map up to date, even when nobody opens the site.
// Called by a schedule (see supabase/migrations/101_bookmap.sql). Each run works through the members
// whose maps are oldest: adds new books from their Goodreads Read shelf with a setting, and copies
// rating changes. It stops before the function's time limit; a map that isn't finished stays due, so
// the next run carries on. Books it can't place are left for the site, which asks the reader to pin them.
//
// Secrets (Edge Functions → Secrets), shared with MovieMap:
//   CRON_SECRET   the same long random string MovieMap's daily sync uses
// Deploy with "Verify JWT" OFF (the schedule authenticates with CRON_SECRET instead).

const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const UA = { "User-Agent": "BookMap/1.0 (+https://dominicvhoule.github.io/thebookmap/)" };
const TIME_BUDGET = 100_000;          // stop starting new work after this many ms
const STALE_HOURS = 20;               // a member is due once their map is this old
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function db(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`db ${r.status} ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

// ---------- the same book key the site uses (js/data.js MM.bookKey) ----------
const norm = (s: string) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
const cleanTitle = (t: string) => { const m = String(t || "").match(/^(.*?)\s*\(([^()]*#\s*[\d.]+[^()]*)\)\s*$/); return m ? { t: m[1].trim(), s: m[2].trim() } : { t: String(t || "").trim(), s: "" }; };
const mainTitle = (t: string) => cleanTitle(t).t.replace(/\s*[:;(].*$/, "");
const firstAuthor = (a: string) => String(a || "").split(/,| and | & /)[0].trim();
const bookKey = (t: string, a: string) => (norm(mainTitle(t)).slice(0, 80) || "untitled") + "|" + norm(firstAuthor(a)).slice(0, 60);

// ---------- Goodreads Read shelf (newest first) ----------
const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " " };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
  e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()] ?? m);
const tag = (s: string, t: string) => { const m = s.match(new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}>`)); return m ? decode(m[1].replace(/^\s*<!\[CDATA\[/, "").replace(/\]\]>\s*$/, "")).trim() : ""; };
const isbnOk = (s: string) => { const d = String(s || "").replace(/[^0-9X]/gi, "").toUpperCase(); return /^[0-9]{9}[0-9X]$|^[0-9]{13}$/.test(d) ? d : ""; };
function day(s: string) { const d = new Date(String(s || "").replace(/\s+[-+]\d{4}$/, "")); return isNaN(+d) || !s ? null : d.toISOString().slice(0, 10); }
type Entry = { gr: string; t: string; s: string; a: string; isbn: string; y: number | null; pages: number | null; r: number | null; read: string | null; rv: boolean; cover: string };
async function shelfPage(id: string, page: number): Promise<Entry[] | null> {
  const r = await fetch(`https://www.goodreads.com/review/list_rss/${id}?shelf=read${page > 1 ? `&page=${page}` : ""}`, { headers: UA });
  if (!r.ok) return null;
  const xml = await r.text();
  if (!/<rss[\s>]/.test(xml)) return null;
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]).map((s) => {
    const c = cleanTitle(tag(s, "title")), y = Number(tag(s, "book_published"));
    const cover = tag(s, "book_large_image_url");
    return { gr: tag(s, "book_id"), t: c.t, s: c.s, a: tag(s, "author_name"), isbn: isbnOk(tag(s, "isbn")), y: y && Math.abs(y) < 3000 ? y : null,
      pages: Number(tag((s.match(/<book\s[^>]*>([\s\S]*?)<\/book>/) ?? [])[1] ?? "", "num_pages")) || null,
      r: Number(tag(s, "user_rating")) || null, read: day(tag(s, "user_read_at")), rv: !!tag(s, "user_review").replace(/<[^>]+>/g, "").trim(),
      cover: /^https:\/\/[a-z0-9.-]*(gr-assets\.com|amazon\.com)\//.test(cover) && !/nophoto/.test(cover) ? cover : "" };
  }).filter((e) => e.t && /^\d+$/.test(e.gr));
}

// ---------- where it's set ----------
type Setting = { place: string; country: string; continent: string | null; lat: number; lon: number; approx: boolean; note: string | null; source: string };
async function sparql(q: string) {
  const r = await fetch("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(q), { headers: { Accept: "application/sparql-results+json", ...UA } });
  return r.ok ? (await r.json()).results.bindings : [];
}
const point = (s: string) => { if (!s || s[0] === "<") return null; const m = /Point\(([-\d.eE]+) ([-\d.eE]+)\)/.exec(s); return m ? [Number(m[1]), Number(m[2])] : null; };
const qidOf = (u: string) => u.split("/").pop()!;
async function olMatch(e: Entry) {
  const fields = "key,title,author_name,first_publish_year,cover_i,id_wikidata,place,edition_count";
  const get = async (q: string) => { const r = await fetch(`https://openlibrary.org/search.json?${q}&lang=en&fields=${fields}&limit=10`, { headers: UA }); return r.ok ? ((await r.json()).docs ?? []) : []; };
  if (e.isbn) { const d = await get(`isbn=${e.isbn}`); if (d[0]) return d[0]; }
  const t = mainTitle(e.t), a = firstAuthor(e.a), nt = norm(t), na = norm(a.split(" ").pop() ?? "");
  let best = null, bestS = -1;
  for (const d of await get(`q=${encodeURIComponent(t + " " + a)}`)) {
    const bt = norm(mainTitle(d.title));
    let s = bt === nt ? 10 : bt.startsWith(nt) || nt.startsWith(bt) ? 5 : 0;
    if (na && norm((d.author_name ?? []).join(" ")).includes(na)) s += 8;
    s += Math.min(4, Math.log10(1 + (d.edition_count ?? 0)) * 1.5) + (d.cover_i ? 1 : 0);
    if (s > bestS) { best = d; bestS = s; }
  }
  return bestS >= 13 ? best : null;
}
async function fromWikidata(qid: string): Promise<Setting | null> {
  const rows = await sparql(`SELECT ?loc ?locLabel ?coord ?country ?countryLabel ?ccoord ?contLabel WHERE {
    wd:${qid} wdt:P840 ?loc . OPTIONAL { ?loc wdt:P625 ?coord . }
    OPTIONAL { ?loc wdt:P17 ?country . OPTIONAL { ?country wdt:P625 ?ccoord . } OPTIONAL { ?country wdt:P30 ?cont . } }
    SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } }`);
  const c = rows.map((b: Record<string, { value: string }>) => ({ id: qidOf(b.loc.value), label: b.locLabel?.value ?? "", pt: point(b.coord?.value ?? ""), cid: b.country ? qidOf(b.country.value) : null,
    country: b.countryLabel?.value ?? "", cpt: point(b.ccoord?.value ?? ""), cont: b.contLabel?.value ?? null })).filter((x: { label: string }) => !/^Q\d+$/.test(x.label));
  const specific = c.find((x: { pt: unknown; cid: string | null; id: string }) => x.pt && x.cid && x.cid !== x.id);
  if (specific) return { place: specific.label, country: specific.country, continent: specific.cont, lon: specific.pt[0], lat: specific.pt[1], approx: false, note: null, source: "wikidata" };
  const invented = c.find((x: { pt: unknown; cpt: unknown }) => !x.pt && x.cpt);
  if (invented) return { place: invented.label, country: invented.country, continent: invented.cont, lon: invented.cpt[0], lat: invented.cpt[1], approx: true, note: `${invented.label} is an invented place, so the pin sits in ${invented.country}.`, source: "wikidata" };
  const ctry = c.find((x: { pt: unknown }) => x.pt);
  if (ctry) return { place: ctry.label, country: ctry.label, continent: ctry.cont, lon: ctry.pt[0], lat: ctry.pt[1], approx: true, note: null, source: "wikidata" };
  return null;
}
// The library catalogue's subject places ("Saint Petersburg (Russia)"), located through Wikipedia.
const TOO_BIG = /^(europe|asia|africa|north america|south america|latin america|oceania|antarctica|middle east|caribbean|scandinavia|balkans|mediterranean.*|.*ocean|earth|world|space|outer space|new england|british isles|great plains|west \(u\.s\.\)|southern states)$/i;
async function fromSubjects(places: string[]): Promise<Setting | null> {
  const groups = new Map<string, { name: string; n: number; first: number }>();
  places.forEach((raw, i) => {
    let s = String(raw).trim();
    if (!s || /imaginary|fictitious|mythical|legendary/i.test(s)) return;
    s = s.replace(/\s*\([^)]*\)\s*$/, "").replace(/^St\.?\s+/i, "Saint ").replace(/\s*--.*$/, "").trim();
    if (!s || TOO_BIG.test(s)) return;
    const g = groups.get(norm(s)) ?? { name: s, n: 0, first: i }; g.n++; groups.set(norm(s), g);
  });
  const cands = [...groups.values()].sort((a, b) => (b.n * 3 - b.first / 10) - (a.n * 3 - a.first / 10)).slice(0, 4);
  if (!cands.length) return null;
  const r = await fetch(`https://en.wikipedia.org/w/api.php?action=query&prop=coordinates|pageprops&ppprop=wikibase_item&redirects=1&format=json&formatversion=2&titles=${encodeURIComponent(cands.map((c) => c.name).join("|"))}`, { headers: UA });
  if (!r.ok) return null;
  const d = await r.json();
  const back = new Map<string, string>(); for (const x of [...(d.query?.redirects ?? []), ...(d.query?.normalized ?? [])]) back.set(x.to, x.from);
  const found = new Map<string, { lat: number; lon: number; item: string | null }>();
  for (const p of d.query?.pages ?? []) {
    const co = (p.coordinates ?? []).find((x: { globe?: string }) => !x.globe || x.globe === "earth"); if (!co) continue;
    let t = p.title; const names = [t]; while (back.has(t)) { t = back.get(t)!; names.push(t); }
    names.forEach((n) => found.set(norm(n), { lat: co.lat, lon: co.lon, item: p.pageprops?.wikibase_item ?? null }));
  }
  for (const c of cands) {
    const hit = found.get(norm(c.name)); if (!hit) continue;
    let country = "", isCountry = false;
    if (hit.item) {
      const rows = await sparql(`SELECT ?c ?cLabel WHERE { OPTIONAL { wd:${hit.item} wdt:P17 ?c . } SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } } LIMIT 1`);
      country = rows[0]?.cLabel?.value ?? ""; isCountry = rows[0]?.c ? qidOf(rows[0].c.value) === hit.item : false;
    }
    return { place: c.name, country: country || c.name, continent: null, lat: hit.lat, lon: hit.lon, approx: isCountry,
      note: null, source: "subjects" };
  }
  return null;
}
async function fromAuthor(qid: string): Promise<Setting | null> {
  const rows = await sparql(`SELECT ?cLabel ?coord WHERE { wd:${qid} wdt:P50 ?a . ?a wdt:P27 ?c . ?c wdt:P625 ?coord . SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } } LIMIT 1`);
  const pt = point(rows[0]?.coord?.value ?? ""), n = rows[0]?.cLabel?.value;
  return pt && n ? { place: n, country: n, continent: null, lon: pt[0], lat: pt[1], approx: true, note: "No setting on record yet, so this is pinned to the author's country. Move the pin if you know better.", source: "author" } : null;
}
async function settingFor(key: string, e: Entry) {
  const cached = await db(`book_settings?book_key=eq.${encodeURIComponent(key)}&select=*`).catch(() => []);
  const doc = await olMatch(e).catch(() => null);
  const ol = doc?.key?.replace("/works/", "") ?? null;
  let qid: string | null = (doc?.id_wikidata ?? []).find((q: string) => /^Q\d+$/.test(q)) ?? null;
  if (!qid && ol) { const rows = await sparql(`SELECT ?w WHERE { ?w wdt:P648 "${ol}" . } LIMIT 1`); qid = rows[0] ? qidOf(rows[0].w.value) : null; }
  const extra = { ol, qid, coverId: doc?.cover_i ?? null, year: doc?.first_publish_year ?? e.y };
  if (cached?.[0]) { const c = cached[0]; return { s: { place: c.place, country: c.country, continent: c.continent, lat: c.lat, lon: c.lon, approx: c.approx, note: c.note, source: c.source } as Setting, ...extra }; }
  let s: Setting | null = null, weak: Setting | null = null;
  if (qid) { s = await fromWikidata(qid).catch(() => null); if (s?.approx) { weak = s; s = null; } }
  if (!s && doc?.place?.length) { s = await fromSubjects(doc.place).catch(() => null); if (s?.approx) { weak = weak ?? s; s = null; } }
  if (s || weak) {
    const keep = (s ?? weak)!;
    await db("book_settings?on_conflict=book_key", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates" },
      body: JSON.stringify({ book_key: key, place: keep.place?.slice(0, 200), country: keep.country?.slice(0, 100), continent: keep.continent, lat: +keep.lat.toFixed(3), lon: +keep.lon.toFixed(3), approx: keep.approx, note: keep.note, source: keep.source }) }).catch(() => {});
  }
  if (!s && !weak && qid) weak = await fromAuthor(qid).catch(() => null);
  return { s: s ?? weak, ...extra };
}

// ---------- one member ----------
async function syncMember(m: { id: string; goodreads_id: string }, deadline: number) {
  const have: { id: number; book_key: string; gr_id: string | null; rating: number | null }[] = await db(`book_logs?user_id=eq.${m.id}&select=id,book_key,gr_id,rating&limit=20000`) ?? [];
  const keys = new Set(have.map((h) => h.book_key)), grs = new Map(have.filter((h) => h.gr_id).map((h) => [h.gr_id!, h]));
  const entries: Entry[] = [];
  // Newest first; keep reading older pages only while every book on the page is new.
  for (let page = 1; page <= 10 && Date.now() < deadline; page++) {
    const list = await shelfPage(m.goodreads_id, page);
    if (!list) { if (page === 1) throw new Error("shelf unreadable"); break; }
    entries.push(...list);
    if (list.length < 100 || list.some((e) => grs.has(e.gr) || keys.has(bookKey(e.t, e.a)))) break;
    await sleep(400);
  }
  let added = 0, rated = 0, left = 0;
  for (const e of entries) {
    const h = grs.get(e.gr);
    if (h) { if ((h.rating ?? null) !== (e.r ?? null)) { await db(`book_logs?id=eq.${h.id}`, { method: "PATCH", body: JSON.stringify({ rating: e.r }) }); rated++; } continue; }
    const key = bookKey(e.t, e.a);
    if (keys.has(key)) continue;
    if (Date.now() > deadline) { left++; continue; }
    const got = await settingFor(key, e).catch(() => null);
    if (!got?.s) continue;   // the site lists it for the reader to pin
    const s = got.s;
    await db("book_logs?on_conflict=user_id,book_key", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates" },
      body: JSON.stringify({ user_id: m.id, title: e.t.slice(0, 400), author: e.a.slice(0, 300) || null, year: got.year || null, series: e.s.slice(0, 200) || null, book_key: key,
        gr_id: e.gr, isbn: e.isbn || null, ol_key: got.ol, wd_qid: got.qid, cover_id: got.coverId, cover_url: null, pages: e.pages && e.pages < 100000 ? e.pages : null,
        place: s.place?.slice(0, 200) || null, country: s.country?.slice(0, 100) || null, continent: s.continent?.slice(0, 40) || null, lat: +s.lat.toFixed(3), lon: +s.lon.toFixed(3),
        approx: s.approx, note: s.note?.slice(0, 500) || null, rating: e.r && e.r >= 1 && e.r <= 5 ? e.r : null, reviewed: e.rv, read_on: e.read, source: s.source }) });
    keys.add(key); added++;
    await sleep(250);   // be gentle with Open Library and Wikidata
  }
  return { added, rated, left };
}

Deno.serve(async (req) => {
  if (!CRON_SECRET || req.headers.get("x-cron-secret") !== CRON_SECRET) return new Response("forbidden", { status: 403 });
  const started = Date.now(), deadline = started + TIME_BUDGET;
  const due = new Date(Date.now() - STALE_HOURS * 3600_000).toISOString();
  const members: { id: string; goodreads_id: string }[] = await db(`profiles?goodreads_id=not.is.null&or=(books_synced.is.null,books_synced.lt.${due})&select=id,goodreads_id&order=books_synced.asc.nullsfirst&limit=40`) ?? [];
  const report: Record<string, unknown> = {};
  for (const m of members) {
    if (Date.now() > deadline) break;
    let done = true;
    try { const r = await syncMember(m, deadline); report[m.goodreads_id] = r; done = r.left === 0; }
    catch (e) { report[m.goodreads_id] = "error: " + String((e as Error).message).slice(0, 120); }
    // An unfinished map stays due, so the next run picks it up where this one stopped.
    if (done) await db(`profiles?id=eq.${m.id}`, { method: "PATCH", body: JSON.stringify({ books_synced: new Date().toISOString() }) }).catch(() => {});
    await sleep(500);
  }
  return new Response(JSON.stringify({ ms: Date.now() - started, report }), { headers: { "Content-Type": "application/json" } });
});
