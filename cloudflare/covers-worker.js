// TheBookMap covers: serves every book cover from your own Cloudflare R2 bucket.
//
//   GET https://<this worker>/b/id/12345-M.jpg     (S, M or L, exactly like covers.openlibrary.org)
//
// The first time a cover is asked for, the Worker fetches it from Open Library once, saves it to R2,
// and serves it. After that it always comes from R2, so Open Library being slow or down doesn't
// matter. Browsers and Cloudflare's edge also cache each image for a year.
//
// Setup (Cloudflare dashboard): Workers & Pages → Create → Worker → paste this file → Deploy.
// Then the Worker's Settings → Bindings → Add → R2 bucket: variable name COVERS, bucket thebookmap-covers.

const OL = "https://covers.openlibrary.org";
const YEAR = "public, max-age=31536000, immutable";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
    const m = url.pathname.match(/^\/b\/id\/(\d{1,12})-([SML])\.jpg$/);
    if (!m) return new Response("Not found", { status: 404 });
    const key = `id/${m[1]}-${m[2]}.jpg`;

    // 1. Cloudflare's edge cache (fastest)
    const cache = caches.default;
    const hit = await cache.match(request);
    if (hit) return hit;

    // 2. Your R2 bucket
    const obj = await env.COVERS.get(key);
    if (obj) {
      const res = new Response(obj.body, { headers: { "Content-Type": "image/jpeg", "Cache-Control": YEAR, "Access-Control-Allow-Origin": "*" } });
      ctx.waitUntil(cache.put(request, res.clone()));
      return res;
    }

    // 3. First time: fetch once from Open Library and keep a copy.
    //    default=false makes Open Library answer 404 instead of a blank placeholder image.
    const up = await fetch(`${OL}/b/id/${m[1]}-${m[2]}.jpg?default=false`, { headers: { "User-Agent": "TheBookMap/1.0 (+https://dominicvhoule.github.io/thebookmap/)" } });
    if (!up.ok) return new Response("No cover", { status: 404, headers: { "Cache-Control": "public, max-age=86400", "Access-Control-Allow-Origin": "*" } });
    const bytes = await up.arrayBuffer();
    if (bytes.byteLength < 200) return new Response("No cover", { status: 404, headers: { "Cache-Control": "public, max-age=86400" } });
    ctx.waitUntil(env.COVERS.put(key, bytes, { httpMetadata: { contentType: "image/jpeg" } }));
    const res = new Response(bytes, { headers: { "Content-Type": "image/jpeg", "Cache-Control": YEAR, "Access-Control-Allow-Origin": "*" } });
    ctx.waitUntil(cache.put(request, res.clone()));
    return res;
  },
};
