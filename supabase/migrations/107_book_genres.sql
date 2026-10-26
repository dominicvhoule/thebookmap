-- TheBookMap: each book's broad genres, worked out once (from Open Library subjects and Wikidata's genre)
-- and shared with every reader, so the map's genre chips are quick. Already applied on the live database.
create table if not exists public.book_genres (
  book_key   text primary key check (char_length(book_key) <= 300),
  genres     text[] not null check (genres <@ array['Fiction','Classics','Historical fiction','Mystery & crime','Thriller','Science fiction','Fantasy','Romance','Horror','Young adult','Poetry','Memoir & biography','History','Philosophy','Travel','Science & nature','Politics & society','Religion']::text[] and cardinality(genres) <= 8),
  created_at timestamptz not null default now()
);
alter table public.book_genres enable row level security;
drop policy if exists "book_genres readable" on public.book_genres;
create policy "book_genres readable" on public.book_genres for select using (true);
drop policy if exists "book_genres insert by members" on public.book_genres;
create policy "book_genres insert by members" on public.book_genres for insert to authenticated with check (true);
grant select on public.book_genres to anon, authenticated;
grant insert on public.book_genres to authenticated;
