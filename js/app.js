// BookMap app: routing, map, reading log, logging, Goodreads import, accounts, people.
(function(){
const CFG = window.BOOKMAP_CONFIG || {};
const FEATURED = window.FEATURED;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const stars = r => r ? "★".repeat(Math.round(r)) : "";
const fmtCoord = (lat,lon)=>`${Math.abs(lat).toFixed(2)}°${lat>=0?"N":"S"} · ${Math.abs(lon).toFixed(2)}°${lon>=0?"E":"W"}`;
const fmtDay = d => { if(!d) return ""; const t = new Date(d + "T12:00:00"); return isNaN(+t) ? d : t.toLocaleDateString([], {day:"numeric", month:"short", year:"numeric"}); };
const siteURL = () => location.origin + location.pathname;
const profileURL = u => siteURL() + "#/u/" + encodeURIComponent(u);
let toastT;
function toast(msg){ const el = $("#toast"); el.textContent = msg; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(()=>el.hidden = true, 2600); }

const contOf = f => f.cont || MM.continentOf(f.c) || "";
const placeLine = f => MM.inOtherWorld(f) ? [f.p, MM.worldName(f.w)].filter((x,i,a)=>x && a.indexOf(x) === i).join(", ")
  : (!f.p ? f.c : !f.c || f.p.includes(f.c) ? f.p : f.p + ", " + f.c) || "";
const byLine = f => [f.a, f.y].filter(Boolean).join(" · ");
// Books without a cover image get a clothbound one, its colour picked from the title.
const CLOTH = ["#17362F","#7A2833","#25356F","#8E6A12","#4B3A5E","#2F5161","#5C3B23","#3E5A2C"];
const cloth = b => { let h = 0; for(const ch of String((b && b.t) || "") + String((b && b.a) || "")) h = (h*31 + ch.charCodeAt(0)) | 0; return CLOTH[Math.abs(h) % CLOTH.length]; };
const isbnOk = s => { const d = String(s || "").replace(/[^0-9X]/gi, "").toUpperCase(); return /^[0-9]{9}[0-9X]$|^[0-9]{13}$/.test(d) ? d : ""; };

/* ================= accounts (Supabase, shared with MovieMap) ================= */
const SB_URL = String(CFG.SUPABASE_URL||"").trim().replace(/\/(rest|auth)\/v1\/?$/,"").replace(/\/+$/,"");
const sb = (SB_URL && CFG.SUPABASE_ANON_KEY && window.supabase) ? window.supabase.createClient(SB_URL, CFG.SUPABASE_ANON_KEY) : null;
let session = null, me = null;     // me = my profile row
// The book tables are added to the shared database by supabase/migrations/101_bookmap.sql. Until that
// has been run, people can still sign in, and their books are kept in this browser.
let booksReady = false;
const cloud = () => !!(sb && session && me && booksReady);

const toRow = f => ({
  title:String(f.t).slice(0, 400), author:f.a ? String(f.a).slice(0, 300) : null, year:+f.y || null, series:f.s ? String(f.s).slice(0, 200) : null,
  book_key:MM.bookKey(f), gr_id:/^\d{1,15}$/.test(f.gr || "") ? String(f.gr) : null, isbn:isbnOk(f.isbn) || null,
  ol_key:/^OL\d+W$/.test(f.ol || "") ? f.ol : null, wd_qid:/^Q\d+$/.test(f.qid || "") ? f.qid : null,
  cover_id:+f.coverId > 0 ? Math.round(+f.coverId) : null, cover_url:null, pages:+f.pages > 0 && +f.pages < 100000 ? Math.round(+f.pages) : null,
  place:f.p ? String(f.p).slice(0, 200) : null, country:f.c || null, continent:f.cont || null, lat:f.lat, lon:f.lon, approx:!!f.ap,
  note:f.n ? String(f.n).slice(0,500) : null, rating:f.r ? Math.max(1, Math.min(5, Math.round(f.r))) : null, reviewed:!!f.rv,
  read_on:/^\d{4}-\d{2}-\d{2}$/.test(f.read || "") ? f.read : null, read_count:Math.max(1, Math.min(999, +f.rc || 1)), source:f.src || null
});
const fromRow = r => ({
  id:r.id, t:r.title, a:r.author||"", y:r.year||"", s:r.series||"", gr:r.gr_id||"", isbn:r.isbn||"", ol:r.ol_key||"", qid:r.wd_qid||"",
  coverId:r.cover_id||null, pages:r.pages||null, p:r.place||"", c:r.country||"", cont:r.continent||"", lat:r.lat, lon:r.lon, ap:r.approx?1:0,
  n:r.note||"", r:r.rating||null, rv:r.reviewed?1:0, read:r.read_on||"", rc:r.read_count||1, src:r.source||"", created:r.created_at
});

async function fetchLogs(userId){
  const out = [];
  for(let from=0; ; from+=1000){
    const {data, error} = await sb.from("book_logs").select("*").eq("user_id", userId).order("read_on", {ascending:false, nullsFirst:false}).order("created_at", {ascending:false}).range(from, from+999);
    if(error) throw error;
    out.push(...data.map(fromRow));
    if(data.length < 1000) break;
  }
  return out;
}

// Shared setting cache hooks used by MM.resolveSettings.
if(sb){
  MM.remoteSettings = async keys => {
    const got = {};
    if(!booksReady) return got;
    for(let i=0; i<keys.length; i+=150){
      const {data} = await sb.from("book_settings").select("*").in("book_key", keys.slice(i, i+150));
      (data||[]).forEach(r=>got[r.book_key] = {p:r.place, c:r.country, cont:r.continent||"", lat:r.lat, lon:r.lon, ap:r.approx?1:0, n:r.note||"", src:r.source});
    }
    return got;
  };
  // Open Library matches shared by every reader (table book_matches). If the table isn't there yet,
  // the site simply looks books up itself.
  let matchesTable = true;
  MM.remoteMatches = async keys => {
    if(!matchesTable) return;
    const need = [...new Set(keys)].filter(k=>!MM.matchMemo[k]);
    for(let i=0; i<need.length; i+=150){
      const {data, error} = await sb.from("book_matches").select("*").in("book_key", need.slice(i, i+150));
      if(error){ matchesTable = false; return; }
      (data||[]).forEach(r=>MM.matchMemo[r.book_key] = {ol:r.ol_key || "", qid:r.wd_qid || "", coverId:r.cover_id || null, t:r.title || "", a:r.author || "", y:r.year || ""});
    }
  };
  MM.saveRemoteMatch = (key, m) => {
    if(!matchesTable || !session || !m || !m.ol) return;
    sb.from("book_matches").upsert({book_key:key, ol_key:m.ol, wd_qid:/^Q\d+$/.test(m.qid || "") ? m.qid : null, cover_id:+m.coverId > 0 ? +m.coverId : null,
      title:String(m.t || "").slice(0, 400), author:String(m.a || "").slice(0, 300), year:+m.y || null}, {onConflict:"book_key", ignoreDuplicates:true})
      .then(({error})=>{ if(error && /book_matches/.test(error.message || "")) matchesTable = false; }, ()=>{});
  };
  // Shared genres (table book_genres): each book's genres are worked out once for everyone.
  let genresTable = true;
  MM.remoteGenres = async keys => {
    const out = {}; if(!genresTable) return out;
    const list = [...new Set(keys)];
    for(let i=0; i<list.length; i+=150){
      const {data, error} = await sb.from("book_genres").select("book_key,genres").in("book_key", list.slice(i, i+150));
      if(error){ genresTable = false; return out; }
      (data || []).forEach(r=>out[r.book_key] = r.genres || []);
    }
    return out;
  };
  MM.saveRemoteGenres = map => {
    if(!genresTable || !session) return;
    const rows = Object.entries(map).filter(([k])=>k.length <= 300).map(([book_key, genres])=>({book_key, genres}));
    for(let i=0; i<rows.length; i+=200) sb.from("book_genres").upsert(rows.slice(i, i+200), {onConflict:"book_key", ignoreDuplicates:true}).then(()=>{}, ()=>{});
  };
  MM.aiSetting = null;   // switched on after sign-in, once the function answers
  MM.summaryServer = body => sb.functions.invoke("book-summary", {body}).then(({data, error})=>{ if(error) throw error; return data; });
  MM.summaryStored = key => cardCache.has(key) && cardCache.get(key).sum ? Promise.resolve(cardCache.get(key).sum) : sb.from("book_summaries").select("summary,source,wiki_page").eq("book_key", key).maybeSingle()
    .then(({data, error})=>{ if(error || !data || !data.summary || data.source === "none") return null; return {text:data.summary, source:data.source, page:data.wiki_page || null}; });
  // "More like this" (similar-books function): the reader's own books are left out on the server too.
  MM.similarServer = book => sb.functions.invoke("similar-books", {body:{book, exclude:myBooks.slice(0, 3000).map(MM.bookKey), n:12}}).then(({data, error})=>{ if(error) throw error; return data; });
  MM.saveRemoteSettings = async map => {
    if(!session || !booksReady) return;
    const rows = Object.keys(map).map(k=>{ const s = map[k]; return {book_key:k, place:s.p ? String(s.p).slice(0, 200) : null, country:s.c || null, continent:s.cont||null, lat:s.lat, lon:s.lon, approx:!!s.ap, note:s.n ? String(s.n).slice(0, 500) : null, source:s.src}; });
    for(let i=0; i<rows.length; i+=200) await sb.from("book_settings").upsert(rows.slice(i, i+200), {onConflict:"book_key", ignoreDuplicates:true});
  };
}

/* ================= my books: account or this browser ================= */
// Maps live on accounts: signed-out visitors can look around but need an account to save books.
// (Books an older version saved in a browser move onto the account at the next sign-in.)
const LOCAL = "bm-local-books";
const NEED_ACCOUNT = "Create an account or sign in to save books to your map.";
const signedOut = () => !!(sb && !me);
const Store = {
  async load(){
    if(cloud()) return fetchLogs(me.id);
    return signedOut() ? [] : MM.lsGet(LOCAL, []);
  },
  async add(list){
    if(!list.length) return {added:0};
    if(cloud()){
      const rows = list.map(toRow);
      let added = 0;
      for(let i=0; i<rows.length; i+=200){
        const {data, error} = await sb.from("book_logs").upsert(rows.slice(i, i+200), {onConflict:"user_id,book_key", ignoreDuplicates:true}).select("id");
        if(error) throw error;
        added += (data||[]).length;
      }
      importReportChanged();
      return {added};
    }
    if(signedOut()) throw new Error(NEED_ACCOUNT);
    const cur = MM.lsGet(LOCAL, []); const have = new Set(cur.map(MM.bookKey));
    const fresh = list.filter(f=>!have.has(MM.bookKey(f))).map(f=>{ const o = Object.assign({}, f); delete o.places; return o; });
    if(!MM.lsSet(LOCAL, [...fresh, ...cur])) throw new Error("This browser is out of storage space. Create an account to keep more books.");
    return {added:fresh.length};
  },
  async update(f, patch){
    if(cloud() && f.id){
      const row = toRow(Object.assign({}, f, patch));
      const {error} = await sb.from("book_logs").update({lat:row.lat, lon:row.lon, approx:row.approx, place:row.place, country:row.country, continent:row.continent,
        note:row.note, rating:row.rating, source:row.source, gr_id:row.gr_id, reviewed:row.reviewed, read_on:row.read_on, read_count:row.read_count, cover_id:row.cover_id}).eq("id", f.id);
      if(error) throw error;
    } else if(!cloud()){
      if(signedOut()) throw new Error(NEED_ACCOUNT);
      const cur = MM.lsGet(LOCAL, []); const k = MM.bookKey(f);
      MM.lsSet(LOCAL, cur.map(x=>MM.bookKey(x)===k ? Object.assign({}, x, patch) : x));
    }
    Object.assign(f, patch);
    importReportChanged();
  },
  async remove(f){
    if(cloud() && f.id){ const {error} = await sb.from("book_logs").delete().eq("id", f.id); if(error) throw error; }
    else if(!cloud()){ if(signedOut()) throw new Error(NEED_ACCOUNT); const k = MM.bookKey(f); MM.lsSet(LOCAL, MM.lsGet(LOCAL, []).filter(x=>MM.bookKey(x)!==k)); }
    importReportChanged();
  }
};
let myBooks = [];
// Every cover comes from Open Library. A book's cover ID is looked up once, when it has none,
// and saved with the book so later visits build the image link straight from it.
async function coverOf(f, size){
  if(!f.coverId){
    const m = await MM.matchBook(f).catch(()=>null);
    if(m && m.coverId){
      if(myBooks.includes(f)) await Store.update(f, {coverId:m.coverId}).catch(()=>{ f.coverId = m.coverId; });
      else f.coverId = m.coverId;
    }
  }
  return MM.coverURL(f, size);
}
/* ---------- Want to read / Currently reading: each reader's private lists (table book_wants) ---------- */
// One row per book; shelf is "want" or "reading", and a book sits on one list at a time (as on Goodreads).
const LISTS = {want:"Want to read", reading:"Currently reading"};
let myWants = [], railTab = "read";
const wantRow = r => ({id:r.id, key:r.book_key, shelf:r.shelf === "reading" ? "reading" : "want", t:r.title, a:r.author || "", y:r.year || "", ol:r.ol_key || "", coverId:r.cover_id || null, isbn:r.isbn || ""});
async function loadWants(){
  myWants = [];
  if(!(sb && session && me)) return;
  const {data, error} = await sb.from("book_wants").select("*").order("created_at", {ascending:false});
  if(!error) myWants = (data || []).map(wantRow);
}
const onList = shelf => myWants.filter(w=>w.shelf === shelf);
const wantOf = b => myWants.find(w=>w.key === MM.bookKey(b));
const wantBtn = b => { const w = wantOf(b);
  return `<span class="lists" id="d-lists">${Object.entries(LISTS).map(([k, name])=>`<button type="button" class="btn ghost small want${w && w.shelf === k ? " on" : ""}" data-shelf="${k}">${w && w.shelf === k ? "✓ " : "+ "}${name}</button>`).join("")}</span>`; };
const wantFields = b => ({book_key:MM.bookKey(b), title:String(b.t).slice(0, 400), author:String(b.a || "").slice(0, 300) || null, year:+b.y || null,
  ol_key:/^OL\d+W$/.test(b.ol || "") ? b.ol : null, cover_id:+b.coverId > 0 ? +b.coverId : null, isbn:String(b.isbn13 || b.isbn || "").slice(0, 20) || null});
function bindWant(b){
  const box = detail.querySelector("#d-lists"); if(!box) return;
  const redo = () => { box.outerHTML = wantBtn(b); bindWant(b); if(railTab !== "read") renderList(); else paintRailTabs(); };
  box.querySelectorAll("button[data-shelf]").forEach(btn=>btn.onclick = async ()=>{
    if(!(sb && session && me)){ toast("Sign in to keep reading lists"); location.hash = "#/account/in"; return; }
    const shelf = btn.dataset.shelf, name = LISTS[shelf];
    box.querySelectorAll("button").forEach(x=>x.disabled = true);
    try{
      const w = wantOf(b);
      if(w && w.shelf === shelf){
        const {error} = await sb.from("book_wants").delete().eq("id", w.id); if(error) throw error;
        myWants = myWants.filter(x=>x !== w); toast(`Taken off your ${name} list`);
      } else if(w){
        const {error} = await sb.from("book_wants").update({shelf}).eq("id", w.id); if(error) throw error;
        w.shelf = shelf; toast(`Moved to ${name}`);
      } else {
        const {data, error} = await sb.from("book_wants").insert(Object.assign(wantFields(b), {shelf})).select().single();
        if(!error) warmSummaries([b]);
        if(error){ if(error.code === "23505"){ await loadWants(); redo(); return; } throw error; }
        myWants.unshift(wantRow(data)); toast(`Added to ${name}`);
      }
      redo();
    }catch(e){ box.querySelectorAll("button").forEach(x=>x.disabled = false); toast(`Couldn't update your ${name} list. Try again.`); }
  });
}
// Goodreads export: books on the to-read and currently-reading shelves go on the matching list here.
// A book that's now on the map (read) comes off the lists. Returns how many were added or moved.
async function syncLists(entries){
  if(!(sb && session && me)) return {added:0, moved:0, done:0};
  await loadWants();
  const read = myKeys(), byKey = new Map(myWants.map(w=>[w.key, w]));
  const done = myWants.filter(w=>read.has(w.key));
  for(let i=0; i<done.length; i+=100){ const {error} = await sb.from("book_wants").delete().in("id", done.slice(i, i+100).map(w=>w.id)); if(error) throw error; }
  const fresh = [], moves = {want:[], reading:[]}, seen = new Set();
  for(const e of entries){
    const k = MM.bookKey(e); if(read.has(k) || onMyMap(e) || seen.has(k)) continue; seen.add(k);
    const w = byKey.get(k);
    if(!w) fresh.push(Object.assign(wantFields(e), {shelf:e.shelf}));
    else if(w.shelf !== e.shelf) moves[e.shelf].push(w.id);
  }
  for(let i=0; i<fresh.length; i+=200){ const {error} = await sb.from("book_wants").upsert(fresh.slice(i, i+200), {onConflict:"user_id,book_key", ignoreDuplicates:true}); if(error) throw error; }
  warmSummaries(entries.filter(e=>fresh.some(r=>r.book_key === MM.bookKey(e))));
  for(const shelf of Object.keys(moves)) for(let i=0; i<moves[shelf].length; i+=100){ const {error} = await sb.from("book_wants").update({shelf}).in("id", moves[shelf].slice(i, i+100)); if(error) throw error; }
  await loadWants();
  return {added:fresh.length, moved:moves.want.length + moves.reading.length, done:done.length};
}
// The reading log's heading: on your own map, three tabs side by side: Read | Reading | Want to read, each with a count.
function paintRailTabs(){
  const h = $("#loghead"); if(!h) return;
  const head = h.closest(".listhead");
  if(!(viewing.mine && me)){ railTab = "read"; head.classList.remove("tabbed"); h.removeAttribute("role"); h.textContent = "Reading log"; $("#q").hidden = false; return; }
  head.classList.add("tabbed"); h.setAttribute("role", "group"); h.setAttribute("aria-label", "Your lists");
  const tab = (k, name, n) => `<button type="button" data-tab="${k}" aria-pressed="${railTab === k}"><b>${name}</b><span>${n}</span></button>`;
  h.innerHTML = tab("read", "Read", myBooks.length) + tab("reading", "Reading", onList("reading").length) + tab("want", "Want to read", onList("want").length);
  h.querySelectorAll("button").forEach(b=>b.onclick = ()=>{ railTab = b.dataset.tab; renderList(); });
  $("#q").hidden = railTab !== "read";
}
async function reloadMine(){ try{ myBooks = await Store.load(); }catch(e){ myBooks = []; toast("Couldn't load your books. Check your connection."); } importReportChanged(); }
const myKeys = () => new Set(myBooks.map(MM.bookKey));
const onMyMap = m => myKeys().has(MM.bookKey(m)) || (!!m.ol && myBooks.some(b=>b.ol === m.ol)) || (!!m.gr && myBooks.some(b=>b.gr === m.gr));

/* ================= map ================= */
// A real street map (MapLibre + OpenFreeMap tiles, free and keyless) that behaves like Google Maps
// (place names and detail appear as you zoom, pins merge into counts and split apart) but is drawn in
// the Swiss palette: grey land, white water and roads, black lettering, red pins.
let countries = [];
let viewing = {owner:null, films:[], mine:false};   // what the map shows (films: the books on it)
let selected = null, picking = null, preview = null;
let map = null, mapReady = false, markers = [], previewMarker = null;
const MAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";
const WORLD_VIEW = {center:[10, 25], zoom:1.3};

function initMap(){
  if(map || !window.maplibregl) return;
  map = new maplibregl.Map({container:"map", style:MAP_STYLE, center:WORLD_VIEW.center, zoom:WORLD_VIEW.zoom,
    minZoom:0.8, maxZoom:17, attributionControl:false, dragRotate:false, pitchWithRotate:false, renderWorldCopies:true});
  map.touchZoomRotate.disableRotation();
  map.getCanvasContainer().style.background = mapColors().land;
  map.addControl(new maplibregl.AttributionControl({compact:true}), "bottom-right");
  map.once("style.load", ()=>{
    paintMap();
    // Countries with a book: solid black with white names. Zoomed in to city level, the black fades so
    // the streets show through and the map's own names take over.
    const firstLabel = map.getStyle().layers.find(l=>l.type === "symbol");
    map.addSource("mm-countries", {type:"geojson", data:{type:"FeatureCollection", features:countries.map(unwrapFeature)}});
    map.addLayer({id:"mm-visited", type:"fill", source:"mm-countries",
      paint:{"fill-color":mapColors().visited, "fill-opacity":["interpolate", ["linear"], ["zoom"], 3.5, 1, 6, 0.35]},
      filter:["in", ["get","name"], ["literal", []]]}, firstLabel && firstLabel.id);
    countryPoints();
    map.addSource("mm-country-points", {type:"geojson", data:{type:"FeatureCollection", features:[]}});
    map.addLayer({id:"mm-visited-labels", type:"symbol", source:"mm-country-points", maxzoom:7,
      layout:{"text-field":["get","label"], "text-font":["Noto Sans Bold"], "text-transform":"uppercase", "text-letter-spacing":0.08,
        "text-size":["interpolate", ["linear"], ["zoom"], 1, 9, 4, 13], "text-max-width":7, "symbol-sort-key":["get","rank"],
        "text-padding":2},
      paint:{"text-color":mapColors().visitedInk, "text-halo-color":mapColors().visited, "text-halo-width":1},
      filter:["in", ["get","name"], ["literal", []]]});
    // Invisible stand-ins for the pins, so the map's names keep clear of them instead of running under them.
    map.addImage("mm-block", {width:32, height:32, data:new Uint8Array(32 * 32 * 4)});
    map.addSource("mm-pins", {type:"geojson", data:{type:"FeatureCollection", features:[]}});
    map.addLayer({id:"mm-pin-blocks", type:"symbol", source:"mm-pins",
      layout:{"icon-image":"mm-block", "icon-size":["get","s"], "icon-offset":["get","o"], "icon-allow-overlap":true, "icon-ignore-placement":false}});
    mapReady = true;
    renderPins(); fitPins(false);
    // Follow the reader's light or dark setting.
    try{ matchMedia("(prefers-color-scheme: dark)").addEventListener("change", ()=>{ paintMap(); renderPins(); }); }catch(e){}
    const fold = () => { const at = map.getContainer().querySelector(".maplibregl-ctrl-attrib"); if(at) at.classList.remove("maplibregl-compact-show"); };
    fold(); map.once("load", fold); map.once("idle", fold);
  });
  map.on("zoomend", ()=>renderPins());
  map.on("click", ev=>{
    if(!picking){
      if(ev.originalEvent && ev.originalEvent.target.closest && ev.originalEvent.target.closest(".gpin")) return;   // that was a pin
      if(!$("#detail").hidden){ closeDetail(); return; }
      // Clicking a black country (one with a book) opens its page.
      const hit = map.getLayer("mm-visited") && map.queryRenderedFeatures(ev.point, {layers:["mm-visited"]})[0];
      if(hit) openCountry(hit.properties.name);
      return;
    }
    const ll = [ev.lngLat.wrap().lng, ev.lngLat.lat];
    const hit = countries.find(c=>d3.geoContains(c, ll));
    const cb = picking; picking = null;
    $("#map").classList.remove("picking"); $("#pickhint").hidden = true;
    cb({lon:+ll[0].toFixed(3), lat:+ll[1].toFixed(3), country: hit ? MM.displayCountry(hit.properties.name) : ""});
  });
}
// One label point per country (on its largest landmass), with the short name used on the map.
const SHORT_NAMES = {"United States of America":"United States","Dem. Rep. Congo":"DR Congo","Bosnia and Herz.":"Bosnia","S. Sudan":"South Sudan","Falkland Is.":"Falklands","W. Sahara":"W. Sahara","Central African Rep.":"Central African Rep.","Dominican Rep.":"Dominican Rep.","Eq. Guinea":"Eq. Guinea","Solomon Is.":"Solomon Is."};
let countryPointsCache = null;
function labelSpots(p){
  if(p.spots) return p.spots;
  p.spots = deepestPoint(p.part).slice(0, 40).map(s=>{ const [w, h] = landRun(p.part, s.c); return {c:s.c, w, h}; });
  return p.spots;
}
// How much land runs across (west-east) and up (south-north) through a point, in degrees, so we can
// tell whether a name written there fits inside the country.
function landRun(poly, [x, y]){
  const xs = [], ys = [];
  poly.coordinates.forEach(r=>{ for(let i=1; i<r.length; i++){
    const [ax, ay] = r[i-1], [bx, by] = r[i];
    if((ay > y) !== (by > y)) xs.push(ax + (y - ay) * (bx - ax) / (by - ay));
    if((ax > x) !== (bx > x)) ys.push(ay + (x - ax) * (by - ay) / (bx - ax));
  } });
  const span = (list, v) => { list.sort((a,b)=>a-b); for(let i=0; i+1<list.length; i+=2) if(list[i] <= v && v <= list[i+1]) return list[i+1] - list[i]; return 0; };
  return [span(xs, x), span(ys, y)];
}
// Spots inside a country, deepest first (furthest from any coast or border), so a name sits on the
// country rather than on a bay or the sea next to it.
function deepestPoint(poly){
  const ring = poly.coordinates[0]; if(!ring || ring.length < 4) return [{c:d3.geoCentroid(poly), d:0}];
  const xs = ring.map(p=>p[0]), ys = ring.map(p=>p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  if(x1 - x0 > 180) return [{c:d3.geoCentroid(poly), d:0}];
  const k = Math.cos((y0 + y1) / 2 * Math.PI / 180) || 1;
  const segs = [];
  poly.coordinates.forEach(r=>{ for(let i=1; i<r.length; i++) segs.push([r[i-1][0] * k, r[i-1][1], r[i][0] * k, r[i][1]]); });
  const dist = (x, y) => { let m = Infinity; for(const [ax, ay, bx, by] of segs){ const dx = bx - ax, dy = by - ay, l = dx*dx + dy*dy; let t = l ? ((x - ax) * dx + (y - ay) * dy) / l : 0; t = Math.max(0, Math.min(1, t)); const ex = ax + t*dx - x, ey = ay + t*dy - y; const d = ex*ex + ey*ey; if(d < m) m = d; } return m; };
  const pts = [];
  const N = 18;
  for(let i=1; i<N; i++) for(let j=1; j<N; j++){
    const x = x0 + (x1 - x0) * i / N, y = y0 + (y1 - y0) * j / N;
    if(d3.geoContains(poly, [x, y])) pts.push({c:[x, y], d:dist(x * k, y)});
  }
  pts.sort((a,b)=>b.d - a.d);
  return pts.length ? pts : [{c:d3.geoCentroid(poly), d:0}];
}
function countryPoints(){
  if(countryPointsCache) return countryPointsCache;
  countryPointsCache = countries.map(f=>{
    const g = f.geometry; if(!g) return null;
    let part = g;
    if(g.type === "MultiPolygon"){ let best = -1; g.coordinates.forEach(c=>{ const p = {type:"Polygon", coordinates:c}, a = d3.geoArea(p); if(a > best){ best = a; part = p; } }); }
    if(part && part.type === "Polygon"){ const xs = part.coordinates[0].map(p=>p[0]); if(Math.max(...xs) - Math.min(...xs) > 180) part = {type:"Polygon", coordinates:part.coordinates.map(unwrapRing)}; }
    const name = f.properties.name;
    return {type:"Feature", part, properties:{name, label:SHORT_NAMES[name] || name, rank:-Math.round(d3.geoArea(part) * 1e4)}, geometry:{type:"Point", coordinates:d3.geoCentroid(part)}};
  }).filter(Boolean);
  return countryPointsCache;
}
// Repaint the OpenFreeMap "liberty" style in BookMap's colours (paper land, blue-grey water, quiet roads),
// in English, without the clutter. The colours come from the page's own tokens, so dark mode follows.
let countryLabelLayers = [];
const NAME_EN = ["coalesce", ["get","name:en"], ["get","name_en"], ["get","name:latin"], ["get","name"]];
function mapColors(){
  const cs = getComputedStyle(document.documentElement), v = n => cs.getPropertyValue(n).trim();
  return {land:v("--m-land") || "#F7F6F1", water:v("--m-water") || "#CBD8DC", road:v("--m-road") || "#FFFFFF", casing:v("--m-casing") || "#D9DDD6",
    building:v("--m-building") || "#E9E8E1", border:v("--m-border") || "#A8B4AE", ink:v("--m-ink") || "#18231F", muted:v("--m-muted") || "#5B6863",
    visited:v("--m-visited") || "#E9D9B1", visitedInk:v("--m-visited-ink") || "#18231F"};
}
function paintMap(){
  const C = mapColors();
  const set = (id, k, v) => { try{ map.setPaintProperty(id, k, v); }catch(e){} };
  const hide = id => { try{ map.setLayoutProperty(id, "visibility", "none"); }catch(e){} };
  map.getCanvasContainer().style.background = C.land;
  for(const l of map.getStyle().layers){
    const id = l.id, t = l.type;
    if(id.startsWith("mm-")) continue;
    if(t === "background") set(id, "background-color", C.land);
    else if(t === "raster" || t === "hillshade" || t === "fill-extrusion") hide(id);
    else if(t === "fill"){
      if(/water/.test(id)) set(id, "fill-color", C.water);
      else if(/building/.test(id)) set(id, "fill-color", C.building);
      else hide(id);
    }
    else if(t === "line"){
      if(/water|river|stream|canal/.test(id)) set(id, "line-color", C.water);
      else if(/boundary|admin/.test(id)){ set(id, "line-color", C.border); set(id, "line-dasharray", [2, 1.5]); }
      else if(/casing/.test(id)) set(id, "line-color", C.casing);
      else if(/rail|transit/.test(id)) set(id, "line-color", C.casing);
      else set(id, "line-color", C.road);
    }
    else if(t === "symbol"){
      if(/poi|shield|aerodrome|airport|transit|station|housenumber|oneway/.test(id)){ hide(id); continue; }
      if(map.getLayoutProperty(id, "text-field")){
        map.setLayoutProperty(id, "text-field", NAME_EN);
        const water = /water|ocean|sea|lake|marine/.test(id);
        if(/country/.test(id)){
          if(!countryLabelLayers.includes(id)) countryLabelLayers.push(id);
          map.setLayoutProperty(id, "text-transform", "uppercase");
          map.setLayoutProperty(id, "text-letter-spacing", 0.08);
          map.setLayoutProperty(id, "text-font", ["Noto Sans Bold"]);
          set(id, "text-color", C.muted); set(id, "text-halo-color", C.land); set(id, "text-halo-width", 1);
          continue;
        }
        set(id, "text-color", water ? C.muted : /country|continent|state/.test(id) || /city|capital/.test(id) ? C.ink : C.muted);
        set(id, "text-halo-color", water ? C.water : C.land);
        set(id, "text-halo-width", 1.2);
        if(map.getLayoutProperty(id, "icon-image")) set(id, "icon-opacity", 0);
      }
    }
  }
  // Countries with a book: gilt, with their names in ink.
  set("mm-visited", "fill-color", C.visited);
  set("mm-visited-labels", "text-color", C.visitedInk); set("mm-visited-labels", "text-halo-color", C.visited);
}
// Shapes that cross the date line jump from +180 to -180; keep each ring's longitudes continuous.
function unwrapRing(ring){
  const out = []; let prev = null, shift = 0;
  for(const [x, y] of ring){
    if(prev !== null){ const d = x - prev; if(d > 180) shift -= 360; else if(d < -180) shift += 360; }
    prev = x; out.push([x + shift, y]);
  }
  return out;
}
function unwrapFeature(f){
  const g = f.geometry; if(!g) return f;
  const poly = p => p.map(unwrapRing);
  const geometry = g.type === "Polygon" ? {type:"Polygon", coordinates:poly(g.coordinates)}
    : g.type === "MultiPolygon" ? {type:"MultiPolygon", coordinates:g.coordinates.map(poly)} : g;
  return {type:"Feature", properties:f.properties, geometry};
}
function drawBase(){ if(!map) initMap(); else map.resize(); }
$("#zin").onclick = ()=>map && map.zoomIn();
$("#zout").onclick = ()=>map && map.zoomOut();
$("#zfit").onclick = ()=>fitPins(true);

// Books whose pins would overlap on screen at this zoom share one pin with a count.
function groupBooks(list){
  const groups = [];
  const near = 26;   // pixels
  list.forEach(f=>{
    if(!Number.isFinite(f.lat) || !Number.isFinite(f.lon)) return;
    const p = map.project([f.lon, f.lat]);
    let g = groups.find(g=>Math.abs(g.px - p.x) < near && Math.abs(g.py - p.y) < near);
    if(!g){ g = {lat:f.lat, lon:f.lon, px:p.x, py:p.y, films:[]}; groups.push(g); }
    g.films.push(f);
  });
  groups.forEach(g=>{ g.ap = g.films.every(f=>f.ap); g.key = g.films.map(MM.bookKey).join("~"); });
  return groups;
}
let genreSel = "";   // the genre the map is narrowed to ("" = every book)
// The genre menu offers a short list of broad genres; each one gathers the finer genres books are tagged with.
const GENRE_MENU = [
  ["Classics", ["Classics"]],
  ["Mystery & thriller", ["Mystery & crime", "Thriller"]],
  ["Sci-fi & fantasy", ["Science fiction", "Fantasy"]],
  ["Romance", ["Romance"]],
  ["Horror", ["Horror"]],
  ["Young adult", ["Young adult"]],
  ["Poetry", ["Poetry"]],
  ["History", ["History", "Historical fiction"]],
  ["Biography", ["Memoir & biography"]],
  ["Philosophy & religion", ["Philosophy", "Religion"]],
  ["Science", ["Science & nature"]],
  ["Politics & society", ["Politics & society"]],
];
const GENRE_OF = Object.fromEntries(GENRE_MENU);
const inGenre = (f, sel) => !sel || (f.g || []).some(x=>GENRE_OF[sel].includes(x));
function filtered(){
  const q = ($("#q").value||"").toLowerCase().trim();
  let list = viewing.films;
  if(genreSel) list = list.filter(f=>inGenre(f, genreSel));
  // Books are shown in English; their original-language title and author (to / ao) still match a search.
  return q ? list.filter(f=>[f.t,f.a,f.p,f.c,f.s,f.to,f.ao].join(" ").toLowerCase().includes(q)) : list;
}
// The genre menu under the map's title: pick one to see only those books (and where they're set).
function pickGenre(g){
  genreSel = g;
  closeDetail(); setOwnerHeader(); renderGenres(); renderPins(); renderList(); renderCTA(); if(mapView !== "map") renderCountryList(true); fitPins(true);
}
function renderGenres(){
  const el = $("#genres"); if(!el) return;
  const films = viewing.films || [];
  const count = {}; GENRE_MENU.forEach(([g])=>{ count[g] = films.filter(f=>inGenre(f, g)).length; });
  const list = GENRE_MENU.map(([g])=>g).filter(g=>count[g]);
  if(viewing.owner && viewing.owner.welcome || !list.length){ el.hidden = true; el.innerHTML = ""; return; }
  if(genreSel && !count[genreSel]) genreSel = "";
  el.hidden = false;
  const opt = (g, label, n) => `<li role="option" tabindex="-1" data-g="${esc(g)}" aria-selected="${genreSel === g}">${esc(label)}<span>${n}</span></li>`;
  el.innerHTML = `<button type="button" class="gbtn" aria-haspopup="listbox" aria-expanded="false">${esc(genreSel || "All genres")}<span>${genreSel ? count[genreSel] : films.length}</span><i aria-hidden="true">▾</i></button>
    <ul class="gmenu" role="listbox" aria-label="Genre" hidden>${opt("", "All genres", films.length)}${list.map(g=>opt(g, g, count[g])).join("")}</ul>`;
  const btn = el.querySelector(".gbtn"), menu = el.querySelector(".gmenu");
  const close = () => { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); document.removeEventListener("pointerdown", outside, true); };
  const outside = e => { if(!el.contains(e.target)) close(); };
  btn.onclick = () => {
    if(!menu.hidden) return close();
    menu.hidden = false; btn.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", outside, true);
    (menu.querySelector('[aria-selected="true"]') || menu.firstElementChild).focus();
  };
  menu.querySelectorAll("li").forEach(li=>{
    li.onclick = () => { close(); pickGenre(li.dataset.g); el.querySelector(".gbtn").focus(); };
    li.onkeydown = e => {
      if(e.key === "Enter" || e.key === " "){ e.preventDefault(); li.click(); }
      else if(e.key === "ArrowDown"){ e.preventDefault(); (li.nextElementSibling || li).focus(); }
      else if(e.key === "ArrowUp"){ e.preventDefault(); (li.previousElementSibling || li).focus(); }
      else if(e.key === "Escape"){ close(); btn.focus(); }
    };
  });
}
const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M5 4.5A2.5 2.5 0 0 1 7.5 2H19v16H7.5a1 1 0 0 0 0 2H19v2H7.5A2.5 2.5 0 0 1 5 19.5v-15Zm3 .5v2h8V5H8Z"/></svg>';
function pinElement(d){
  const lone = d.films.length === 1;
  const el = document.createElement("button");
  el.type = "button";
  el.className = "gpin" + (d.ap ? " approx" : "") + (!!selected && d.films.includes(selected) ? " sel" : "") + (lone ? "" : " many");
  el.setAttribute("aria-label", d.films.map(f=>f.t).join(", "));
  el.title = d.films.length > 1 ? `${d.films.length} books` : d.films[0].t;
  el.innerHTML = `<span class="b">${lone ? ICON : `<b>${d.films.length}</b>`}</span>`;
  el.addEventListener("click", ev=>{ ev.stopPropagation(); openGroup(d); });
  return el;
}
function renderPins(){
  renderWorlds();
  if(!mapReady) return;
  markers.forEach(m=>m.remove()); markers = [];
  map.getContainer().classList.toggle("far", map.getZoom() < 2.6);
  const groups = groupBooks(filtered());
  groups.sort((a,b)=>(!!selected && a.films.includes(selected)) - (!!selected && b.films.includes(selected)));
  groups.forEach(g=>{
    const sel = !!selected && g.films.includes(selected);
    markers.push(new maplibregl.Marker({element:pinElement(g), anchor: sel ? "bottom" : "center"}).setLngLat([g.lon, g.lat]).addTo(map));
  });
  const far = map.getZoom() < 2.6;
  if(map.getSource("mm-pins")) map.getSource("mm-pins").setData({type:"FeatureCollection", features:groups.map(g=>{
    const sel = !!selected && g.films.includes(selected), many = g.films.length > 1;
    const px = (sel ? 34 : far ? (many ? 22 : 18) : (many ? 28 : 24)) + 4, s = px / 32;
    return {type:"Feature", properties:{s, o:[0, sel ? -21 / s : 0]}, geometry:{type:"Point", coordinates:[g.lon, g.lat]}};
  })});
  const visited = [...new Set(filtered().map(f=>MM.geoName(f.c)))];
  if(map.getLayer("mm-visited")) map.setFilter("mm-visited", ["in", ["get","name"], ["literal", visited]]);
  // A name is only written where it fits inside its country at this zoom, like a printed map.
  const z = map.getZoom(), pxPerDeg = 512 * Math.pow(2, z) / 360;
  const fs = Math.max(9, Math.min(13, 9 + (z - 1) * 4 / 3));
  const set = new Set(visited);
  const pinBoxes = groups.map(g=>{ const p = map.project([g.lon, g.lat]), r = (g.films.length > 1 ? 15 : 13) + 3; return [p.x - r, p.y - r, p.x + r, p.y + r]; });
  const placed = [];
  for(const p of (countryPointsCache || [])){
    const q = p.properties; if(!set.has(q.name)) continue;
    const textW = String(q.label).length * fs * 0.78 + 6, textH = fs * 1.3;
    for(const spot of labelSpots(p)){
      const lat = spot.c[1] * Math.PI / 180;
      if(z < 5 && (textW > spot.w * pxPerDeg * 0.92 || textH * 1.25 > spot.h * pxPerDeg / Math.cos(lat))) continue;
      const sp = map.project(spot.c), box = [sp.x - textW/2, sp.y - textH/2, sp.x + textW/2, sp.y + textH/2];
      if(pinBoxes.some(b=>!(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3]))) continue;
      placed.push({type:"Feature", properties:q, geometry:{type:"Point", coordinates:spot.c}});
      break;
    }
  }
  if(map.getSource("mm-country-points")) map.getSource("mm-country-points").setData({type:"FeatureCollection", features:placed});
  if(map.getLayer("mm-visited-labels")) map.setFilter("mm-visited-labels", null);
  const named = [...new Set(visited.flatMap(n=>[n, MM.displayCountry(n), (countryPointsCache || []).find(p=>p.properties.name === n)?.properties.label].filter(Boolean)))];
  const onBlack = ["any", ["in", ["get","name:en"], ["literal", named]], ["in", ["get","name"], ["literal", named]]];
  countryLabelLayers.forEach(id=>map.setLayoutProperty(id, "text-field", ["case", onBlack, "", NAME_EN]));
  if(previewMarker){ previewMarker.remove(); previewMarker = null; }
  if(preview){
    const el = document.createElement("div"); el.className = "gpin sel preview"; el.innerHTML = `<span class="b">${ICON}</span>`;
    previewMarker = new maplibregl.Marker({element:el, anchor:"bottom"}).setLngLat([preview.lon, preview.lat]).addTo(map);
  }
}
function fitPins(animate){
  if(!mapReady) return;
  const pts = viewing.films.filter(f=>Number.isFinite(f.lat) && Number.isFinite(f.lon));
  if(!pts.length){ map.jumpTo(WORLD_VIEW); return; }
  const b = new maplibregl.LngLatBounds();
  pts.forEach(f=>b.extend([f.lon, f.lat]));
  const pad = Math.min(60, Math.max(24, map.getContainer().clientWidth / 14));
  map.fitBounds(b, {padding:{top:pad + 50, bottom:pad + 30, left:pad, right:pad}, maxZoom:6, duration: animate ? 700 : 0});
}
// Centre a place in the part of the map the book card leaves uncovered.
function flyTo(f){
  if(!mapReady || !Number.isFinite(f.lat)) return;
  const el = map.getContainer(), W = el.clientWidth, H = el.clientHeight;
  const phone = window.innerWidth <= 860 || W < 560;
  const cardW = Math.min(380, W - 48) + 24;
  const offset = phone ? [0, -Math.round(H * 0.22)] : [-Math.round(cardW / 2), 0];
  map.flyTo({center:[f.lon, f.lat], zoom:Math.max(map.getZoom(), 5), duration:900, essential:true, offset});
}
function startPicking(cb){ picking = cb; $("#map").classList.add("picking"); $("#pickhint").hidden = false; if(window.innerWidth <= 860) $(".mapwrap").scrollIntoView({behavior:"smooth", block:"start"}); }

/* ================= book card ================= */
const detail = $("#detail");
function coverSlot(f, url){
  const ph = `<span class="ph"><b>${esc(f.t)}</b><span>${esc(String(f.a || "").split(" & ")[0])}</span></span>`;
  return `<div class="poster" style="--c:${cloth(f)}">${ph}${url ? `<img src="${esc(url)}" alt="Cover of ${esc(f.t)}" style="position:relative;z-index:2" onerror="this.remove()">` : ""}</div>`;
}
function openGroup(g){
  if(g.films.length === 1) return openBook(g.films[0]);
  selected = null; detail.hidden = false;
  const label = g.films[0].p || g.films[0].c;
  detail.innerHTML = `<div class="stub place-head"><small>${g.films.length} books · one place</small><h3>${esc(label)}</h3><button class="x" aria-label="Close">×</button></div>
    <div class="body"><ul class="multi">${g.films.map((f,i)=>`<li><button data-i="${i}"><b>${esc(f.t)}</b><span class="meta">${esc(f.a)}</span></button></li>`).join("")}</ul></div>`;
  detail.querySelector(".x").onclick = closeDetail;
  detail.querySelectorAll(".multi button").forEach(b=>b.onclick = ()=>openBook(g.films[+b.dataset.i]));
  // Warm up what each listed book's card needs, so tapping one opens it with its summary already there.
  g.films.slice(0, 8).forEach(f=>{ const c = cardCache.get(MM.bookKey(f)); if(!(c && c.sum)) MM.bookSummary(f).then(sum=>cacheSummary(f, sum)).catch(()=>null); if(f.coverId) loadImg(MM.coverURL(f, "L")); });
}
// The book card appears in one go: cover, details and suggestions together. Opening another book
// meanwhile cancels this one.
let openToken = 0;
const timeout = (p, ms) => Promise.race([p, new Promise(r=>setTimeout(()=>r(null), ms))]);
// Resolves with the URL once the image has fully downloaded (null if it fails), so a card can wait
// for its cover and appear complete instead of showing the plain cloth cover first.
// Covers for a scrolling grid or list. Books with a saved cover ID start loading as soon as they are
// within a couple of screens (the first screenful straight away), and each cover is painted the moment
// it arrives; books without one are looked up (shared cache, then Open Library once). Covers already
// seen this visit appear instantly when a list is drawn again. Every cover is stored on the cover
// server in advance (table cover_store), so these are fast fetches.
let coverObservers = [];
const coversSeen = new Set();
function paintCover(el, url){ el.style.backgroundImage = `url("${url}")`; el.textContent = ""; el.classList.add("has"); }
function lazyCovers(root, bookOf, size){
  // Stop watching lists that have since been redrawn.
  coverObservers = coverObservers.filter(o=>{ if(o.els.some(e=>e.isConnected)) return true; o.io.disconnect(); return false; });
  const els = [...root.querySelectorAll(".th")];
  const books = els.map(bookOf).filter(Boolean);
  const need = books.filter(b=>!b.coverId).map(MM.bookKey);
  const shared = need.length && MM.remoteMatches ? MM.remoteMatches(need).catch(()=>{}) : Promise.resolve();
  const show = async el=>{
    const b = bookOf(el); if(!b) return;
    if(!b.coverId) await shared;
    const url = b.coverId ? MM.coverURL(b, size) : await coverOf(b, size).catch(()=>null);
    if(!url) return;
    if(coversSeen.has(url)) return paintCover(el, url);
    const im = new Image();
    im.onload = ()=>{ if(im.naturalWidth > 10){ coversSeen.add(url); paintCover(el, url); } };
    im.src = url;
  };
  const io = new IntersectionObserver(entries=>entries.forEach(en=>{
    if(!en.isIntersecting) return;
    io.unobserve(en.target);
    show(en.target);
  }), {rootMargin:"1200px 0px"});
  els.forEach(el=>{
    const b = bookOf(el), url = b && b.coverId && MM.coverURL(b, size);
    if(url && coversSeen.has(url)) paintCover(el, url); else io.observe(el);
  });
  coverObservers.push({io, els});
  return io;
}
const loadImg = url => !url ? Promise.resolve(null) : new Promise(res=>{ const im = new Image(); im.onload = ()=>res(im.naturalWidth > 10 ? url : null); im.onerror = ()=>res(null); im.src = url; });
// Everything a book card shows for every book on the map, read in one go when the map is shown
// (book_cards: saved summary, Wikipedia credit, readers' ratings and reviews), so tapping a book opens its
// card at once with nothing to wait for. A book that isn't in the answer has no saved summary and no
// ratings yet: its card opens straight away and the summary is worked out then.
var cardCache = new Map();   // book key → {sum:{text, source, page} | null, cm: book_community object | null}
var noCommunity = {ratings:0, average:null, spread:[0,0,0,0,0], review_count:0, reviews:[]};
var cardAsked = new Set();
function warmCards(films){
  if(!sb || !films || !films.length) return Promise.resolve();
  const keys = [...new Set(films.map(MM.bookKey))].filter(k=>!cardAsked.has(k) && !(cardCache.has(k) && !cardCache.get(k).partial));
  keys.forEach(k=>cardAsked.add(k));
  const jobs = [];
  for(let i=0; i<keys.length; i+=1000){
    const part = keys.slice(i, i+1000);
    jobs.push(sb.rpc("book_cards", {p_keys:part}).then(({data, error})=>{
      if(error){ part.forEach(k=>cardAsked.delete(k)); return; }
      const got = new Map((data || []).map(r=>[r.k, r]));
      part.forEach(k=>{
        const r = got.get(k);
        const had = cardCache.get(k);
        cardCache.set(k, {sum: r && r.s ? {text:r.s, source:r.src || "", page:r.pg || null} : (had && had.sum) || null, cm: r && r.cm ? r.cm : null});
      });
    }, ()=>part.forEach(k=>cardAsked.delete(k))));
  }
  return Promise.all(jobs);
}
function cacheSummary(b, sum){
  if(!sum || !sum.text) return;
  const k = MM.bookKey(b), c = cardCache.get(k);
  if(c) c.sum = sum; else cardCache.set(k, {sum, cm:null, partial:true});
}
// Everything a book card shows, fetched before the card appears (each part gives up after a few seconds).
async function cardParts(b, ms = 5000){
  const cover = (async()=>loadImg(b.coverId ? MM.coverURL(b, "L") : await coverOf(b, "L")))().catch(()=>null);
  const [url, sum] = await Promise.all([timeout(cover, ms), timeout(MM.bookSummary(b).catch(()=>null), ms)]);
  return {url, sum};
}
// How the location was chosen stays out of the way: a small "Why this location?" button reveals it.
const whyHTML = note => note ? `<details class="why"><summary>Why this location?</summary><p class="note">${esc(note)}</p></details>` : "";
async function openBook(f, fly){
  const token = ++openToken;
  selected = f; preview = null;
  if(MM.inOtherWorld(f) !== worldView && mapView === "map") setWorld(MM.inOtherWorld(f));
  if(fly) flyTo(f);
  renderPins(); markListSelection();
  // The card opens at once, from what was read when the map loaded (cardCache): the summary is already
  // there and the cover image loads from the cover store in place. Only a book nobody has opened before
  // fills in its summary after the card is open.
  const cached = cardCache.get(MM.bookKey(f));
  const sum = cached && cached.sum || null;
  const url = f.coverId ? MM.coverURL(f, "L") : null;
  const note = MM.cleanNote(f.n, placeLine(f));
  const mine = viewing.mine;
  detail.innerHTML = `<div class="top">${coverSlot(f, url)}
    <div class="stub"><small>${esc(f.y)}</small><h3>${esc(f.t)}</h3><p class="by">${esc(f.a)}</p>${f.s ? `<p class="series">${esc(f.s)}</p>` : ""}<button class="x" aria-label="Close">×</button></div></div>
    <div class="body">
      <div><div class="place">${esc(placeLine(f))}</div><div class="coord">${MM.inOtherWorld(f) ? "Other worlds · " + esc(MM.worldName(f.w)) : fmtCoord(f.lat, f.lon)}</div></div>
      ${whyHTML(note)}
      <div id="d-sum">${sumHTML(sum)}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">${f.r ? `<span class="stars">${stars(f.r)}</span>` : ""}${f.rv ? '<span class="tag">Reviewed</span>' : ""}${f.rc > 1 ? `<span class="tag">Read ${f.rc} times</span>` : ""}${f.ap ? '<span class="tag ap">Approx. setting</span>' : ""}${f.read ? `<span class="tag muted">Read ${esc(fmtDay(f.read))}</span>` : ""}</div>
      ${mine ? `<div class="cta"><button class="btn ghost small" id="d-move">Move pin</button><button class="btn ghost small" id="d-del">Remove</button></div>` : (onMyMap(f) ? "" : `<div class="cta">${wantBtn(f)}</div>`)}
      <div id="d-comm"></div>
      <div id="d-more"><button type="button" class="btn ghost small" id="d-more-btn">See more like this</button></div>
    </div>`;
  detail.hidden = false; detail.scrollTop = 0;
  detail.querySelector(".x").onclick = closeDetail;
  if(!(sum && sum.text)) fillSummary(f, token);
  if(!url) fillCover(f, token);
  bindWant(f);
  // Readers' ratings and reviews show at once from the map's read, then refresh quietly.
  if(cached && !cached.partial) renderCommunity(f, token, mine, cached.cm || noCommunity);
  fillCommunity(f, token, mine);
  // Suggestions only load when asked for, which also keeps opening a card quick.
  const moreBtn = detail.querySelector("#d-more-btn");
  if(moreBtn) moreBtn.onclick = ()=>{ moreBtn.disabled = true; moreBtn.textContent = "Finding books like this…";
  MM.similarFrom(f, onMyMap).catch(()=>null).then(sim=>{
    const box = token === openToken && detail.querySelector("#d-more");
    const list = sim && sim.list || [];
    if(!box) return;
    if(!list.length){ box.innerHTML = `<p class="hint" style="margin:0">We couldn't find similar books for this one yet.</p>`; return; }
    box.innerHTML = `<div class="more"><div class="more-h"><b class="sub" style="font-size:15px">${esc(sim.heading)}</b><span class="hint">Scroll for more →</span></div>
        <ul>${list.map((m,i)=>`<li><button type="button" data-i="${i}" title="${esc(m.t)}"><span class="th" style="--c:${cloth(m)};background-image:url('${MM.coverURL(m, "M")}')"></span><span class="t">${esc(m.t)}</span><span class="y">${esc(m.a.split(" & ")[0])}</span></button></li>`).join("")}</ul>
        <p class="hint" style="font-size:12px;margin:0">Tap one to see where it's set and where to find a copy.</p></div>`;
    box.querySelectorAll(".more button").forEach(b=>b.onclick = ()=>{ box.querySelectorAll(".more button").forEach(x=>x.classList.remove("busy")); b.classList.add("busy"); openPreview(list[+b.dataset.i], f); });
  }); };
  if(mine){
    detail.querySelector("#d-move").onclick = ()=>{ toast("Tap the map where it takes place"); startPicking(async pt=>{
      const moved = pt.country && pt.country !== f.c;
      try{ await Store.update(f, {lat:pt.lat, lon:pt.lon, ap:0, src:"user", c: moved ? pt.country : f.c, p: moved ? pt.country : f.p, cont: moved ? "" : f.cont}); toast("Pin moved"); }
      catch(e){ toast("Couldn't move the pin. Try again."); }
      openBook(f); renderAll();
    }); };
    const del = detail.querySelector("#d-del");
    del.onclick = async ()=>{
      if(del.dataset.armed !== "1"){ del.dataset.armed = "1"; del.textContent = "Tap again to remove"; return; }
      try{ await Store.remove(f); myBooks = myBooks.filter(x=>x!==f); viewing.films = viewing.films.filter(x=>x!==f); closeDetail(); renderAll(); toast("Removed " + f.t); }
      catch(e){ toast("Couldn't remove it. Try again."); }
    };
  }
}
/* ---------- preview of a suggested book (not on the map yet) ---------- */
// Flies to where it's set and shows what it's about and where to find a copy.
// Every "find a copy" link goes through here, so affiliate links can be added in one place later.
function shopLink(shop, b){
  const q = encodeURIComponent(b.isbn || ((b.t || "") + " " + (b.a || "").split(" & ")[0]));
  return {
    goodreads: MM.goodreadsPage(b),
    openlibrary: MM.olPage(b),
    bookshop: `https://bookshop.org/search?keywords=${q}`,
    library: `https://search.worldcat.org/search?q=${q}`
  }[shop];
}
// The story summary can take a few lookups, so the card opens first and the summary appears when it's ready.
// A summary, with Wikipedia's credit line when it came from an article.
const sumHTML = sum => sum && sum.text ? `<p class="ov">${esc(sum.text)}</p>${MM.summaryCredit(sum) ? `<p class="sumcredit">${MM.summaryCredit(sum)}</p>` : ""}` : "";
function fillSummary(b, token){
  const el0 = detail.querySelector("#d-sum");
  if(el0 && !el0.innerHTML.trim()) el0.innerHTML = `<p class="hint busy" style="margin:0">Finding what it's about…</p>`;
  MM.bookSummary(b).catch(()=>null).then(sum=>{
    cacheSummary(b, sum);
    const el = token === openToken && detail.querySelector("#d-sum");
    if(el) el.innerHTML = sum && sum.text ? sumHTML(sum) : "";
  });
}
// A cover that wasn't ready when the card opened is put in as soon as it has loaded.
function fillCover(b, token){
  (async()=>loadImg(b.coverId ? MM.coverURL(b, "L") : await coverOf(b, "L")))().catch(()=>null).then(url=>{
    const slot = url && token === openToken && detail.querySelector(".top .poster");
    if(slot && !slot.querySelector("img")) slot.insertAdjacentHTML("beforeend", `<img src="${esc(url)}" alt="Cover of ${esc(b.t)}" style="position:relative;z-index:2" onerror="this.remove()">`);
  });
}
async function openPreview(m, from){
  const token = ++openToken;
  // Everything is looked up at once, and the card waits at most about 4 seconds. If where it's set is
  // still being worked out (it can take longer for a book nobody has added), the card opens anyway and
  // the place fills in when it arrives.
  // Suggestions from "More like this" may already carry their v2 place (or invented world); use it as is.
  const known = Number.isFinite(m.lat) && Number.isFinite(m.lon) ? [{p:m.p, c:m.c || "", lat:m.lat, lon:m.lon, ap:m.ap ? 1 : 0, n:m.n || "", src:"v2"}]
    : (m.w && !Number.isFinite(m.lat) ? [{p:MM.worldName ? MM.worldName(m.w) : m.w, c:"", n:m.n || "", w:m.w, src:"v2"}]
    // A v2 place without coordinates yet: show where it's set, but don't drop a pin at 0°, 0°.
    : (m.p ? [{p:m.p, c:m.c || "", n:m.n || "", src:"v2"}] : null));
  const setP = known ? Promise.resolve(known) : MM.resolveSettings([m]).catch(()=>null);
  const [det0, settings, parts] = await Promise.all([timeout(MM.bookDetails(m).catch(()=>m), 4000), timeout(setP, 4000), cardParts(m, 4000)]);
  if(token !== openToken) return;
  const det = det0 || m;
  const s = settings && settings[0];
  const placeBlock = s => s ? `<div><div class="place">${esc(placeLine({p:s.p, c:s.c}))}</div>${whyHTML(MM.cleanNote(s.n, placeLine({p:s.p, c:s.c})))}</div>` : `<p class="hint" style="margin:0">We couldn't find where this one is set.</p>`;
  const showPlace = s => { if(s && Number.isFinite(s.lat)){ preview = {lat:s.lat, lon:s.lon}; selected = null; renderPins(); flyTo({lat:s.lat, lon:s.lon}); } };
  showPlace(s);
  if(settings === null) setP.then(r=>{ const el = token === openToken && $("#pv-place"); if(el){ const s2 = r && r[0]; el.innerHTML = placeBlock(s2); showPlace(s2); } });
  detail.innerHTML = `<div class="top">${coverSlot(det, parts.url)}
    <div class="stub"><small>${esc(det.y)}${det.pages ? " · " + det.pages + " pages" : ""}</small><h3>${esc(det.t)}</h3><p class="by">${esc(det.a)}</p><button class="x" aria-label="Close">×</button></div></div>
    <div class="body">
      ${from ? `<button type="button" class="back" id="pv-back" style="margin:0">← Back to ${esc(from.t)}</button>` : ""}
      <div id="pv-place">${settings === null ? `<p class="hint busy" style="margin:0">Finding where it's set…</p>` : placeBlock(s)}</div>
      <div id="d-sum">${sumHTML(parts.sum)}</div>
      ${det.subjects && det.subjects.length ? `<div style="display:flex;gap:6px;flex-wrap:wrap">${det.subjects.slice(0, 3).map(x=>`<span class="tag muted">${esc(x)}</span>`).join("")}</div>` : ""}
      <div class="cta"><button class="btn gold" type="button" id="pv-add">Add to my map</button>${wantBtn(det)}</div>
      <div id="d-comm"></div>
      <div class="watch"><b class="sub" style="font-size:15px">Find a copy</b>
        <div class="shops">
          <a href="${esc(shopLink("bookshop", det))}" target="_blank" rel="noopener sponsored">Bookshop.org ↗</a>
          <a href="${esc(shopLink("library", det))}" target="_blank" rel="noopener">At a library ↗</a>
        </div></div>
    </div>`;
  detail.hidden = false; detail.scrollTop = 0;
  detail.querySelector(".x").onclick = closeDetail;
  const back = $("#pv-back"); if(back) back.onclick = ()=>{ preview = null; openBook(from, true); };
  if(!(parts.sum && parts.sum.text)) fillSummary(det, token);
  bindWant(det);
  fillCommunity(det, token, false);
  $("#pv-add").onclick = ()=>{ preview = null; pendingLog = {ol:det.ol, t:det.t, a:det.a, y:det.y, coverId:det.coverId, qid:det.qid, places:det.places}; location.hash = "#/log"; };
}
/* ---------- community: what TheBookMap's readers think of a book ---------- */
// Average of every reader's rating on their map, how the ratings spread, and readers' reviews (book_reviews).
// On a book that's on your own map you can write, edit or delete your review; it shows with your stars.
const fmtWhen = t => { const d = new Date(t); return isNaN(+d) ? "" : d.toLocaleDateString([], {day:"numeric", month:"short", year:"numeric"}); };
async function fillCommunity(b, token, mine){
  if(!detail.querySelector("#d-comm") || !sb) return;
  const key = MM.bookKey(b);
  let c = null;
  try{ const {data, error} = await sb.rpc("book_community", {p_key:key, p_limit:50}); if(error) throw error; c = data; }catch(e){ return; }
  if(!c) return;
  const cached = cardCache.get(key);
  if(cached && !cached.partial){
    const same = JSON.stringify(cached.cm || noCommunity) === JSON.stringify(c.ratings || c.review_count ? c : noCommunity);
    cached.cm = c.ratings || c.review_count ? c : null;
    if(same && detail.querySelector("#d-comm .comm")) return;   // already showing this; don't redraw under the reader's typing
  }
  renderCommunity(b, token, mine, c);
}
function renderCommunity(b, token, mine, c){
  const box = detail.querySelector("#d-comm");
  if(token !== openToken || !box || !c) return;
  const key = MM.bookKey(b);
  const reviews = c.reviews || [];
  const myReview = me ? reviews.find(r=>r.mine || (r.username && r.username === me.username)) : null;
  const others = reviews.filter(r=>r !== myReview);
  const n = c.ratings || 0, max = Math.max(1, ...(c.spread || [0]));
  const reviewLi = r => `<li><div class="rv-h">${r.username ? `<a href="#/u/${encodeURIComponent(r.username)}">${esc(r.name)}</a>` : `<span class="rv-anon">${esc(r.name)}</span>`}${r.rating ? ` <span class="stars">${stars(r.rating)}</span>` : ""}<span class="rv-d">${esc(fmtWhen(r.at))}</span></div><p class="rv-b">${esc(r.body)}</p></li>`;
  const SHOW = 3;
  box.innerHTML = `<div class="comm">
    <b class="sub" style="font-size:15px">What readers think</b>
    ${n ? `<div class="comm-top"><span class="avg">${Number(c.average).toFixed(1)}</span><span class="stars">${stars(c.average)}</span><span class="hint">${n} rating${n===1?"":"s"} · ${c.review_count} review${c.review_count===1?"":"s"} on TheBookMap</span></div>
      <div class="spread">${[5,4,3,2,1].map(k=>{ const v = (c.spread || [])[k-1] || 0; return `<div><span>${k} ★</span><i><b style="width:${Math.round(v * 100 / max)}%"></b></i><em>${v}</em></div>`; }).join("")}</div>`
      : `<p class="hint" style="margin:0">No ratings on TheBookMap yet.${mine ? " Rate it and write the first review." : ""}</p>`}
    ${mine && me ? `<div class="myrev">
      <label for="rv-t" class="sub" style="font-size:14px">${myReview ? "Your review" : "Write a review"}</label>
      <textarea id="rv-t" maxlength="5000" rows="4" placeholder="What did you think? Others will see this with your name and stars.">${esc(myReview ? myReview.body : "")}</textarea>
      <div class="cta"><button type="button" class="btn small" id="rv-save">${myReview ? "Save changes" : "Post review"}</button>${myReview ? `<button type="button" class="btn ghost small" id="rv-del">Delete</button>` : ""}<span class="hint" id="rv-msg"></span></div>
    </div>` : ""}
    ${others.length ? `<ul class="reviews">${others.map((r,i)=>i < SHOW ? reviewLi(r) : "").join("")}</ul>${others.length > SHOW ? `<button type="button" class="linkbtn" id="rv-all">Show all ${others.length} reviews</button>` : ""}` : ""}
  </div>`;
  const all = box.querySelector("#rv-all");
  if(all) all.onclick = ()=>{ box.querySelector(".reviews").innerHTML = others.map(reviewLi).join(""); all.remove(); };
  const save = box.querySelector("#rv-save");
  if(save) save.onclick = async ()=>{
    const body = box.querySelector("#rv-t").value.trim(), msg = box.querySelector("#rv-msg");
    if(!body){ msg.textContent = "Write something first."; return; }
    save.disabled = true; msg.textContent = "";
    const {error} = await sb.from("book_reviews").upsert({user_id:me.id, book_key:key, body, updated_at:new Date().toISOString()}, {onConflict:"user_id,book_key"});
    if(error){ save.disabled = false; msg.textContent = "Couldn't save. Try again."; return; }
    toast(myReview ? "Review updated" : "Review posted"); fillCommunity(b, token, mine);
  };
  const del = box.querySelector("#rv-del");
  if(del) del.onclick = async ()=>{
    if(del.dataset.armed !== "1"){ del.dataset.armed = "1"; del.textContent = "Tap again to delete"; return; }
    const {error} = await sb.from("book_reviews").delete().eq("user_id", me.id).eq("book_key", key);
    if(error){ toast("Couldn't delete it. Try again."); return; }
    toast("Review deleted"); fillCommunity(b, token, mine);
  };
}
function closeDetail(){ preview = null; openToken++; detail.hidden = true; selected = null; renderPins(); markListSelection(); }

/* ================= profile + reading log ================= */
function setOwnerHeader(){
  const o = viewing.owner || {};
  const name = o.display_name || o.name || o.username || "Your map";
  const av = $("#av"); av.textContent = (name||"?")[0]; av.style.background = MM.avatarColor(o.username || name);
  $("#uname").textContent = name;
  $("#ubio").textContent = [o.username ? "@" + o.username : "", o.bio].filter(Boolean).join(" · ");
  // The numbers follow the genre menu, so "Philosophy" shows how many philosophy books and where.
  const shown = genreSel ? viewing.films.filter(f=>inGenre(f, genreSel)) : viewing.films;
  const ctry = new Set(shown.map(f=>MM.geoName(f.c)).filter(Boolean));
  const cont = new Set(shown.map(contOf).filter(Boolean));
  const authors = new Set(shown.map(f=>MM.norm(String(f.a||"").split(" & ")[0])).filter(Boolean));
  $("#s-books").textContent = shown.length;
  $("#s-authors").textContent = authors.size;
  $("#s-ctry").textContent = ctry.size;
  $("#s-cont").textContent = cont.size;
  $("#whose-k").textContent = viewing.mine ? (me ? (me.book_private ? "Your map · private" : "Your map") : "Saved in this browser") : o.featured ? "Starter shelf" : o.private ? "Private map" : "Member's map";
  $("#whose-h").textContent = viewing.mine ? (me ? (me.display_name || me.username) : "Your map") : name;
}
let listObserver = null;
function renderList(){
  const ul = $("#films");
  paintRailTabs();
  listObserver && listObserver.disconnect();
  if(railTab !== "read"){
    const ws = onList(railTab);
    ul.innerHTML = ws.length ? ws.map((w,i)=>`<li><button data-i="${i}" style="--c:${cloth(w)}"><span class="bar"></span><span class="th" data-i="${i}"></span><span style="min-width:0"><b>${esc(w.t)}</b><span class="meta"><i>${esc(String(w.a).split(" & ")[0])}</i></span></span><span class="r"><em>${esc(w.y)}</em></span></button></li>`).join("")
      : `<li class="empty">Nothing here yet. Open any book that isn't on your map and press <b>${LISTS[railTab]}</b>, or import your Goodreads or StoryGraph export.</li>`;
    ul.querySelectorAll("button[data-i]").forEach(b=>b.onclick = ()=>openPreview(ws[+b.dataset.i], null));
    if(ws.length) listObserver = lazyCovers(ul, el=>ws[+el.dataset.i], "S");
    return;
  }
  const list = filtered();
  if(!list.length){
    ul.innerHTML = `<li class="empty">${viewing.films.length ? "No books match that filter." : viewing.mine ? 'No books yet. <a href="#/log">Log a book</a> or <a href="#/import">import from Goodreads</a>.' : "No books logged yet."}</li>`;
    return;
  }
  ul.innerHTML = list.map((f,i)=>`<li><button data-i="${i}" style="--c:${cloth(f)}"><span class="bar ${f.ap?"ap":""}"></span><span class="th" data-i="${i}" data-t="${esc(f.t)}"></span><span style="min-width:0"><b>${esc(f.t)}</b><span class="meta"><i>${esc(f.a.split(" & ")[0])}</i>${f.a && placeLine(f) ? " · " : ""}${esc(placeLine(f))}</span></span><span class="r">${stars(f.r)}<em>${esc((f.read || "").slice(0, 4) || f.y)}</em></span></button></li>`).join("");
  ul.querySelectorAll("button").forEach(b=>b.onclick = ()=>openBook(list[+b.dataset.i], true));
  listObserver = lazyCovers(ul, el=>list[+el.dataset.i], "S");
  markListSelection();
}
function markListSelection(){
  if(railTab !== "read") return;
  const list = filtered();
  $("#films").querySelectorAll("button[data-i]").forEach(b=>b.classList.toggle("sel", list[+b.dataset.i] === selected));
}
$("#q").addEventListener("input", ()=>{ renderPins(); renderList(); renderCountryList(); });

