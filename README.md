# TheBookMap

Log the books you read and see where each one takes place on a world map. The book version of [MovieMap](https://github.com/dominicvhoule/moviemap), with Goodreads in Letterboxd's place.

Live at **https://dominicvhoule.github.io/thebookmap/**

## What it does

- **Map**: every book is a pin at the place its story is set. Dashed pins are approximate (country-level or invented places). It's MovieMap's street map (MapLibre with free OpenFreeMap tiles) in BookMap's colours: place names, cities and streets appear as you zoom, nearby pins merge into a count, and countries you've read in turn gold. Opening a book suggests more set in the same city or country, or by the same author.
- **Log a book**: search a title or author, pick the right one, and BookMap finds the setting and cover. Move the pin if it's wrong.
- **Goodreads**: paste your Goodreads profile link or username and every book on your Read shelf comes in, with ratings and dates read. Linking loads up to 6,000 books and only works for public profiles; anyone with a private profile or a bigger shelf uses the export. New books are picked up automatically: once a day on the server (`book-sync`), and whenever the site is opened (at most every 6 hours, with a full re-read weekly). Rating changes follow Goodreads, and books you take off your shelf come off the map.
- **Private Goodreads profile**: import the library export (`goodreads_library_export.csv`) on the Goodreads tab instead. It brings in ratings, dates read and read counts.
- **Map, List, Stats**: switch the map to List (countries A to Z, with search) or Stats (share of books by country, continent and decade, best-rated countries, and how many are by a writer from the country they're set in). Opening a country splits its books into ones by writers from there and ones by writers from elsewhere.
- **People**: one account for BookMap and MovieMap. Search members, follow them, view their maps, find friends from your phone's contacts (Android Chrome), or share an invite link.
- **Poster**: a print-ready poster of any map.

## Where the data comes from

| What | Source |
|---|---|
| Titles, authors, covers, editions | [Open Library](https://openlibrary.org/) (no key needed). Every cover is Open Library's: each book saves its Open Library cover ID once, and the image link is built from it |
| Your books, ratings, dates read | Your public Goodreads Read shelf (`goodreads-feed` function), or the Goodreads export |
| Where a book takes place | [Wikidata](https://www.wikidata.org/) "narrative location" (P840), linked to Open Library works (P648) |
| When Wikidata has none | The library catalogue's subject places on Open Library ("Saint Petersburg (Russia)"), located through Wikipedia |
| Then | The places linked in the book's Wikipedia article (its Setting or Plot section) |
| Optional AI step | Claude reads the Wikipedia article and catalogue entry (`book-setting` function, needs an API key) |
| Last resort | The author's country (Wikidata), marked approximate |
| Cover images | Your own Cloudflare Worker and R2 bucket (`cloudflare/covers-worker.js`): each cover is fetched from Open Library once, then always served from R2 |
| Base map | [OpenFreeMap](https://openfreemap.org/) tiles (OpenStreetMap data) drawn with [MapLibre](https://maplibre.org/) |
| Accounts, maps, follows | [Supabase](https://supabase.com/), the same project as MovieMap |

Resolved settings are cached in a shared `book_settings` table so each book is only looked up once.

## Setup (shares MovieMap's Supabase project)

The site works before this: anyone can browse the starter shelf and keep books in their browser, and people can sign in with their MovieMap account. This one step turns on books on accounts, People and the nightly Goodreads check.

1. **SQL Editor → New query**: paste all of `supabase/migrations/101_bookmap.sql` and press **Run**. It only adds tables and columns; nothing of MovieMap's is changed. It also schedules the nightly Goodreads check, using the secret MovieMap's daily sync already keeps in Vault.
2. **Authentication → URL Configuration**: add `https://dominicvhoule.github.io/thebookmap/` under **Redirect URLs**, so sign-up and password emails come back to BookMap.

The three functions are already deployed to the project: `goodreads-feed` (Verify JWT on), `book-sync` (Verify JWT off; uses `CRON_SECRET`), and `book-setting` (Verify JWT on; does nothing until `ANTHROPIC_API_KEY` is set, the same key MovieMap's AI step uses). To redeploy one, paste its `supabase/functions/<name>/index.ts` into the Supabase editor.

## Files

```
index.html          page shell
styles.css          all styles (phone layout at the bottom)
config.js           Supabase settings (MovieMap's project)
js/featured.js      the hand-checked starter shelf (245 books), shown to signed-out visitors
js/data.js          Open Library and Wikidata lookups, country helpers
js/wikiplot.js      settings from the catalogue's subject places and from Wikipedia
js/poster.js        printable poster
js/app.js           map, reading log, logging, Goodreads, accounts, people
data/world.json     country shapes (Natural Earth via world-atlas)
supabase/migrations/101_bookmap.sql       the book tables and the nightly schedule
supabase/functions/goodreads-feed/index.ts  reads public Goodreads Read shelves
supabase/functions/book-sync/index.ts       adds new Goodreads books for every member, once a day
supabase/functions/book-setting/index.ts    asks Claude where a book is set (optional)
```

## Limits

- **Goodreads**: there's no sign-in (Goodreads closed its API to new apps). Linking reads the public Read shelf feed, so it only works for public profiles and can break if Goodreads changes the feed. Reading the feed this way may not be allowed under Goodreads' terms. Private profiles can use the export.
- **Settings**: Wikidata records settings for well-known books; the catalogue and Wikipedia fill many gaps, but newer and smaller books often end up on the author's country or need a pin by hand. Books set in invented worlds (Middle-earth) or with no setting (self-help, poetry) usually land on the author's country; move or remove them. Move pin always wins.
- **Contacts on iPhone**: Safari doesn't let websites read contacts. iPhone users can share an invite link or search by username instead.
