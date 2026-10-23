// Poster: draws a print-ready, landscape poster of a map onto a canvas.
// One pin per country (sized or numbered), a list by country, and stats. Four layouts:
// Departure Board, Passport, Atlas Index and Marquee. The same file runs TheMovieMap and TheBookMap;
// only BRAND (colours, type, mark, words) differs between the two.
(function(){
/* ======================= site brand ======================= */
const BRAND = {
  name:"THEBOOKMAP", noun:"book", nouns:"books",
  words:{eyebrowA:"WHERE MY BOOKS TOOK ME", passport:"READING PASSPORT", atlas:"AN ATLAS OF", marquee:"READ IN", span:"YEARS OF WRITING", dest:"DESTINATION"},
  c:{dark:"#17362F", darkLand:"#24493F", darkDeep:"#0F2620", accent:"#C9971C", hot:"#8C2F39", light:"#FAFAF7", paleOcean:"#CBD8DC", paleLand:"#E6E9E2",
     soft:"#5B6863", mutedOnDark:"#B9C9C1", line:"#DDE2DA", atlasBg:"#EEF0EB", border:"#A8B4AE", mqLand:"#DDB24A", mqVisited:"#F6E7B8", onAccent:"#17362F"},
  f:{display:"Libre Bodoni", displayWeight:700, upper:true, body:"Literata", bodyMax:600, mono:"Spline Sans Mono", monoMax:500},
  fonts:["700 100px 'Libre Bodoni'","600 100px Literata","500 100px Literata","400 100px Literata","500 100px 'Spline Sans Mono'","400 100px 'Spline Sans Mono'"],
  mark(ctx, x, y, s, onDark){        // an open book with a map pin
    const k = s / 34; ctx.save(); ctx.translate(x, y + 2*k); ctx.scale(k, k);
    if(!onDark){ ctx.fillStyle = BRAND.c.dark; ctx.fillRect(-1, -3, 36, 34); }
    ctx.fillStyle = "#EEF0EB"; ctx.fill(new Path2D("M2 5c5-2 10-2 15 1v22c-5-3-10-3-15-1Z"));
    ctx.fillStyle = BRAND.c.accent; ctx.fill(new Path2D("M32 5c-5-2-10-2-15 1v22c5-3 10-3 15-1Z"));
    ctx.fillStyle = BRAND.c.dark; ctx.beginPath(); ctx.arc(24.5, 13, 3.4, 0, Math.PI*2); ctx.fill();
    ctx.strokeStyle = BRAND.c.dark; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(24.5, 16.4); ctx.lineTo(24.5, 21.4); ctx.stroke();
    ctx.restore();
  }
};
/* ===================== end site brand ===================== */

// Landscape sizes. Layouts are drawn on a 900-unit-tall grid and scaled up.
const SIZES = {
  "24x18": {label:"24 × 18 in", w:4800, h:3600, pdf:{unit:"in", format:[24,18], orientation:"landscape"}},
  "a2":    {label:"A2 landscape (59.4 × 42 cm)", w:5091, h:3600, pdf:{unit:"mm", format:"a2", orientation:"landscape"}},
  "a3":    {label:"A3 landscape (42 × 29.7 cm)", w:5091, h:3600, pdf:{unit:"mm", format:"a3", orientation:"landscape"}}
};
const C = BRAND.c;
const THEMES = {
  departure:{label:"Departure Board", bg:C.dark, pin:C.accent},
  passport: {label:"Passport", bg:C.light, pin:C.hot},
  atlas:    {label:"Atlas Index", bg:C.atlasBg, pin:C.dark},
  marquee:  {label:"Marquee", bg:C.accent, pin:C.hot}
};
MM.POSTER_SIZES = SIZES; MM.POSTER_THEMES = THEMES; MM.POSTER_DEFAULT = "departure";
MM.posterFontsReady = async function(){
  try{ await Promise.all(BRAND.fonts.map(f=>document.fonts.load(f))); await document.fonts.ready; }catch(e){}
};

/* ---------- type helpers (all sizes in layout units) ---------- */
const fam = n => `"${n}", Arial, sans-serif`;
const FD = px => `${BRAND.f.displayWeight} ${px}px ${fam(BRAND.f.display)}`;
const FB = (px, wt) => `${Math.min(wt || 400, BRAND.f.bodyMax)} ${px}px ${fam(BRAND.f.body)}`;
const FM = (px, wt) => `${Math.min(wt || 700, BRAND.f.monoMax)} ${px}px ${fam(BRAND.f.mono)}`;
const up = s => BRAND.f.upper ? String(s).toUpperCase() : String(s);
function txt(ctx, s, x, y, font, color, align, spacing){
  ctx.font = font; ctx.fillStyle = color; ctx.textAlign = align || "left";
  if("letterSpacing" in ctx) ctx.letterSpacing = (spacing || 0) + "px";
  ctx.fillText(s, x, y);
  if("letterSpacing" in ctx) ctx.letterSpacing = "0px";
  ctx.textAlign = "left";
}
function width(ctx, s, font, spacing){ ctx.font = font; if("letterSpacing" in ctx) ctx.letterSpacing = (spacing||0) + "px"; const w = ctx.measureText(s).width; if("letterSpacing" in ctx) ctx.letterSpacing = "0px"; return w; }
function fit(ctx, s, mk, maxW, start, min){ let px = start; while(px > min && width(ctx, s, mk(px)) > maxW) px -= 2; return px; }
function clip(ctx, s, font, maxW){
  ctx.font = font; if(ctx.measureText(s).width <= maxW) return s;
  let t = s; while(t.length > 1 && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1);
  return t.trimEnd() + "…";
}
function wrap(ctx, s, font, maxW){
  ctx.font = font; const words = String(s).split(/\s+/), lines = [];
  let line = "";
  for(const w of words){ const t = line ? line + " " + w : w; if(ctx.measureText(t).width > maxW && line){ lines.push(line); line = w; } else line = t; }
  if(line) lines.push(line); return lines;
}
function rect(ctx, x, y, w, h, color){ ctx.fillStyle = color; ctx.fillRect(x, y, w, h); }

/* ---------- the data a poster needs ---------- */
function summarize(opts){
  const films = opts.films.filter(f=>f && f.t);
  const by = new Map();
  films.forEach(f=>{
    const geo = opts.geoName(f.c || ""); if(!geo) return;
    if(!by.has(geo)) by.set(geo, {geo, name: opts.displayName ? opts.displayName(geo) : (f.c === "Hong Kong" ? "China" : f.c), films:[]});
    by.get(geo).films.push(f);
  });
  const list = [...by.values()].map(g=>{
    const pts = g.films.filter(f=>isFinite(f.lat) && isFinite(f.lon));
    const best = [...g.films].sort((a,b)=>(b.r||0) - (a.r||0) || (b.y||0) - (a.y||0));
    const years = g.films.map(f=>+f.y).filter(Boolean);
    return Object.assign(g, {n:g.films.length, lat: pts.length ? pts.reduce((s,f)=>s+f.lat,0)/pts.length : null, lon: pts.length ? pts.reduce((s,f)=>s+f.lon,0)/pts.length : null,
      top: best[0] ? best[0].t : "", first: years.length ? Math.min(...years) : ""});
  }).sort((a,b)=>b.n - a.n || a.name.localeCompare(b.name));
  const years = films.map(f=>+f.y).filter(y=>y > 0);
  const rated = films.filter(f=>f.r);
  const conts = {}; films.forEach(f=>{ const c = opts.contOf ? opts.contOf(f) : f.cont; if(c) conts[c] = (conts[c] || 0) + 1; });
  const decs = {}; years.forEach(y=>{ const d = Math.floor(y/10)*10; decs[d] = (decs[d] || 0) + 1; });
  return {
    list, n: films.length, countries: list.length, continents: Object.keys(conts).length, conts, decs,
    first: years.length ? Math.min(...years) : "", last: years.length ? Math.max(...years) : "",
    decades: Object.keys(decs).length, avg: rated.length ? (rated.reduce((s,f)=>s + +f.r, 0) / rated.length).toFixed(1) : "",
    pct: Math.min(100, Math.round(list.length / 195 * 100))
  };
}

/* ---------- the map ---------- */
// mode: "count" (pins sized by count, showing it), "index" (numbered like the list), "bubble" (circles by size)
function drawMap(ctx, S, opts, box, st){
  const shapes = opts.countries.filter(c=>c.properties.name !== "Antarctica");
  // Fit the inhabited world (56°S to 84°N) rather than the shapes, whose date-line rings skew the bounds.
  const frame = d3.geoGraticule().extent([[-179.9, -56], [179.9, 84]]).outline();
  const proj = d3.geoNaturalEarth1().fitExtent([[box.x + 4, box.y + 4], [box.x + box.w - 4, box.y + box.h - 4]], frame);
  const path = d3.geoPath(proj, ctx);
  ctx.save(); ctx.beginPath(); ctx.rect(box.x, box.y, box.w, box.h); ctx.clip();
  if(st.ocean) rect(ctx, box.x, box.y, box.w, box.h, st.ocean);
  const vis = new Set(S.list.map(g=>g.geo));
  shapes.forEach(c=>{ ctx.beginPath(); path(c); ctx.fillStyle = vis.has(c.properties.name) ? st.visited : st.land; ctx.fill(); ctx.strokeStyle = st.border; ctx.lineWidth = 0.5; ctx.stroke(); });
  if(st.vline) shapes.forEach(c=>{ if(!vis.has(c.properties.name)) return; ctx.beginPath(); path(c); ctx.strokeStyle = st.vline; ctx.lineWidth = 0.9; ctx.stroke(); });
  // pins: one per country, at the average of its titles' settings
  const pins = S.list.map((g,i)=>({g, i, xy: g.lat == null || g.geo === "Antarctica" ? null : proj([g.lon, g.lat])})).filter(p=>p.xy);
  pins.forEach(p=>{
    p.r = st.mode === "bubble" ? 5 + Math.sqrt(p.g.n) * 6.5 : st.mode === "index" ? 8.5 : 7 + Math.min(7, Math.sqrt(p.g.n) * 2.2);
    p.x0 = p.x = p.xy[0]; p.y0 = p.y = p.xy[1];
  });
  if(st.mode !== "bubble"){   // nudge overlapping pins apart; each keeps a thin leader to its spot
    for(let it=0; it<160; it++){
      let moved = false;
      for(let i=0; i<pins.length; i++) for(let j=i+1; j<pins.length; j++){
        const a = pins[i], b = pins[j]; let dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy); const min = a.r + b.r + 1.5;
        if(d < min){ if(d < 0.01){ dx = 1; dy = 0; d = 1; } const push = (min - d) / 2; a.x -= dx/d*push; a.y -= dy/d*push; b.x += dx/d*push; b.y += dy/d*push; moved = true; }
      }
      pins.forEach(p=>{ p.x += (p.x0 - p.x) * 0.03; p.y += (p.y0 - p.y) * 0.03; });
      if(!moved) break;
    }
    pins.forEach(p=>{ if(Math.hypot(p.x - p.x0, p.y - p.y0) > 3){ ctx.beginPath(); ctx.moveTo(p.x0, p.y0); ctx.lineTo(p.x, p.y); ctx.strokeStyle = st.leader; ctx.lineWidth = 0.8; ctx.stroke(); ctx.beginPath(); ctx.arc(p.x0, p.y0, 1.6, 0, Math.PI*2); ctx.fillStyle = st.leader; ctx.fill(); } });
  }
  [...pins].sort((a,b)=>b.r - a.r).forEach(p=>{
    ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI*2);
    ctx.globalAlpha = st.mode === "bubble" ? 0.82 : 1; ctx.fillStyle = st.pin; ctx.fill(); ctx.globalAlpha = 1;
    ctx.lineWidth = 1.5; ctx.strokeStyle = st.ring; ctx.stroke();
    if(st.mode === "bubble" && p.g.n < 2) return;
    const label = String(st.mode === "index" ? p.i + 1 : p.g.n);
    const px = st.mode === "bubble" ? Math.min(14, 8 + p.g.n) : label.length > 1 ? 9 : 10;
    ctx.textBaseline = "middle"; txt(ctx, label, p.x, p.y + 0.5, FB(px, 800), st.pinText, "center"); ctx.textBaseline = "alphabetic";
  });
  ctx.restore();
}

