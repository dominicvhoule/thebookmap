-- BookMap: books on the same accounts as MovieMap (one shared Supabase project).
-- Paste this whole file into Supabase → SQL Editor → New query, then Run. Safe to run more than once.
-- It only adds things: new columns on profiles, two new tables, one function and a nightly schedule.
-- Nothing of MovieMap's is changed or removed (apart from reserving the username "bookmap").

-- ---------- the Goodreads link on each profile ----------
alter table public.profiles add column if not exists goodreads_id text
  check (goodreads_id is null or goodreads_id ~ '^[0-9]{1,15}$');
alter table public.profiles add column if not exists goodreads_name text
  check (goodreads_name is null or char_length(goodreads_name) <= 80);
alter table public.profiles add column if not exists books_synced timestamptz;   -- last nightly Goodreads check
create index if not exists profiles_goodreads_id on public.profiles (goodreads_id);

-- ---------- book_logs: the books on each person's map, readable by everyone ----------
create table if not exists public.book_logs (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade default auth.uid(),
  title       text not null check (char_length(title) <= 400),
  author      text check (char_length(author) <= 300),
  year        int,
  series      text check (char_length(series) <= 200),
  book_key    text not null check (char_length(book_key) between 1 and 300),   -- main title + first author, so a book is on a map once
  gr_id       text check (gr_id ~ '^[0-9]{1,15}$'),                            -- the Goodreads book it came from
  isbn        text check (isbn ~ '^[0-9]{9}[0-9X]$|^[0-9]{13}$'),
  ol_key      text check (ol_key ~ '^OL[0-9]+W$'),                             -- Open Library work
  wd_qid      text check (wd_qid ~ '^Q[0-9]+$'),                               -- Wikidata item
  cover_url   text check (char_length(cover_url) <= 500 and cover_url ~ '^https://'),
  pages       int check (pages between 1 and 100000),
  place       text check (char_length(place) <= 200),
  country     text check (char_length(country) <= 100),
  continent   text check (char_length(continent) <= 40),
  lat         double precision not null check (lat between -90 and 90),
  lon         double precision not null check (lon between -180 and 180),
  approx      boolean not null default false,
  note        text check (char_length(note) <= 500),
  rating      smallint check (rating between 1 and 5),
  reviewed    boolean not null default false,
  read_on     date,
  read_count  smallint not null default 1 check (read_count between 1 and 999),
  source      text check (char_length(source) <= 20),
  created_at  timestamptz not null default now(),
  unique (user_id, book_key)
);
create index if not exists book_logs_user on public.book_logs (user_id);
create index if not exists book_logs_user_gr on public.book_logs (user_id, gr_id);
alter table public.book_logs enable row level security;
drop policy if exists "book logs are public" on public.book_logs;
create policy "book logs are public" on public.book_logs for select using (true);
drop policy if exists "add own book logs" on public.book_logs;
create policy "add own book logs" on public.book_logs for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "edit own book logs" on public.book_logs;
create policy "edit own book logs" on public.book_logs for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "delete own book logs" on public.book_logs;
create policy "delete own book logs" on public.book_logs for delete to authenticated using ((select auth.uid()) = user_id);

-- ---------- shared cache of book settings (each book is looked up once for everyone) ----------
create table if not exists public.book_settings (
  book_key   text primary key check (char_length(book_key) between 1 and 300),
  place      text check (char_length(place) <= 200),
  country    text check (char_length(country) <= 100),
  continent  text check (char_length(continent) <= 40),
  lat        double precision not null check (lat between -90 and 90),
  lon        double precision not null check (lon between -180 and 180),
  approx     boolean not null default false,
  note       text check (char_length(note) <= 500),
  source     text not null check (source in ('wikidata','subjects','wikipedia','ai')),
  updated_at timestamptz not null default now()
);
alter table public.book_settings enable row level security;
drop policy if exists "book settings are public" on public.book_settings;
create policy "book settings are public" on public.book_settings for select using (true);
drop policy if exists "signed-in users add book settings" on public.book_settings;
create policy "signed-in users add book settings" on public.book_settings for insert to authenticated with check (true);
-- No update policy: a cached setting is written once. Personal corrections live on each person's own log.

-- ---------- People on BookMap: members with books, newest first ----------
create or replace function public.book_readers(n int default 12)
returns table (id uuid, username text, display_name text, books bigint)
language sql stable set search_path = public as $$
  select p.id, p.username, p.display_name, count(b.id) as books
  from profiles p join book_logs b on b.user_id = p.id
  group by p.id
  order by min(b.created_at) desc
  limit least(greatest(n, 1), 50);
$$;
grant execute on function public.book_readers(int) to anon, authenticated;

-- Keep "bookmap" free for BookMap's starter shelf (alongside MovieMap's reserved names).
create or replace function public.username_available(name text) returns boolean
language sql stable security definer set search_path = public as $$
  select lower(name) ~ '^[a-z0-9_]{3,20}$' and lower(name) not in ('henry', 'grant', 'bookmap')
     and not exists (select 1 from profiles where username = lower(name));
$$;

-- ---------- nightly Goodreads check (the book-sync function) ----------
-- Uses the secret MovieMap's daily sync already keeps in Vault, so there's nothing to paste in.
select cron.unschedule(jobid) from cron.job where jobname in ('bookmap-daily-sync', 'bookmap-daily-sync-2');
select cron.schedule('bookmap-daily-sync', '35 9 * * *', $$
  select net.http_post(
    url := 'https://hwzxyfpqxqndgjbiaiec.supabase.co/functions/v1/book-sync',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'moviemap_cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 150000);
$$);
select cron.schedule('bookmap-daily-sync-2', '50 9 * * *', $$
  select net.http_post(
    url := 'https://hwzxyfpqxqndgjbiaiec.supabase.co/functions/v1/book-sync',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'moviemap_cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 150000);
$$);
