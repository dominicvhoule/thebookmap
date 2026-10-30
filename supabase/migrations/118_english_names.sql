-- Books are shown under their English published title and English author name (owner, 2026-10-29: English only).
-- The original-language title and author are kept, unshown, so searches in the original still find the book.
alter table public.loc_test_books add column if not exists title_orig text, add column if not exists author_orig text,
  add column if not exists english_checked_at timestamptz;
alter table public.book_vectors add column if not exists title_orig text, add column if not exists author_orig text;

-- Applied once on 2026-10-29 after the English pass (location-test action "english", Haiku): the 56 renamed
-- books were re-keyed under their English names in book_vectors, book_summaries, book_genres and book_matches
-- (a copy under the new key), and Emily's shelf (book_starter) shows the English title and author, keeping the
-- originals as "to" / "ao" for search. Keys come from bm_key (migration 119), the site's MM.bookKey in SQL.