function logo(ctx, xRight, yBottom, size, color, onDark){
  const font = FB(size * 0.58, 900);
  const w = width(ctx, BRAND.name, font, 0.3);
  BRAND.mark(ctx, xRight - w - size - 8, yBottom - size + size*0.08, size, onDark);
  txt(ctx, BRAND.name, xRight, yBottom - size*0.28, font, color, "right", 0.3);
}
const monthYear = () => new Date().toLocaleDateString("en-US", {month:"long", year:"numeric"}).toUpperCase();
const span = S => S.first && S.last ? (S.first === S.last ? String(S.first) : `${S.first}–${S.last}`) : "";

/* ---------- A · Departure Board ---------- */
function departure(ctx, LW, H, S, opts){
  rect(ctx, 0, 0, LW, H, C.dark);
  const P = 48, colW = 330, colX = LW - P - colW, Lw = colX - 40 - P;
  txt(ctx, `${BRAND.words.eyebrowA}${span(S) ? " · " + span(S) : ""}`, P, 57, FB(13, 700), C.accent, "left", 2.3);
  const title = up(opts.title), tpx = fit(ctx, title, FD, Lw, 86, 40);
  txt(ctx, title, P - 2, 70 + tpx * 0.78, FD(tpx), C.light, "left", -1.5);
  const mapY = 70 + tpx * 0.78 + 26, mapH = Math.min(Lw * 0.56, H - mapY - 150);
  drawMap(ctx, S, opts, {x:P, y:mapY, w:Lw, h:mapH}, {land:C.darkLand, border:C.dark, visited:C.accent, pin:C.hot, pinText:"#FFFFFF", ring:C.dark, leader:C.mutedOnDark, mode:"count"});
  const sy = mapY + mapH + 20; rect(ctx, P, sy, Lw, 3, C.accent);
  const stats = [[S.n, up(S.n === 1 ? BRAND.noun : BRAND.nouns), C.accent], [S.countries, S.countries === 1 ? "COUNTRY" : "COUNTRIES"], [S.pct + "%", "OF THE WORLD"], [S.continents, S.continents === 1 ? "CONTINENT" : "CONTINENTS"], [S.decades, S.decades === 1 ? "DECADE" : "DECADES"]];
  stats.forEach(([v, l, col], i)=>{ const x = P + i * Lw / 5; txt(ctx, String(v), x, sy + 62, FD(52), col || C.light); txt(ctx, l, x, sy + 84, FB(12, 700), C.light, "left", 1); });
  // the board
  txt(ctx, BRAND.words.dest, colX, 56, FM(12), C.accent, "left", 1); txt(ctx, up(BRAND.nouns), colX + colW, 56, FM(12), C.accent, "right", 1);
  rect(ctx, colX, 64, colW, 2, C.accent);
  const rowH = 38, top = 78, maxRows = Math.floor((H - 90 - top - 24) / rowH);
  const rows = S.list.length > maxRows ? S.list.slice(0, maxRows - 1) : S.list;
  rows.forEach((g, i)=>{
    const y = top + i * rowH;
    rect(ctx, colX, y, colW - 48, 22, C.darkDeep);
    txt(ctx, clip(ctx, g.name.toUpperCase(), FM(15), colW - 64), colX + 6, y + 16, FM(15), C.light, "left", 0.6);
    txt(ctx, clip(ctx, g.top, FB(10.5, 500), colW - 60), colX + 6, y + 33, FB(10.5, 500), C.mutedOnDark);
    rect(ctx, colX + colW - 40, y, 40, 22, C.hot);
    txt(ctx, String(g.n), colX + colW - 20, y + 17, FM(18), "#FFFFFF", "center");
  });
  if(S.list.length > rows.length) txt(ctx, `+ ${S.list.length - rows.length} MORE DESTINATIONS`, colX, top + rows.length * rowH + 14, FM(12, 400), C.mutedOnDark);
  logo(ctx, LW - P, H - 30, 26, C.light, true);
}