async function renderCTA(){
  const cta = $("#cta"), ov = $("#overlap");
  ov.hidden = true; cta.innerHTML = "";
  const o = viewing.owner || {};
  if(viewing.mine){
    cta.innerHTML = `<a class="btn gold" href="#/log">Log a book</a><a class="btn ghost" href="#/import">Import</a>${me ? `<button class="btn ghost" id="share">Share</button>` : ""}`;
    const sh = $("#share"); if(sh) sh.onclick = ()=>shareLink(profileURL(me.username), "My map on TheBookMap");
    if(me && !booksReady && sb){ ov.hidden = false; ov.innerHTML = "Your books are saved in this browser for now, while TheBookMap's accounts are being set up."; }
    return;
  }
  if(o.featured && !me){
    cta.innerHTML = sb ? `<a class="btn gold" href="#/account/up">Create your map</a><a class="btn ghost" href="#/explore">Find people</a>` : `<a class="btn" href="#/log">Start your map</a>`;
  }
  // Overlap with my map.
  if(myBooks.length && viewing.films.length){
    const mineC = new Set(myBooks.map(f=>MM.geoName(f.c))); const shared = [...new Set(viewing.films.map(f=>MM.geoName(f.c)))].filter(c=>c && mineC.has(c));
    const mk = myKeys(); const both = viewing.films.filter(f=>mk.has(MM.bookKey(f))).map(f=>f.t);
    ov.hidden = false;
    ov.innerHTML = `You overlap in <b>${shared.length} ${shared.length===1?"country":"countries"}</b>${both.length ? ` and have both read <b>${both.slice(0,6).map(esc).join(", ")}${both.length>6 ? ` and ${both.length-6} more` : ""}</b>` : ""}.`;
  }
  if(me && o.id && o.id !== me.id){
    const {data} = await sb.from("follows").select("followee").eq("follower", me.id).eq("followee", o.id).maybeSingle();
    let following = !!data;
    const b = document.createElement("button");
    const paint = ()=>{ b.textContent = following ? "Following" : "Follow"; b.className = "btn" + (following ? " ghost" : ""); };
    paint();
    b.onclick = async ()=>{
      b.disabled = true;
      const res = following ? await sb.from("follows").delete().eq("follower", me.id).eq("followee", o.id) : await sb.from("follows").insert({follower:me.id, followee:o.id});
      b.disabled = false;
      if(res.error) return toast("That didn't go through. Try again.");
      following = !following; paint();
    };
    cta.prepend(b);
  }
}
function renderAll(){ setOwnerHeader(); renderGenres(); renderPins(); renderList(); renderCTA(); renderCountryList(); warmCards(viewing.films); }

