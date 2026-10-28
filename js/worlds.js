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
  let TOP = 130, BOTTOM = 96;   // keep islands clear of the map's toolbar (top) and the title (bottom)
  function layout(worlds){
    // Try full-size islands first; if they don't all fit, shrink them a little and try again.
    for(let scale = 1; scale > 0.25; scale *= 0.9){ const out = tryLayout(worlds, scale); if(out) return out; }
    return tryLayout(worlds, 0.25, true);
  }
  function tryLayout(worlds, scale, force){
    const placed = [];
    for(let i=0; i<worlds.length; i++){
      const w = worlds[i];
      const r = Math.min(120, 30 + 19 * Math.sqrt(w.books.length)) * scale;
      let best = null;
      for(let step=0; step<1600 && !best; step++){
        const a = step * 2.399963, d = 6 * Math.sqrt(step) * 3.2;
        const x = W / 2 + Math.cos(a) * d * 1.45, y = (TOP + H - BOTTOM) / 2 + Math.sin(a) * d * 0.95;
        if(x - r < 40 || x + r > W - 40 || y - r * 0.85 < TOP || y + r * 0.85 + 34 > H - BOTTOM) continue;
        // Each island needs room for itself and its name underneath (names are about 8.8 units a letter).
        const hw = Math.max(r * 1.08, w.name.length * 4.5 + 6);
        if(x - hw < 30 || x + hw > W - 30) continue;
        if(placed.every(p=>Math.abs(p.x - x) > p.hw + hw + 8 || (y + r * 0.85 + 40 < p.y - p.r * 0.85 - 6) || (p.y + p.r * 0.85 + 40 < y - r * 0.85 - 6))) best = {x, y, hw};
      }
      if(!best && !force) return null;
      if(!best) best = {x: 80 + (i * 137) % (W - 160), y: TOP + (i * 89) % Math.max(60, H - TOP - BOTTOM), hw: r};
      placed.push(Object.assign(w, best, {r}));
    }
    return placed;
  }
  // Book pins inside an island: a sunflower spiral, so any number fits evenly.
  function pinSpots(w){
    const n = w.books.length, out = [];
    const spread = w.r * (n === 1 ? 0 : 0.62);
    for(let i=0; i<n; i++){
      const rr = spread * Math.sqrt((i + 0.5) / n), a = i * 2.399963;
      out.push([w.x + Math.cos(a) * rr * 1.05, w.y + Math.sin(a) * rr * 0.78]);
    }
    return out;
  }

  function compass(x, y, s){
    const pt = (a, l) => [x + Math.sin(a) * l, y - Math.cos(a) * l];
    let d = "";
    for(let i=0; i<8; i++){
      const a = i * Math.PI / 4, l = i % 2 ? s * 0.55 : s, w = s * 0.13;
      const tip = pt(a, l), left = pt(a - Math.PI / 2, w), right = pt(a + Math.PI / 2, w);
      d += `<path d="M${x},${y}L${left[0]},${left[1]}L${tip[0]},${tip[1]}Z" class="wc-dark"/><path d="M${x},${y}L${right[0]},${right[1]}L${tip[0]},${tip[1]}Z" class="wc-light"/>`;
    }
    const n = pt(0, s + 13);
    return `<g class="wc" aria-hidden="true"><circle cx="${x}" cy="${y}" r="${s * 0.72}" class="wc-ring"/>${d}<text x="${n[0]}" y="${n[1]}" text-anchor="middle">N</text></g>`;
  }
  function waves(rnd){
    let out = "";
    for(let i=0; i<26; i++){
      const x = 40 + rnd() * (W - 80), y = 80 + rnd() * (H - 120), s = 7 + rnd() * 6;
      out += `<path d="M${x},${y}q${s / 2},-${s / 2.4} ${s},0t${s},0" class="wv"/>`;
    }
    return out;
  }

  // Draw the chart into `el`. books: the books on it; opts.selected: the open book; opts.onBook(f); opts.onWorld(world).
  MM.renderWorlds = function(el, books, opts = {}){
    const cw = el.clientWidth || 1000, ch = el.clientHeight || 640;
    W = cw < 640 ? 640 : 1000;
    H = Math.round(Math.min(W * 1.6, Math.max(W * 0.56, W * ch / cw)));
    const bar = el.parentElement && el.parentElement.querySelector(".mapbar");
    TOP = Math.max(90, ((bar ? bar.getBoundingClientRect().bottom - el.getBoundingClientRect().top : 90) + 14) * W / cw);
    const byWorld = new Map();
    books.filter(MM.inOtherWorld).forEach(f=>{
      const name = MM.worldName(f.w);
      if(!byWorld.has(name)) byWorld.set(name, {name, books:[]});
      byWorld.get(name).books.push(f);
    });
    const worlds = layout([...byWorld.values()].sort((a,b)=>b.books.length - a.books.length || a.name.localeCompare(b.name)));
    if(!worlds.length){
      el.innerHTML = `<div class="worlds-empty"><b>No other worlds yet</b><span>Books set in invented worlds, like Middle-earth or Narnia, appear here as islands.</span></div>`;
      return;
    }
    const sea = seeded("sea");
    let islands = "", pins = "", labels = "";
    worlds.forEach(w=>{
      const rnd = seeded(w.name);
      const d = coast(w.x, w.y, w.r, rnd);
      const ripple1 = coast(w.x, w.y, w.r, seeded(w.name), 1.16), ripple2 = coast(w.x, w.y, w.r, seeded(w.name), 1.32);
      const hills = [];
      const nh = Math.min(6, Math.floor(w.r / 22));
      for(let i=0; i<nh; i++){
        const a = rnd() * Math.PI * 2, rr = w.r * (0.25 + rnd() * 0.35);
        const hx = w.x + Math.cos(a) * rr, hy = w.y + Math.sin(a) * rr * 0.7, hs = 5 + rnd() * 4;
        hills.push(`<path d="M${(hx - hs).toFixed(1)},${hy.toFixed(1)}l${hs},-${(hs * 1.2).toFixed(1)}l${hs},${(hs * 1.2).toFixed(1)}" class="hill"/>`);
      }
      const sel = opts.world === w.name;
      islands += `<g class="isl${sel ? " on" : ""}" data-world="${esc(w.name)}" tabindex="0" role="button" aria-label="${esc(w.name)}, ${w.books.length} book${w.books.length === 1 ? "" : "s"}">
        <path d="${ripple2}" class="rip r2"/><path d="${ripple1}" class="rip"/>
        <path d="${d}" class="land"/><path d="${d}" class="shore"/>${hills.join("")}</g>`;
      pinSpots(w).forEach(([x, y], i)=>{
        const f = w.books[i], on = opts.selected === f;
        pins += `<g class="wpin${on ? " on" : ""}" data-world="${esc(w.name)}" data-i="${i}" tabindex="0" role="button" aria-label="${esc(f.t)}${f.p ? ", " + esc(f.p) : ""}">
          <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${on ? 8 : 6}"/><title>${esc(f.t)}${f.p ? " · " + esc(f.p) : ""}</title></g>`;
      });
      const ly = w.y + w.r * 0.82 + 20;
      labels += `<text class="wl" x="${w.x.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle">${esc(w.name)}</text>
        <text class="wn" x="${w.x.toFixed(1)}" y="${(ly + 15).toFixed(1)}" text-anchor="middle">${w.books.length} book${w.books.length === 1 ? "" : "s"}</text>`;
    });
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Map of other worlds: ${worlds.length} invented world${worlds.length === 1 ? "" : "s"}">
      <defs>
        <filter id="wpaper" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" seed="4" result="n"/><feColorMatrix in="n" type="matrix" values="0 0 0 0 0.35  0 0 0 0 0.27  0 0 0 0 0.14  0 0 0 .09 0"/><feComposite in2="SourceGraphic" operator="over"/></filter>
        <radialGradient id="wvig" cx="50%" cy="50%" r="70%"><stop offset="60%" stop-color="#000" stop-opacity="0"/><stop offset="100%" stop-color="#5a3d12" stop-opacity=".22"/></radialGradient>
      </defs>
      <rect width="${W}" height="${H}" class="paper"/><rect width="${W}" height="${H}" filter="url(#wpaper)" fill="transparent"/><rect width="${W}" height="${H}" fill="url(#wvig)"/>
      <rect x="14" y="14" width="${W - 28}" height="${H - 28}" class="frame"/><rect x="20" y="20" width="${W - 40}" height="${H - 40}" class="frame thin"/>
      <g aria-hidden="true">${waves(sea)}</g>
      ${compass(W - 84, H - 84, 34)}
      <text class="wtitle" x="44" y="${H - 58}">Other Worlds</text>
      <text class="wsub" x="46" y="${H - 38}">${books.filter(MM.inOtherWorld).length} books in ${worlds.length} invented world${worlds.length === 1 ? "" : "s"}</text>
      ${islands}${labels}${pins}
    </svg>`;
    const flat = new Map(worlds.map(w=>[w.name, w]));
    el.querySelectorAll(".wpin").forEach(g=>{
      const go = e=>{ e.stopPropagation(); opts.onBook && opts.onBook(flat.get(g.dataset.world).books[+g.dataset.i]); };
      g.onclick = go; g.onkeydown = e=>{ if(e.key === "Enter" || e.key === " "){ e.preventDefault(); go(e); } };
    });
    el.querySelectorAll(".isl").forEach(g=>{
      const go = ()=>opts.onWorld && opts.onWorld(flat.get(g.dataset.world));
      g.onclick = go; g.onkeydown = e=>{ if(e.key === "Enter" || e.key === " "){ e.preventDefault(); go(); } };
    });
  };
})();