/* ---------- B · Passport ---------- */
function passport(ctx, LW, H, S, opts){
  rect(ctx, 0, 0, LW, H, C.dark); rect(ctx, 14, 14, LW - 28, H - 28, C.light);
  const P = 44;
  txt(ctx, `${BRAND.words.passport} · ISSUED ${monthYear()}`, P, 62, FB(12, 800), C.hot, "left", 2.4);
  const badgeW = 120, title = up(opts.title);
  // stats to the right of the title, left of the badge
  const stats = [[S.n, up(S.n === 1 ? BRAND.noun : BRAND.nouns)], [S.countries, S.countries === 1 ? "COUNTRY" : "COUNTRIES"], [S.continents, S.continents === 1 ? "CONTINENT" : "CONTINENTS"], S.avg ? [S.avg + "★", "AVERAGE", C.hot] : [S.decades, "DECADES"]];
  let sx = LW - P - badgeW - 24;
  for(let i = stats.length - 1; i >= 0; i--){ const [v, l, col] = stats[i]; const w = Math.max(width(ctx, String(v), FD(34)), width(ctx, l, FB(11, 700), 1.1)); txt(ctx, String(v), sx, 112, FD(34), col || C.dark, "right"); txt(ctx, l, sx, 128, FB(11, 700), C.dark, "right", 1.1); sx -= w + 22; }
  const tpx = fit(ctx, title, FD, sx - P - 10, 58, 28);
  txt(ctx, title, P, 122, FD(tpx), C.dark, "left", -0.5);
  // the logo badge, top right
  rect(ctx, LW - P - badgeW, 44, badgeW, 76, C.dark);
  BRAND.mark(ctx, LW - P - badgeW/2 - 17, 52, 34, true);
  txt(ctx, BRAND.name, LW - P - badgeW/2, 108, FB(11, 900), "#FFFFFF", "center", 0.5);
  const mapY = 142, mapW = LW - 2*P, mapH = Math.min(mapW * 0.456, H - mapY - 236);
  drawMap(ctx, S, opts, {x:P, y:mapY, w:mapW, h:mapH}, {land:C.paleLand, border:"#FFFFFF", visited:C.accent, vline:C.dark, pin:C.hot, pinText:"#FFFFFF", ring:"#FFFFFF", leader:C.soft, mode:"count"});
  // passport stamps for the top countries
  const cols = 8, gap = 12, sw = (mapW - gap*(cols-1)) / cols, sh = 84, y0 = mapY + mapH + 14;
  const stamps = S.list.slice(0, 16), tilt = [-4, 3, -2, 5, -5, 2, -3, 4];
  stamps.forEach((g, i)=>{
    const cx = P + (i % cols) * (sw + gap) + sw/2, cy = y0 + Math.floor(i / cols) * (sh + gap) + sh/2;
    const ink = i % 2 ? C.hot : C.dark, shape = i % 3;
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(tilt[i % 8] * Math.PI / 180);
    ctx.strokeStyle = ink; ctx.lineWidth = 2.5; ctx.beginPath();
    if(shape === 0) ctx.ellipse(0, 0, sw/2 - 4, sh/2 - 2, 0, 0, Math.PI*2); else ctx.roundRect(-sw/2 + 2, -sh/2 + 2, sw - 4, sh - 4, shape === 1 ? 10 : 2);
    ctx.stroke();
    txt(ctx, `ENTRY · ${g.first}`, 0, -22, FB(9, 800), ink, "center", 1.2);
    const lines = wrap(ctx, g.name.toUpperCase(), FB(13, 900), sw - 24).slice(0, 2);
    lines.forEach((l, k)=>txt(ctx, clip(ctx, l, FB(13, 900), sw - 20), 0, (lines.length === 1 ? 2 : -5) + k * 14, FB(13, 900), ink, "center"));
    txt(ctx, String(g.n), 0, 31, FD(20), ink, "center");
    ctx.restore();
  });
  const rest = S.list.slice(16);
  if(rest.length){
    const y = y0 + 2*(sh + gap) + 6;
    let line = "+ ", shown = 0;
    for(const g of rest){ const t = line + (shown ? ", " : "") + g.name; if(width(ctx, t + ` and ${rest.length - shown - 1} more`, FB(11.5, 500)) > mapW) break; line = t; shown++; }
    txt(ctx, line + (rest.length > shown ? ` and ${rest.length - shown} more` : ""), P, y, FB(11.5, 500), C.soft);
  }
}