function showMap(owner, films, mine){
  viewing = {owner, films, mine};
  if(worldView) setWorld(false);
  const vt = document.querySelector(".viewtog"); if(vt) vt.hidden = !!owner.welcome;   // nothing to list on the welcome
  selected = null; detail.hidden = true; $("#q").value = ""; genreSel = "";
  renderAll(); fitPins(true);
  // Genres are worked out in the background (once per book); the chips appear when they're ready.
  const shown = viewing.films;
  if(shown.some(f=>!f.g)) MM.genresOf(shown).then(()=>{ if(viewing.films === shown) renderGenres(); }).catch(()=>{});
}
// Emily's starter shelf has no hand-checked places any more: her books are placed by the same pipeline as
// everyone's (shared pins first), once per page load, and the map fills in when they're ready.
let featuredReady = null, featuredPlaced = [];
function placeFeatured(){
  if(featuredReady) return featuredReady;
  featuredReady = (async ()=>{
    // Emily's shelf lives in the database (book_starter), already placed by the v2 location algorithm.
    if(sb){
      try{
        const {data, error} = await sb.from("book_starter").select("book").order("pos");
        if(!error && data && data.length){ featuredPlaced = data.map(r=>r.book); FEATURED.books = featuredPlaced; FEATURED.count = featuredPlaced.length; return featuredPlaced; }
      }catch(e){}
    }
    const books = FEATURED.books;
    const dets = await MM.pool(books, 3, async f=>f.ol ? {t:f.t, a:f.a, y:f.y, ol:f.ol, coverId:f.coverId}
      : Object.assign({}, (await MM.matchBook(f).catch(()=>null)) || {}, {t:f.t, a:f.a, y:f.y}));
    const settings = await MM.resolveSettings(dets);
    featuredPlaced = books.map((f,i)=>settings[i] ? Object.assign({}, f, {qid:dets[i].qid || f.qid, ol:f.ol || dets[i].ol, coverId:f.coverId || dets[i].coverId}, settings[i]) : null).filter(Boolean);
    return featuredPlaced;
  })().catch(e=>{ featuredReady = null; throw e; });
  return featuredReady;
}
function showFeatured(){
  showMap(FEATURED, featuredPlaced, false);
  if(featuredPlaced.length === FEATURED.books.length && featuredReady) return;
  $("#whose-k").textContent = "Placing Emily's books…";
  placeFeatured().then(list=>{ if(viewing.owner === FEATURED){ showMap(FEATURED, list, false); } }).catch(()=>{ if(viewing.owner === FEATURED) $("#whose-k").textContent = "Starter shelf"; });
}
function showMine(){
  const owner = me ? Object.assign({}, me) : {name:"Your map", username:"", bio:"Saved in this browser"};
  showMap(owner, myBooks, true);
}

