// TheBookMap: "More like this", step 1 (content-based).
// Each book gets an embedding of what it's about from Supabase's built-in gte-small model (no API cost), stored in
// book_vectors; suggestions are the nearest books by meaning, nudged towards the same place / invented world
// (similar_books_v in migration 113). Same writer and books the reader already has are left out.
//
// POST {book:{t,a,y,ol,coverId,p,c,w}, exclude:[book keys], n}  → {list:[{key,t,a,y,ol,coverId,p,c,w,lat,lon,ap,n}]}
//   A book that isn't stored yet is added on the spot when Open Library confirms it (title, author and
//   description come from Open Library and our own summaries, never from the request), so the pool grows as
//   readers open books. Otherwise its embedding is used once and not kept.
// POST {ticket, action:"seed", ids:[loc_test_books ids]}  → adds pre-placed books (private; ticket from SQL _fn_call)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
// deno-lint-ignore no-explicit-any
const model = new (globalThis as any).Supabase.ai.Session("gte-small");

const db = (path: string, init: RequestInit = {}) =>
  fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
const rpc = async (fn: string, args: Record<string, unknown>) => {
  const r = await db(`rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });
  if (!r.ok) throw new Error(fn + "_" + r.status + " " + (await r.text()).slice(0, 200));
  return await r.json();
};

// Same keys as the site (js/data.js MM.norm / MM.bookKey).
const norm = (s: unknown) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
const cleanTitle = (t: string) => { const m = String(t || "").match(/^(.*?)\s*\(([^()]*#\s*[\d.]+[^()]*)\)\s*$/); return m ? m[1].trim() : String(t || "").trim(); };
const mainTitle = (t: string) => cleanTitle(t).replace(/\s*[:;(].*$/, "");
const firstAuthor = (a: string) => String(a || "").split(/,| and | & /)[0].trim();
const bookKey = (t: string, a: string) => (norm(mainTitle(t)).slice(0, 80) || "untitled") + "|" + norm(firstAuthor(a)).slice(0, 60);
const worldKey = (w: unknown) => {
  const s = String(w ?? "").replace(/\s*\([^)]*\)\s*/g, " ").replace(/^the world of\s+/i, "").replace(/\s+/g, " ").trim();
  return s ? s : null;
};
const placeKey = (p: unknown) => { const s = String(p ?? "").split(",")[0].trim(); return s || null; };

async function embed(text: string): Promise<number[]> {
  return await model.run(text.slice(0, 2000), { mean_pool: true, normalize: true });
}
// What the book is about: its summary. The title is left out (title words pulled "Gone Girl" towards "Gone With
// the Wind") unless the description is too short to go on. Genres aren't added: only some books have them stored,
// and they would pull those books together for that reason alone.
const embedText = (t: string, a: string, y: unknown, _genres: string[], about: string) =>
  `${about.length < 200 ? `${t}${a ? " by " + a : ""}${y ? ` (${y})` : ""}. ` : ""}${about}`.trim();

async function summaryFor(key: string): Promise<string> {
  const r = await db(`book_summaries?book_key=eq.${encodeURIComponent(key)}&select=summary`);
  const rows = r.ok ? await r.json() : [];
  return (rows[0]?.summary as string) || "";
}
async function genresFor(key: string): Promise<string[]> {
  const r = await db(`book_genres?book_key=eq.${encodeURIComponent(key)}&select=genres`);
  const rows = r.ok ? await r.json() : [];
  return Array.isArray(rows[0]?.genres) ? rows[0].genres : [];
}
async function olWork(ol: string) {
  if (!/^OL\d+W$/.test(ol)) return null;
  // The work record (title, description, covers) and, at the same time, the author's name from the search index
  // (the work record only links to author records).
  const getJson = (url: string) => fetch(url, { signal: AbortSignal.timeout(9000) }).then((r) => r.ok ? r.json() : null).catch(() => null);
  const [w, sr] = await Promise.all([
    getJson(`https://openlibrary.org/works/${ol}.json`),
    getJson(`https://openlibrary.org/search.json?q=key:${encodeURIComponent("/works/" + ol)}&fields=author_name&limit=1`),
  ]);
  if (!w) return null;
  let d = w.description; d = typeof d === "object" ? d?.value : d;
  d = String(d || "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\s+/g, " ").trim().slice(0, 1500);
  const author = String(sr?.docs?.[0]?.author_name?.[0] || "");
  return { title: String(w.title || ""), author, description: d, cover: Array.isArray(w.covers) ? w.covers.find((c: number) => c > 0) ?? null : null };
}

type Row = Record<string, unknown>;
const out = (rows: Row[]) => rows.map((r) => ({
  key: r.book_key, t: r.title, a: r.author, y: r.year, ol: r.ol, coverId: r.cover_id,
  p: r.place, c: r.country, w: r.world, lat: r.lat, lon: r.lon, ap: r.ap ? 1 : 0, n: r.note,
}));

async function useTicket(token: unknown) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{24,100}$/.test(token)) return false;
  const r = await db(`loc_test_tickets?token=eq.${token}`, { method: "DELETE", headers: { Prefer: "return=representation" } });
  const rows = r.ok ? await r.json() : [];
  return Array.isArray(rows) && rows.length === 1;
}

