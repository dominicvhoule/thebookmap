// BookMap data layer: Open Library lookups (search, covers, details), Wikidata setting lookups, country helpers.
(function(){
const MM = window.MM = {};

/* ---------------- small utilities ---------------- */
MM.norm = s => String(s||"").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/&/g,"and").replace(/[^a-z0-9]/g,"");
// "Mockingjay (The Hunger Games, #3)" → title "Mockingjay", series "The Hunger Games, #3"
MM.cleanTitle = function(t){
  const m = String(t||"").match(/^(.*?)\s*\(([^()]*#\s*[\d.]+[^()]*)\)\s*$/);
  return m ? {t:m[1].trim(), s:m[2].trim()} : {t:String(t||"").trim(), s:""};
};
const mainTitle = t => MM.cleanTitle(t).t.replace(/\s*[:;(].*$/, "");     // drop series and subtitle
const firstAuthor = a => String(a||"").split(/,| and | & /)[0].trim();
// One book, whatever the edition: its main title and first author.
MM.bookKey = b => (MM.norm(mainTitle(b.t)).slice(0, 80) || "untitled") + "|" + MM.norm(firstAuthor(b.a)).slice(0, 60);
MM.sleep = ms => new Promise(r=>setTimeout(r,ms));
function lsGet(k,d){ try{ const v = localStorage.getItem(k); return v===null ? d : JSON.parse(v); }catch(e){ return d; } }
function lsSet(k,v){ try{ localStorage.setItem(k, JSON.stringify(v)); return true; }catch(e){ return false; } }
MM.lsGet = lsGet; MM.lsSet = lsSet;

// Run fn over items with at most n in flight.
MM.pool = async function(items, n, fn){
  const out = new Array(items.length); let i = 0;
  const worker = async()=>{ while(i < items.length){ const k = i++; try{ out[k] = await fn(items[k], k); }catch(e){ out[k] = undefined; } } };
  await Promise.all(Array.from({length:Math.min(n, items.length)}, worker));
  return out;
};

/* ---------------- countries ---------------- */
// Wikidata / library-catalogue names → names used in the map geometry (world-atlas, Natural Earth).
const GEO_ALIASES = {
  "united states":"United States of America","usa":"United States of America","united states of america":"United States of America","u.s.":"United States of America",
  "people's republic of china":"China","hong kong":"China","macau":"China","republic of china":"Taiwan",
  "kingdom of the netherlands":"Netherlands","the netherlands":"Netherlands","czech republic":"Czechia",
  "democratic republic of the congo":"Dem. Rep. Congo","republic of the congo":"Congo","bosnia and herzegovina":"Bosnia and Herz.",
  "dominican republic":"Dominican Rep.","central african republic":"Central African Rep.","south sudan":"S. Sudan",
  "ivory coast":"Côte d'Ivoire","north macedonia":"Macedonia","eswatini":"eSwatini","equatorial guinea":"Eq. Guinea",
  "western sahara":"W. Sahara","french polynesia":"Fr. Polynesia","solomon islands":"Solomon Is.","state of palestine":"Palestine","palestinian territories":"Palestine",
  "soviet union":"Russia","russian empire":"Russia","russian soviet federative socialist republic":"Russia","russia (federation)":"Russia","russian federation":"Russia",
  "east germany":"Germany","west germany":"Germany","nazi germany":"Germany","german reich":"Germany","weimar republic":"Germany","german empire":"Germany","kingdom of prussia":"Germany","prussia":"Germany",
  "england":"United Kingdom","scotland":"United Kingdom","wales":"United Kingdom","northern ireland":"United Kingdom","great britain":"United Kingdom","kingdom of great britain":"United Kingdom","kingdom of england":"United Kingdom","united kingdom of great britain and ireland":"United Kingdom",
  "irish free state":"Ireland","kingdom of italy":"Italy","francoist spain":"Spain","second spanish republic":"Spain","yugoslavia":"Serbia","kingdom of france":"France","french third republic":"France",
  "austria-hungary":"Austria","austrian empire":"Austria","ottoman empire":"Turkey","qing dynasty":"China","empire of japan":"Japan","british raj":"India","mandatory palestine":"Israel",
  "south korea":"South Korea","republic of korea":"South Korea","north korea":"North Korea","korea":"South Korea",
  "viet nam":"Vietnam","türkiye":"Turkey","turkiye":"Turkey","myanmar":"Myanmar","burma":"Myanmar","cabo verde":"Cape Verde"
};
const DISPLAY = {"People's Republic of China":"China","United States of America":"United States","Kingdom of the Netherlands":"Netherlands"};
MM.displayCountry = c => DISPLAY[c] || c || "";
MM.geoName = c => { if(!c) return ""; return GEO_ALIASES[String(c).toLowerCase()] || c; };
const CONTINENT_FIX = {"Insular Oceania":"Oceania","Australian continent":"Oceania","Australia":"Oceania","Eurasia":"Europe","Americas":"North America"};
MM.fixContinent = c => CONTINENT_FIX[c] || c || "";

// Filled by the app once the world geometry loads: geo name → [lon, lat] of the country's largest landmass.
MM.centroids = {};
MM.setWorld = function(features){
  MM.worldFeatures = features;
  features.forEach(f=>{
    let g = f.geometry;
    if(g && g.type==="MultiPolygon"){
      let best = null, bestA = -1;
      g.coordinates.forEach(c=>{ const p = {type:"Polygon", coordinates:c}; const a = d3.geoArea(p); if(a>bestA){ bestA=a; best=p; } });
      g = best;
    }
    if(g) MM.centroids[f.properties.name] = d3.geoCentroid(g);
  });
};
MM.countryPoint = c => MM.centroids[MM.geoName(c)] || null;
// The country containing a point. Coastal cities can fall just outside the simplified shapes, so look nearby too.
MM.countryAt = function(lon, lat){
  const feats = MM.worldFeatures || [];
  const offsets = [[0,0],[0.15,0],[-0.15,0],[0,0.15],[0,-0.15],[0.35,0],[-0.35,0],[0,0.35],[0,-0.35],[0.35,0.35],[-0.35,-0.35],[0.35,-0.35],[-0.35,0.35]];
  for(const [dx,dy] of offsets){
    const f = feats.find(c=>d3.geoContains(c, [lon + dx, lat + dy]));
    if(f) return MM.displayCountry(f.properties.name);
  }
  return "";
};

/* ---------------- Open Library ---------------- */
const OL = "https://openlibrary.org";
const FIELDS = "key,title,subtitle,author_name,first_publish_year,cover_i,id_wikidata,place,edition_count,number_of_pages_median,editions,editions.title,editions.cover_i,editions.language";
let olGate = Promise.resolve(), olLast = 0;
async function olFetch(path){
  // Open Library asks apps to go gently: at most a few requests a second from one visitor.
  const turn = olGate.then(async()=>{ const wait = 220 - (Date.now() - olLast); if(wait > 0) await MM.sleep(wait); olLast = Date.now(); });
  olGate = turn.catch(()=>{});
  await turn;
  for(let attempt=0; attempt<3; attempt++){
    const r = await fetch(OL + path);
    if(r.status === 429 || r.status >= 500){ await MM.sleep(1500 * (attempt + 1)); continue; }
    if(r.status === 404) return null;
    if(!r.ok) throw new Error("ol-http-" + r.status);
    return r.json();
  }
  throw new Error("ol-busy");
}
MM.olFetch = olFetch;
MM.coverURL = (b, size) => {
  if(!b) return null;
  if(b.cover) return b.cover;                                                        // Goodreads cover, full size
  if(b.coverId) return `https://covers.openlibrary.org/b/id/${b.coverId}-${size||"L"}.jpg`;
  if(b.isbn) return `https://covers.openlibrary.org/b/isbn/${b.isbn}-${size||"L"}.jpg?default=false`;
  return null;
};
MM.olPage = b => b.ol ? `${OL}/works/${b.ol}` : `${OL}/search?q=${encodeURIComponent((b.t||"") + " " + (b.a||""))}`;
MM.goodreadsPage = b => b.gr ? `https://www.goodreads.com/book/show/${encodeURIComponent(b.gr)}` : `https://www.goodreads.com/search?q=${encodeURIComponent(b.isbn || ((b.t||"") + " " + (b.a||"")))}`;

// A search result → a book summary {ol, t, a, y, coverId, qid, pages, places, editions}.
function fromDoc(d){
  if(!d || !d.key) return null;
  const ed = d.editions && d.editions.docs && d.editions.docs[0];
  const latin = s => /[a-z]/i.test(s || "");
  const t = (ed && ed.title && (latin(ed.title) || !latin(d.title))) ? ed.title : d.title;
  const authors = (d.author_name || []).filter(a=>!/translat|editor|illustrat/i.test(a));
  return {
    ol: d.key.replace("/works/", ""), t: String(t || "").trim(), a: authors.slice(0, 2).join(" & "), y: d.first_publish_year || "",
    coverId: (ed && ed.cover_i) || d.cover_i || null, qid: (d.id_wikidata || []).find(q=>/^Q\d+$/.test(q)) || null,
    pages: d.number_of_pages_median || null, places: (d.place || []).slice(0, 25), editions: d.edition_count || 0
  };
}
MM.searchBooks = async function(query){
  const d = await olFetch(`/search.json?q=${encodeURIComponent(query)}&lang=en&fields=${FIELDS}&limit=20`);
  const words = MM.norm(query);
  return (d && d.docs || []).map(fromDoc).filter(b=>b && b.t && b.a)
    // Relevance from Open Library, nudged towards real books people read over stray single editions.
    .map((b,i)=>({b, s: -i + Math.log10(1 + b.editions) * 3 + (b.coverId ? 2 : 0) + (MM.norm(b.t).includes(words) || words.includes(MM.norm(b.t)) ? 4 : 0)}))
    .sort((x,y)=>y.s - x.s).slice(0, 10).map(x=>x.b);
};
// The Open Library work for a book we know by ISBN, title and author (Goodreads entries, the starter shelf).
MM.matchBook = async function(e){
  const cacheKey = "bm-match2:" + (e.isbn13 || e.isbn || MM.bookKey(e));
  const hit = lsGet(cacheKey, undefined); if(hit !== undefined) return hit;
  let found = null;
  for(const isbn of [e.isbn13, e.isbn].filter(Boolean)){
    const d = await olFetch(`/search.json?isbn=${encodeURIComponent(isbn)}&lang=en&fields=${FIELDS}&limit=1`).catch(()=>null);
    found = d && d.docs && fromDoc(d.docs[0]); if(found) break;
  }
  if(!found && e.t){
    const t = mainTitle(e.t), a = firstAuthor(e.a), nt = MM.norm(t), na = MM.norm(a.split(" ").pop());
    const d = await olFetch(`/search.json?q=${encodeURIComponent(t + " " + a)}&lang=en&fields=${FIELDS}&limit=10`).catch(()=>null);
    let best = null, bestS = -1;
    (d && d.docs || []).map(fromDoc).filter(Boolean).forEach(b=>{
      const bt = MM.norm(mainTitle(b.t));
      let s = 0;
      if(bt === nt) s += 10; else if(bt.startsWith(nt) || nt.startsWith(bt)) s += 5;
      if(na && MM.norm(b.a).includes(na)) s += 8;
      s += Math.min(4, Math.log10(1 + b.editions) * 1.5) + (b.coverId ? 1 : 0);
      if(s > bestS){ best = b; bestS = s; }
    });
    found = bestS >= 13 ? best : null;     // title and author both have to match
  }
  if(found){ found = Object.assign({}, found); delete found.editions; }
  lsSet(cacheKey, found || null);
  return found || null;
};
// Details for one work: description and subjects (for previews), plus anything the summary lacked.
MM.bookDetails = async function(b){
  if(!b || !b.ol) return b || null;
  const k = "bm-work1:" + b.ol;
  let w = lsGet(k, null);
  if(!w){
    const d = await olFetch(`/works/${b.ol}.json`).catch(()=>null);
    if(!d) return b;
    const desc = typeof d.description === "string" ? d.description : (d.description && d.description.value) || "";
    w = {ov: desc.replace(/\r/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/-{3,}[\s\S]*$/, "").replace(/\n{2,}/g, "\n").trim().slice(0, 1200),
      subjects: (d.subjects || []).filter(s=>!/^(fiction|literature|accessible book|protected daisy|in library|large type|reading level|open library)/i.test(s)).slice(0, 6),
      places: (d.subject_places || []).slice(0, 25), coverId: (d.covers || []).find(c=>c > 0) || null};
    lsSet(k, w);
  }
  return Object.assign({}, b, {ov: w.ov, subjects: w.subjects, places: (b.places && b.places.length) ? b.places : w.places, coverId: b.coverId || w.coverId});
};
// A cover for a book we only know by title and author (the starter shelf, old pins).
MM.coverFor = async function(b){
  const direct = MM.coverURL(b, "M"); if(direct) return direct;
  try{ const m = await MM.matchBook(b); return m && m.coverId ? MM.coverURL({coverId:m.coverId}, "M") : null; }catch(e){ return null; }
};

/* ---------------- Wikidata: where the story takes place (P840, narrative location) ---------------- */
function parsePoint(s){
  if(!s || s.charAt(0)==="<") return null;               // coordinates on another globe
  const m = /Point\(([-\d.eE]+) ([-\d.eE]+)\)/.exec(s);
  return m ? [+m[1], +m[2]] : null;
}
const qidOf = uri => uri ? uri.split("/").pop() : null;
async function sparql(query){
  try{
    const r = await fetch("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(query), {headers:{Accept:"application/sparql-results+json"}});
    return r.ok ? (await r.json()).results.bindings : [];
  }catch(e){ return []; }
}
// Wikidata items for Open Library works (P648 links them).
MM.qidsForWorks = async function(ols){
  const out = {}, list = [...new Set(ols.filter(o=>/^OL\d+W$/.test(o||"")))];
  for(let i=0; i<list.length; i+=60){
    const rows = await sparql(`SELECT ?ol ?w WHERE { VALUES ?ol { ${list.slice(i, i+60).map(o=>`"${o}"`).join(" ")} } ?w wdt:P648 ?ol . }`);
    rows.forEach(b=>{ out[b.ol.value] = out[b.ol.value] || qidOf(b.w.value); });
  }
  return out;
};
MM.wikidataSettings = async function(qids){
  const out = {};
  const list = [...new Set(qids.filter(q=>/^Q\d+$/.test(q||"")))];
  for(let i=0; i<list.length; i+=40){
    const rows = await sparql(`SELECT ?book ?loc ?locLabel ?coord ?country ?countryLabel ?contLabel WHERE {
      VALUES ?book { ${list.slice(i, i+40).map(q=>"wd:"+q).join(" ")} }
      ?book wdt:P840 ?loc .
      OPTIONAL { ?loc wdt:P625 ?coord . }
      OPTIONAL { ?loc wdt:P17 ?country . OPTIONAL { ?country wdt:P30 ?cont . } }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }`);
    const byBook = {};
    rows.forEach(b=>{ const k = qidOf(b.book.value); (byBook[k] = byBook[k] || []).push(b); });
    Object.keys(byBook).forEach(k=>{ const s = pickSetting(byBook[k]); if(s) out[k] = s; });
    if(i + 40 < list.length) await MM.sleep(250);
  }
  return out;
};
// From all narrative-location rows for one book, pick the most specific place that has coordinates.
// An invented place (Macondo) has no coordinates but often a country, so it's pinned there, approximately.
function pickSetting(rows){
  const locs = {};
  rows.forEach(b=>{
    const id = qidOf(b.loc.value);
    const L = locs[id] = locs[id] || {id, label:b.locLabel ? b.locLabel.value : "", pt:null, country:null, countryId:null, cont:null};
    if(!L.pt && b.coord) L.pt = parsePoint(b.coord.value);
    if(!L.country && b.country){ L.country = b.countryLabel ? b.countryLabel.value : ""; L.countryId = qidOf(b.country.value); }
    if(!L.cont && b.contLabel) L.cont = b.contLabel.value;
  });
  const all = Object.values(locs).filter(L=>!/^Q\d+$/.test(L.label));
  const specific = all.filter(L=>L.pt && L.countryId && L.countryId !== L.id);
  const countryLevel = all.filter(L=>L.pt && (!L.countryId || L.countryId === L.id));
  const invented = all.filter(L=>!L.pt && L.country && MM.countryPoint(L.country));
  const others = chosen => all.filter(L=>L!==chosen).map(L=>L.label).slice(0,3);
  let chosen = specific[0];
  if(chosen) return {p:chosen.label, c:MM.displayCountry(chosen.country || ""), cont:MM.fixContinent(chosen.cont), lon:+chosen.pt[0].toFixed(3), lat:+chosen.pt[1].toFixed(3), ap:0,
    n: others(chosen).length ? "Also set in " + others(chosen).join(", ") + "." : "", src:"wikidata"};
  chosen = invented[0];
  if(chosen){ const pt = MM.countryPoint(chosen.country), c = MM.displayCountry(chosen.country);
    return {p:chosen.label, c, cont:MM.fixContinent(chosen.cont), lon:+pt[0].toFixed(3), lat:+pt[1].toFixed(3), ap:1, n:`${chosen.label} is an invented place, so the pin sits in ${c}.`, src:"wikidata"}; }
  chosen = countryLevel[0];
  if(chosen) return {p:chosen.label, c:MM.displayCountry(chosen.label), cont:MM.fixContinent(chosen.cont), lon:+chosen.pt[0].toFixed(3), lat:+chosen.pt[1].toFixed(3), ap:1,
    n: others(chosen).length ? "Also set in " + others(chosen).join(", ") + "." : "", src:"wikidata"};
  return null;
}

// Where each book's author is from (citizenship, as Wikidata records it), by book item. Used for the
// country pages ("by writers from here") and as the last-resort pin.
MM.authorCountries = async function(qids){
  const out = {}, list = [...new Set(qids.filter(q=>/^Q\d+$/.test(q||"")))];
  const need = list.filter(q=>{ const c = lsGet("bm-auth1:" + q, null); if(c){ out[q] = c; return false; } return true; });
  for(let i=0; i<need.length; i+=50){
    const rows = await sparql(`SELECT ?book ?cLabel WHERE {
      VALUES ?book { ${need.slice(i, i+50).map(q=>"wd:"+q).join(" ")} }
      ?book wdt:P50 ?a . ?a wdt:P27 ?c .
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } }`);
    const got = {};
    rows.forEach(b=>{ const k = qidOf(b.book.value), n = b.cLabel && b.cLabel.value; if(n && !/^Q\d+$/.test(n)) (got[k] = got[k] || []).includes(n) || got[k].push(n); });
    need.slice(i, i+50).forEach(q=>{ out[q] = got[q] || []; lsSet("bm-auth1:" + q, out[q]); });
  }
  return out;
};
const FALLBACK_NOTE = "No setting on record yet, so this is pinned to the author's country. Move the pin if you know better.";
MM.fallbackSetting = function(det){
  for(const c of (det && det.authorCountries) || []){
    const pt = MM.countryPoint(c);
    if(pt) return {p:MM.displayCountry(MM.geoName(c)), c:MM.displayCountry(MM.geoName(c)), cont:"", lon:+pt[0].toFixed(3), lat:+pt[1].toFixed(3), ap:1, n:FALLBACK_NOTE, src:"author"};
  }
  return null;
};

// Settings found for each book, kept in this browser (and shared through Supabase when signed in).
MM.settingCache = {
  get(k){ return lsGet("bm-set1:" + k, null); },
  put(k, s){ lsSet("bm-set1:" + k, s); }
};
// Hand-checked settings (the starter shelf), matched by title and author.
MM.curated = function(det){
  const list = window.FEATURED && window.FEATURED.books; if(!list || !det) return null;
  const k = MM.bookKey(det);
  const f = list.find(x=>MM.bookKey(x) === k);
  return f ? {p:f.p, c:f.c, cont:f.cont || "", lat:f.lat, lon:f.lon, ap:f.ap ? 1 : 0, n:f.n || "", src:"curated"} : null;
};

// Resolve books (summaries with ol/qid/places) to settings. Steps, cheapest first:
// 1 hand-checked → 2 cached (this browser, then shared) → 3 Wikidata narrative location → 4 the library
// catalogue's subject places → 5 places linked in the Wikipedia plot → 6 AI, if switched on → 7 the author's country.
MM.resolveSettings = async function(dets, onStep){
  const keyOf = d => MM.bookKey(d);
  const curated = new Map();
  dets.forEach(d=>{ if(!d) return; const c = MM.curated(d); if(c) curated.set(keyOf(d), c); });
  const weakCached = s => s && s.src === "author" && ((MM.wikiPlotSetting && !s.wikiTried) || (MM.aiSetting && !s.aiTried));
  const isNeeded = d => d && !curated.has(keyOf(d)) && (!MM.settingCache.get(keyOf(d)) || weakCached(MM.settingCache.get(keyOf(d))));
  let need = dets.filter(isNeeded);
  if(MM.remoteSettings && need.length){
    try{ const got = await MM.remoteSettings(need.map(keyOf)); Object.keys(got).forEach(k=>MM.settingCache.put(k, got[k])); }catch(e){}
    need = need.filter(isNeeded);
  }
  const fresh = {};
  const put = (d, s) => { MM.settingCache.put(keyOf(d), s); if(["wikidata","subjects","wikipedia"].includes(s.src)) fresh[keyOf(d)] = s; };
  if(need.length){
    // Wikidata items: from Open Library's own link, else through the work's Open Library id.
    const missing = need.filter(d=>!d.qid && d.ol);
    if(missing.length){ const q = await MM.qidsForWorks(missing.map(d=>d.ol)); missing.forEach(d=>{ if(q[d.ol]) d.qid = q[d.ol]; }); }
    const wd = await MM.wikidataSettings(need.map(d=>d.qid));
    const rest = [];
    need.forEach(d=>{ const w = d.qid && wd[d.qid]; if(w && !w.ap) put(d, w); else { if(w) d.wdCountry = w; rest.push(d); } });
    // The catalogue's subject places, all books at once.
    const subj = MM.subjectSettings ? await MM.subjectSettings(rest).catch(()=>({})) : {};
    const rest2 = [];
    rest.forEach(d=>{ const s = subj[keyOf(d)]; if(s && !s.ap) put(d, s); else { d.subjCountry = s || null; rest2.push(d); } });
    // Authors' countries for the last resort, all at once.
    const ac = await MM.authorCountries(rest2.map(d=>d.qid).filter(Boolean));
    rest2.forEach(d=>{ d.authorCountries = (d.qid && ac[d.qid]) || []; });
    let done = 0;
    await MM.pool(rest2, 2, async d=>{
      let s = null;
      if(MM.wikiPlotSetting){ try{ s = await MM.wikiPlotSetting(d); }catch(e){} }
      if(s && s.ap && (d.wdCountry || d.subjCountry)) s = null;       // a recorded country beats a guess from the plot
      if(!s && MM.aiSetting){ try{ s = await MM.aiSetting(d); }catch(e){} }
      if(!s) s = d.wdCountry || d.subjCountry || null;
      if(!s){ s = MM.fallbackSetting(d); if(s) s = Object.assign({}, s, {wikiTried: MM.wikiPlotSetting ? 1 : 0, aiTried: MM.aiSetting ? 1 : 0}); }
      if(s) put(d, s);
      done++; if(onStep) onStep(done, rest2.length);
    });
  }
  if(MM.saveRemoteSettings && Object.keys(fresh).length){ try{ await MM.saveRemoteSettings(fresh); }catch(e){} }
  return dets.map(d=>d ? (curated.get(keyOf(d)) || MM.settingCache.get(keyOf(d))) : null);
};

/* ---------------- more books set in the same place ---------------- */
let isoMap = null;
const ISO_EXTRA = {"unitedstatesofamerica":"US","usa":"US","unitedkingdom":"GB","england":"GB","scotland":"GB","wales":"GB","southkorea":"KR","korea":"KR","northkorea":"KP","russia":"RU","sovietunion":"RU","russianempire":"RU","czechia":"CZ","czechrepublic":"CZ","turkey":"TR","turkiye":"TR","vietnam":"VN","iran":"IR","syria":"SY","laos":"LA","bolivia":"BO","venezuela":"VE","tanzania":"TZ","moldova":"MD","palestine":"PS","taiwan":"TW","eastgermany":"DE","westgermany":"DE","nazigermany":"DE","demrepcongo":"CD","congo":"CG","ivorycoast":"CI","cotedivoire":"CI","bosniaandherz":"BA","dominicanrep":"DO","centralafricanrep":"CF","ssudan":"SS","macedonia":"MK","northmacedonia":"MK","eswatini":"SZ","eqguinea":"GQ","wsahara":"EH","solomonis":"SB","hongkong":"HK","macau":"MO"};
MM.isoFor = function(name){
  if(!name) return null;
  if(!isoMap){
    isoMap = Object.assign({}, ISO_EXTRA);
    try{
      const dn = new Intl.DisplayNames(["en"], {type:"region"});
      for(let a=65; a<91; a++) for(let b=65; b<91; b++){
        const code = String.fromCharCode(a, b);
        try{ const n = dn.of(code); if(n && n !== code) isoMap[MM.norm(n)] = isoMap[MM.norm(n)] || code; }catch(e){}
      }
    }catch(e){}
  }
  return isoMap[MM.norm(name)] || isoMap[MM.norm(MM.geoName(name))] || isoMap[MM.norm(MM.displayCountry(name))] || null;
};
// "More set in Buenos Aires": well-loved books the library catalogue files under the same place, then
// the same country, then more by the same author.
async function placeBooks(q){
  const key = "bm-like3:" + MM.norm(q);
  let list = lsGet(key, null);
  if(!list){
    const d = await olFetch(`/search.json?q=${encodeURIComponent(q)}&lang=en&sort=editions&fields=${FIELDS}&limit=30`).catch(()=>null);
    list = (d && d.docs || []).map(fromDoc).filter(b=>b && b.coverId && b.a).map(b=>({ol:b.ol, t:b.t, a:b.a, y:b.y, coverId:b.coverId, qid:b.qid, places:b.places}));
    if(list.length) lsSet(key, list.slice(0, 24));
  }
  return list;
}
MM.similarFrom = async function(f, exclude){
  const self = f.ol, seen = new Set();
  // Other books by the same writer (and translations of this one) only show under "More by".
  const pick = (list, byAuthor) => list.filter(m=>m.ol !== self && !seen.has(m.ol) && !(exclude && exclude(m)) && (byAuthor || MM.norm(firstAuthor(m.a)) !== MM.norm(firstAuthor(f.a || "")))).slice(0, 8);
  const tries = [];
  // "Haymarket, Saint Petersburg" → Saint Petersburg (the last part that isn't the country).
  const parts = String(f.p || "").split(",").map(s=>s.trim()).filter(s=>s && MM.norm(s) !== MM.norm(f.c));
  const city = !f.ap && parts.length ? parts[parts.length - 1] : "";
  if(city) tries.push([`place:"${city}"`, "More set in " + city]);
  if(f.c) tries.push([`place:"${MM.displayCountry(f.c)}"`, "More set in " + MM.displayCountry(f.c)]);
  if(f.a) tries.push([`author:"${firstAuthor(f.a)}"`, "More by " + firstAuthor(f.a)]);
  for(const [q, heading] of tries){
    const list = pick(await placeBooks(q), q.startsWith("author:"));
    if(list.length >= 3) return {list, heading};
  }
  return {list:[], heading:""};
};

// Continent of a country (by its ISO code), for pins whose source didn't say.
const CONT_CODES = {"Europe":"AD AL AT AX BA BE BG BY CH CZ DE DK EE ES FI FO FR GB GG GI GR HR HU IE IM IS IT JE LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SJ SK SM UA XK VA",
  "Asia":"AE AF AM AZ BD BH BN BT CC CN CX CY GE HK ID IL IN IO IQ IR JO JP KG KH KP KR KW KZ LA LB LK MM MN MO MV MY NP OM PH PK PS QA SA SG SY TH TJ TL TM TR TW UZ VN YE",
  "North America":"AG AI AW BB BL BM BQ BS BZ CA CR CU CW DM DO GD GL GP GT HN HT JM KN KY LC MF MQ MS MX NI PA PM PR SV TC TT US VC VG VI",
  "Africa":"AO BF BI BJ BW CD CF CG CI CM CV DJ DZ EG EH ER ET GA GH GM GN GQ GW KE KM LR LS LY MA MG ML MR MU MW MZ NA NE NG RE RW SC SD SH SL SN SO SS ST SZ TD TG TN TZ UG YT ZA ZM ZW",
  "Antarctica":"AQ BV HM", "South America":"AR BO BR CL CO EC FK GF GS GY PE PY SR UY VE",
  "Oceania":"AS AU CK FJ FM GU KI MH MP NC NF NR NU NZ PF PG PW SB TK TO TV VU WF WS"};
const CONT_BY_ISO = {}; Object.entries(CONT_CODES).forEach(([c, codes])=>codes.split(" ").forEach(k=>CONT_BY_ISO[k] = c));
MM.continentOf = c => CONT_BY_ISO[MM.isoFor(c)] || "";

/* ---------------- avatar colour ---------------- */
MM.avatarColor = function(name){
  const pal = ["#BF4E2A","#56663A","#3E7590","#A0712A","#7A4E7E","#2F6F62"];
  let h = 0; for(const ch of String(name||"")) h = (h*31 + ch.charCodeAt(0)) >>> 0;
  return pal[h % pal.length];
};
})();