/* ================= countries: the list view and each country's page ================= */
// Every book is pinned where its story is set. A country's page then splits its books into ones by
// writers from there and ones by writers from elsewhere (an English novel set in Kenya shows in Kenya,
// as not by a Kenyan writer). "From" uses the author's citizenship on Wikidata, so dual citizens count for each.
const regionName = (()=>{ try{ const dn = new Intl.DisplayNames(["en"], {type:"region"}); return c => { try{ return dn.of(c); }catch(e){ return c; } }; }catch(e){ return c => c; } })();
const geoOf = f => MM.geoName(f.c || "");
function countryGroups(list){
  const m = new Map();
  list.forEach(f=>{ const g = geoOf(f); if(!g) return; if(!m.has(g)) m.set(g, []); m.get(g).push(f); });
  return [...m.entries()].map(([geo, films])=>({geo, name:MM.displayCountry(geo), films}))
    .sort((a,b)=>b.films.length - a.films.length || a.name.localeCompare(b.name));
}
// Each book's writer's countries (ISO codes), from Wikidata, cached on the book.
async function originsOf(films){
  const need = films.filter(f=>!f.made);
  // Books known only by title and author (the starter shelf, older pins): find their Open Library record first.
  await MM.pool(need.filter(f=>!f.qid && !f.ol), 3, async f=>{ const m = await MM.matchBook(f).catch(()=>null); if(m){ f.ol = m.ol; if(m.qid) f.qid = m.qid; } });
  const noQid = need.filter(f=>!f.qid && f.ol);
  if(noQid.length){ const q = await MM.qidsForWorks(noQid.map(f=>f.ol)).catch(()=>({})); noQid.forEach(f=>{ if(q[f.ol]) f.qid = q[f.ol]; }); }
  const ac = await MM.authorCountries(need.map(f=>f.qid).filter(Boolean)).catch(()=>({}));
  // Books whose Wikidata entry gave no writer: look the writer up by name instead.
  const noWriter = need.filter(f=>!(f.qid && ac[f.qid] && ac[f.qid].length));
  const byName = noWriter.length ? await MM.writerCountriesByName(noWriter.map(f=>f.a)).catch(()=>({})) : {};
  need.forEach(f=>{
    const names = (f.qid && ac[f.qid] && ac[f.qid].length) ? ac[f.qid] : (byName[String(f.a || "").split(" & ")[0].trim()] || []);
    f.made = [...new Set(names.map(n=>MM.isoFor(MM.geoName(n))).filter(Boolean))];
  });
}
const madeLine = f => f.made && f.made.length ? "By a writer from " + f.made.slice(0, 2).map(regionName).join(" and ") + (f.made.length > 2 ? " and elsewhere" : "") : "Where the writer is from isn't on record";
function filmRows(list){
  return list.map((f,i)=>`<li><button type="button" data-i="${i}"><span class="th" data-i="${i}" style="--c:${cloth(f)}"></span><span style="min-width:0"><b>${esc(f.t)}</b><span class="meta">${esc([f.a.split(" & ")[0], f.p && f.p !== f.c ? f.p : "", f._away ? madeLine(f) : ""].filter(Boolean).join(" · "))}</span></span><span class="r"><em>${esc(f.y)}</em></span></button></li>`).join("");
}
async function openCountry(geo){
  const films = viewing.films.filter(f=>geoOf(f) === geo);
  if(!films.length) return;
  const name = MM.displayCountry(geo);
  showPanel("country"); closeDetail();
  const el = $("#country");
  const head = `<button type="button" class="back" id="cback">← ${viewing.mine ? "Your reading log" : "Reading log"}</button>
    <small class="k">Country</small><h2 class="h" style="margin-top:2px">${esc(name)}</h2>
    <p class="hint">${films.length} book${films.length===1?"":"s"} set here${viewing.owner && !viewing.mine ? " on this map" : ""}.</p>`;
  el.innerHTML = head + `<p class="hint busy">Checking where each writer is from…</p>`;
  const bind = ()=>{ $("#cback").onclick = ()=>{ showPanel("map"); }; };
  bind();
  if(window.innerWidth <= 860) $("#view-country").scrollIntoView({behavior:"smooth", block:"start"});
  await originsOf(films);
  if($("#view-country").hidden) return;
  const iso = MM.isoFor(geo) || MM.isoFor(name);
  const home = films.filter(f=>iso && (f.made || []).includes(iso));
  const away = films.filter(f=>!home.includes(f)).map(f=>Object.assign(f, {_away:true}));
  home.forEach(f=>f._away = false);
  el.innerHTML = head + `
    <h3 class="csec">By writers from ${esc(name)} <span>${home.length}</span></h3>
    ${home.length ? `<ul class="cfilms">${filmRows(home)}</ul>` : `<p class="hint">None yet: everything here was written by someone from elsewhere.</p>`}
    <h3 class="csec">Set in ${esc(name)}, by writers from elsewhere <span>${away.length}</span></h3>
    ${away.length ? `<ul class="cfilms away">${filmRows(away)}</ul>` : `<p class="hint">None: every book set here is by a writer from here.</p>`}`;
  bind();
  el.querySelectorAll("ul.cfilms").forEach((ul, k)=>{ const list = k === 0 && home.length ? home : away; ul.querySelectorAll("button").forEach(b=>b.onclick = ()=>openBook(list[+b.dataset.i], true)); lazyCovers(ul, th=>list[+th.dataset.i], "M"); });
}

