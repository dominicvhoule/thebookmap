-- TheBookMap: Open Library matches shared by every reader.
-- When anyone's sync matches a book to Open Library, the match (work, Wikidata item, cover ID) is saved
-- here, so the same book is never searched again for anyone else. This keeps big Goodreads syncs fast
-- and well under Open Library's limits. Safe to run more than once; changes nothing of MovieMap's.

create table if not exists public.book_matches (
  book_key   text primary key check (char_length(book_key) <= 160),
  ol_key     text check (ol_key ~ '^OL\d+W$'),
  wd_qid     text check (wd_qid ~ '^Q\d+$'),
  cover_id   integer check (cover_id > 0),
  title      text check (char_length(title) <= 400),
  author     text check (char_length(author) <= 300),
  year       integer,
  created_at timestamptz not null default now()
);
alter table public.book_matches enable row level security;

drop policy if exists "book_matches readable" on public.book_matches;
create policy "book_matches readable" on public.book_matches for select using (true);
drop policy if exists "book_matches insert by members" on public.book_matches;
create policy "book_matches insert by members" on public.book_matches for insert to authenticated with check (true);

grant select on public.book_matches to anon, authenticated;
grant insert on public.book_matches to authenticated;

-- Each book keeps its own Open Library cover ID (already added on the live database).
alter table public.book_logs add column if not exists cover_id integer check (cover_id > 0);
