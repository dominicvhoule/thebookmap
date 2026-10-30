// TheBookMap location pipeline v2: the one question Claude is asked about each book.
// Shared by the test bench (location-test) and, once it wins the test, the live pipeline.
// The rules mirror the Project doc location-pipeline-v2.md; edit them here.

export const PROMPT_VERSION = "v2.6";

export function locationPrompt(b: { title: string; author: string; year?: number | null; description?: string | null }) {
  return `You help a website put every book a reader has read on a world map.

Book: ${b.title}${b.author ? ` by ${b.author}` : ""}${b.year ? ` (first published ${b.year})` : ""}
Catalogue description: ${b.description ? b.description.slice(0, 1500) : "(none)"}

Use what you know about this book; the description is only a hint and may be a publisher's blurb.

STEP 1. Sort the book into one type:
- "real": the book happens somewhere real on Earth. Includes novels, history, travel, biography, memoir, reportage, and science fiction or fantasy set in the real world (1984 is in London).
- "invented": the book happens in an invented world or in space (Middle-earth, Westeros, Arrakis, a starship, a far planet), OR in a fictional place that cannot be put in any real country (see FICTIONAL PLACES).
- "none": the book has no physical setting: philosophy, self-help, maths, science explainers, essays on ideas, most poetry collections.

STEP 2. Answer for that type:
- real: "main" is the place this book is anchored to. Weigh two things together:
  (a) where the book happens, giving most weight to its most important and impactful parts, not just the page count;
  (b) the place readers associate with the book: how it is known, taught and talked about. This weighs heavily. If readers strongly associate a book with one place, choose that place even if more pages happen somewhere else.
  By kind of book:
  - Novels and other stories: the place readers associate with the book, weighed with where it happens.
  - Journeys (quests, road trips, voyages, migrations): the anchor or origin of the story, where it starts and where the traveller returns, unless a later part of the journey is far bigger and more impactful and is what readers remember the book for; then that place.
  - Memoirs, autobiographies and biographies: the place of the part of the person's life that both the book talks about the most AND people associate with the person. Do not default to where the person was born or grew up just because the book starts there; choose their childhood home only when the book is mainly about growing up and that is what people associate with them.
  Be only as specific as you are certain of: a city or site if the book is clearly anchored there, otherwise the state, province or region. Give a state or province whenever the book can reasonably provide one. Only if the book is about the country in general (a national history, a survey of the whole country) give the country itself, with "precision": "country". If the book moves between places, list them in story order in "journey" with a short note each (e.g. "Born in Ajaccio, 1769"); otherwise leave "journey" empty. FICTIONAL PLACES: if the main place is fictional (an invented town, farm, island or house), readers will see its fictional name, so always give it in "invented_name". Then decide whether you are CONFIDENT of its real physical location. Confident means the book or its author says where it is, or it is widely accepted (Maycomb is Monroeville, Alabama; Hardy's Casterbridge is Dorchester, Dorset). Your own guess does not count. If confident: type "real", the real location in "main", and "real_basis": "stated" (by the book or author) or "accepted". If not confident of the exact place, but the book clearly happens in a real country (an unnamed American suburb, an unnamed English village): type "real", "main" is that country (or the state or region, if the book clearly implies one), "real_basis": "implied", "ambiguous": true, and the fictional name or a short label in "invented_name". Only if the place cannot be put in any real country (an island the book never places, a land that could not be on Earth): type "invented", the fictional name or a short label in "world", "main" null, "real_basis": "unknown".
- invented: give the world's name (or the fictional place's name) in "world". Leave "main" null.
- none: "main" is the author's location (the city, or at least the state/province, where reasonably known), weighed in this order: where they were based when they wrote this book; then where they spent most of their working life; then their citizenship; birthplace counts least. (Jacques Derrida, born in Algeria, career in Paris: Paris.) Say which of these you used in "author_basis". If you do not know where the author is based, give the author's country (where they are from or publish), with "precision": "country" and "ambiguous": true. Never leave "main" empty for a "none" book.

Place names must be real names a map can find: "Loire Valley", "Ontario", "Kyoto", "Lyon". Never a description ("the Rhine corridor", "rural Provence", "an unnamed village"): put descriptions in "why". "region" is the state, province or equivalent first-level division (null for a city-state or a country-level answer). "country" is always one modern country.

STEP 3. Names in English (the site shows books in English only):
- "english_title": the title the book is published under in English (e.g. "Cien años de soledad" → "One Hundred Years of Solitude"); the same title if it is already English; the original, transliterated into Latin letters, if there is no English edition.
- "english_author": the author's name as English-language editions print it, in Latin letters, keeping accents (e.g. "Gabriel García Márquez").

STEP 4. Be honest about what you know:
- "known": "well" if you know this book itself; "description" if you are working mainly from the description and the author; "guessing" if you are not sure. Never present a guess as certain.
- "ambiguous": true when two or more places are equally strong as the anchor (a novel split evenly between two cities, a memoir split between two homes). Put them all in "candidates", main first; readers will help decide.

Reply with only this JSON object, no other text:
{"type": "real" | "invented" | "none",
 "main": {"place": "most specific place name", "region": "state or province", "country": "modern country, in English", "precision": "site" | "city" | "region" | "country"} | null,
 "invented_name": "the fictional name of the main place, or null",
 "real_basis": "stated" | "accepted" | "implied" | "unknown" | null,
 "journey": [{"place": "...", "country": "...", "note": "under 12 words"}],
 "world": "string or null",
 "author_basis": "writing" | "career" | "citizenship" | "birthplace" | null,
 "known": "well" | "description" | "guessing",
 "ambiguous": true | false,
 "candidates": [{"place": "...", "country": "..."}],
 "english_title": "...",
 "english_author": "...",
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