/* ---------- Other worlds: the fantasy map (js/worlds.js) ---------- */
let worldView = false, worldSel = "", worldQuery = "", worldFocus = "";
function worldBooks(){ return filtered().filter(MM.inOtherWorld); }
function paintWorldTog(){
  const t = $(".worldtog"); if(!t) return;
  const n = worldBooks().length;
  t.hidden = !n || !!(viewing.owner && viewing.owner.welcome);
  if(!n && worldView) setWorld(false);
  $("#wcount").textContent = n ? n : "";
  t.querySelectorAll("button").forEach(b=>b.setAttribute("aria-pressed", String((b.dataset.w === "worlds") === worldView)));
}
function setWorld(on){
  worldView = !!on;
  $(".mapwrap").classList.toggle("worldview", worldView);
  $("#worlds").hidden = !worldView;
  $("#wsearch").hidden = !worldView;
  if(!worldView){ worldSel = ""; worldQuery = ""; worldFocus = ""; $("#wq").value = ""; $("#wres").hidden = true; if(map) map.resize(); }
  paintWorldTog(); renderWorlds();
}
function renderWorlds(){
  paintWorldTog();
  if(!worldView) return;
  const side = $(".mapside"), wrap = $(".mapwrap");
  if(side && wrap) $("#wsearch").style.top = Math.round(side.getBoundingClientRect().bottom - wrap.getBoundingClientRect().top + 8) + "px";
  MM.renderWorlds($("#worlds"), worldBooks(), {selected, world:worldSel, icon:ICON, query:worldQuery, focus:worldFocus,
    onBook: f=>openBook(f, false),
    onWorld: w=>openWorld(w)});
}
// Tapping an island lists that world's books in the card.
function openWorld(w){
  worldSel = w.name; selected = null; openToken++;
  const prof = MM.worldProfile(w.name, w.books);
  detail.innerHTML = `<div class="whead"><small>Other worlds</small><h3>${esc(w.name)}</h3><p>${w.books.length} book${w.books.length===1?"":"s"}</p><button class="x" aria-label="Close">×</button></div>
    ${prof.desc ? `<p class="wdesc">${esc(prof.desc)}</p>` : ""}
    <div class="body"><ul class="wlist">${w.books.map((f,i)=>`<li><button type="button" data-i="${i}"><b>${esc(f.t)}</b><span>${esc(f.a)}${f.p && f.p !== w.name ? " · " + esc(f.p) : ""}</span></button></li>`).join("")}</ul></div>`;
  detail.hidden = false;
  detail.querySelector(".x").onclick = ()=>{ worldSel = ""; closeDetail(); };
  detail.querySelectorAll(".wlist button").forEach(b=>b.onclick = ()=>openBook(w.books[+b.dataset.i], false));
  renderWorlds();
}
// Search on the Other worlds map: worlds, places within them, book titles and authors. Results list under the
// box; the map fades whatever doesn't match while you type.
function worldSearchResults(q){
  const fold = x => String(x || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  q = fold(q).trim(); if(!q) return [];
  const books = worldBooks(), byW = new Map();
  books.forEach(f=>{ const n = MM.worldName(f.w); if(!byW.has(n)) byW.set(n, []); byW.get(n).push(f); });
  const out = [], places = new Set();
  byW.forEach((list, name)=>{
    const prof = MM.worldProfile(name, list);
    if(fold(name).includes(q) || fold(prof.desc).includes(q)) out.push({kind:"world", name, list, label:name, sub:`World · ${list.length} book${list.length===1?"":"s"}`});
  });
  books.forEach(f=>{ const n = MM.worldName(f.w); if(f.p && fold(f.p).includes(q) && !places.has(n + "|" + f.p)){ places.add(n + "|" + f.p); out.push({kind:"place", name:n, list:byW.get(n).filter(x=>x.p === f.p), label:f.p, sub:`Place in ${n}`}); } });
  books.forEach(f=>{ if(fold(f.t).includes(q) || fold(f.a).includes(q)) out.push({kind:"book", name:MM.worldName(f.w), f, label:f.t, sub:`${f.a || ""} · ${MM.worldName(f.w)}`}); });
  return out.slice(0, 12);
}
function paintWorldResults(){
  const ul = $("#wres"), res = worldSearchResults(worldQuery);
  if(!worldQuery.trim()){ ul.hidden = true; ul.innerHTML = ""; return; }
  ul.hidden = false;
  ul.innerHTML = res.length ? res.map((r,i)=>`<li><button type="button" data-i="${i}"><b>${esc(r.label)}</b><span>${esc(r.sub)}</span></button></li>`).join("")
    : `<li class="none">Nothing in other worlds matches “${esc(worldQuery.trim())}”.</li>`;
  ul.querySelectorAll("button").forEach(b=>b.onclick = ()=>{
    const r = res[+b.dataset.i];
    ul.hidden = true; worldFocus = r.name;
    if(r.kind === "book" || (r.kind === "place" && r.list.length === 1)) openBook(r.f || r.list[0], false);
    else { const books = worldBooks().filter(f=>MM.worldName(f.w) === r.name); openWorld({name:r.name, books}); }
  });
}
(function(){
  const q = $("#wq"); if(!q) return;
  q.oninput = ()=>{ worldQuery = q.value; worldFocus = ""; paintWorldResults(); renderWorlds(); };
  q.onkeydown = e=>{
    if(e.key === "Escape"){ q.value = ""; worldQuery = ""; paintWorldResults(); renderWorlds(); }
    if(e.key === "Enter"){ const b = $("#wres button"); if(b){ e.preventDefault(); b.click(); } }
    if(e.key === "ArrowDown"){ const b = $("#wres button"); if(b){ e.preventDefault(); b.focus(); } }
  };
  $("#wres").onkeydown = e=>{
    const items = [...document.querySelectorAll("#wres button")], i = items.indexOf(document.activeElement);
    if(e.key === "ArrowDown" && i >= 0){ e.preventDefault(); (items[i + 1] || items[i]).focus(); }
    if(e.key === "ArrowUp" && i >= 0){ e.preventDefault(); (items[i - 1] || q).focus(); }
    if(e.key === "Escape"){ q.focus(); $("#wres").hidden = true; }
  };
  q.onfocus = ()=>{ if(worldQuery.trim()) paintWorldResults(); };
})();
window.addEventListener("resize", ()=>{ if(worldView) renderWorlds(); });
document.querySelectorAll(".worldtog button").forEach(b=>b.onclick = ()=>{ closeDetail(); setView("map"); setWorld(b.dataset.w === "worlds"); });

// Map, List and Stats: three ways to look at the same books.
let mapView = "map", listQuery = "";
function setView(v){
  // List and Stats are views of the Earth map: leaving for them closes Other worlds, its search box and card.
  if(v !== "map" && typeof worldView !== "undefined" && worldView){ closeDetail(); setWorld(false); }
  mapView = v;
  document.querySelectorAll(".viewtog button").forEach(b=>b.setAttribute("aria-pressed", String(b.dataset.v === v)));
  $(".mapwrap").classList.toggle("listing", v !== "map");
  $("#clist").hidden = v === "map";
  if(v === "map"){ if(map) map.resize(); } else renderCountryList(true);
}
document.querySelectorAll(".viewtog button").forEach(b=>b.onclick = ()=>setView(b.dataset.v));
function renderCountryList(fresh){
  if(mapView === "list") return renderList2(fresh);
  if(mapView === "stats") return renderStats();
}
// The list view: countries A to Z, with a search box.
// It's kept between switches to Map and back: redrawn only when the books, the filter or the search change.
let listSig = "";
function renderList2(fresh){
  const el = $("#clist");
  const built = el.querySelector("#csearch") && el.querySelector("#cgroups");
  if(!built){
    el.innerHTML = `<div class="clist-in"><div class="clist-top"><p class="k" id="ccount"></p>
      <input id="csearch" type="search" placeholder="Find a country" aria-label="Find a country" autocomplete="off" value="${esc(listQuery)}"></div><div id="cgroups"></div></div>`;
    $("#csearch").oninput = e=>{ listQuery = e.target.value; renderList2(false); };
  }
  const all = countryGroups(filtered()).sort((a,b)=>a.name.localeCompare(b.name));
  const q = MM.norm(listQuery);
  const groups = q ? all.filter(g=>MM.norm(g.name).includes(q)) : all;
  const sig = q + "|" + groups.map(g=>g.name + ":" + g.films.map(f=>MM.bookKey(f) + (f.coverId || "")).join(",")).join(";")
    + "|" + worldBooks().map(f=>MM.bookKey(f) + f.w).join(",");
  if(built && sig === listSig) return;
  listSig = sig;
  const total = all.reduce((n,g)=>n + g.films.length, 0);
  $("#ccount").textContent = `${all.length} countr${all.length===1?"y":"ies"} · ${total} book${total===1?"":"s"}`;
  const box = $("#cgroups");
  box.innerHTML = groups.length ? groups.map((g,i)=>`<section>
      <button type="button" class="chead" data-g="${i}"><b>${esc(g.name)}</b><span>${g.films.length}</span></button>
      <ul class="cposters">${g.films.map((f,j)=>`<li><button type="button" data-g="${i}" data-f="${j}" title="${esc(f.t)}${f.a ? " by " + esc(f.a) : ""}"><span class="th" data-g="${i}" data-f="${j}" style="--c:${cloth(f)}">${esc(f.t)}</span><span class="t">${esc(f.t)}</span></button></li>`).join("")}</ul>
    </section>`).join("") + otherWorldsList(q) : (otherWorldsList(q) || `<p class="hint">${all.length ? "No country matches that." : "No books yet."}</p>`);
  box.querySelectorAll(".chead[data-g]").forEach(b=>b.onclick = ()=>openCountry(groups[+b.dataset.g].geo));
  box.querySelectorAll("[data-wf]").forEach(b=>b.onclick = ()=>{ setView("map"); openBook(worldBooks()[+b.dataset.wf], false); });
  box.querySelectorAll(".chead[data-world]").forEach(b=>b.onclick = ()=>{ setView("map"); setWorld(true); });
  box.querySelectorAll(".cposters button").forEach(b=>b.onclick = ()=>openBook(groups[+b.dataset.g].films[+b.dataset.f], false));
  const wb = worldBooks();
  lazyCovers(box, el=>el.dataset.wf != null ? wb[+el.dataset.wf] : groups[+el.dataset.g].films[+el.dataset.f], "M");
}
// The list view's last section: books in invented worlds, by world.
function otherWorldsList(q){
  const wb = worldBooks(); if(!wb.length) return "";
  const byW = new Map(); wb.forEach((f,i)=>{ const n = MM.worldName(f.w); if(!byW.has(n)) byW.set(n, []); byW.get(n).push(i); });
  const rows = [...byW.entries()].filter(([n])=>!q || MM.norm(n).includes(q) || MM.norm("other worlds").includes(q)).sort((a,b)=>a[0].localeCompare(b[0]));
  if(!rows.length) return "";
  return `<h3 class="csec" style="margin-top:22px">Other worlds <span>${wb.length} book${wb.length===1?"":"s"}</span></h3>` + rows.map(([n, idx])=>`<section>
      <button type="button" class="chead" data-world="${esc(n)}"><b>${esc(n)}</b><span>${idx.length}</span></button>
      <ul class="cposters">${idx.map(i=>{ const f = wb[i]; return `<li><button type="button" data-wf="${i}" title="${esc(f.t)}"><span class="th" data-wf="${i}" style="--c:${cloth(f)}"></span><span class="t">${esc(f.t)}</span></button></li>`; }).join("")}</ul>
    </section>`).join("");
}
// The stats view.
let statsToken = 0;
async function renderStats(){
  const el = $("#clist"), token = ++statsToken;
  const films = filtered(), n = films.length;
  if(!n){ el.innerHTML = `<div class="clist-in"><p class="hint">No books yet.</p></div>`; return; }
  const pct = x => Math.round(x * 100 / n);
  const groups = countryGroups(films);
  const conts = new Map(); films.forEach(f=>{ const c = contOf(f); if(c) conts.set(c, (conts.get(c) || 0) + 1); });
  const decades = new Map(); films.forEach(f=>{ const y = +f.y; if(y) { const d = Math.floor(y / 10) * 10; decades.set(d, (decades.get(d) || 0) + 1); } });
  const places = new Map(); films.forEach(f=>{ if(f.p && f.p !== f.c && !f.ap){ places.set(f.p, (places.get(f.p) || 0) + 1); } });
  const topPlace = [...places.entries()].sort((a,b)=>b[1] - a[1])[0];
  const pages = films.reduce((s,f)=>s + (+f.pages || 0), 0);
  const rated = groups.map(g=>({name:g.name, geo:g.geo, rs:g.films.map(f=>+f.r).filter(Boolean)})).filter(g=>g.rs.length >= 2)
    .map(g=>({...g, avg:g.rs.reduce((a,b)=>a + b, 0) / g.rs.length})).sort((a,b)=>b.avg - a.avg).slice(0, 5);
  const bars = (rows, max) => `<ul class="bars">${rows.map(r=>`<li${r.geo ? ` data-geo="${esc(r.geo)}"` : ""}><span class="bl">${esc(r.label)}</span><span class="bt"><i style="width:${Math.max(2, r.v * 100 / max)}%"></i></span><span class="bv">${esc(r.text)}</span></li>`).join("")}</ul>`;
  const top = groups.slice(0, 10), rest = groups.slice(10).reduce((s,g)=>s + g.films.length, 0);
  const ctryRows = top.map(g=>({label:g.name, geo:g.geo, v:g.films.length, text:pct(g.films.length) + "%"}));
  if(rest) ctryRows.push({label:`${groups.length - 10} other countries`, v:rest, text:pct(rest) + "%"});
  const contRows = [...conts.entries()].sort((a,b)=>b[1] - a[1]).map(([c,v])=>({label:c, v, text:pct(v) + "%"}));
  const decRows = [...decades.entries()].sort((a,b)=>a[0] - b[0]).map(([d,v])=>({label:d < 0 ? Math.abs(d) + "s BC" : d + "s", v, text:String(v)}));
  el.innerHTML = `<div class="clist-in statsview">
    <div class="bignums">
      <div><b>${groups.length}</b><span>countries, ${Math.round(groups.length * 100 / 195)}% of the world</span></div>
      <div><b>${conts.size}</b><span>continent${conts.size===1?"":"s"}</span></div>
      ${films.some(MM.inOtherWorld) ? `<div><b>${new Set(films.filter(MM.inOtherWorld).map(f=>MM.worldName(f.w))).size}</b><span>other worlds, ${films.filter(MM.inOtherWorld).length} books</span></div>` : ""}
      <div><b id="st-home">–</b><span>by a writer from the country they're set in</span></div>
      ${topPlace && topPlace[1] >= 2 ? `<div><b>${esc(topPlace[0])}</b><span>most-visited place, ${topPlace[1]} books</span></div>`
        : pages ? `<div><b>${pages.toLocaleString()}</b><span>pages read</span></div>`
        : `<div><b>${esc(groups[0].name)}</b><span>top country, ${pct(groups[0].films.length)}% of books</span></div>`}
    </div>
    <h3 class="csec">Where your books are set <span>% of ${n}</span></h3>${bars(ctryRows, Math.max(top[0].films.length, rest))}
    ${contRows.length ? `<h3 class="csec">By continent</h3>${bars(contRows, contRows[0].v)}` : ""}
    ${decRows.length ? `<h3 class="csec">By decade published</h3>${bars(decRows, Math.max(...decRows.map(r=>r.v)))}` : ""}
    ${rated.length ? `<h3 class="csec">Best-rated countries <span>2+ rated books</span></h3>${bars(rated.map(r=>({label:r.name, geo:r.geo, v:r.avg, text:"★ " + r.avg.toFixed(1)})), 5)}` : ""}
    <h3 class="csec">Where the writers are from <span id="st-madeh"></span></h3><div id="st-made"><p class="hint busy">Checking where each writer is from…</p></div>
  </div>`;
  el.querySelectorAll(".bars li[data-geo]").forEach(li=>{ li.tabIndex = 0; li.onclick = ()=>openCountry(li.dataset.geo); li.onkeydown = e=>{ if(e.key === "Enter") openCountry(li.dataset.geo); }; });
  await originsOf(films);
  if(token !== statsToken || mapView !== "stats") return;
  const known = films.filter(f=>f.made && f.made.length);
  const home = known.filter(f=>{ const iso = MM.isoFor(geoOf(f)) || MM.isoFor(f.c); return iso && f.made.includes(iso); });
  $("#st-home").textContent = known.length ? Math.round(home.length * 100 / known.length) + "%" : "–";
  const makers = new Map(); known.forEach(f=>{ const c = f.made[0]; makers.set(c, (makers.get(c) || 0) + 1); });
  const mk = [...makers.entries()].sort((a,b)=>b[1] - a[1]).slice(0, 8);
  $("#st-madeh").textContent = `writer's country, % of ${known.length}`;
  $("#st-made").innerHTML = mk.length ? bars(mk.map(([c,v])=>({label:regionName(c), v, text:Math.round(v * 100 / known.length) + "%"})), mk[0][1]) : `<p class="hint">Not on record.</p>`;
}

/* ================= rail views ================= */
function showPanel(id){
  ["map","welcome","explore","log","import","account","country"].forEach(v=>$("#view-"+v).hidden = v !== id);
}
function setNav(name){ document.querySelectorAll(".nav a, .acct").forEach(a=>a.setAttribute("aria-current", a.dataset.nav === name ? "page" : "false")); }
function paintAccountLink(){ $("#acct-link").textContent = me ? "@" + me.username : (sb ? "Sign in" : "Account"); }

/* ---------- log a book: search Open Library, pick the right one, we find the setting ---------- */
let draft = null, draftRating = null, searchT = null, searchSeq = 0;
// Logging and Goodreads need an account: signed-out visitors get this instead.
function needAccount(el, title, what){
  el.innerHTML = `<h2 class="h">${esc(title)}</h2>
    <p class="hint" style="margin:0;font-size:15px;color:var(--ink)">Create a free account to ${what}. Your map is saved to your account, so it's there on any device and friends can follow it.</p>
    <div class="cta"><a class="btn" href="#/account/up">Create an account</a><a class="btn ghost" href="#/account/in">Sign in</a></div>`;
}
function renderLog(){
  const el = $("#log");
  if(signedOut()) return needAccount(el, "Log a book", "start logging books");
  showMine_keepView();
  el.innerHTML = `<h2 class="h">Log a book</h2>
    <div class="search"><label for="lq" class="sr">Book title or author</label><input id="lq" type="search" autocomplete="off" placeholder="Search a title or author, e.g. Pedro Páramo"></div>
    <p class="hint" id="ls">Start typing and pick the right book. We'll work out where it takes place.</p>
    <ul class="results" id="lr"></ul>
    <div id="lc" hidden></div>
    ${!cloud() ? `<p class="notice">${me ? "Books save in this browser for now." : sb ? 'You\'re not signed in, so books save in this browser only. <a href="#/account">Sign in</a> to keep them on your account.' : "Books save in this browser."}</p>` : ""}`;
  const q = $("#lq");
  q.addEventListener("input", ()=>{ clearTimeout(searchT); searchT = setTimeout(()=>runSearch(q.value.trim()), 350); });
  q.focus({preventScroll:true});
  if(pendingLog){ const p = pendingLog; pendingLog = null; q.value = p.t; chooseBook(p); }
}
async function runSearch(text){
  const seq = ++searchSeq, st = $("#ls"), ul = $("#lr");
  if(!st) return;
  $("#lc").hidden = true;
  if(text.length < 2){ ul.innerHTML = ""; st.textContent = "Start typing and pick the right book."; st.classList.remove("busy"); return; }
  st.textContent = "Searching…"; st.classList.add("busy");
  try{
    const res = await MM.searchBooks(text);
    if(seq !== searchSeq) return;
    st.classList.remove("busy");
    if(!res.length){ ul.innerHTML = ""; st.textContent = `No books found for "${text}". Check the spelling, or add the author.`; return; }
    st.textContent = "Pick the one you read.";
    ul.innerHTML = res.map((m,i)=>`<li><button data-i="${i}"><span class="th" style="--c:${cloth(m)};${m.coverId ? `background-image:url('${MM.coverURL(m,"S")}')` : ""}"></span><span style="min-width:0"><b>${esc(m.t)} <span class="m">${esc(m.y)}</span></b><span class="m">${esc(m.a)}</span>${onMyMap(m) ? '<br><span class="have">On your map</span>' : ""}</span></button></li>`).join("");
    ul.querySelectorAll("button").forEach(b=>b.onclick = ()=>chooseBook(res[+b.dataset.i]));
  }catch(e){
    if(seq !== searchSeq) return;
    st.classList.remove("busy");
    st.textContent = "Search didn't go through. Check your connection and try again.";
  }
}
async function chooseBook(m){
  const st = $("#ls"); $("#lr").innerHTML = "";
  st.textContent = `Finding where ${m.t} takes place…`; st.classList.add("busy");
  try{
    // A book from a Goodreads list or a suggestion may not have its Open Library record yet.
    let det = m.ol ? m : (await MM.matchBook(m).catch(()=>null));
    det = det ? Object.assign({}, det, {t:m.t || det.t, a:m.a || det.a, gr:m.gr, isbn:m.isbn || det.isbn}) : Object.assign({}, m);
    const [s] = await MM.resolveSettings([det]);
    st.classList.remove("busy");
    draft = Object.assign({t:det.t, a:det.a || "", y:det.y || "", s:m.s || "", ol:det.ol || "", qid:det.qid || "", isbn:det.isbn || "", gr:det.gr || "", coverId:det.coverId || null, pages:det.pages || null},
      s || {p:"", c:"", lat:NaN, lon:NaN, ap:1, n:"", src:""});
    draft.read = m.read || new Date().toISOString().slice(0,10);
    draftRating = m.r || null;
    st.textContent = s ? "Check the setting, rate it, then pin it." : "We couldn't find where this one is set. Tap Place pin on the map, then tap where it takes place.";
    renderConfirm();
    if(Number.isFinite(draft.lat)){ preview = {lat:draft.lat, lon:draft.lon}; renderPins(); flyTo(draft); }
  }catch(e){
    st.classList.remove("busy"); st.textContent = "Couldn't load that book. Try again.";
  }
}
function renderConfirm(){
  const f = draft, el = $("#lc"); el.hidden = false;
  const placed = Number.isFinite(f.lat);
  const have = onMyMap(f);
  const cover = MM.coverURL(f, "M");
  el.innerHTML = `<div class="box" style="background:var(--card)">
    <div style="display:grid;grid-template-columns:72px minmax(0,1fr);gap:12px;align-items:start">
      <div style="width:72px">${coverSlot(f, cover)}</div>
      <div style="min-width:0"><b class="sub" style="display:block;font-size:22px;line-height:1.05">${esc(f.t)}</b><span class="hint" style="font-style:italic">${esc(byLine(f))}</span></div>
    </div>
    ${placed ? `<div><b>${esc(placeLine(f))}</b><div class="hint" style="font-family:var(--f-mono);font-size:12px">${fmtCoord(f.lat,f.lon)}${f.ap ? " · approximate" : ""}</div></div>` : ""}
    ${f.n ? `<p class="hint">${esc(f.n)}</p>` : ""}
    <button type="button" class="linkbtn" id="c-move">${placed ? "Pin in the wrong place? Move it" : "Place pin on the map"}</button>
    <div><div class="field" style="margin-bottom:2px">Your rating</div><div class="rate" id="c-rate"></div></div>
    <label class="field" for="c-date">Finished on<input type="date" id="c-date" value="${esc(f.read)}"></label>
    ${have ? '<p class="ok">This book is already on your map.</p>' : ""}
    <div class="cta"><button class="btn gold" id="c-pin" ${placed && !have ? "" : "disabled"}>Add to my map</button><button class="btn ghost" id="c-back">Back</button></div>
  </div>`;
  renderRate();
  $("#c-move").onclick = ()=>startPicking(pt=>{
    if(pt.country && pt.country !== draft.c){ draft.c = pt.country; draft.p = pt.country; draft.n = ""; draft.cont = ""; }
    Object.assign(draft, {lat:pt.lat, lon:pt.lon, ap:0, src:"user"});
    preview = {lat:pt.lat, lon:pt.lon}; renderConfirm(); renderPins();
  });
  $("#c-back").onclick = ()=>{ draft = null; preview = null; el.hidden = true; renderPins(); $("#lq").focus(); };
  $("#c-date").onchange = e=>draft.read = e.target.value;
  $("#c-pin").onclick = async ()=>{
    const f = Object.assign({}, draft); if(draftRating) f.r = draftRating;
    $("#c-pin").disabled = true;
    try{
      await Store.add([f]); await reloadMine(); warmSummaries([f]);
      draft = null; preview = null; toast("Pinned " + f.t);
      location.hash = "#/";
      setTimeout(()=>{ const g = myBooks.find(x=>MM.bookKey(x)===MM.bookKey(f)); if(g) openBook(g, true); }, 700);
    }catch(e){ $("#c-pin").disabled = false; toast(e.message && e.message.includes("storage") ? e.message : "Couldn't save it. Try again."); }
  };
}
// Whole stars, as on Goodreads.
function renderRate(){
  const el = $("#c-rate"); if(!el) return;
  el.innerHTML = [1,2,3,4,5].map(n=>`<button type="button" data-n="${n}" class="${draftRating && draftRating >= n ? "on" : ""}" aria-label="${n} star${n===1?"":"s"}">★</button>`).join("")
    + `<button type="button" class="clear" data-n="0">${draftRating ? stars(draftRating) + " · clear" : "No rating"}</button>`;
  el.querySelectorAll("button").forEach(b=>b.onclick = ()=>{ const n = +b.dataset.n; draftRating = n || null; renderRate(); });
}
function showMine_keepView(){ if(!viewing.mine) showMine(); }

/* ---------- Goodreads: link a profile, read the whole Read shelf ---------- */
const GR_SYNC_EVERY = 6*60*60*1000;   // check for new books at most every 6 hours per browser
const grSyncKey = () => "bm-gr-sync:" + (me ? me.id : "local");
const grReportKey = () => "bm-gr-report:" + (me ? me.id : "local");
const GR_LOCAL = "bm-gr-local";        // the linked profile, for someone without an account
let pendingLog = null;   // a skipped Goodreads book waiting to be pinned by hand
// The linked Goodreads profile: on the account when there is one, else in this browser.
function grLinked(){
  if(cloud() && me.goodreads_id) return {id:me.goodreads_id, name:me.goodreads_name || ""};
  if(!cloud()) return MM.lsGet(GR_LOCAL, null);
  return null;
}
async function setGrLinked(link){
  if(cloud()){
    const {error} = await sb.from("profiles").update({goodreads_id:link ? link.id : null, goodreads_name:link ? (link.name || "").slice(0, 80) || null : null}).eq("id", me.id);
    if(error) throw error;
    me.goodreads_id = link ? link.id : null; me.goodreads_name = link ? link.name : null;
  } else MM.lsSet(GR_LOCAL, link);
}

// Turn Goodreads entries into map-ready books: find each one on Open Library, then where it's set.
async function placeEntries(entries, progress){
  let done = 0;
  // Books another reader already matched need no lookup at all.
  if(MM.remoteMatches) await MM.remoteMatches(entries.map(MM.bookKey)).catch(()=>{});
  const busy = [];
  const found = await MM.pool(entries, 2, async (e, i)=>{
    const m = await MM.matchBook(e).catch(err=>{ if(/ol-busy/.test(err && err.message)) busy.push(i); return null; });
    done++; progress && progress(done, entries.length);
    return m;
  });
  // If Open Library was too busy for some, wait a little and try those again before giving up for now.
  // Anything still unfinished isn't remembered as missing, so the next sync picks it up.
  if(busy.length){
    await MM.sleep(20000);
    for(const i of busy) found[i] = await MM.matchBook(entries[i]).catch(()=>null);
  }
  // Goodreads' own title and author are kept, so the book is recognised on the next sync.
  const dets = entries.map((e,i)=>Object.assign({}, found[i] || {}, {t:e.t, a:e.a || (found[i] && found[i].a) || "", y:(found[i] && found[i].y) || e.y || "", isbn:e.isbn || "", isbn13:e.isbn13 || ""}));
  const settings = await MM.resolveSettings(dets);
  const ready = [], missed = [];
  entries.forEach((e,i)=>{
    const d = dets[i], s = settings[i];
    const book = {t:e.t, s:e.s || "", a:d.a, y:d.y, ol:d.ol || "", qid:d.qid || "", isbn:e.isbn13 || e.isbn || "", gr:e.gr || "", coverId:d.coverId || null,
      pages:e.pages || d.pages || null, r:e.r || null, rv:e.rv ? 1 : 0, rc:e.rc || 1, read:e.read || ""};
    if(!s) missed.push(book); else ready.push(Object.assign(book, s));
  });
  return {ready, missed};
}

// Talk to the server function that reads Goodreads for us.
async function grInvoke(body){
  if(!sb) throw new Error("not_deployed");
  const {data, error} = await sb.functions.invoke("goodreads-feed", {body});
  if(error){
    let code = "";
    const status = error.context && error.context.status;
    try{ code = (await error.context.json()).error; }catch(e){}
    throw new Error(code || (status === 404 || error.name === "FunctionsFetchError" ? "not_deployed" : "failed"));
  }
  return data || {};
}
// The Read shelf, newest first, a hundred books a page. all.complete is true once the whole shelf has
// been read, which removals rely on.
const fromGr = b => { const c = MM.cleanTitle(b.title); return {t:c.t, s:c.s, a:b.author || "", gr:b.gid, isbn:b.isbn || "", isbn13:b.isbn13 || "", y:b.year || "", pages:b.pages || null, r:b.rating || null, read:b.read || "", rv:b.reviewed ? 1 : 0}; };
async function fetchGoodreadsShelf(user, maxPages, onPage){
  const all = []; all.complete = false; all.id = ""; all.name = "";
  const seen = new Set();
  for(let page=1; page<=maxPages; page++){
    let d;
    try{ d = await grInvoke({user, page}); }catch(e){ if(page === 1) throw e; break; }
    if(page === 1){ all.id = d.id; all.name = d.name || ""; }
    const fresh = (d.books || []).filter(b=>!seen.has(b.gid));
    fresh.forEach(b=>{ seen.add(b.gid); all.push(fromGr(b)); });
    onPage && onPage(page, all.length);
    if(!fresh.length || !d.more){ all.complete = true; break; }
  }
  return all;
}
const GR_ERRORS = {
  not_found:"Goodreads has no profile with that name or link. Check it, or paste the link from your Goodreads profile page.",
  bad_user:"That doesn't look like a Goodreads profile link or username.",
  private:"That Goodreads profile is private, so its shelves can't be read. Make it public on Goodreads, or import your library export below.",
  not_deployed:"Goodreads linking isn't switched on for this site yet.",
  layout:"Goodreads answered in a way we didn't expect. Try again later, or import your library export below.",
  upstream:"Goodreads didn't answer just now. Try again in a few minutes.",
  unreachable:"Goodreads didn't answer just now. Try again in a few minutes."
};

// Pull books into the map. full: read the whole Read shelf (Connect, weekly). Otherwise the newest page.
let syncing = false;
async function syncGoodreads({quiet=false, full=false, progress=null} = {}){
  const link = grLinked();
  if(syncing || !link) return null;
  syncing = true;
  const say = s => progress && progress(s);
  try{
    say("Reading your Goodreads shelf…");
    const list = await fetchGoodreadsShelf(link.id, full ? 60 : 1, (pg, n)=>say(`Reading your Goodreads shelf… page ${pg} (${n} books)`));
    if(!list.length && full){ say("Your Read shelf on Goodreads is empty."); }
    if(list.name && list.name !== link.name){ try{ await setGrLinked({id:link.id, name:list.name}); }catch(e){} }
    const haveGr = new Set(myBooks.map(b=>b.gr).filter(Boolean)), have = myKeys();
    const todo = list.filter(e=>!(e.gr && haveGr.has(e.gr)) && !have.has(MM.bookKey(e)));
    let added = 0, missed = [];
    // In batches, saving each one, so a big shelf keeps its progress if the page closes.
    for(let i=0; i<todo.length; i+=40){
      const part = todo.slice(i, i+40);
      say(`Finding where your books take place… ${i} of ${todo.length}. Keep this page open.`);
      const r = await placeEntries(part, (d,n)=>say(`Finding where your books take place… ${i + d} of ${todo.length}. Keep this page open.${Date.now() - MM.olBusyAt < 30000 ? " Open Library is busy, so this is going slower; nothing will be skipped." : ""}`));
      added += (await Store.add(r.ready)).added;
      missed.push(...r.missed);
    }
    if(todo.length) await reloadMine();
    // Keep earlier skipped books that are still missing, so the list survives later syncs.
    const prev = (MM.lsGet(grReportKey(), null) || {missed:[]});
    const nowGr = new Set(myBooks.map(b=>b.gr).filter(Boolean)), nowKeys = myKeys();
    const byId = new Map();
    [...prev.missed, ...missed].forEach(m=>{ if(!(m.gr && nowGr.has(m.gr)) && !nowKeys.has(MM.bookKey(m))) byId.set(m.gr || MM.bookKey(m), m); });
    MM.lsSet(grReportKey(), {total: full && list.complete ? list.length : Math.max(prev.total||0, list.length), full: full || !!prev.full, missed:[...byId.values()]});
    MM.lsSet(grSyncKey(), Date.now());
    // Ratings follow Goodreads for every book read; removals only after reading the whole shelf.
    const changes = list.length ? await reconcileGoodreads(list, full && list.complete) : {rated:0, removed:0, held:0};
    if((added || changes.rated || changes.removed) && viewing.mine){ viewing.films = myBooks; renderAll(); if(added || changes.removed) fitPins(true); }
    if(changes.removed || changes.rated) toast([changes.removed ? `Removed ${changes.removed} book${changes.removed===1?"":"s"} you took off your Goodreads shelf` : "", changes.rated ? `updated ${changes.rated} rating${changes.rated===1?"":"s"}` : ""].filter(Boolean).join(", ").replace(/^u/, "U"));
    if(changes.held) toast(`${changes.held} books are missing from your Goodreads shelf, which looks like a reading problem, so none were removed`);
    if(byId.size && (added || !quiet)) toast(`${added ? `Added ${added} from Goodreads. ` : ""}${byId.size} need${byId.size===1?"s":""} a pin: see the Import tab`);
    else if(added) toast(`Added ${added} book${added===1?"":"s"} from Goodreads`);
    else if(!quiet) toast("You're up to date with Goodreads");
    return {added, total:list.length, rated:changes.rated, removed:changes.removed};
  }catch(e){
    if(!quiet) toast(GR_ERRORS[e.message] || "Sync didn't go through. Try again.");
    return {error:e.message};
  }finally{ syncing = false; }
}
// Keep the map in step with Goodreads. Each pin remembers which Goodreads book it came from; pins made
// before that are linked up by title and author the first time. Books added by hand that aren't on
// Goodreads are never touched. If an unusually large share would disappear at once, nothing is removed.
async function reconcileGoodreads(list, complete){
  const byGr = new Map(list.map(e=>[e.gr, e]));
  const byKey = new Map(list.map(e=>[MM.bookKey(e), e]));
  const out = {rated:0, removed:0, held:0};
  const claimed = new Set(myBooks.filter(f=>f.gr).map(f=>f.gr));
  for(const f of myBooks){
    if(f.gr) continue;
    const e = byKey.get(MM.bookKey(f));
    if(!e || claimed.has(e.gr)) continue;
    try{ await Store.update(f, {gr:e.gr}); claimed.add(e.gr); }catch(err){}
  }
  for(const f of myBooks){
    const e = f.gr && byGr.get(f.gr); if(!e) continue;
    const want = e.r || null, have = f.r || null;
    if(want === have) continue;
    try{ await Store.update(f, {r:want}); out.rated++; }catch(err){}
  }
  if(!complete) return out;
  const linked = myBooks.filter(f=>f.gr), gone = linked.filter(f=>!byGr.has(f.gr));
  if(gone.length > Math.max(5, linked.length * 0.3)){ out.held = gone.length; return out; }
  for(const f of gone){ try{ await Store.remove(f); myBooks = myBooks.filter(x=>x!==f); out.removed++; }catch(err){} }
  if(out.removed && viewing.mine) viewing.films = myBooks;
  return out;
}

// Re-check pins that were only the author's country, once better sources may know more. Pins you moved yourself are left alone.
const FIX_VERSION = "bm-fix-v1:";
async function refreshSettings(force){
  if(!cloud()) return;
  const flag = FIX_VERSION + me.id;
  if(!force && MM.lsGet(flag, false)) return;
  const cands = myBooks.filter(f=>f.src === "author").slice(0, 60);
  if(!cands.length){ MM.lsSet(flag, true); return; }
  const dets = await MM.pool(cands, 3, async f=>Object.assign({}, (await MM.matchBook(f).catch(()=>null)) || {}, {t:f.t, a:f.a, qid:f.qid || undefined, ol:f.ol || undefined}));
  const settings = await MM.resolveSettings(dets);
  let changed = 0;
  for(let i=0; i<cands.length; i++){
    const f = cands[i], s = settings[i];
    if(!s || s.src === "author") continue;
    if(Math.abs(s.lat - f.lat) < 0.01 && Math.abs(s.lon - f.lon) < 0.01) continue;
    try{ await Store.update(f, {p:s.p, c:s.c, cont:s.cont||"", lat:s.lat, lon:s.lon, ap:s.ap, n:s.n||"", src:s.src}); changed++; }catch(e){}
  }
  MM.lsSet(flag, true);
  if(changed && viewing.mine){ renderAll(); fitPins(true); toast(`Moved ${changed} pin${changed===1?"":"s"} to a better spot`); }
}
function maybeAutoSync(){
  if(cloud()) refreshSettings(false);
  return;   // Goodreads comes in only through the library export now; profile linking was removed.
  const last = MM.lsGet(grSyncKey(), 0);
  const rep = MM.lsGet(grReportKey(), null);
  // Quick check (newest page) every 6 hours; a full re-read of the whole shelf once a week.
  const lastFull = MM.lsGet(grSyncKey() + ":full", 0);
  const full = !(rep && rep.full) || Date.now() - lastFull > 7*24*60*60*1000;
  if(full || Date.now() - last > GR_SYNC_EVERY) syncGoodreads({quiet:true, full}).then(r=>{ if(full && r && !r.error) MM.lsSet(grSyncKey() + ":full", Date.now()); });
}

/* ---------- Goodreads library export (for private profiles) ---------- */
// Goodreads' export is one CSV: every book on every shelf, with ratings, dates read and read counts.
function parseCSV(text){
  const rows = []; let row = [], cell = "", q = false;
  for(let i=0; i<text.length; i++){
    const ch = text[i];
    if(q){ if(ch === '"'){ if(text[i+1] === '"'){ cell += '"'; i++; } else q = false; } else cell += ch; }
    else if(ch === '"') q = true;
    else if(ch === ","){ row.push(cell); cell = ""; }
    else if(ch === "\n" || ch === "\r"){ if(ch === "\r" && text[i+1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if(cell || row.length){ row.push(cell); rows.push(row); }
  const head = (rows.shift() || []).map(h=>h.replace(/^﻿/, "").trim());
  return rows.filter(r=>r.some(Boolean)).map(r=>Object.fromEntries(head.map((h,i)=>[h, (r[i] || "").trim()])));
}
function readExport(text){
  const rows = parseCSV(text);
  if(!rows.length || !("Title" in rows[0])) return null;
  if("Read Status" in rows[0] && ("Authors" in rows[0] || "Star Rating" in rows[0])) return readStoryGraph(rows);
  if(!("Exclusive Shelf" in rows[0])) return null;
  const day = s => { const m = String(s || "").match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/); return m ? `${m[1]}-${m[2].padStart(2,"0")}-${m[3].padStart(2,"0")}` : ""; };
  const books = rows.filter(r=>r["Exclusive Shelf"] === "read").map(r=>{
    const c = MM.cleanTitle(r.Title);
    return {t:c.t, s:c.s, a:r.Author || "", gr:/^\d+$/.test(r["Book Id"] || "") ? r["Book Id"] : "", isbn:isbnOk(r.ISBN), isbn13:isbnOk(r.ISBN13),
      y:+(r["Original Publication Year"] || r["Year Published"]) || "", pages:+r["Number of Pages"] || null, r:+r["My Rating"] || null,
      read:day(r["Date Read"]) || "", rv:(r["My Review"] || "").trim() ? 1 : 0, rc:Math.max(1, +r["Read Count"] || 1)};
  });
  const lists = rows.filter(r=>r["Exclusive Shelf"] === "to-read" || r["Exclusive Shelf"] === "currently-reading").map(r=>{
    const c = MM.cleanTitle(r.Title);
    return {t:c.t, s:c.s, a:r.Author || "", gr:/^\d+$/.test(r["Book Id"] || "") ? r["Book Id"] : "", isbn:isbnOk(r.ISBN), isbn13:isbnOk(r.ISBN13),
      y:+(r["Original Publication Year"] || r["Year Published"]) || "", shelf:r["Exclusive Shelf"] === "to-read" ? "want" : "reading"};
  });
  return {books, lists, shelved:rows.length, source:"Goodreads"};
}
// The StoryGraph's export (Manage Account → Manage Your Data → Export StoryGraph Library): one CSV with
// Title, Authors, ISBN/UID, Read Status (read / currently-reading / to-read / did-not-finish…), Star Rating
// (can be quarter stars), Last Date Read, Read Count, Review. Mapped onto the same entries as Goodreads.
function readStoryGraph(rows){
  const day = s => { const m = String(s || "").match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/); return m ? `${m[1]}-${m[2].padStart(2,"0")}-${m[3].padStart(2,"0")}` : ""; };
  const status = r => String(r["Read Status"] || "").toLowerCase().trim().replace(/[\s_]+/g, "-");
  const author = r => String(r.Authors || r.Author || "").split(/,| & | and /)[0].trim();
  const isbn = r => { const v = String(r["ISBN/UID"] || r.ISBN || "").replace(/[^0-9Xx]/g, ""); return isbnOk(v); };
  const rating = r => { const v = parseFloat(r["Star Rating"]); return v > 0 ? Math.max(1, Math.min(5, Math.round(v))) : null; };
  const base = r => { const c = MM.cleanTitle(r.Title); const i = isbn(r); return {t:c.t, s:c.s, a:author(r), gr:"", isbn:i && i.length === 10 ? i : "", isbn13:i && i.length === 13 ? i : "", y:""}; };
  const books = rows.filter(r=>status(r) === "read").map(r=>Object.assign(base(r), {
    pages:null, r:rating(r), read:day(r["Last Date Read"]) || day(r["Dates Read"]) || "", rv:(r.Review || "").trim() ? 1 : 0, rc:Math.max(1, +r["Read Count"] || 1)}));
  const lists = rows.filter(r=>["to-read", "currently-reading"].includes(status(r))).map(r=>Object.assign(base(r), {shelf:status(r) === "to-read" ? "want" : "reading"}));
  return {books, lists, shelved:rows.length, source:"The StoryGraph"};
}
// Card summaries are made as soon as books are added (logged, imported, or put on a reading list), a
// couple at a time in the background, so a book's card is ready when it's first opened. There's one
// writer, the book-summary function: the saved summary if there is one, else the book's own Wikipedia
// article (credited), else Claude in its own words. Each book is done once and shared with everyone.
const sumQueue = []; let sumBusy = 0;
function warmSummaries(list){
  (list || []).forEach(b=>{ if(b && b.t) sumQueue.push(b); });
  const next = () => {
    while(sumBusy < 2 && sumQueue.length){
      const b = sumQueue.shift(); sumBusy++;
      MM.bookSummary(b).catch(()=>null).finally(()=>{ sumBusy--; setTimeout(next, 300); });
    }
  };
  next();
}
let importing = false;
async function importGoodreadsExport(file, status, button){
  if(importing) return;
  importing = true; if(button) button.setAttribute("aria-disabled", "true");
  const say = t => { if(status) status.textContent = t; };
  try{
    say("Reading your export…");
    const got = readExport(await file.text());
    if(!got){ say("That file doesn't look like a Goodreads or StoryGraph export. Choose the CSV file Goodreads or The StoryGraph gives you, without changing it."); return; }
    const {books, lists, source} = got;
    // The to-read and currently-reading shelves go on the reading lists (after the map, so books just read come off them).
    const listNote = async () => {
      if(!lists.length || !(sb && session && me)) return "";
      try{
        await syncLists(lists); if(viewing.mine) renderList();
        const n = onList("want").length, c = onList("reading").length;
        return ` Want to read: ${n} book${n===1?"":"s"}; Currently reading: ${c}.`;
      }catch(err){ return " Couldn't update your reading lists this time; try the file again."; }
    };
    const haveGr = new Set(myBooks.map(b=>b.gr).filter(Boolean)), have = myKeys();
    // Books already on the map: bring their ratings and read counts up to date with the export.
    const byKey = new Map(myBooks.map(f=>[MM.bookKey(f), f])), byGr = new Map(myBooks.filter(f=>f.gr).map(f=>[f.gr, f]));
    let updated = 0;
    for(const e of books){
      const f = (e.gr && byGr.get(e.gr)) || byKey.get(MM.bookKey(e)); if(!f) continue;
      const patch = {};
      if(e.r && +f.r !== +e.r) patch.r = e.r;
      if(e.rc > (f.rc || 1)) patch.rc = e.rc;
      if(e.gr && !f.gr) patch.gr = e.gr;
      if(Object.keys(patch).length){ try{ await Store.update(f, patch); updated++; }catch(err){} }
    }
    const todo = books.filter(e=>!(e.gr && haveGr.has(e.gr)) && !have.has(MM.bookKey(e)));
    if(!todo.length){ if(lists.length) say("Updating your reading lists…"); const ln = await listNote(); say(`All ${books.length} books from your Read shelf are already on your map${updated ? `; updated ${updated}` : ""}.${ln}`); if(updated && viewing.mine) renderAll(); return; }
    let added = 0, missed = [];
    for(let i=0; i<todo.length; i+=40){
      const part = todo.slice(i, i+40);
      say(`Finding where your books take place… ${i} of ${todo.length}. Keep this page open.`);
      const r = await placeEntries(part, (d)=>say(`Finding where your books take place… ${i + d} of ${todo.length}. Keep this page open.${Date.now() - MM.olBusyAt < 30000 ? " Open Library is busy, so this is going slower; nothing will be skipped." : ""}`));
      added += (await Store.add(r.ready)).added;
      missed.push(...r.missed);
      warmSummaries(r.ready);
      // Show progress as it happens: the new books on the map, and the box's counts.
      await reloadMine();
      const sofar = MM.lsGet(grReportKey(), null) || {missed:[], total:0};
      const seen = new Map(); [...sofar.missed, ...r.missed].forEach(m=>seen.set(m.gr || MM.bookKey(m), m));
      MM.lsSet(grReportKey(), {total:Math.max(sofar.total || 0, books.length), full:true, missed:[...seen.values()]});
      if(viewing.mine){ viewing.films = myBooks; renderAll(); }
      renderImportReport();
    }
    const ln = await listNote();
    const prev = MM.lsGet(grReportKey(), null) || {missed:[], total:0};
    const byId = new Map(); [...prev.missed, ...missed].forEach(m=>byId.set(m.gr || MM.bookKey(m), m));
    MM.lsSet(grReportKey(), {total:Math.max(prev.total || 0, books.length), full:true, missed:[...byId.values()]});
    if(viewing.mine){ viewing.films = myBooks; renderAll(); fitPins(true); }
    toast(`Added ${added} book${added===1?"":"s"} from your ${source} export`);
    renderImport();
    const s2 = $("#grcs"); if(s2) s2.textContent = `Done: ${added} added${missed.length ? `, ${missed.length} need${missed.length===1?"s":""} a pin (listed above)` : ""}.${ln}`;
  }catch(e){ say("Couldn't read that file. Try the CSV exactly as Goodreads or The StoryGraph sent it."); }
  finally{ importing = false; if(button) button.removeAttribute("aria-disabled"); }
}

let importFrom = MM.lsGet("bm-import-from", "goodreads");
function renderImport(){
  const el = $("#import");
  if(signedOut()) return needAccount(el, "Import", "import your books from Goodreads or The StoryGraph");
  showMine_keepView();
  const gr = importFrom !== "storygraph";
  el.innerHTML = `<h2 class="h">Import your books</h2>
    <p class="hint">Bring in every book you've read, with your ratings and dates read, from Goodreads or The StoryGraph. Both let you export your whole library as one file, whether your profile is public or private.</p>
    <div class="seg isrc" role="group" aria-label="Import from"><button type="button" data-src="goodreads" aria-pressed="${gr}">Goodreads</button><button type="button" data-src="storygraph" aria-pressed="${!gr}">The StoryGraph</button></div>
    ${gr ? `<figure class="howvid">
      <video src="media/goodreads-export.mp4" poster="media/goodreads-export.jpg" controls muted playsinline preload="none" aria-label="Screen recording: on Goodreads, open My Books, then Import and export, press Export Library, then download the file"></video>
      <figcaption>On Goodreads: <b>My Books</b> → <b>Import and export</b> (left, under Tools) → <b>Export Library</b>. When the link to your file appears under the button, click it to download.</figcaption>
    </figure>
    <ol class="howto">
      <li><span class="n">1</span><span class="tx"><a href="https://www.goodreads.com/review/import" target="_blank" rel="noopener">Export your library on Goodreads ↗</a><span>My Books → Import and export → Export Library</span></span></li>
      <li><span class="n">2</span><span class="tx"><b>Download the file Goodreads makes</b><span>It's called goodreads_library_export.csv</span></span></li>
      <li><span class="n">3</span><span class="tx"><b>Bring it in here</b><span>Your books are placed on your map</span></span><label class="btn small" for="grcsv" tabindex="0">Choose the file</label><input type="file" id="grcsv" accept=".csv,text/csv" hidden></li>
    </ol>` : `<ol class="howto">
      <li><span class="n">1</span><span class="tx"><a href="https://app.thestorygraph.com/" target="_blank" rel="noopener">Export your library on The StoryGraph ↗</a><span>Your profile picture → Manage Account → Manage Your Data → Export StoryGraph Library, then Generate export</span></span></li>
      <li><span class="n">2</span><span class="tx"><b>Download the file when it's ready</b><span>It can take a few minutes; the CSV appears on the same page</span></span></li>
      <li><span class="n">3</span><span class="tx"><b>Bring it in here</b><span>Your books are placed on your map</span></span><label class="btn small" for="grcsv" tabindex="0">Choose the file</label><input type="file" id="grcsv" accept=".csv,text/csv" hidden></li>
    </ol>`}
    <p class="hint" id="grcs" aria-live="polite"></p>
    <p class="hint">Read more books since? Export again and import the new file: books already on your map are skipped. Books marked read go on your map; to-read and currently-reading go on your reading lists.</p>
    <div id="grrep" aria-live="polite"></div>
    ${!cloud() ? `<p class="notice">${me ? "Books save in this browser for now." : '<a href="#/account">Sign in</a> to keep your books on your account.'}</p>` : ""}`;
  el.querySelectorAll(".isrc button").forEach(b=>b.onclick = ()=>{ importFrom = b.dataset.src; MM.lsSet("bm-import-from", importFrom); renderImport(); });
  renderImportReport();
  const csv = $("#grcsv"), cl = el.querySelector('label[for="grcsv"]');
  if(cl) cl.onkeydown = e=>{ if(e.key === "Enter" || e.key === " "){ e.preventDefault(); csv.click(); } };
  if(csv) csv.onchange = ()=>{ if(csv.files.length) importGoodreadsExport(csv.files[0], $("#grcs"), cl); };
}
// The import box: books on your map and those still needing a pin. It always shows the state right now:
// it's redrawn after every batch of an import and whenever a book is added, placed, moved or removed.
function renderImportReport(){
  const box = $("#grrep"); if(!box) return;
  let rep = MM.lsGet(grReportKey(), null);
  // The list of books still needing a pin is kept in this browser; books placed since are taken off it.
  if(rep){
    const still = rep.missed.filter(m=>!onMyMap(m));
    if(booksReady && !myBooks.length && !importing){ MM.lsSet(grReportKey(), null); rep = null; }   // e.g. after a reset
    else if(still.length !== rep.missed.length){ rep.missed = still; MM.lsSet(grReportKey(), rep); }
  }
  const missing = rep ? rep.missed : [];
  box.innerHTML = rep ? `<div class="box">
      <p class="ok" style="margin:0"><b>${myBooks.length} book${myBooks.length===1?"":"s"}</b> on your map${missing.length ? `, <b>${missing.length}</b> still need${missing.length===1?"s":""} a pin` : ", none waiting for a pin"}.</p>
      ${missing.length ? `<p class="hint">We couldn't work out where ${missing.length===1 ? "this one takes" : "these take"} place. Tap Place it to pin ${missing.length===1 ? "it" : "each one"} yourself.</p>
      <ul class="results">${missing.slice(0, 200).map((m,i)=>`<li><button data-i="${i}"><span class="th" style="--c:${cloth(m)};${MM.coverURL(m,"S") ? `background-image:url('${esc(MM.coverURL(m,"S"))}')` : ""}"></span><span style="min-width:0"><b>${esc(m.t)}</b><span class="m">${esc(m.a)}</span><span class="m" style="color:var(--rust)"> · Place it →</span></span></button></li>`).join("")}</ul>` : ""}
    </div>` : "";
  box.querySelectorAll(".results button").forEach(b=>b.onclick = ()=>{ pendingLog = missing[+b.dataset.i]; location.hash = "#/log"; });
}
let reportT = null;
function importReportChanged(){ clearTimeout(reportT); reportT = setTimeout(renderImportReport, 0); }

/* ---------- people ---------- */
const starterCard = () => `<a class="ucard" href="#/u/${FEATURED.username}"><span class="avatar" style="background:${MM.avatarColor(FEATURED.username)}">${FEATURED.name[0]}</span><span style="min-width:0"><b>${esc(FEATURED.name)}</b><span class="m">Starter shelf</span></span><em><b>${FEATURED.books.length || FEATURED.count || 0}</b><br>books</em></a>`;
async function renderExplore(){
  const el = $("#explore");
  if(!sb){
    el.innerHTML = `<h2 class="h">Community</h2><p class="hint">Accounts aren't switched on for this site yet, so there's one map to explore.</p><div class="list">${starterCard()}</div>`;
    return;
  }
  el.innerHTML = `<h2 class="h">Community</h2>
    <p class="hint" style="margin-top:-4px">See where other readers' books have taken them. Only public maps appear here.</p>
    <div class="search"><label for="pq" class="sr">Search people</label><input id="pq" type="search" autocomplete="off" placeholder="Search readers by username or name"></div>
    <div class="list" id="pr"></div>
    ${me ? `<h3 class="sub">From people you follow</h3><ul class="feed" id="feed"><li class="hint">Loading…</li></ul>` : ""}
    <h3 class="sub">Maps to explore</h3><div class="maps" id="maps"><p class="hint">Loading…</p></div>
    ${me ? `<div class="cta"><button class="btn ghost small" id="invite">Invite friends</button>${("contacts" in navigator && "ContactsManager" in window) ? `<button class="btn ghost small" id="fromcontacts">Find friends in contacts</button>` : ""}</div><div id="cres"></div>
      <h3 class="sub">Following</h3><div class="list" id="following"><p class="hint">Loading…</p></div>
      <h3 class="sub">Followers</h3><div class="list" id="followers"><p class="hint">Loading…</p></div>
      <p class="hint" style="margin:0;font-size:12.5px">Follows are shared with TheMovieMap: follow someone on either site and it counts on both.</p>` : `<p class="notice"><a href="#/account">Sign in</a> to follow people and find friends from your contacts.</p>`}
    <h3 class="sub">New on TheBookMap</h3><div class="list" id="newest"><p class="hint">Loading…</p></div>`;
  renderMapCards();
  let t; $("#pq").addEventListener("input", e=>{ clearTimeout(t); t = setTimeout(()=>searchPeople(e.target.value.trim()), 250); });
  const counts = booksReady ? ",book_logs(count)" : "";
  if(me){
    $("#invite").onclick = ()=>shareLink(profileURL(me.username), "Follow my map on TheBookMap");
    const fc = $("#fromcontacts"); if(fc) fc.onclick = findFromContacts;
    const {data} = await sb.from("follows").select(`followee:profiles!follows_followee_fkey(id,username,display_name${counts})`).eq("follower", me.id).limit(100);
    const flAll = (data||[]).map(r=>r.followee).filter(Boolean), fl = flAll.filter(hasBookMap), flRest = flAll.length - fl.length;
    renderFeed(flAll.map(p=>p.id));
    $("#following").innerHTML = (fl.length ? fl.map(personCard).join("") : `<p class="hint">${flRest ? "None of the people you follow have a book map yet." : "You're not following anyone yet. Search above, or invite friends."}</p>`)
      + (flRest ? `<p class="hint" style="margin:0;font-size:12.5px">${flRest} more ${flRest === 1 ? "person" : "people"} you follow ${flRest === 1 ? "hasn't" : "haven't"} started a book map yet, or keep${flRest === 1 ? "s" : ""} it private. They'll show up here once they log a book.</p>` : "");
    const {data:fr} = await sb.from("follows").select(`follower:profiles!follows_follower_fkey(id,username,display_name${counts})`).eq("followee", me.id).limit(100);
    const frAll = (fr||[]).map(r=>r.follower).filter(Boolean), frs = frAll.filter(hasBookMap), frRest = frAll.length - frs.length;
    const fe = $("#followers"); if(fe) fe.innerHTML = (frs.length ? frs.map(personCard).join("") : `<p class="hint">${frRest ? "None of your followers have a book map yet." : `No followers yet. Share your map with "Invite friends".`}</p>`)
      + (frRest ? `<p class="hint" style="margin:0;font-size:12.5px">${frRest} more ${frRest === 1 ? "follower hasn't" : "followers haven't"} started a book map yet, or keep${frRest === 1 ? "s" : ""} it private.</p>` : "");
  }
  const {data:newest} = booksReady ? await sb.rpc("book_readers", {n:12}) : {data:[]};
  const nn = $("#newest"); if(nn) nn.innerHTML = (newest||[]).length ? newest.map(p=>personCard(Object.assign({}, p, {book_logs:[{count:p.books}]}))).join("") : `<p class="hint">Nobody yet. Be the first.</p>`;
}
// Community: the newest books from people you follow (public maps only; the database leaves private ones out).
async function renderFeed(ids){
  const box = $("#feed"); if(!box) return;
  if(!ids.length){ box.innerHTML = `<li class="hint">Follow readers to see the books they add here.</li>`; return; }
  const {data, error} = await sb.from("book_logs").select("title,author,place,country,cover_id,created_at,user_id,profiles(username,display_name)").in("user_id", ids.slice(0, 200)).order("created_at", {ascending:false}).limit(20);
  if(error || !data || !data.length){ box.innerHTML = `<li class="hint">${error ? "Couldn't load this just now." : "Nothing new from people you follow yet."}</li>`; return; }
  box.innerHTML = data.map(r=>{
    const who = r.profiles || {}, name = who.display_name || who.username || "A reader";
    const where = [r.place, r.country].filter((x,i,a)=>x && a.indexOf(x) === i).join(", ");
    return `<li><a href="#/u/${encodeURIComponent(who.username || "")}"><span class="avatar" style="background:${MM.avatarColor(who.username || name)}">${esc(name[0] || "?")}</span><span style="min-width:0"><span class="fw"><b>${esc(name)}</b> added <i>${esc(r.title)}</i></span><span class="m">${esc([r.author, where].filter(Boolean).join(" · "))}</span></span><em>${esc(fmtWhen(r.created_at))}</em></a></li>`;
  }).join("");
}
// A small world map with a dot for each pin, for map cards.
let thumbLand = null;
function mapThumb(pts){
  const W = 168, H = 84;
  const proj = d3.geoEqualEarth().fitSize([W, H], {type:"Sphere"});
  if(thumbLand === null && countries.length){ const path = d3.geoPath(proj); thumbLand = countries.map(c=>path(c) || "").join(""); }
  const dots = (pts || []).map(([lon, lat])=>{ const xy = proj([lon, lat]); return xy ? `<circle cx="${xy[0].toFixed(1)}" cy="${xy[1].toFixed(1)}" r="2.2"/>` : ""; }).join("");
  return `<svg class="thumb" viewBox="0 0 ${W} ${H}" aria-hidden="true"><path d="${thumbLand || ""}" class="tl"/>${dots}</svg>`;
}
async function renderMapCards(){
  const box = $("#maps"); if(!box) return;
  let rows = [];
  if(booksReady){ try{ const {data, error} = await sb.rpc("book_maps", {n:12}); if(!error) rows = data || []; }catch(e){} }
  const card = (href, name, user, books, ctry, pts, tag) => `<a class="mcard" href="${href}">${mapThumb(pts)}<span class="mc-b"><b>${esc(name)}</b><span class="m">${tag ? esc(tag) + " · " : ""}${books} book${books===1?"":"s"} · ${ctry} countr${ctry===1?"y":"ies"}</span></span></a>`;
  const starterPts = (FEATURED.books || []).filter(f=>Number.isFinite(f.lat)).map(f=>[f.lon, f.lat]);
  const starterCtry = new Set((FEATURED.books || []).map(f=>f.c).filter(Boolean)).size;
  const html = rows.filter(r=>!me || r.id !== me.id).map(r=>card(`#/u/${encodeURIComponent(r.username)}`, r.display_name || r.username, r.username, +r.books, +r.countries, r.pts)).join("")
    + card(`#/u/${FEATURED.username}`, FEATURED.name, FEATURED.username, FEATURED.books.length || FEATURED.count || 0, starterCtry, starterPts, "Starter shelf");
  box.innerHTML = html;
  // Emily's books load on demand; redraw her card once they're in.
  if(!starterPts.length && typeof placeFeatured === "function") placeFeatured().then(()=>{ if($("#maps") === box) renderMapCards(); }).catch(()=>{});
}
// Accounts and follows are shared with TheMovieMap (same Supabase project). Here we list only people who
// have a book map, i.e. at least one book logged; follows made on either site count on both.
const hasBookMap = p => !booksReady || !!(p && p.book_logs && p.book_logs[0] && p.book_logs[0].count > 0);
function personCard(p){
  const n = p.book_logs && p.book_logs[0] ? p.book_logs[0].count : "";
  const name = p.display_name || p.username;
  return `<a class="ucard" href="#/u/${encodeURIComponent(p.username)}"><span class="avatar" style="background:${MM.avatarColor(p.username)}">${esc(name[0]||"?")}</span><span style="min-width:0"><b>${esc(name)}</b><span class="m">@${esc(p.username)}</span></span><em>${n!=="" ? `<b>${n}</b><br>book${n===1?"":"s"}` : ""}</em></a>`;
}
async function searchPeople(q){
  const box = $("#pr"); if(!box) return;
  if(q.length < 2){ box.innerHTML = ""; return; }
  const like = "%" + q.replace(/[%_\\]/g, m=>"\\" + m) + "%";
  const {data:all, error} = await sb.from("profiles").select(`id,username,display_name${booksReady ? ",book_logs(count)" : ""}`).or(`username.ilike.${like},display_name.ilike.${like}`).limit(40);
  if(error){ box.innerHTML = `<p class="err">Search didn't go through.</p>`; return; }
  const data = all.filter(hasBookMap).slice(0, 20);
  box.innerHTML = data.length ? data.map(personCard).join("") : `<p class="hint">No one with a book map matches "${esc(q)}".</p>`;
}
async function sha256(s){ const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join(""); }
const normEmail = e => String(e||"").trim().toLowerCase();
const normPhone = p => { const d = String(p||"").replace(/\D/g,""); return d.length >= 7 ? d.slice(-10) : ""; };
async function findFromContacts(){
  const out = $("#cres");
  try{
    const picked = await navigator.contacts.select(["email","tel"], {multiple:true});
    if(!picked.length) return;
    const keys = new Set();
    for(const c of picked){ (c.email||[]).forEach(e=>{ if(normEmail(e)) keys.add("e:" + normEmail(e)); }); (c.tel||[]).forEach(t=>{ if(normPhone(t)) keys.add("p:" + normPhone(t)); }); }
    const hashes = await Promise.all([...keys].slice(0,500).map(sha256));
    const {data, error} = await sb.rpc("find_by_contacts", {hashes});
    if(error) throw error;
    out.innerHTML = data.length ? `<h3 class="sub">From your contacts</h3><div class="list">${data.map(personCard).join("")}</div>` : `<p class="hint">None of those contacts are on TheBookMap yet, or they haven't turned on "Let friends find me". Try Invite friends.</p>`;
  }catch(e){ out.innerHTML = `<p class="hint">Couldn't read your contacts.</p>`; }
}
async function shareLink(url, title){
  if(navigator.share){ try{ await navigator.share({title, url}); return; }catch(e){ if(e && e.name === "AbortError") return; } }
  try{ await navigator.clipboard.writeText(url); toast("Link copied"); }catch(e){ prompt("Copy this link", url); }
}

/* ---------- account ---------- */
let acctTab = "in";
function renderAccount(){
  const el = $("#account");
  if(!sb){
    el.innerHTML = `<h2 class="h">Accounts</h2><p class="hint">Accounts aren't switched on for this site yet. Until they are, your books save in this browser.</p>`;
    return;
  }
  if(!session){
    el.innerHTML = `<h2 class="h">${acctTab === "up" ? "Create your map" : "Sign in"}</h2>
      <p class="hint">One account for TheBookMap and MovieMap. Already on MovieMap? Sign in with the same email.</p>
      <div class="tabs" role="tablist"><button role="tab" aria-selected="${acctTab==="in"}" data-t="in">Sign in</button><button role="tab" aria-selected="${acctTab==="up"}" data-t="up">Create account</button></div>
      <form id="af" class="pad" style="padding:0">
        ${acctTab==="up" ? `<label class="field" for="a-user">Username<input id="a-user" required autocomplete="username" placeholder="letters, numbers, _" pattern="[A-Za-z0-9_]{3,20}"></label>
        <label class="field" for="a-name">Display name<input id="a-name" maxlength="40" autocomplete="name"></label>` : ""}
        <label class="field" for="a-email">Email<input id="a-email" type="email" required autocomplete="email"></label>
        <label class="field" for="a-pass">Password<input id="a-pass" type="password" required minlength="8" autocomplete="${acctTab==="up" ? "new-password" : "current-password"}"></label>
        <p class="err" id="a-err" hidden></p>
        <div class="cta"><button class="btn" type="submit">${acctTab==="up" ? "Create account" : "Sign in"}</button>${acctTab==="in" ? `<button type="button" class="linkbtn" id="a-forgot">Forgot password?</button>` : ""}</div>
      </form>
      ${myBooks.length && booksReady ? `<p class="notice">The ${myBooks.length} book${myBooks.length===1?"":"s"} saved in this browser will move to your account when you sign in.</p>` : ""}`;
    el.querySelectorAll(".tabs button").forEach(b=>b.onclick = ()=>{ acctTab = b.dataset.t; renderAccount(); });
    const err = m=>{ const e = $("#a-err"); e.textContent = m; e.hidden = !m; };
    const fg = $("#a-forgot"); if(fg) fg.onclick = async ()=>{
      const email = $("#a-email").value.trim(); if(!email) return err("Type your email first, then tap Forgot password.");
      const {error} = await sb.auth.resetPasswordForEmail(email, {redirectTo: siteURL()});
      error ? err(error.message) : (err(""), toast("Check your email for a reset link"));
    };
    $("#af").onsubmit = async ev=>{
      ev.preventDefault(); err("");
      const email = $("#a-email").value.trim(), password = $("#a-pass").value;
      const btn = ev.target.querySelector('button[type="submit"]'); btn.disabled = true;
      try{
        if(acctTab === "up"){
          const username = $("#a-user").value.trim().toLowerCase();
          if(!/^[a-z0-9_]{3,20}$/.test(username)) throw new Error("Usernames are 3–20 letters, numbers or underscores.");
          const {data:ok} = await sb.rpc("username_available", {name:username});
          if(ok === false || username === FEATURED.username) throw new Error("That username is taken. Try another.");
          const {data, error} = await sb.auth.signUp({email, password, options:{data:{username, display_name:$("#a-name").value.trim()}, emailRedirectTo: siteURL()}});
          if(error) throw error;
          if(!data.session){ $("#account").innerHTML = `<h2 class="h">Check your email</h2><p class="hint">We sent a confirmation link to <b>${esc(email)}</b>. Open it on this device to finish creating your map.</p>`; return; }
        } else {
          const {error} = await sb.auth.signInWithPassword({email, password});
          if(error) throw new Error(error.message === "Invalid login credentials" ? "That email and password don't match." : error.message);
        }
      }catch(e){ err(e.message || "That didn't work. Try again."); }
      finally{ btn.disabled = false; }
    };
    return;
  }
  const p = me || {};
  const name = p.display_name || p.username || "";
  const sw = (id, on, label) => `<label class="sw" for="${id}"><input type="checkbox" id="${id}" role="switch" ${on ? "checked" : ""}><span class="sw-t" aria-hidden="true"></span><span class="sr">${label}</span></label>`;
  el.innerHTML = `<div class="acct-head">
      <span class="avatar" style="background:${MM.avatarColor(p.username || name)}">${esc((name || "?")[0])}</span>
      <div style="min-width:0"><h2 class="h" style="margin:0">${esc(name)}</h2><p class="hint" style="margin:2px 0 0">@${esc(p.username)}</p></div>
      <a class="btn ghost small" href="#/u/${encodeURIComponent(p.username)}">View my map</a>
    </div>
    <form id="pf" class="settings" novalidate>
      <section class="set">
        <h3 class="set-h">Profile</h3>
        <p class="set-d">How you appear on your map, in Community and next to your reviews.</p>
        <label class="set-f" for="p-name"><span>Display name</span><input id="p-name" maxlength="40" value="${esc(p.display_name)}" autocomplete="name"></label>
        <label class="set-f" for="p-bio"><span>Bio <em id="p-bio-n">${(p.bio || "").length}/160</em></span><textarea id="p-bio" maxlength="160" rows="3" placeholder="A line about you and what you read">${esc(p.bio)}</textarea></label>
      </section>
      <section class="set"${privacyReady ? "" : " hidden"}>
        <h3 class="set-h">Privacy</h3>
        <div class="set-row">
          <div><b>Private map</b><p>Only you can see your map. It leaves Community and search, and your link shows "This map is private". Reviews you write stay on book cards, signed "A fellow reader".</p></div>
          ${sw("p-priv", p.book_private, "Private map")}
        </div>
      </section>
      <section class="set">
        <h3 class="set-h">Find friends</h3>
        <div class="set-row">
          <div><b>Let friends find me from their contacts</b><p>Friends who have your email or phone number can find you. We keep only a scrambled fingerprint, never the email or number itself.</p></div>
          ${sw("p-disc", p.discoverable, "Let friends find me from their contacts")}
        </div>
        <label class="set-f" for="p-phone" id="p-phone-f"${p.discoverable ? "" : " hidden"}><span>Phone number <em>optional</em></span><input id="p-phone" type="tel" autocomplete="tel" placeholder="${p.discoverable ? "Saved privately · type to replace" : "Only used for matching"}"></label>
      </section>
      <section class="set">
        <h3 class="set-h">Your books</h3>
        <div class="set-row">
          <div><b>Import from Goodreads or The StoryGraph</b><p>Bring in your whole reading history from an export file.</p></div>
          <a class="btn ghost small" href="#/import">Import</a>
        </div>
        <div class="set-row">
          <div><b>Share my map</b><p>A link anyone can open${p.book_private ? " (your map is private, so others will see it's private)" : ""}.</p></div>
          <button class="btn ghost small" type="button" id="p-share">Share</button>
        </div>
      </section>
      <section class="set">
        <h3 class="set-h">Account</h3>
        <div class="set-row">
          <div><b>Email</b><p>${esc(session.user.email)}</p></div>
        </div>
        <div class="set-row">
          <div><b>Sign out</b><p>Your account, profile and follows are shared with MovieMap.</p></div>
          <button class="btn ghost small" type="button" id="p-out">Sign out</button>
        </div>
      </section>
      <div class="set-save">
        <p class="err" id="p-err" hidden></p>
        <span class="hint" id="p-state" aria-live="polite">All changes saved</span>
        <button class="btn" type="submit" id="p-save" disabled>Save changes</button>
      </div>
    </form>`;
  // The Save button wakes up only when something has changed.
  const snap = () => JSON.stringify([$("#p-name").value, $("#p-bio").value, $("#p-priv") && $("#p-priv").checked, $("#p-disc").checked, $("#p-phone").value]);
  const start = snap();
  const dirty = () => { const d = snap() !== start; $("#p-save").disabled = !d; $("#p-state").textContent = d ? "Unsaved changes" : "All changes saved"; };
  $("#pf").addEventListener("input", dirty); $("#pf").addEventListener("change", dirty);
  $("#p-bio").addEventListener("input", ()=>{ $("#p-bio-n").textContent = $("#p-bio").value.length + "/160"; });
  $("#p-disc").addEventListener("change", ()=>{ $("#p-phone-f").hidden = !$("#p-disc").checked; });
  $("#p-out").onclick = async ()=>{ await sb.auth.signOut(); };
  $("#p-share").onclick = ()=>shareLink(profileURL(p.username), "My map on TheBookMap");
  $("#pf").onsubmit = async ev=>{
    ev.preventDefault();
    const e = $("#p-err"); e.hidden = true;
    $("#p-save").disabled = true; $("#p-state").textContent = "Saving…";
    const disc = $("#p-disc").checked;
    const patch = {display_name:$("#p-name").value.trim(), bio:$("#p-bio").value.trim(), discoverable: disc};
    const {error} = await sb.from("profiles").update(patch).eq("id", me.id);
    if(error){ e.textContent = "Couldn't save. Try again."; e.hidden = false; dirty(); return; }
    const priv = $("#p-priv").checked;
    if(privacyReady && priv !== !!me.book_private){
      const {error:pe} = await sb.from("book_prefs").upsert({user_id:me.id, private:priv, updated_at:new Date().toISOString()}, {onConflict:"user_id"});
      if(pe){ e.textContent = "Couldn't change who can see your map. Try again."; e.hidden = false; dirty(); return; }
      me.book_private = priv;
      if(viewing.mine) setOwnerHeader();
    }
    try{
      const phone = normPhone($("#p-phone").value);
      if(!disc){ await sb.from("contact_keys").delete().eq("user_id", me.id); }
      else {
        const keys = [await sha256("e:" + normEmail(session.user.email))];
        if(phone) keys.push(await sha256("p:" + phone));
        if(phone || !(await sb.from("contact_keys").select("hash").eq("user_id", me.id)).data?.length){
          await sb.from("contact_keys").delete().eq("user_id", me.id);
          await sb.from("contact_keys").insert(keys.map(hash=>({user_id:me.id, hash})));
        }
      }
    }catch(x){}
    Object.assign(me, patch); paintAccountLink(); toast("Changes saved"); renderAccount();
  };
}

/* ================= routing ================= */
async function route(){
  const h = location.hash || "#/";
  if(/access_token|error_description|type=recovery/.test(h)) return;   // Supabase is handling a sign-in link
  closeDetail(); preview = null; picking = null; $("#pickhint").hidden = true; $("#map").classList.remove("picking");
  setView("map");   // every page opens on the map; List and Stats are views of the map, not pages
  const [, a, b] = h.split("/");
  if(a === "u" && b){
    setNav(""); showPanel("map");
    const name = decodeURIComponent(b).toLowerCase();
    if(me && name === me.username){ setNav("home"); return showMine(); }
    if(name === FEATURED.username) return showFeatured();
    if(sb){
      const {data:p} = await sb.from("profiles").select("*").eq("username", name).maybeSingle();
      if(p){
        if(booksReady && await isPrivateMap(p.id)) return showMap(Object.assign({}, p, {private:true, bio:"This map is private."}), [], false);
        const films = booksReady ? await fetchLogs(p.id).catch(()=>[]) : []; return showMap(p, films, false);
      }
    }
    showMap({name:"Not found", username:name, bio:"No one has this username."}, [], false);
    return;
  }
  if(a === "explore"){ setNav("explore"); showBackdrop(); showPanel("explore"); return renderExplore(); }
  if(a === "log"){ setNav("log"); showBackdrop(); showPanel("log"); return renderLog(); }
  if(a === "import"){ setNav("import"); showBackdrop(); showPanel("import"); return renderImport(); }
  if(a === "poster"){ location.replace("#/"); return; }   // posters were dropped (2026-10-27); old links go home
  if(a === "account"){ if(b === "up" || b === "in") acctTab = b; setNav("account"); showBackdrop(); showPanel("account"); return renderAccount(); }
  setNav("home");
  if(!me && !myBooks.length) return showWelcome();
  showPanel("map"); showFeaturedOrMine();
}
// First visit (signed out, no books yet): an invitation to make a map, with Emily's starter shelf to look around.
function showWelcome(){
  showBackdrop();
  showPanel("welcome");
  $("#whose-k").textContent = "Welcome to"; $("#whose-h").textContent = "TheBookMap";
  $("#welcome").innerHTML = `<h2 class="h">See the world one book at a time</h2>
    <p class="lead">Every book you've read, pinned where its story takes place. Import your Goodreads or StoryGraph library and every book you've read lands on the map, or add books one by one.</p>
    <div class="cta"><a class="btn gold" href="#/account/up">Create your map</a><a class="btn ghost" href="#/import">Import your books</a></div>
    <p class="hint">Already have an account? <a href="#/account/in">Sign in</a>. MovieMap accounts work here too.</p>
    <h3 class="sub" style="margin-top:22px">Or look around first</h3>
    <div class="list">${starterCard()}</div>`;
}
// Behind People, Log a book, Goodreads and the account page: your own map, or the plain world map
// for a visitor (not whichever map they last looked at).
function showBackdrop(){
  if(me || myBooks.length){ if(!viewing.mine) showMine(); return; }
  if(!(viewing.owner && viewing.owner.welcome)) showMap({name:"TheBookMap", username:"", bio:"", welcome:true}, [], false);
  $("#whose-k").textContent = "Welcome to"; $("#whose-h").textContent = "TheBookMap";
}
function showFeaturedOrMine(){
  if(me || myBooks.length) return showMine();
  showFeatured();
}
window.addEventListener("hashchange", route);
// The logo always goes home, even when the page is already on the map.
// The logo always goes home: your map (or Emily's starter shelf), on the Map view, zoomed out to every pin.
document.querySelector(".brand").addEventListener("click", async e=>{
  e.preventDefault();
  setView("map");
  if((location.hash || "#/") !== "#/") history.pushState(null, "", "#/");
  await route();
  window.scrollTo(0, 0);
  setTimeout(()=>fitPins(true), 50);
});

/* ================= auth wiring ================= */
async function loadMe(){
  me = null;
  if(!session) return;
  for(let i=0; i<3 && !me; i++){   // the profile row is created by a trigger right after sign-up
    const {data} = await sb.from("profiles").select("*").eq("id", session.user.id).maybeSingle();
    me = data || null; if(!me) await MM.sleep(600);
  }
  if(me){
    try{ const {data:pr, error} = await sb.from("book_prefs").select("private").eq("user_id", me.id).maybeSingle(); me.book_private = !!(pr && pr.private); privacyReady = !error; }
    catch(e){ me.book_private = false; privacyReady = false; }
  }
}
// Private book maps (book_prefs): only the owner can see them; enforced by the database.
let privacyReady = false;   // false until the book_prefs table exists (migration 113); the switch stays hidden till then
async function isPrivateMap(userId){
  try{ const {data} = await sb.from("book_prefs").select("private").eq("user_id", userId).maybeSingle(); return !!(data && data.private); }catch(e){ return false; }
}
// Is the book table there yet? (supabase/migrations/101_bookmap.sql)
async function checkBooksTable(){
  if(!sb) return false;
  const {error} = await sb.from("book_logs").select("id", {head:true, count:"exact"}).limit(1);
  return !error;
}
async function moveLocalBooks(){
  const local = MM.lsGet(LOCAL, []);
  if(!local.length || !cloud()) return;
  try{
    const {added} = await Store.add(local); MM.lsSet(LOCAL, []);
    // A Goodreads profile linked before signing in moves to the account too.
    const gl = MM.lsGet(GR_LOCAL, null);
    if(gl && !me.goodreads_id){ await setGrLinked(gl).catch(()=>{}); MM.lsSet(GR_LOCAL, null); }
    if(added) toast(`Moved ${added} book${added===1?"":"s"} to your account`);
  }catch(e){}
}
let aiState = "unknown";   // unknown | on | off
// Several parts of the page can ask about the same book at once (the preview, the card, the map). They all
// share one request, so a book costs one Claude call.
const aiInflight = new Map();
function aiFor(d){
  const k = MM.bookKey(d);
  if(aiInflight.has(k)) return aiInflight.get(k).then(r=>{ if(r.skipped) d.aiSkipped = 1; return r.setting; });
  const p = aiAsk(d).then(setting=>({setting, skipped: !!d.aiSkipped}), ()=>({setting:null, skipped:true}));
  aiInflight.set(k, p);
  p.finally(()=>aiInflight.delete(k));
  return p.then(r=>r.setting);
}
async function aiAsk(d){
  if(aiState === "off" || !cloud()) return null;
  const {data, error} = await sb.functions.invoke("book-setting", {body:{key:MM.bookKey(d), title:d.t, author:d.a || "", year:d.y || null, qid:d.qid || null, isbn:isbnOk(d.isbn13) || isbnOk(d.isbn) || null, overview:d.ov || ""}});
  if(error){
    const status = error.context && error.context.status;
    if(!status || status === 404 || error.name === "FunctionsFetchError" || error.name === "FunctionsRelayError") aiState = "off";
    return null;
  }
  if(data && data.reason === "no_api_key"){ aiState = "off"; return null; }
  aiState = "on";
  // Anything other than a real answer or "couldn't place it" (a limit, not on a map yet, a failed call):
  // try this book again another time.
  if(data && !data.setting && data.reason && data.reason !== "unknown") d.aiSkipped = 1;
  return data && data.setting || null;
}
async function onAuth(newSession, event){
  session = newSession;
  await loadMe();
  MM.aiSetting = (sb && newSession && booksReady) ? aiFor : null;
  if(cloud()) await moveLocalBooks();
  await reloadMine();
  await loadWants().catch(()=>{});
  paintAccountLink();
  maybeAutoSync();
  if(event === "PASSWORD_RECOVERY"){
    showPanel("account"); setNav("account");
    $("#account").innerHTML = `<h2 class="h">Choose a new password</h2><form id="np" style="display:grid;gap:12px"><label class="field" for="np-p">New password<input id="np-p" type="password" minlength="8" required autocomplete="new-password"></label><div class="cta"><button class="btn">Save password</button></div></form>`;
    $("#np").onsubmit = async e=>{ e.preventDefault(); const {error} = await sb.auth.updateUser({password:$("#np-p").value}); if(error) return toast(error.message); toast("Password updated"); location.hash = "#/"; };
    return;
  }
  if(/access_token|type=/.test(location.hash) || (event === "SIGNED_IN" && /#\/account/.test(location.hash))){ history.replaceState(null, "", siteURL() + "#/"); }
  route();
}

/* ================= boot ================= */
async function boot(){
  let topo;
  try{ topo = await (await fetch("data/world.json")).json(); }catch(e){ toast("The map didn't load. Refresh to try again."); return; }
  countries = topojson.feature(topo, topo.objects.countries).features;
  MM.setWorld(countries);
  let rT; new ResizeObserver(()=>{ clearTimeout(rT); rT = setTimeout(()=>{ drawBase(); fitPins(false); }, 60); }).observe($(".mapwrap"));
  drawBase();
  if(sb){
    booksReady = await checkBooksTable().catch(()=>false);
    const {data} = await sb.auth.getSession();
    sb.auth.onAuthStateChange((event, s)=>{
      if(event === "INITIAL_SESSION" || event === "TOKEN_REFRESHED") return;
      if(event === "USER_UPDATED"){ session = s; return; }
      setTimeout(()=>onAuth(s, event), 0);
    });
    await onAuth(data.session, "INITIAL");
  } else {
    await reloadMine(); paintAccountLink(); route();
  }
}
boot();
})();
