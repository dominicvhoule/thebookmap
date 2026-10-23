// BookMap: find where a book is set from two free sources, when Wikidata has no recorded setting.
// 1. The library catalogue's "subject places" (Open Library), e.g. "Saint Petersburg (Russia)".
// 2. The places linked in the book's Wikipedia article ("Setting" or "Plot" section).
// Linked places have coordinates on Wikipedia, which allows these lookups from the browser (origin=*).
(function(){
const API = "https://en.wikipedia.org/w/api.php";
const SECTIONS = [/^setting$/i, /^(plot|plot summary|synopsis|summary|story|storyline|premise|overview|contents)$/i];
// Places too big to be a "setting" on their own.
const TOO_BIG = new Set(["europe","asia","africa","north america","south america","latin america","oceania","antarctica","the americas","americas","middle east","the middle east","western europe","eastern europe","central europe","southeast asia","east asia","south asia","central asia","caribbean","the caribbean","scandinavia","balkans","the balkans","mediterranean","mediterranean sea","mediterranean region","atlantic ocean","pacific ocean","indian ocean","arctic ocean","arctic regions","earth","world","the world","space","outer space","moon","mars","heaven","hell","west (u.s.)","southern states","new england","great plains","british isles"]);
const NATURAL = /( river| mountains| mountain range| range| desert| falls| ocean| sea| gulf| strait| glacier| rainforest| islands?)$|^(gulf|strait|sea|bay) of |^(andes|alps|himalayas|sahara|amazon)$/i;

async function wiki(params){
  const q = new URLSearchParams(Object.assign({format:"json", formatversion:"2", origin:"*"}, params));
  const r = await fetch(API + "?" + q);
  if(!r.ok) throw new Error("wiki-" + r.status);
  return r.json();
}
// Coordinates for Wikipedia page titles, following redirects. → Map(asked title → {lat, lon, title})
async function coordinates(titles){
  const out = new Map();
  for(let i=0; i<titles.length; i+=50){
    const d = await wiki({action:"query", prop:"coordinates", titles:titles.slice(i, i+50).join("|"), redirects:"1", colimit:"max"});
    const back = new Map(); (d.query?.redirects || []).forEach(r=>back.set(r.to, r.from)); (d.query?.normalized || []).forEach(r=>back.set(r.to, r.from));
    (d.query?.pages || []).forEach(p=>{
      const c = (p.coordinates || []).find(x=>x.globe === "earth" || !x.globe);
      if(!c) return;
      let t = p.title; const orig = new Set([t]);
      while(back.has(t)){ t = back.get(t); orig.add(t); }
      orig.forEach(o=>out.set(o, {lat:c.lat, lon:c.lon, title:p.title}));
    });
  }
  return out;
}
const countryNames = () => new Set(Object.keys(MM.centroids).map(n=>n.toLowerCase()));
function isCountry(title){
  const t = title.toLowerCase().replace(/\s*\([^)]*\)$/, "");
  return countryNames().has(t) || countryNames().has(MM.geoName(t).toLowerCase()) || /^(kingdom|republic|empire|state) of /.test(t) || /(empire|soviet union|nazi germany|east germany|west germany|yugoslavia|czechoslovakia)$/.test(t);
}

/* ---------- 1. subject places from the library catalogue ---------- */
// "Saint Petersburg (Russia)", "St. Petersburg Russia", "San Petersburgo (Rusia)" all count for one place.
function subjectCandidates(places){
  const groups = new Map(); let invented = "";
  (places || []).forEach((raw, i)=>{
    let s = String(raw).trim(); if(!s) return;
    if(/imaginary|fictitious|mythical|legendary/i.test(s)){ invented = invented || s.replace(/\s*\([^)]*\)\s*$/, "").trim(); return; }
    const hint = (s.match(/\(([^)]+)\)\s*$/) || [])[1] || "";
    s = s.replace(/\s*\([^)]*\)\s*$/, "").replace(/^St\.?\s+/i, "Saint ").replace(/\s*--.*$/, "").trim();
    if(!s || TOO_BIG.has(s.toLowerCase()) || NATURAL.test(s) || /^(united states|europe|asia)\s/i.test(s) && s.length > 25) return;
    const k = MM.norm(s);
    const g = groups.get(k) || {name:s, hint:"", n:0, first:i};
    g.n++; if(hint && !g.hint && !/^\d/.test(hint)) g.hint = hint;
    groups.set(k, g);
  });
  const list = [...groups.values()].map(g=>Object.assign(g, {country:isCountry(g.name)}));
  list.forEach(g=>g.score = g.n * 3 + (1 - g.first / Math.max(1, (places||[]).length)) * 1.5);
  list.sort((a,b)=>b.score - a.score);
  // Specific places first, then countries.
  return {cands:[...list.filter(g=>!g.country).slice(0, 3), ...list.filter(g=>g.country).slice(0, 1)], invented};
}
MM.subjectSettings = async function(dets){
  const per = new Map(), titles = new Set();
  dets.forEach(d=>{ const c = subjectCandidates(d.places); if(c.cands.length){ per.set(d, c); c.cands.forEach(g=>{ titles.add(g.name); if(g.hint) titles.add(g.name + ", " + g.hint); }); } });
  if(!titles.size) return {};
  const coords = await coordinates([...titles]);
  const out = {};
  per.forEach(({cands, invented}, d)=>{
    for(const g of cands){
      let pt = null;
      // Where the catalogue names the country ("Cambridge (Mass.)"), make sure the place found is there.
      const hinted = g.hint && coords.get(g.name + ", " + g.hint);
      const plain = coords.get(g.name);
      pt = hinted || plain; if(!pt) continue;
      const country = g.country ? MM.displayCountry(MM.geoName(g.name)) : MM.countryAt(pt.lon, pt.lat);
      if(g.country){
        const p = MM.countryPoint(g.name) || [pt.lon, pt.lat];
        out[MM.bookKey(d)] = {p: invented || country, c:country, cont:"", lat:+p[1].toFixed(3), lon:+p[0].toFixed(3), ap:1,
          n: invented ? `${invented} is an invented place, so the pin sits in ${country}.` : "", src:"subjects"};
      } else {
        out[MM.bookKey(d)] = {p:g.name, c:country, cont:"", lat:+pt.lat.toFixed(3), lon:+pt.lon.toFixed(3), ap:0, n:"", src:"subjects"};
      }
      break;
    }
  });
  return out;
};

