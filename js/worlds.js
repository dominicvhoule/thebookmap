// TheBookMap: "Other worlds", the fantasy map.
// Books set in invented worlds (Middle-earth, Narnia, Discworld…) can't go on the Earth map, so they get their
// own chart: an old-atlas sea with one island per world. Books in the same world (a series) share an island, and
// an island grows with the number of books on it. Each book is a pin on its island; tap one to open the book.
//
// A book is on this map when it has `w` (the world's name) and no coordinates. `p` may name the place within the
// world (the Shire, Hogwarts…). Drawn as one SVG, so it's sharp at any size and needs no tiles.
(function(){
  const MM = window.MM = window.MM || {};

  // One name per world, so a series' books land on the same island even when Claude names it slightly differently.
  const ALIAS = {
    "westeros and essos":"Westeros", "the known world":"Westeros", "dune universe":"Arrakis", "rakis":"Arrakis",
    "the wheel of time world":"Randland", "wheel of time world":"Randland", "randland":"Randland", "the westlands":"Randland",
    "the continent":"The Witcher's Continent", "the witcher world":"The Witcher's Continent",
    "the four corners of civilization":"Temerant", "dr seusss whimsical world":"Dr. Seuss's world",
    "dr seusss unnamed whimsical landscape":"Dr. Seuss's world", "grishaverse":"The Grishaverse", "ravka":"The Grishaverse"
  };
  const key = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  MM.worldName = function(raw){
    let s = String(raw || "").trim();
    if(!s) return "";
    const whole = ALIAS[key(s)]; if(whole) return whole;
    s = s.replace(/\s*\([^)]*\)\s*/g, " ").replace(/^the world of\s+/i, "").replace(/\s+/g, " ").trim();
    const k = key(s);
    if(ALIAS[k]) return ALIAS[k];
    for(const a in ALIAS) if(k.startsWith(a + " ") || k === a) return ALIAS[a];
    return s;
  };
  MM.inOtherWorld = f => !!(f && f.w && !isFinite(f.lat));

  // Small seeded random numbers, so each world always gets the same coastline.
  function seeded(str){
    let h = 2166136261;
    for(let i=0; i<str.length; i++){ h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return () => { h += 0x6D2B79F5; let t = h; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }
  // An island outline: a circle pushed in and out by a few waves, smoothed into a closed curve.
  function coast(cx, cy, r, rnd, scale = 1){
    const waves = [2, 3, 5, 7].map(k=>({k, a:(0.05 + rnd() * 0.12) / Math.sqrt(k / 2), ph:rnd() * Math.PI * 2}));
    const n = 56, pts = [];
    for(let i=0; i<n; i++){
      const t = i / n * Math.PI * 2;
      let m = 1; waves.forEach(w=>{ m += w.a * Math.sin(w.k * t + w.ph); });
      pts.push([cx + Math.cos(t) * r * m * scale, cy + Math.sin(t) * r * m * 0.82 * scale]);
    }
    let d = "";
    for(let i=0; i<n; i++){
      const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
      if(!i) d += `M${p1[0].toFixed(1)},${p1[1].toFixed(1)}`;
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      d += `C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
    }
    return d + "Z";
  }
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

  // Islands laid out on a fixed chart, biggest first, each in the free spot nearest the middle.
  let W = 1000, H = 640;   // the chart's size; set to the screen's shape on each draw
  let TOP = 130, BOTTOM = 24, PX = 1;   // space kept clear for the map's toolbar (top); PX: screen pixels per chart unit
  function layout(worlds, minScale, force){
    // Try full-size islands first; if they don't all fit, shrink them a little and try again.
    for(let scale = 1; scale >= minScale; scale *= 0.9){ const out = tryLayout(worlds, scale); if(out) return out; }
    return force ? tryLayout(worlds, minScale, true) : null;
  }
  function tryLayout(worlds, scale, force){
    const placed = [];
    for(let i=0; i<worlds.length; i++){
      const w = worlds[i];
      const r = Math.min(130, 34 + 20 * Math.sqrt(w.books.length)) * scale;
      let best = null;
      for(let step=0; step<1600 && !best; step++){
        const a = step * 2.399963, d = 6 * Math.sqrt(step) * 3.2;
        const x = W / 2 + Math.cos(a) * d * 1.45, y = (TOP + H - BOTTOM) / 2 + Math.sin(a) * d * 0.95;
        if(x - r < 20 || x + r > W - 20 || y - r * 0.85 < TOP || y + r * 0.85 + 40 / PX > H - BOTTOM) continue;
        // Each island needs room for itself and its name underneath (names are about 8.8 units a letter).
        const hw = Math.max(r * 1.08, (w.name.length * 3.9 + 10) / PX);
        if(x - hw < 30 || x + hw > W - 30) continue;
        const lh = 40 / PX;
        if(placed.every(p=>Math.abs(p.x - x) > p.hw + hw + 8 || (y + r * 0.85 + lh < p.y - p.r * 0.85 - 6) || (p.y + p.r * 0.85 + lh < y - r * 0.85 - 6))) best = {x, y, hw};
      }
      if(!best && !force) return null;
      if(!best) best = {x: 80 + (i * 137) % (W - 160), y: TOP + (i * 89) % Math.max(60, H - TOP - BOTTOM), hw: r};
      placed.push(Object.assign(w, best, {r}));
    }
    return placed;
  }
  // Pins inside an island: a sunflower spiral, so any number fits evenly.
  function pinSpots(w, n){
    const out = [];
    const spread = n === 1 ? 0 : Math.max(w.r * 0.55, 15 * Math.sqrt(n) / PX);
    for(let i=0; i<n; i++){
      const rr = spread * Math.sqrt((i + 0.5) / n), a = i * 2.399963;
      out.push([w.x + Math.cos(a) * rr * 1.05, w.y + Math.sin(a) * rr * 0.78]);
    }
    return out;
  }

  // Draw the map into `el`, in the Earth map's style: the same sea, land and border colours (they follow dark
  // mode), uppercase map lettering, and the same pin buttons. Books at the same place in a world share one pin
  // with a count, as on Earth.
  // books: the books on it; opts.selected: the open book; opts.world: the island whose list is open;
  // opts.icon: the pin's book icon; opts.onBook(f); opts.onWorld(world).
  MM.renderWorlds = function(el, books, opts = {}){
    const cw = el.clientWidth || 1000, ch = el.clientHeight || 640;
    W = cw < 640 ? 640 : 1000;
    // The chart is as wide as the map and at least as tall; when the islands don't fit at a readable size
    // (many worlds on a phone), it grows taller and scrolls inside the map area.
    const s = cw / W, ox = 0, oy = 0;
    H = Math.round(W * ch / cw);
    PX = s;
    const bar = el.parentElement && el.parentElement.querySelector(".mapbar");
    TOP = Math.max(60, ((bar ? bar.getBoundingClientRect().bottom - el.getBoundingClientRect().top : 90) + 16) / s);
    BOTTOM = 24 / s;
    const byWorld = new Map();
    books.filter(MM.inOtherWorld).forEach(f=>{
      const name = MM.worldName(f.w);
      if(!byWorld.has(name)) byWorld.set(name, {name, books:[]});
      byWorld.get(name).books.push(f);
    });
    const list = [...byWorld.values()].sort((a,b)=>b.books.length - a.books.length || a.name.localeCompare(b.name));
    let worlds = null;
    for(let grow = 0; grow < 8 && !worlds; grow++){ worlds = layout(list, 0.6); if(!worlds) H = Math.round(H * 1.2); }
    if(!worlds) worlds = layout(list, 0.5, true);
    if(!list.length){
      el.innerHTML = `<div class="worlds-empty"><b>No other worlds yet</b><span>Books set in invented worlds, like Middle-earth or Narnia, appear here as islands.</span></div>`;
      return;
    }
    const at = (x, y) => `left:${(ox + x * s).toFixed(1)}px;top:${(oy + y * s).toFixed(1)}px`;
    let islands = "", overlay = "";
    const spots = [];
    worlds.forEach(w=>{
      const d = coast(w.x, w.y, w.r, seeded(w.name));
      islands += `<path d="${d}" class="land${opts.world === w.name ? " on" : ""}" data-world="${esc(w.name)}"/>`;
      // One pin per place within the world (or one for the whole world), like books sharing a spot on Earth.
      const byPlace = new Map();
      w.books.forEach(f=>{ const k = MM.norm ? MM.norm(f.p || "") : String(f.p || "").toLowerCase(); if(!byPlace.has(k)) byPlace.set(k, []); byPlace.get(k).push(f); });
      const groups = [...byPlace.values()];
      pinSpots(w, groups.length).forEach(([x, y], i)=>{
        const g = groups[i], lone = g.length === 1, sel = !!opts.selected && g.includes(opts.selected);
        const approx = g.every(f=>f.ap);
        spots.push({w, g});
        overlay += `<button type="button" class="gpin wp${lone ? "" : " many"}${sel ? " sel" : ""}${approx ? " approx" : ""}" data-s="${spots.length - 1}" style="${at(x, y)}"
          aria-label="${esc(g.map(f=>f.t).join(", "))}" title="${esc(lone ? g[0].t : g.length + " books")}"><span class="b">${lone ? (opts.icon || "") : `<b>${g.length}</b>`}</span></button>`;
      });
      overlay += `<button type="button" class="wlabel" data-world="${esc(w.name)}" style="${at(w.x, w.y + w.r * 0.82 + 8 / s)}">${esc(w.name)}<span>${w.books.length} book${w.books.length === 1 ? "" : "s"}</span></button>`;
    });
    el.innerHTML = `<div class="wcanvas" style="height:${Math.round(H * s)}px"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Map of other worlds: ${worlds.length} invented world${worlds.length === 1 ? "" : "s"}">${islands}</svg><div class="wover">${overlay}</div></div>`;
    const flat = new Map(worlds.map(w=>[w.name, w]));
    el.querySelectorAll(".gpin.wp").forEach(b=>b.onclick = e=>{
      e.stopPropagation();
      const {w, g} = spots[+b.dataset.s];
      if(g.length === 1) opts.onBook && opts.onBook(g[0]); else opts.onWorld && opts.onWorld(w);
    });
    el.querySelectorAll(".wlabel").forEach(b=>b.onclick = ()=>opts.onWorld && opts.onWorld(flat.get(b.dataset.world)));
    el.querySelectorAll("path.land").forEach(p=>p.onclick = ()=>opts.onWorld && opts.onWorld(flat.get(p.dataset.world)));
  };
})();