// Pre-placed books (loc_test_books + their final v2 answer; coordinates from Emily's shelf where she has them).
async function seed(ids: number[]) {
  const list = ids.map(Number).filter(Number.isFinite).slice(0, 40);
  const books = await (await db(`loc_test_books?select=id,title,author,year,ol_key,cover_id,description&id=in.(${list.join(",")})`)).json();
  const res = await (await db(`loc_test_results?select=book_id,variant,answer&model=eq.claude-opus-5-5&variant=in.(v2.4,v2.5)&book_id=in.(${list.join(",")})`)).json();
  const starter = await (await db(`book_starter?select=book`)).json();
  const coords = new Map<string, Row>();
  for (const s of starter) { const b = s.book as Row; coords.set(bookKey(String(b.t), String(b.a)), b); }
  let done = 0;
  for (const b of books) {
    const ans = (res.find((r: Row) => r.book_id === b.id && r.variant === "v2.5") ?? res.find((r: Row) => r.book_id === b.id))?.answer ?? null;
    const key = bookKey(b.title, b.author);
    const [sum, genres] = await Promise.all([summaryFor(key), genresFor(key)]);
    const about = sum || b.description || "";
    const embedding = await embed(embedText(b.title, b.author, b.year, genres, about));
    const main = ans?.main ?? null, st = coords.get(key);
    const row = {
      book_key: key, title: b.title, author: b.author, author_key: norm(firstAuthor(b.author)).slice(0, 60), year: b.year,
      ol: b.ol_key, cover_id: b.cover_id, place: ans?.type === "invented" ? null : placeKey(main?.place), country: main?.country ?? null,
      world: ans?.type === "invented" ? worldKey(ans?.world) : null,
      lat: st && Number.isFinite(st.lat as number) ? st.lat : null, lon: st && Number.isFinite(st.lon as number) ? st.lon : null,
      ap: !!(st ? st.ap : (ans?.ambiguous || ans?.known === "guessing")), note: ans?.why ?? null, genres,
      embedding: JSON.stringify(embedding), source: "seed", updated_at: new Date().toISOString(),
    };
    const w = await db("book_vectors?on_conflict=book_key", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: JSON.stringify(row) });
    if (!w.ok) throw new Error("save_" + w.status + " " + (await w.text()).slice(0, 200));
    done++;
  }
  return done;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  let b: Record<string, unknown> = {};
  try { b = await req.json(); } catch { /* empty */ }
  try {
    if (b.action === "seed") {
      if (!(await useTicket(b.ticket))) return json({ error: "bad_ticket" }, 403);
      return json({ seeded: await seed(Array.isArray(b.ids) ? b.ids as number[] : []) });
    }

    const bk = (b.book ?? {}) as Row;
    const t = String(bk.t ?? "").slice(0, 300), a = String(bk.a ?? "").slice(0, 200);
    if (!t) return json({ error: "no_book" }, 400);
    const key = bookKey(t, a);
    const exclude = (Array.isArray(b.exclude) ? b.exclude : []).filter((x) => typeof x === "string").slice(0, 3000).map((x) => String(x).slice(0, 150));
    const n = Math.min(Math.max(Number(b.n) || 10, 1), 20);

    const have = await (await db(`book_vectors?book_key=eq.${encodeURIComponent(key)}&select=book_key`)).json();
    if (Array.isArray(have) && have.length) return json({ list: out(await rpc("similar_books", { p_key: key, p_exclude: exclude, p_n: n })) });

    // Not stored yet: describe it from our own summary, else Open Library.
    const ol = String(bk.ol ?? "");
    const [sum, genres, work] = await Promise.all([summaryFor(key), genresFor(key), olWork(ol)]);
    const about = sum || work?.description || "";
    if (about.length < 40) return json({ list: [], reason: "no_description" });
    const embedding = await embed(embedText(t, a, bk.y, genres, about));
    const isWorld = !!bk.w && !Number.isFinite(Number(bk.lat));
    const attrs = { place: isWorld ? null : placeKey(bk.p), country: isWorld ? null : (bk.c ? String(bk.c).slice(0, 80) : null), world: isWorld ? worldKey(bk.w) : null };
    // Keep it for everyone only when Open Library confirms the book (title and author match). Nothing from the
    // request is stored as shown data: title, author, cover and text come from Open Library and our summaries; its
    // place is used for this search only (a reader's own pin may have been moved).
    if (work && norm(mainTitle(work.title)) === norm(mainTitle(t)) && work.author && norm(firstAuthor(work.author)) === norm(firstAuthor(a))) {
      const w = await db("book_vectors?on_conflict=book_key", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates" }, body: JSON.stringify({
        book_key: key, title: work.title || t, author: work.author, author_key: norm(firstAuthor(a)).slice(0, 60), year: Number(bk.y) || null,
        ol, cover_id: work.cover || null, place: null, country: null, world: null, genres, embedding: JSON.stringify(embedding), source: "reader",
      }) });
      if (!w.ok) console.warn("book_vectors save failed", w.status, (await w.text()).slice(0, 200));
    } else if (work) {
      console.warn("not saved: Open Library didn't confirm", key, JSON.stringify({ title: work.title, author: work.author }));
    }
    const rows = await rpc("similar_books_v", { q_embedding: JSON.stringify(embedding), q_key: key, q_author_key: norm(firstAuthor(a)).slice(0, 60),
      q_place: attrs.place, q_country: attrs.country, q_world: attrs.world, p_exclude: exclude, p_n: n });
    return json({ list: out(rows) });
  } catch (e) {
    return json({ error: String((e as Error).message || "failed") }, 500);
  }
});