/* ---------- 2. places linked in the Wikipedia article ---------- */
// The English Wikipedia article for this book: via Wikidata when we have its id, else a careful search.
async function findArticle(det){
  if(det.qid && /^Q\d+$/.test(det.qid)){
    try{
      const r = await fetch(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${det.qid}&props=sitelinks&sitefilter=enwiki&format=json&origin=*`);
      const t = (await r.json())?.entities?.[det.qid]?.sitelinks?.enwiki?.title;
      if(t) return t;
    }catch(e){}
  }
  const title = MM.cleanTitle(det.t).t.replace(/\s*:.*$/, "");
  const author = String(det.a || "").split(/,| & | and /)[0];
  const d = await wiki({action:"query", list:"search", srsearch:`${title} ${author} novel book`, srlimit:"6", srprop:"snippet"});
  const want = MM.norm(title), surname = MM.norm(author.split(" ").pop());
  // Only accept a page that is this book: same title (optionally "(novel)"), and it mentions the author.
  const hit = (d.query?.search || []).find(s=>{
    const base = MM.norm(s.title.replace(/\s*\([^)]*\)\s*$/, ""));
    return base === want && (!surname || MM.norm(s.snippet).includes(surname) || /\((novel|book|novella|memoir|poem)\)/i.test(s.title));
  });
  return hit ? hit.title : null;
}
// Wikitext of the Setting section, else the plot, else the lead.
async function plotWikitext(page){
  const s = await wiki({action:"parse", page, prop:"sections", redirects:"1"});
  const secs = s.parse?.sections || [];
  let sec = null;
  for(const re of SECTIONS){ sec = secs.find(x=>re.test(String(x.line).replace(/<[^>]+>/g, "").trim())); if(sec) break; }
  const w = await wiki({action:"parse", page, prop:"wikitext", section: sec ? sec.index : "0", redirects:"1"});
  return {text: w.parse?.wikitext || "", fromPlot: !!sec};
}
// Score each linked place: how often it (or its displayed name) appears, and how early.
function linkCandidates(wikitext){
  const body = wikitext.replace(/<ref[\s\S]*?(<\/ref>|\/>)/g, "").replace(/\{\{[^{}]*\}\}/g, "");
  const cands = new Map();
  const re = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g;
  let m;
  while((m = re.exec(body))){
    const target = m[1].trim();
    if(/^(file|image|category|wikt|wiktionary):/i.test(target)) continue;
    const shown = (m[2] || m[1]).replace(/'''?/g, "").trim();
    const c = cands.get(target) || {target, shown:new Map(), links:0, first:m.index};
    c.links++; c.shown.set(shown, (c.shown.get(shown) || 0) + 1);
    cands.set(target, c);
  }
  const plain = body.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2").replace(/\[\[([^\]]+)\]\]/g, "$1");
  cands.forEach(c=>{
    const names = new Set([c.target.replace(/\s*\([^)]*\)$/, ""), ...c.shown.keys()].map(n=>n.split(",")[0].trim()).filter(n=>n.length > 2));
    let mentions = 0;
    names.forEach(n=>{ const r = new RegExp("\\b" + n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "g"); mentions = Math.max(mentions, (plain.match(r) || []).length); });
    c.mentions = Math.max(mentions, c.links);
    c.pos = c.first / Math.max(1, body.length);
  });
  return [...cands.values()];
}
MM.wikiPlotSetting = async function(det){
  if(!det || !det.t) return null;
  const page = await findArticle(det);
  if(!page) return null;
  const {text, fromPlot} = await plotWikitext(page);
  if(!text) return null;
  const cands = linkCandidates(text).filter(c=>!TOO_BIG.has(c.target.toLowerCase()) && !NATURAL.test(c.target.replace(/\s*\([^)]*\)$/, "").split(",")[0].trim()));
  if(!cands.length) return null;
  const coords = await coordinates(cands.map(c=>c.target));
  const places = cands.filter(c=>coords.has(c.target)).map(c=>{
    const country = isCountry(c.target);
    const score = c.mentions * (country ? 1 : 3) + (1 - c.pos) * 1.5;
    return Object.assign(c, coords.get(c.target), {country, score});
  });
  if(!places.length) return null;
  places.sort((a,b)=>b.score - a.score);
  const specific = places.filter(p=>!p.country);
  // A specific place wins unless a country is mentioned far more often (a story spread across one country).
  const best = specific.length && specific[0].score * 1.6 >= places[0].score ? specific[0] : places[0];
  const shown = [...best.shown.entries()].sort((a,b)=>b[1]-a[1])[0][0];
  const label = shown.replace(/\s*\([^)]*\)$/, "");
  const country = best.country ? MM.displayCountry(MM.geoName(label)) : MM.countryAt(best.lon, best.lat);
  const others = specific.filter(p=>p !== best).slice(0, 2).map(p=>[...p.shown.keys()][0]);
  return {
    p: label, c: country || "", cont: "",
    lat: +best.lat.toFixed(3), lon: +best.lon.toFixed(3),
    ap: best.country || !fromPlot ? 1 : 0,
    n: others.length ? `Other places in the book: ${others.join(" and ")}.` : "",
    src: "wikipedia"
  };
};
/* ---------- a short summary of the book ---------- */
// What the book is about, in two or three sentences: the opening of its encyclopedia article when that
// describes the story, else the publisher's description, else the start of the plot. Sentences about
// publication, prizes, sales and adaptations are left out; so are the sources' names.
const META = /\b(published|publication|publish|reprint|considered|regarded|acclaimed|hailed|bestsell|best-sell|best sell|award|prize|nominat|adapted|adaptation|translated|translation|installments?|instalments?|serial|serialized|edition|sold|copies|praised|critic|review|banned|film|movie|television|miniseries|ranked|greatest|masterpiece|classic|landmark|debut|sequel|trilogy|series of|volume|imprint|publisher|author of|written by|wrote|his (first|second|third|last|final)|her (first|second|third|last|final)|literary|literature|genre|bestseller|nominee|Wikipedia)(s|es|ed|ing)?\b/i;
const IS_A = /^[^.]{0,160}\b(is|was) an? ([\w-]+ ){0,6}(novel|novella|book|memoir|autobiography|biography|collection|work|story|play|poem|treatise|account|history|study|essay)s?\b/i;
function sentences(text){
  const t = String(text || "").replace(/\s*\[[^\]]*\]\([^)]*\)/g, "").replace(/\[(\d+|[a-z])\]/g, "").replace(/\s*\((?:[^()]*?)(?:Russian|French|German|Spanish|Italian|Japanese|Chinese|Swedish|Portuguese|Arabic|Hebrew|IPA|tr\.|lit\.|pronounced|born|died|\d{4}[–-]\d{4})[^()]*\)/g, "")
    .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, "$1").replace(/\s+/g, " ").trim();
  const raw = t.split(/(?<=[.!?]["”’)]?)\s+(?=["“(]?[A-Z0-9])/);
  const out = [];
  raw.forEach(s=>{ const prev = out[out.length - 1]; if(prev && /\b(Mr|Mrs|Ms|Dr|St|Jr|Sr|vs|Lt|Col|Gen|Sgt|Capt|[A-Z])\.$/.test(prev)) out[out.length - 1] = prev + " " + s; else out.push(s); });
  return out.map(s=>s.trim()).filter(s=>s.length > 20);
}
const english = s => { const w = (" " + s.toLowerCase() + " ").match(/ (the|and|of|to|a|in|is|his|her|who|with|as|for|on) /g); return (w || []).length >= Math.min(4, s.split(" ").length / 8); };
function story(text, keepIsA){
  return sentences(text).filter((s,i)=>!META.test(s) && (keepIsA || !IS_A.test(s)));
}
function trimTo(list){
  let out = "";
  for(const s of list){ if(out && (out + " " + s).length > 430) break; out = out ? out + " " + s : s; if(out.length > 300) break; }
  return out.length > 430 ? out.slice(0, 427).replace(/\s+\S*$/, "") + "…" : out;
}
async function wikiSummaryText(page){
  const d = await wiki({action:"query", prop:"extracts", explaintext:"1", exsectionformat:"wiki", titles:page, redirects:"1"});
  const text = (d.query?.pages || [])[0]?.extract || "";
  const lead = text.split(/\n==[^=]/)[0];
  const sec = text.match(/\n==\s*(Plot|Plot summary|Synopsis|Summary|Premise|Story|Storyline|Overview|Content|Contents)\s*==\n([\s\S]*?)(?=\n==[^=]|$)/i);
  return {lead, plot: sec ? sec[2].replace(/\n===[^=]+===\n/g, " ") : ""};
}
MM.bookSummary = async function(b){
  if(!b || !b.t) return "";
  const k = "bm-sum2:" + MM.bookKey(b);
  const hit = MM.lsGet(k, null); if(hit !== null) return hit;
  let det = b;
  if(!det.ol && !det.qid){ const m = await MM.matchBook(b).catch(()=>null); if(m) det = Object.assign({}, m, {t:b.t, a:b.a}); }
  if(!det.qid && det.ol){ const q = await MM.qidsForWorks([det.ol]).catch(()=>({})); if(q[det.ol]) det = Object.assign({}, det, {qid:q[det.ol]}); }
  const [page, ol] = await Promise.all([findArticle(det).catch(()=>null), det.ol ? MM.bookDetails(det).catch(()=>null) : null]);
  const w = page ? await wikiSummaryText(page).catch(()=>({lead:"", plot:""})) : {lead:"", plot:""};
  // The publisher's description, unless it's in another language or just a copy of the encyclopedia.
  const blurb = ol && ol.ov && !/wikipedia/i.test(ol.ov) && english(ol.ov) ? ol.ov : "";
  const pick = [story(w.lead), story(blurb, true), story(w.plot, true)].find(l=>l.join(" ").length >= 80) || [];
  const out = trimTo(pick);
  if(out || page) MM.lsSet(k, out);  // don't remember a miss caused by a failed lookup
  return out;
};
// Setting notes from older versions named their source; keep only what the place line doesn't say.
MM.cleanNote = function(n, place){
  let s = String(n || "")
    .replace(/,?\s*(from|according to) the (book's |)Wikipedia (article|plot summary)\.?/gi, ".")
    .replace(/,?\s*as the library catalogue records it\.?/gi, ".")
    .replace(/\s*Also mentions ([^.]+)\./, " Other places in the book: $1.")
    .replace(/\.\./g, ".").trim();
  return s;
};
})();