/* ---------- C · Atlas Index ---------- */
function atlas(ctx, LW, H, S, opts){
  rect(ctx, 0, 0, LW, H, C.atlasBg);
  const P = 40, idxW = 300, Lw = LW - 2*P - 36 - idxW, ix = P + Lw + 36;
  const title = up(opts.title);
  const r1 = `${BRAND.words.atlas} ${S.n} ${up(S.n === 1 ? BRAND.noun : BRAND.nouns)}`, r2 = span(S);
  const rw = Math.max(width(ctx, r1, FB(13, 700), 1.5), width(ctx, r2, FB(13, 700), 1.5));
  const tpx = fit(ctx, title, FD, Lw - rw - 20, 60, 28);
  txt(ctx, title, P, 96, FD(tpx), C.dark, "left", -0.5);
  txt(ctx, r1, P + Lw, 80, FB(13, 700), C.dark, "right", 1.5); txt(ctx, r2, P + Lw, 98, FB(13, 700), C.dark, "right", 1.5);
  rect(ctx, P, 108, Lw, 4, C.dark);
  const mapY = 126, mapH = Math.min(Lw * 0.5125, H - mapY - 210);
  drawMap(ctx, S, opts, {x:P, y:mapY, w:Lw, h:mapH}, {ocean:C.paleOcean, land:"#FFFFFF", border:C.border, visited:C.accent, vline:C.dark, pin:C.dark, pinText:C.accent, ring:"#FFFFFF", leader:C.soft, mode:"index"});
  ctx.strokeStyle = C.dark; ctx.lineWidth = 2; ctx.strokeRect(P + 1, mapY + 1, Lw - 2, mapH - 2);
  // by continent, by decade
  const by = mapY + mapH + 30, half = (Lw - 28) / 2;
  txt(ctx, "BY CONTINENT", P, by, FB(12, 800), C.dark, "left", 1.7);
  const conts = Object.entries(S.conts).sort((a,b)=>b[1] - a[1]), cmax = conts.length ? conts[0][1] : 1;
  conts.slice(0, 7).forEach(([name, n], i)=>{ const y = by + 16 + i * 20; txt(ctx, clip(ctx, name, FB(12.5, 500), 100), P, y + 9, FB(12.5, 500), C.dark); rect(ctx, P + 112, y, half - 150, 10, C.line); rect(ctx, P + 112, y, (half - 150) * n / cmax, 10, i ? C.dark : C.hot); txt(ctx, String(n), P + half, y + 10, FB(12.5, 800), C.dark, "right"); });
  const dx = P + half + 28; txt(ctx, "BY DECADE", dx, by, FB(12, 800), C.dark, "left", 1.7);
  const decs = Object.entries(S.decs).sort((a,b)=>a[0] - b[0]).slice(-12), dmax = Math.max(1, ...decs.map(d=>d[1]));
  const bw = (half - 6 * (decs.length - 1)) / Math.max(1, decs.length), base = by + 132;
  decs.forEach(([d, n], i)=>{ const x = dx + i * (bw + 6), h = Math.max(2, n / dmax * 84); rect(ctx, x, base - h, bw, h, n === dmax ? C.accent : C.dark); if(n === dmax){ ctx.strokeStyle = C.dark; ctx.lineWidth = 1.5; ctx.strokeRect(x, base - h, bw, h); }
    txt(ctx, String(n), x + bw/2, base - h - 5, FB(10.5, 800), C.dark, "center"); txt(ctx, "’" + String(d).slice(-2), x + bw/2, base + 13, FB(10, 500), C.dark, "center"); });
  // the index, numbered like the pins
  txt(ctx, "INDEX", ix, 96, FB(22, 900), C.dark, "left", 0.4);
  txt(ctx, `${S.countries} ${S.countries === 1 ? "COUNTRY" : "COUNTRIES"}`, ix + idxW, 96, FB(12, 700), C.dark, "right");
  rect(ctx, ix, 108, idxW, 4, C.dark);
  const drawn = S.list.filter(g=>g.lat != null && g.geo !== "Antarctica"), others = S.list.filter(g=>!drawn.includes(g));
  const avail = H - 126 - 80, perCol = Math.max(1, Math.ceil(drawn.length / 2)), rh = Math.min(17.4, avail / perCol), fs = Math.min(11, rh * 0.66), cw = (idxW - 14) / 2;
  drawn.forEach((g, i)=>{ const col = Math.floor(i / perCol), row = i % perCol, x = ix + col * (cw + 14), y = 126 + row * rh;
    txt(ctx, String(i + 1), x, y + rh * 0.7, FB(fs, 800), C.hot); txt(ctx, clip(ctx, g.name, FB(fs, 400), cw - 44), x + 22, y + rh * 0.7, FB(fs, 400), C.dark); txt(ctx, String(g.n), x + cw, y + rh * 0.7, FB(fs, 800), C.dark, "right");
    rect(ctx, x, y + rh - 1, cw, 1, C.line); });
  if(others.length) txt(ctx, clip(ctx, "Also: " + others.map(g=>`${g.name} (${g.n})`).join(", ") + ", not drawn.", FB(10.5, 400), idxW), ix, 126 + perCol * rh + 16, FB(10.5, 400), C.soft);
  logo(ctx, LW - P, H - 30, 26, C.dark, false);
}

