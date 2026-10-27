// TheBookMap: test bench for the location pipeline v2.
// Sends the test books (loc_test_books) to a Claude model through the Message Batches API (50% off),
// and collects the answers into loc_test_results for the owner to review and score.
//
// Private: every request needs a single-use ticket from loc_test_tickets (made by hand in SQL).
// Deploy with Verify JWT on; the site's public key is enough to reach it, the ticket is what authorises.
//
// POST {ticket, action: "load"}                                       → copies test/location-test-books.json into loc_test_books
// POST {ticket, action: "try",    model, ids: [book ids, up to 10]}  → answers now (not batched; variant "trial")
// POST {ticket, action: "submit",  model, ids?: [...], variant?}      → {batch_id}   (all books if no ids)
// POST {ticket, action: "collect", batch_id}                          → {saved, failed} once the batch has ended
// POST {ticket, action: "status",  batch_id}                          → the batch's processing status
// POST {ticket, action: "cancel",  batch_id}                          → cancels a batch (unfinished requests aren't billed)
// POST {ticket, action: "reparse"}                                    → re-reads saved replies that didn't parse
// ("try" saves as variant "trial" unless a variant is passed, e.g. "v2.0" to count with the batched results)

import { locationPrompt, parseAnswer, PROMPT_VERSION } from "./prompt.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MODELS = new Set(["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]);
const MAX_TOKENS = 4000;   // hidden thinking counts towards this; only what's used is billed
const BOOKS_URL = "https://raw.githubusercontent.com/dominicvhoule/thebookmap/main/test/location-test-books.json";
const AH = { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" };

const db = (path: string, init: RequestInit = {}) =>
  fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });

async function useTicket(token: unknown) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{24,100}$/.test(token)) return false;
  const r = await db(`loc_test_tickets?token=eq.${token}`, { method: "DELETE", headers: { Prefer: "return=representation" } });
  const rows = r.ok ? await r.json() : [];
  return Array.isArray(rows) && rows.length === 1;
}

type Book = { id: number; title: string; author: string; year: number | null; description: string | null };
async function books(ids?: number[]): Promise<Book[]> {
  const filter = ids && ids.length ? `&id=in.(${ids.map(Number).filter(Number.isFinite).join(",")})` : "";
  const r = await db(`loc_test_books?select=id,title,author,year,description&order=id${filter}`);
  if (!r.ok) throw new Error("books_" + r.status);
  return await r.json();
}

