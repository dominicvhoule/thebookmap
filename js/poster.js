// BookMap poster: draws a print-ready poster of a map onto a canvas.
// Numbered pins on a world map, with a key of places and titles underneath.
(function(){
const SIZES = {
  "18x24": {label:"18 × 24 in", w:3600, h:4800, pdf:{unit:"in", format:[18,24]}},
  "a2":    {label:"A2 (42 × 59.4 cm)", w:3600, h:5091, pdf:{unit:"mm", format:"a2"}},
  "a3":    {label:"A3 (29.7 × 42 cm)", w:3600, h:5091, pdf:{unit:"mm", format:"a3"}}
};
const THEMES = {
  library: {label:"Library", bg:"#EEF0EB", ink:"#18231F", muted:"#5B6863", rule:"#CDD3CC", ocean:"#CBD8DC", land:"#F7F6F1", border:"#A8B4AE", grat:"#B7C8CD", visited:"#E9D9B1", pin:"#2B3F9E", series:"#2B3F9E", ring:"#F7F6F1", num:"#FFFFFF"},
  swiss: {label:"Swiss", bg:"#FFFFFF", ink:"#111111", muted:"#6E6E6E", rule:"#111111", ocean:"#FFFFFF", land:"#E6E6E6", border:"#FFFFFF", grat:"#FFFFFF", visited:"#111111", pin:"#E4002B", series:"#E4002B", ring:"#FFFFFF", num:"#FFFFFF"},
  paper: {label:"Paper", bg:"#EDEFEA", ink:"#1C2733", muted:"#5D6A72", rule:"#C9CFC6", ocean:"#D3DFE3", land:"#F7F5EE", border:"#AEB9B2", grat:"#C2D2D8", visited:"#EFD9A7", pin:"#BF4E2A", series:"#3E7590", ring:"#F7F5EE", num:"#FFFFFF"},
  night: {label:"Night", bg:"#141B21", ink:"#E7EBE6", muted:"#9AA7AE", rule:"#2E3A43", ocean:"#0F1E27", land:"#26323A", border:"#3E4D55", grat:"#1A2C36", visited:"#5A5232", pin:"#E8714A", series:"#7FB2CB", ring:"#141B21", num:"#141B21"},
  sand:  {label:"Sand", bg:"#E9DFCB", ink:"#2B241B", muted:"#6E604C", rule:"#CDBF9F", ocean:"#CBD3C6", land:"#F3ECDC", border:"#B9A983", grat:"#BFC8B9", visited:"#E3B969", pin:"#8E3B1E", series:"#3D5A6B", ring:"#F3ECDC", num:"#FFFFFF"}
};
MM.POSTER_SIZES = SIZES; MM.POSTER_THEMES = THEMES;

// One typeface throughout, in the Swiss manner.
const SANS = `"Helvetica Neue", Helvetica, "Nimbus Sans", Arial, sans-serif`;
const F = {
  display: w => `700 ${w}px ${SANS}`,
  body: (w, wt) => `${wt||400} ${w}px ${SANS}`,
  mono: (w, wt) => `${wt||500} ${w}px ${SANS}`
};
MM.posterFontsReady = async function(){
  try{
    await document.fonts.ready;
  }catch(e){}
};

function fitText(ctx, text, font, maxW, startPx, minPx){
  let px = startPx;
  ctx.font = font(px);
  while(ctx.measureText(text).width > maxW && px > minPx){ px -= 4; ctx.font = font(px); }
  return px;
}
function ellipsize(ctx, text, maxW){
  if(ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while(s.length > 1 && ctx.measureText(s + "…").width > maxW) s = s.slice(0, -1);
  return s.trimEnd() + "…";
}
function spaced(ctx, text, x, y, spacing){   // letter-spaced label
  for(const ch of text){ ctx.fillText(ch, x, y); x += ctx.measureText(ch).width + spacing; }
}

/**
 * opts: {title, subtitle, films, countries (topojson features), theme, size, showKey, isSeries(f), geoName(c), url}
 */
MM.renderPoster = function(opts){
  const S = SIZES[opts.size] || SIZES["18x24"], T = THEMES[opts.theme] || THEMES.paper;
  const W = S.w, H = S.h, M = Math.round(W * 0.06);
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = T.bg; ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = "alphabetic";

  // ---- header
  let y = M + 40;
  ctx.fillStyle = T.pin; ctx.fillRect(M, y - 36, 44, 44);   // the red square
  ctx.fillStyle = T.ink; ctx.font = F.body(48, 700);
  ctx.fillText("TheBookMap", M + 72, y);
  ctx.fillStyle = T.muted; ctx.font = F.body(48, 400);
  ctx.fillText("See the world one book at a time", M + 72 + ctx.measureText("TheBookMap  ").width + 40, y);
  y += 60;
  ctx.fillStyle = T.rule; ctx.fillRect(M, y, W - 2*M, 4);
  y += 30;
  const title = opts.title;
  if("letterSpacing" in ctx) ctx.letterSpacing = "-12px";
  const tpx = fitText(ctx, title, F.display, W - 2*M, 360, 140);
  y += tpx * 0.9;
  ctx.fillStyle = T.ink; ctx.font = F.display(tpx); ctx.fillText(title, M - tpx*0.04, y);
  if("letterSpacing" in ctx) ctx.letterSpacing = "0px";
  y += 90;
  ctx.font = F.body(64, 400); ctx.fillStyle = T.muted;
  ctx.fillText(ellipsize(ctx, opts.subtitle, W - 2*M), M, y);
  y += 70;

  // ---- map
  const mapW = W - 2*M, mapH = Math.round(mapW * 0.5);
  const mapTop = y;
  const proj = d3.geoEqualEarth().fitExtent([[M, mapTop], [M + mapW, mapTop + mapH]], {type:"Sphere"});
  const path = d3.geoPath(proj, ctx);
  ctx.beginPath(); path({type:"Sphere"}); ctx.fillStyle = T.ocean; ctx.fill();
  ctx.beginPath(); path(d3.geoGraticule10()); ctx.strokeStyle = T.grat; ctx.lineWidth = 2; ctx.stroke();
  const visited = new Set(opts.films.map(f=>opts.geoName(f.c)));
  opts.countries.forEach(c=>{
    ctx.beginPath(); path(c);
    ctx.fillStyle = visited.has(c.properties.name) ? T.visited : T.land; ctx.fill();
    ctx.strokeStyle = T.border; ctx.lineWidth = 1.6; ctx.stroke();
  });
  ctx.beginPath(); path({type:"Sphere"}); ctx.strokeStyle = T.border; ctx.lineWidth = 3; ctx.stroke();

  // One pin per place (books at the same spot share it), numbered west to east so the key reads like the map.
  const R = 30, groups = [];
  opts.films.filter(f=>isFinite(f.lat) && isFinite(f.lon)).forEach(f=>{
    let g = groups.find(g=>Math.abs(g.lat - f.lat) < 0.35 && Math.abs(g.lon - f.lon) < 0.35);
    if(!g){ g = {lat:f.lat, lon:f.lon, films:[]}; groups.push(g); }
    g.films.push(f);
  });
  groups.forEach(g=>{ [g.x0, g.y0] = proj([g.lon, g.lat]); g.x = g.x0; g.y = g.y0; });
  groups.sort((a,b)=>a.x0 - b.x0 || a.y0 - b.y0).forEach((g,i)=>{
    g.n = i + 1;
    const places = [...new Set(g.films.map(f=>f.p || f.c))];
    g.place = places.join(" · ");
    const c = g.films[0].c || "";
    g.country = c && !places.some(p=>p.includes(c)) ? c : "";
  });
  // Nudge overlapping pins apart; each keeps a thin leader line to its true spot.
  for(let it=0; it<120; it++){
    let moved = false;
    for(let i=0; i<groups.length; i++) for(let j=i+1; j<groups.length; j++){
      const a = groups[i], b = groups[j];
      let dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
      const min = 2*R + 6;
      if(d < min){
        if(d < 0.01){ dx = 1; dy = 0; d = 1; }
        const push = (min - d) / 2;
        a.x -= dx/d*push; a.y -= dy/d*push; b.x += dx/d*push; b.y += dy/d*push; moved = true;
      }
    }
    // gentle pull back toward the true spot
    groups.forEach(g=>{ g.x += (g.x0 - g.x) * 0.02; g.y += (g.y0 - g.y) * 0.02; });
    if(!moved) break;
  }
  groups.forEach(g=>{
    if(Math.hypot(g.x - g.x0, g.y - g.y0) > 8){
      ctx.beginPath(); ctx.moveTo(g.x0, g.y0); ctx.lineTo(g.x, g.y); ctx.strokeStyle = T.ink; ctx.globalAlpha = .55; ctx.lineWidth = 3; ctx.stroke(); ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.arc(g.x0, g.y0, 7, 0, Math.PI*2); ctx.fillStyle = T.ink; ctx.fill();
    }
  });
  groups.forEach(g=>{
    const series = g.films.every(opts.isSeries);
    const approx = g.films.every(f=>f.ap);
    ctx.beginPath();
    if(series) ctx.roundRect(g.x - R, g.y - R, 2*R, 2*R, 8); else ctx.arc(g.x, g.y, R, 0, Math.PI*2);
    ctx.fillStyle = series ? T.series : T.pin; ctx.fill();
    ctx.lineWidth = 6; ctx.strokeStyle = T.ring; ctx.setLineDash(approx ? [10, 7] : []); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = T.num; ctx.font = F.mono(g.n > 99 ? 22 : 28, 600); ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(String(g.n), g.x, g.y + 1);
    ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  });
  y = mapTop + mapH + 90;

  // ---- key
  const footH = 150;
  const keyBottom = H - M - footH;
  if(opts.showKey && groups.length){
    ctx.fillStyle = T.rule; ctx.fillRect(M, y - 40, W - 2*M, 3);
    const cols = 3, gap = 70, colW = (W - 2*M - gap*(cols-1)) / cols;
    const rowH = 132;
    const maxRows = Math.max(1, Math.floor((keyBottom - y) / rowH));
    const rows = Math.min(maxRows, Math.ceil(groups.length / cols));   // balance the columns
    const cap = cols * rows;
    const shown = groups.length > cap ? groups.slice(0, cap - 1) : groups;
    shown.forEach((g,i)=>{
      const col = Math.floor(i / rows), row = i % rows;
      const x = M + col * (colW + gap), yy = y + row * rowH + 40;
      ctx.fillStyle = T.pin; ctx.font = F.mono(36, 600);
      ctx.fillText(String(g.n).padStart(2, "0"), x, yy);
      const tx = x + 92, tw = colW - 92;
      ctx.fillStyle = T.ink; ctx.font = F.body(40, 600);
      ctx.fillText(ellipsize(ctx, g.place + (g.country ? ", " + g.country : ""), tw), tx, yy);
      ctx.fillStyle = T.muted; ctx.font = F.body(34, 400);
      ctx.fillText(ellipsize(ctx, g.films.map(f=>f.t).join(" · "), tw), tx, yy + 48);
    });
    if(groups.length > cap){
      const i = cap - 1, col = Math.floor(i / rows), row = i % rows;
      ctx.fillStyle = T.muted; ctx.font = F.body(40, 600);
      ctx.fillText(`+ ${groups.length - cap + 1} more places`, M + col * (colW + gap) + 92, y + row * rowH + 40);
    }
  }

  // ---- footer
  const fy = H - M;
  ctx.fillStyle = T.rule; ctx.fillRect(M, fy - footH + 40, W - 2*M, 3);
  ctx.fillStyle = T.muted; ctx.font = F.body(40, 400);
  ctx.fillText(opts.url || "", M, fy - 20);
  const date = new Date().toLocaleDateString("en-US", {month:"long", year:"numeric"});
  ctx.textAlign = "right"; ctx.fillText(date, W - M, fy - 20); ctx.textAlign = "left";
  return cv;
};
function spacedRight(ctx, text, right, y, spacing){
  ctx.textAlign = "left";
  let w = 0; for(const ch of text) w += ctx.measureText(ch).width + spacing;
  spaced(ctx, text, right - w + spacing, y, spacing);
}
})();