/* ---------- D · Marquee ---------- */
function marquee(ctx, LW, H, S, opts){
  rect(ctx, 0, 0, LW, H, C.accent);
  const P = 30, title = up(opts.title);
  // the logo badge, top right
  const bfont = FB(15, 900), bw = width(ctx, BRAND.name, bfont, 0.3) + 58;
  rect(ctx, LW - P - bw + 4, P + 4, bw, 46, C.onAccent); rect(ctx, LW - P - bw, P, bw, 46, "#FFFFFF");
  ctx.strokeStyle = C.onAccent; ctx.lineWidth = 3; ctx.strokeRect(LW - P - bw, P, bw, 46);
  BRAND.mark(ctx, LW - P - bw + 10, P + 9, 28, false);
  txt(ctx, BRAND.name, LW - P - 12, P + 29, bfont, C.onAccent, "right", 0.3);
  const eyebrow = `${BRAND.words.marquee} ${S.countries} ${S.countries === 1 ? "COUNTRY" : "COUNTRIES"}`;
  const ew = width(ctx, eyebrow, FB(14, 800), 2.2);
  const tpx = fit(ctx, title, FD, LW - 2*P - bw - ew - 40, 92, 36);
  txt(ctx, title, P - 2, P + tpx * 0.82, FD(tpx), C.onAccent, "left", -2.5);
  txt(ctx, eyebrow, P + width(ctx, title, FD(tpx), -2.5) + 20, P + tpx * 0.82 - 6, FB(14, 800), C.onAccent, "left", 2.2);
  const mapY = P + tpx * 0.82 + 14, mapW = LW - 2*P, mapH = Math.min(mapW * 0.49, H - mapY - 180);
  drawMap(ctx, S, opts, {x:P, y:mapY, w:mapW, h:mapH}, {land:C.mqLand, border:C.accent, visited:C.mqVisited, pin:C.hot, pinText:"#FFFFFF", ring:C.accent, mode:"bubble"});
  const by = mapY + mapH + 10; rect(ctx, P, by, mapW, 4, C.onAccent);
  const statsW = 470, lw = mapW - statsW - 26;
  txt(ctx, "TOP BILLING", P, by + 30, FB(12, 800), C.hot, "left", 1.9);
  let x = P, y = by + 58, shown = 0;
  for(const g of S.list.slice(0, 14)){
    const name = g.name.toUpperCase() + " ", nw = width(ctx, name, FB(22, 900)), w = nw + width(ctx, String(g.n), FB(22, 900)) + 16;
    if(x + w > P + lw){ if(y >= by + 58 + 26) break; x = P; y += 26; }
    txt(ctx, name, x, y, FB(22, 900), C.onAccent); txt(ctx, String(g.n), x + nw, y, FB(22, 900), C.hot);
    x += w; shown++;
  }
  const more = S.list.slice(shown).map(g=>g.name).sort();
  if(more.length) txt(ctx, more.length === 1 ? `and ${more[0]}` : `and ${more.length} more, from ${more[0]} to ${more[more.length - 1]}`, P, y + 24, FB(12.5, 500), C.onAccent);
  const years = S.first && S.last ? S.last - S.first : 0;
  const blocks = [[String(S.n), up(BRAND.nouns), C.onAccent, C.accent], [S.pct + "%", "OF THE WORLD", C.onAccent, C.accent], [years ? String(years) : String(S.decades), years ? BRAND.words.span : "DECADES", C.hot, "#FFFFFF"]];
  const bW = (statsW - 16) / 3;
  blocks.forEach(([v, l, bg, fg], i)=>{ const bx = LW - P - statsW + i * (bW + 8); rect(ctx, bx, by + 18, bW, 74, bg); txt(ctx, v, bx + 12, by + 64, FD(44), fg); txt(ctx, clip(ctx, l, FB(11, 800), bW - 16), bx + 12, by + 84, FB(11, 800), "#FFFFFF", "left", 1.1); });
}

/**
 * opts: {title, films, countries (GeoJSON features), geoName, contOf?, displayName?, theme, size}
 */
MM.renderPoster = function(opts){
  const S0 = SIZES[opts.size] || SIZES["24x18"];
  const layout = {departure, passport, atlas, marquee}[opts.theme] || departure;
  const cv = document.createElement("canvas"); cv.width = S0.w; cv.height = S0.h;
  const ctx = cv.getContext("2d");
  const H = 900, u = S0.h / H, LW = S0.w / u;
  ctx.scale(u, u); ctx.textBaseline = "alphabetic";
  layout(ctx, LW, H, summarize(opts), opts);
  return cv;
};
})();
