// TheBookMap location pipeline v2: the one question Claude is asked about each book.
// Shared by the test bench (location-test) and, once it wins the test, the live pipeline.
// The rules mirror the Project doc location-pipeline-v2.md; edit them here.

export const PROMPT_VERSION = "v2.1";

export function locationPrompt(b: { title: string; author: string; year?: number | null; description?: string | null }) {
  return `You help a website put every book a reader has read on a world map.

Book: ${b.title}${b.author ? ` by ${b.author}` : ""}${b.year ? ` (first published ${b.year})` : ""}
Catalogue description: ${b.description ? b.description.slice(0, 1500) : "(none)"}

Use what you know about this book; the description is only a hint and may be a publisher's blurb.

STEP 1. Sort the book into one type:
- "real": the book happens somewhere real on Earth. Includes novels, history, travel, biography, memoir, reportage, and science fiction or fantasy set in the real world (1984 is in London).
- "invented": the book happens in an invented world or in space (Middle-earth, Westeros, Arrakis, a starship, a far planet).
- "none": the book has no physical setting: philosophy, self-help, maths, science explainers, essays on ideas, most poetry collections.

STEP 2. Answer for that type:
- real: "main" is where most of the book happens, as specific as you can honestly be: a city or site if the book is centred there, otherwise the state, province or region where most of it happens. Never stop at the country: if the book is spread across a whole country, pick the state/province/region it spends the most time in or that matters most to it; if no part dominates, use the state/province where the author was based when writing, and list the others in "candidates". If the book moves between places, list them in story order in "journey" with a short note each (e.g. "Born in Ajaccio, 1769"); otherwise leave "journey" empty. For biographies and memoirs, use where most of the life in the book takes place. An invented town that stands in for a real place (Maycomb for Monroeville, Alabama; Macondo for Aracataca) counts as real: give the real place in "main" and the invented name in "invented_name".
- invented: give the world's name in "world". Leave "main" null.
- none: "main" is the author's location (at least the state/province, ideally the city), weighed in this order: where they were based when they wrote this book; then where they spent most of their working life; then their citizenship; birthplace counts least. (Jacques Derrida, born in Algeria, career in Paris: Paris.) Say which of these you used in "author_basis".

Place names must be real names a map can find: "Salinas Valley", "Oklahoma", "Anhui", "Paris". Never a description ("Route 66 corridor", "rural England", "an unnamed island"): put descriptions in "why". "region" is always the state, province or equivalent first-level division (or null only for a city-state). "country" is always one modern country. If the setting is unnamed (a fictional farm, an island at sea), give the real region the book implies or the author had in mind.

STEP 3. Be honest about what you know:
- "known": "well" if you know this book itself; "description" if you are working mainly from the description and the author; "guessing" if you are not sure. Never present a guess as certain.
- "ambiguous": true only when two or more places are equally defensible as the main one (a memoir split evenly between cities). Put them all in "candidates", main first.

Reply with only this JSON object, no other text:
{"type": "real" | "invented" | "none",
 "main": {"place": "most specific place name", "region": "state or province", "country": "modern country, in English", "precision": "site" | "city" | "region"} | null,
 "invented_name": "string or null",
 "journey": [{"place": "...", "country": "...", "note": "under 12 words"}],
 "world": "string or null",
 "author_basis": "writing" | "career" | "citizenship" | "birthplace" | null,
 "known": "well" | "description" | "guessing",
 "ambiguous": true | false,
 "candidates": [{"place": "...", "country": "..."}],
 "why": "one sentence, under 30 words"}`;
}

// Finds every complete top-level {...} in the reply and keeps the LAST valid answer: a model sometimes writes
// the JSON, then a correction and the JSON again.
export function parseAnswer(text: string): Record<string, unknown> | null {
  let found: Record<string, unknown> | null = null;
  for (let i = text.indexOf("{"); i !== -1; i = text.indexOf("{", i + 1)) {
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) { end = j; break; }
    }
    if (end === -1) break;
    try {
      const a = JSON.parse(text.slice(i, end + 1));
      if (a && typeof a === "object" && ["real", "invented", "none"].includes(a.type)) found = a;
    } catch { /* not JSON; keep looking */ }
    i = end;
  }
  return found;
}
