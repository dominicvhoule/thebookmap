-- The starter account's shelf (Emily): books in the site's own format, read by everyone.
-- Filled on 2026-10-27 with 150 of Open Library's most-read books placed by the v2 location algorithm
-- (Opus 5.5; final answers = v2.5 where re-run, else v2.4): 120 on Earth, 30 in invented worlds (book.w).
-- Coordinates for Earth books come from OpenStreetMap (Nominatim/Photon) for the place Claude named.
create table if not exists public.book_starter (
  pos int primary key,
  book jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.book_starter enable row level security;
drop policy if exists "starter shelf is public" on public.book_starter;
create policy "starter shelf is public" on public.book_starter for select to anon, authenticated using (true);
grant select on public.book_starter to anon, authenticated;
