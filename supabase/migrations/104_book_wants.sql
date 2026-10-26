-- TheBookMap: each reader's "Want to read" list. Private to the reader. Already applied on the live database.
create table if not exists public.book_wants (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  book_key   text not null check (char_length(book_key) <= 300),
  title      text not null check (char_length(title) <= 400),
  author     text check (char_length(author) <= 300),
  year       integer,
  ol_key     text check (ol_key ~ '^OL\d+W$'),
  cover_id   integer check (cover_id > 0),
  isbn       text check (char_length(isbn) <= 20),
  created_at timestamptz not null default now(),
  unique (user_id, book_key)
);
alter table public.book_wants enable row level security;
drop policy if exists "own wants: read" on public.book_wants;
create policy "own wants: read" on public.book_wants for select to authenticated using (user_id = auth.uid());
drop policy if exists "own wants: add" on public.book_wants;
create policy "own wants: add" on public.book_wants for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "own wants: remove" on public.book_wants;
create policy "own wants: remove" on public.book_wants for delete to authenticated using (user_id = auth.uid());
grant select, insert, delete on public.book_wants to authenticated;
