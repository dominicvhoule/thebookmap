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

  // ---------- What each world is like ----------
  // A short description and a shape for well-known worlds, so each island looks a little like its world:
  // kind = continent | tall (a long north–south continent) | island | twin (two lands) | archipelago | disc |
  //        planet | moon | flat | city | realm;  land = mixed | forest | desert | ice | mountains | storm | red | dream | rock.
  const PROFILES = {
    "Middle-earth": {kind:"continent", land:"mixed", desc:"Tolkien's old continent of shires, forests and mountains, with the dark land of Mordor in the east."},
    "Narnia": {kind:"realm", land:"forest", desc:"A kingdom of talking animals, woods and long winters, reached through a wardrobe."},
    "Discworld": {kind:"disc", land:"mixed", desc:"A flat world riding on four elephants and a giant turtle, with the city of Ankh-Morpork at its heart."},
    "Westeros": {kind:"tall", land:"mixed", desc:"A long continent of rival kingdoms, from the Wall in the frozen north to the deserts of Dorne."},
    "Arrakis": {kind:"planet", land:"desert", desc:"A desert planet of endless dunes, giant sandworms and the spice everyone wants."},
    "Earthsea": {kind:"archipelago", land:"mixed", desc:"Hundreds of islands scattered across an open ocean, where knowing a thing's true name is power."},
    "Roshar": {kind:"planet", land:"storm", desc:"A world of stone and shell, scoured by highstorms that sweep in from the east."},
    "Randland": {kind:"continent", land:"mixed", desc:"A continent of old kingdoms between the Blight in the north and the sea, turning on the Wheel of Time."},
    "Alagaësia": {kind:"continent", land:"mountains", desc:"A land of dragon riders, elven forests and the vast Beor Mountains."},
    "Prythian": {kind:"island", land:"forest", desc:"A faerie land of seven courts, each bound to a season or a time of day."},
    "Erilea": {kind:"continent", land:"mixed", desc:"A continent ruled from Adarlan's glass castle, where magic has been outlawed."},
    "Temerant": {kind:"continent", land:"mixed", desc:"The Four Corners of Civilization, home to the University and the city of Imre."},
    "The Grishaverse": {kind:"continent", land:"ice", desc:"Ravka, Kerch and Fjerda: Grisha magic, smugglers' harbours and the frozen Ice Court."},
    "Mid-World": {kind:"continent", land:"desert", desc:"A dying world that has \"moved on\", crossed by a lone gunslinger chasing the man in black."},
    "Lusitania": {kind:"planet", land:"forest", desc:"A colony planet of grassland and forest, shared with the alien pequeninos."},
    "Mars": {kind:"planet", land:"red", desc:"Bradbury's Mars of dry canals and old cities, settled by people from a doomed Earth."},
    "Camazotz": {kind:"planet", land:"dream", desc:"A grey planet where everyone moves in perfect step, under the control of IT."},
    "Faerie": {kind:"realm", land:"forest", desc:"A magical land that lies beyond the wall of the village of Wall."},
    "Elfhame": {kind:"archipelago", land:"forest", desc:"Enchanted islands of the High Court of Faerie, hidden from mortal eyes."},
    "Flatland": {kind:"flat", land:"rock", desc:"A world of only two dimensions, peopled by lines, triangles and polygons."},
    "Florin and Guilder": {kind:"twin", land:"mixed", desc:"Two rival kingdoms of princes, pirates and the Cliffs of Insanity."},
    "The Witcher's Continent": {kind:"continent", land:"forest", desc:"A war-torn continent of quarrelling kingdoms, monsters and elves."},
    "Wonderland": {kind:"realm", land:"dream", desc:"A dream world down a rabbit hole, of mad tea parties and the Queen of Hearts."},
    "Oz": {kind:"realm", land:"mixed", desc:"Four countries around the Emerald City, at the end of the yellow brick road."},
    "Neverland": {kind:"island", land:"forest", desc:"An island where children never grow up, home to pirates, fairies and mermaids."},
    "Camorr": {kind:"city", land:"rock", desc:"A city of canals and thieves, built on towers of ancient alien glass."},
    "Arbre": {kind:"planet", land:"mixed", desc:"A planet where scholars live walled off from the world in mathematical concents."},
    "Castalia": {kind:"realm", land:"mixed", desc:"A secluded province of scholars devoted to the Glass Bead Game."},
    "Artemis": {kind:"moon", land:"rock", desc:"The first city on the Moon: five domes of tourists, workers and smugglers."},
    "Harmont": {kind:"city", land:"rock", desc:"A town beside the Zone, where visitors from space left strange and deadly things behind."},
    "Dr. Seuss's world": {kind:"realm", land:"dream", desc:"Dr. Seuss's bright, rhyming landscape of odd creatures and odder hats."}
  };
  // Worlds without an entry get a shape guessed from their books' notes (desert, planet, islands, ice…).
  MM.worldProfile = function(name, books = []){
    const p = PROFILES[name]; if(p) return p;
    const text = (name + " " + books.map(f=>[f.n, f.p].join(" ")).join(" ")).toLowerCase();
    const has = re => re.test(text);
    const kind = has(/\b(moon|lunar)\b/) ? "moon" : has(/\b(planet|world in space|galaxy|space station|orbit)\b/) ? "planet"
      : has(/\barchipelago|islands\b/) ? "archipelago" : has(/\b(city|town)\b/) ? "city" : has(/\b(island)\b/) ? "island" : "continent";
    const land = has(/desert|dune|sand/) ? "desert" : has(/\b(ice|frozen|snow|winter)\b/) ? "ice" : has(/forest|wood|jungle/) ? "forest"
      : has(/mountain|peak/) ? "mountains" : has(/dream|magic|whimsical/) ? "dream" : "mixed";
    return {kind, land, desc:""};
  };

  // ---------- Shapes ----------
  function smooth(pts){
    const n = pts.length; let d = "";
    for(let i=0; i<n; i++){
      const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
      if(!i) d += `M${p1[0].toFixed(1)},${p1[1].toFixed(1)}`;
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      d += `C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
    }
    return d + "Z";
  }
  function blob(cx, cy, rx, ry, rnd, rough = 1){
    const waves = [2, 3, 5, 7, 11].map(k=>({k, a:rough * (0.04 + rnd() * 0.11) / Math.sqrt(k / 2), ph:rnd() * Math.PI * 2}));
    const pts = [];
    for(let i=0; i<64; i++){
      const t = i / 64 * Math.PI * 2;
      let m = 1; waves.forEach(w=>{ m += w.a * Math.sin(w.k * t + w.ph); });
      pts.push([cx + Math.cos(t) * rx * m, cy + Math.sin(t) * ry * m]);
    }
    return smooth(pts);
  }
  const circle = (cx, cy, r) => `M${(cx - r).toFixed(1)},${cy.toFixed(1)}a${r.toFixed(1)},${r.toFixed(1)} 0 1,0 ${(2 * r).toFixed(1)},0a${r.toFixed(1)},${r.toFixed(1)} 0 1,0 ${(-2 * r).toFixed(1)},0Z`;
  // The land of one world, as SVG path data (may be several pieces), plus extra lines drawn on top.
  function shapeOf(w, prof, spots){
    const rnd = seeded(w.name), {x, y, r} = w;
    switch(prof.kind){
      case "tall": return {d:blob(x, y, r * 0.62, r * 0.98, rnd, 1.1)};
      case "continent": return {d:blob(x, y, r * 1.12, r * 0.8, rnd, 1.15)};
      case "realm": return {d:blob(x, y, r, r * 0.84, rnd, 0.8)};
      case "twin": return {d:blob(x - r * 0.42, y, r * 0.58, r * 0.66, rnd) + blob(x + r * 0.48, y + r * 0.08, r * 0.5, r * 0.6, rnd)};
      case "archipelago": {
        // Islets under each pin, plus a scatter of smaller ones.
        let d = ""; spots.forEach(([px, py])=>{ d += blob(px, py, 18 / PX + r * 0.12, 14 / PX + r * 0.1, rnd); });
        for(let i=0; i<7; i++){ const a = rnd() * Math.PI * 2, rr = r * (0.3 + rnd() * 0.65); d += blob(x + Math.cos(a) * rr * 1.1, y + Math.sin(a) * rr * 0.75, r * (0.07 + rnd() * 0.1), r * (0.06 + rnd() * 0.08), rnd); }
        return {d};
      }
      case "disc": return {d:circle(x, y, r * 0.92), extra:`<path d="${circle(x, y, r * 0.8)}" class="wrim"/><path d="${circle(x, y, Math.max(3 / PX, r * 0.07))}" class="whub"/>`};
      case "planet": return {d:circle(x, y, r * 0.86), extra:`<path d="M${(x + r * 0.1).toFixed(1)},${(y - r * 0.85).toFixed(1)}a${(r * 0.86).toFixed(1)},${(r * 0.86).toFixed(1)} 0 0,1 0,${(r * 1.7).toFixed(1)}a${(r * 0.55).toFixed(1)},${(r * 0.86).toFixed(1)} 0 0,0 0,${(-r * 1.7).toFixed(1)}Z" class="wshade"/>`};
      case "moon": {
        let craters = ""; for(let i=0; i<5; i++){ const a = rnd() * Math.PI * 2, rr = r * 0.5 * rnd(); craters += `<path d="${circle(x + Math.cos(a) * rr, y + Math.sin(a) * rr, r * (0.06 + rnd() * 0.08))}" class="wcrater"/>`; }
        return {d:circle(x, y, r * 0.7), extra:craters};
      }
      case "flat": { const pts = []; for(let i=0; i<5; i++){ const a = -Math.PI / 2 + i * Math.PI * 2 / 5; pts.push(`${(x + Math.cos(a) * r).toFixed(1)},${(y + Math.sin(a) * r * 0.86).toFixed(1)}`); } return {d:`M${pts.join("L")}Z`}; }
      case "city": {
        let grid = ""; for(let i=-2; i<=2; i++){ grid += `<path d="M${(x + i * r * 0.22).toFixed(1)},${(y - r * 0.5).toFixed(1)}v${(r).toFixed(1)}M${(x - r * 0.55).toFixed(1)},${(y + i * r * 0.18).toFixed(1)}h${(r * 1.1).toFixed(1)}" class="wgrid"/>`; }
        return {d:blob(x, y, r * 0.72, r * 0.6, rnd, 0.6), extra:grid};
      }
      default: return {d:blob(x, y, r, r * 0.82, rnd)};
    }
  }
  // A few marks for the kind of land: mountains, trees, dunes, ice, storms. Sized in screen pixels.
  function landMarks(w, prof){
    const rnd = seeded(w.name + "~"), u = 1 / PX, {x, y, r} = w, out = [];
    if(["moon", "flat", "city", "archipelago"].includes(prof.kind)) return "";
    const spot = () => { const a = rnd() * Math.PI * 2, rr = r * (0.2 + rnd() * 0.45); return [x + Math.cos(a) * rr, y + Math.sin(a) * rr * 0.7]; };
    const n = Math.max(3, Math.min(8, Math.round(r * PX / 14)));
    const mountain = () => { const [mx, my] = spot(), h = (5 + rnd() * 3) * u; out.push(`<path d="M${(mx - h).toFixed(1)},${my.toFixed(1)}l${h.toFixed(1)},${(-h * 1.15).toFixed(1)}l${h.toFixed(1)},${(h * 1.15).toFixed(1)}" class="wm"/>`); };
    const tree = () => { const [tx, ty] = spot(); out.push(`<path d="${circle(tx, ty, (2.2 + rnd()) * u)}" class="wt"/>`); };
    const dune = () => { const [dx, dy] = spot(), l = (7 + rnd() * 5) * u; out.push(`<path d="M${(dx - l).toFixed(1)},${dy.toFixed(1)}q${(l / 2).toFixed(1)},${(-l / 2.5).toFixed(1)} ${l.toFixed(1)},0t${l.toFixed(1)},0" class="wd"/>`); };
    const ice = () => { const [ix, iy] = spot(), l = (5 + rnd() * 4) * u; out.push(`<path d="M${(ix - l).toFixed(1)},${iy.toFixed(1)}h${(2 * l).toFixed(1)}M${(ix - l / 2).toFixed(1)},${(iy + 3 * u).toFixed(1)}h${l.toFixed(1)}" class="wi"/>`); };
    const storm = () => { const [sx, sy] = spot(), l = (6 + rnd() * 4) * u; out.push(`<path d="M${(sx - l).toFixed(1)},${sy.toFixed(1)}a${l.toFixed(1)},${(l * 0.6).toFixed(1)} 0 1,1 ${(l * 1.4).toFixed(1)},${(l * 0.3).toFixed(1)}" class="wd"/>`); };
    const star = () => { const [qx, qy] = spot(), l = (2.5 + rnd() * 1.5) * u; out.push(`<path d="M${(qx - l).toFixed(1)},${qy.toFixed(1)}h${(2 * l).toFixed(1)}M${qx.toFixed(1)},${(qy - l).toFixed(1)}v${(2 * l).toFixed(1)}" class="wd"/>`); };
    const mix = {mixed:[mountain, tree, tree], forest:[tree, tree, tree, mountain], desert:[dune], ice:[ice, mountain], mountains:[mountain, mountain, tree],
      storm:[storm, mountain], red:[dune, mountain], dream:[star, tree], rock:[mountain]}[prof.land] || [mountain];
    for(let i=0; i<n; i++) mix[i % mix.length]();
    return out.join("");
  }

  // Does a book (or its world) match the search box?
  const fold = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  MM.worldMatch = (q, f, world, prof) => !q || [f && f.t, f && f.a, f && f.p, world, prof && prof.desc].some(v=>fold(v).includes(q));

  // Draw the map into `el`, in the Earth map's style: the same sea, land and border colours (they follow dark
  // mode), uppercase map lettering, and the same pin buttons. Books at the same place in a world share one pin
  // with a count, as on Earth. Each world's land is shaped and marked a little like the world itself.
  // books: the books on it; opts.selected: the open book; opts.world: the island whose list is open;
  // opts.query: search text (non-matching worlds and pins fade); opts.focus: a world to scroll into view;
  // opts.icon: the pin's book icon; opts.onBook(f); opts.onWorld(world).
  MM.renderWorlds = function(el, books, opts = {}){
    const cw = el.clientWidth || 1000, ch = el.clientHeight || 640;
    W = cw < 640 ? 640 : 1000;
    // The chart is as wide as the map and at least as tall; when the islands don't fit at a readable size
    // (many worlds on a phone), it grows taller and scrolls inside the map area.
    const s = cw / W, ox = 0, oy = 0;
    H = Math.round(W * ch / cw);
    PX = s;
    const top = el.getBoundingClientRect().top;
    const clear = [".mapbar", ".wsearch:not([hidden]) input"].map(q=>el.parentElement && el.parentElement.querySelector(q)).filter(Boolean)
      .reduce((m, n)=>Math.max(m, n.getBoundingClientRect().bottom - top), 74);
    TOP = Math.max(60, (clear + 16) / s);
    BOTTOM = 24 / s;
    const byWorld = new Map();
    books.filter(MM.inOtherWorld).forEach(f=>{
      const name = MM.worldName(f.w);
      if(!byWorld.has(name)) byWorld.set(name, {name, books:[]});
      byWorld.get(name).books.push(f);
    });
    const list = [...byWorld.values()].sort((a,b)=>b.books.length - a.books.length || a.name.localeCompare(b.name));
    if(!list.length){
      el.innerHTML = `<div class="worlds-empty"><b>No other worlds yet</b><span>Books set in invented worlds, like Middle-earth or Narnia, appear here as islands.</span></div>`;
      return;
    }
    let worlds = null;
    for(let grow = 0; grow < 8 && !worlds; grow++){ worlds = layout(list, 0.6); if(!worlds) H = Math.round(H * 1.2); }
    if(!worlds) worlds = layout(list, 0.5, true);
    const q = fold(opts.query || "").trim();
    const at = (x, y) => `left:${(ox + x * s).toFixed(1)}px;top:${(oy + y * s).toFixed(1)}px`;
    let islands = "", overlay = "";
    const spots = [];
    worlds.forEach(w=>{
      const prof = w.prof = MM.worldProfile(w.name, w.books);
      const worldHit = !!q && MM.worldMatch(q, null, w.name, prof);
      const anyHit = !q || worldHit || w.books.some(f=>MM.worldMatch(q, f));
      // One pin per place within the world (or one for the whole world), like books sharing a spot on Earth.
      const byPlace = new Map();
      w.books.forEach(f=>{ const k = MM.norm ? MM.norm(f.p || "") : String(f.p || "").toLowerCase(); if(!byPlace.has(k)) byPlace.set(k, []); byPlace.get(k).push(f); });
      const groups = [...byPlace.values()];
      const where = pinSpots(w, groups.length);
      const shape = shapeOf(w, prof, where);
      islands += `<g class="wworld${anyHit ? "" : " dim"}${worldHit ? " hit" : ""}"><path d="${shape.d}" class="land t-${prof.land}${opts.world === w.name ? " on" : ""}" data-world="${esc(w.name)}"/>${shape.extra || ""}${landMarks(w, prof)}</g>`;
      where.forEach(([x, y], i)=>{
        const g = groups[i], lone = g.length === 1, sel = !!opts.selected && g.includes(opts.selected);
        const approx = g.every(f=>f.ap), hit = !q || worldHit || g.some(f=>MM.worldMatch(q, f));
        spots.push({w, g});
        overlay += `<button type="button" class="gpin wp${lone ? "" : " many"}${sel ? " sel" : ""}${approx ? " approx" : ""}${hit ? "" : " dim"}" data-s="${spots.length - 1}" style="${at(x, y)}"
          aria-label="${esc(g.map(f=>f.t).join(", "))}" title="${esc(lone ? g[0].t + (g[0].p ? " · " + g[0].p : "") : g.length + " books" + (g[0].p ? " · " + g[0].p : ""))}"><span class="b">${lone ? (opts.icon || "") : `<b>${g.length}</b>`}</span></button>`;
      });
      const ly = prof.kind === "tall" ? w.y + w.r * 0.98 : prof.kind === "moon" ? w.y + w.r * 0.7 : w.y + w.r * 0.86;
      overlay += `<button type="button" class="wlabel${anyHit ? "" : " dim"}" data-world="${esc(w.name)}" style="${at(w.x, ly + 8 / s)}">${esc(w.name)}<span>${w.books.length} book${w.books.length === 1 ? "" : "s"}</span></button>`;
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
    // Bring a searched-for world into view when the chart scrolls (phones).
    const fw = opts.focus && flat.get(opts.focus);
    if(fw && el.scrollHeight > el.clientHeight) el.scrollTo({top:Math.max(0, fw.y * s - el.clientHeight / 2), behavior:"smooth"});
  };
})();