const textOf = (msg: { content?: { type: string; text?: string }[] }) =>
  (msg?.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");

async function save(rows: Record<string, unknown>[]) {
  for (let i = 0; i < rows.length; i += 200) {
    const r = await db("loc_test_results?on_conflict=book_id,model,variant", {
      method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: JSON.stringify(rows.slice(i, i + 200)) });
    if (!r.ok) throw new Error("save_" + r.status + " " + (await r.text()).slice(0, 200));
  }
}
const resultRow = (id: number, model: string, variant: string, msg: Record<string, unknown> | null, error: string | null) => {
  const raw = msg ? textOf(msg as never) : "";
  const usage = (msg?.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
  const cut = msg?.stop_reason === "max_tokens";
  const answer = msg && !cut ? parseAnswer(raw) : null;
  return { book_id: id, model, variant, answer, raw: raw.slice(0, 20000), in_tokens: usage.input_tokens ?? null,
    out_tokens: usage.output_tokens ?? null, error: error ?? (cut ? "cut_off" : answer ? null : "unparsed"), created_at: new Date().toISOString() };
};
const params = (model: string, b: Book) => ({ model, max_tokens: MAX_TOKENS, messages: [{ role: "user", content: locationPrompt(b) }] });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  if (!KEY) return json({ error: "no_api_key" }, 500);
  let b: Record<string, unknown> = {};
  try { b = await req.json(); } catch { /* empty */ }
  if (!(await useTicket(b.ticket))) return json({ error: "bad_ticket" }, 403);
  const action = String(b.action ?? "");
  const variant = typeof b.variant === "string" && /^[a-z0-9._-]{1,20}$/.test(b.variant) ? b.variant : PROMPT_VERSION;

  try {
    if (action === "load") {
      // The test book list lives in the repo (test/location-test-books.json); copy it into loc_test_books.
      const r = await fetch(BOOKS_URL);
      if (!r.ok) return json({ error: "books_file_" + r.status }, 502);
      const rows = await r.json();
      for (let i = 0; i < rows.length; i += 250) {
        const w = await db("loc_test_books?on_conflict=id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" },
          body: JSON.stringify(rows.slice(i, i + 250)) });
        if (!w.ok) return json({ error: "load_" + w.status, detail: (await w.text()).slice(0, 300) }, 500);
      }
      return json({ loaded: rows.length });
    }

    if (action === "reparse") {
      // Re-read saved replies that didn't parse (after a parser fix); no new Claude calls.
      const r = await db(`loc_test_results?error=eq.unparsed&select=book_id,model,variant,raw`);
      const rows = r.ok ? await r.json() : [];
      let fixed = 0;
      for (const row of rows) {
        const answer = parseAnswer(row.raw ?? "");
        if (!answer) continue;
        await db(`loc_test_results?book_id=eq.${row.book_id}&model=eq.${row.model}&variant=eq.${encodeURIComponent(row.variant)}`,
          { method: "PATCH", body: JSON.stringify({ answer, error: null }) });
        fixed++;
      }
      return json({ checked: rows.length, fixed });
    }

    if (action === "try") {
      const model = String(b.model);
      if (!MODELS.has(model)) return json({ error: "bad_model" }, 400);
      const list = (await books(Array.isArray(b.ids) ? (b.ids as number[]).slice(0, 10) : [])).slice(0, 10);
      const rows = await Promise.all(list.map(async (bk) => {
        const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: AH, body: JSON.stringify(params(model, bk)) });
        const msg = r.ok ? await r.json() : null;
        return resultRow(bk.id, model, typeof b.variant === "string" ? variant : "trial", msg, r.ok ? null : `http_${r.status}`);
      }));
      await save(rows);
      return json({ results: rows.map((r) => ({ id: r.book_id, answer: r.answer, error: r.error, in: r.in_tokens, out: r.out_tokens, raw: r.answer ? undefined : r.raw })) });
    }

    if (action === "submit") {
      const model = String(b.model);
      if (!MODELS.has(model)) return json({ error: "bad_model" }, 400);
      const list = await books(Array.isArray(b.ids) ? b.ids as number[] : undefined);
      if (!list.length) return json({ error: "no_books" }, 400);
      const r = await fetch("https://api.anthropic.com/v1/messages/batches", {
        method: "POST", headers: AH,
        body: JSON.stringify({ requests: list.map((bk) => ({ custom_id: `b${bk.id}`, params: params(model, bk) })) }),
      });
      const out = await r.json();
      if (!r.ok) return json({ error: "batch_" + r.status, detail: out }, 502);
      await db("loc_test_batches", { method: "POST", body: JSON.stringify({ batch_id: out.id, model, variant, books: list.length }) });
      return json({ batch_id: out.id, books: list.length, status: out.processing_status });
    }

    if (action === "cancel") {
      const id = String(b.batch_id ?? "");
      if (!/^[A-Za-z0-9_-]{6,100}$/.test(id)) return json({ error: "bad_batch" }, 400);
      const r = await fetch(`https://api.anthropic.com/v1/messages/batches/${id}/cancel`, { method: "POST", headers: AH });
      const out = await r.json();
      if (!r.ok) return json({ error: "batch_" + r.status, detail: out }, 502);
      await db(`loc_test_batches?batch_id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ status: "canceled" }) });
      return json({ status: out.processing_status, counts: out.request_counts });
    }

    if (action === "status" || action === "collect") {
      const id = String(b.batch_id ?? "");
      if (!/^[A-Za-z0-9_-]{6,100}$/.test(id)) return json({ error: "bad_batch" }, 400);
      const r = await fetch(`https://api.anthropic.com/v1/messages/batches/${id}`, { headers: AH });
      const batch = await r.json();
      if (!r.ok) return json({ error: "batch_" + r.status, detail: batch }, 502);
      if (action === "status" || batch.processing_status !== "ended") {
        return json({ status: batch.processing_status, counts: batch.request_counts });
      }
      const meta = await (await db(`loc_test_batches?batch_id=eq.${id}&select=model,variant`)).json();
      const model = meta?.[0]?.model ?? "unknown", v = meta?.[0]?.variant ?? variant;
      const res = await fetch(batch.results_url, { headers: AH });
      const lines = (await res.text()).split("\n").filter(Boolean);
      const rows = lines.map((line) => {
        const o = JSON.parse(line);
        const bookId = Number(String(o.custom_id).slice(1));
        return o.result?.type === "succeeded" ? resultRow(bookId, model, v, o.result.message, null)
          : resultRow(bookId, model, v, null, o.result?.type ?? "failed");
      });
      await save(rows);
      await db(`loc_test_batches?batch_id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ status: "collected", collected_at: new Date().toISOString() }) });
      return json({ saved: rows.length, failed: rows.filter((x) => x.error).length, counts: batch.request_counts });
    }

    return json({ error: "bad_action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message || "failed") }, 500);
  }
});
