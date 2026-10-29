-- TheBookMap: private book maps (2026-10-28). Book maps only; MovieMap is unaffected.
-- Public is the default. A private map is seen only by its owner: its books leave People, Community and
-- search, and its link shows "This map is private". Its reviews stay on book cards, signed "A fellow reader".

create table if not exists public.book_prefs (
  user_id uuid primary key references auth.users(id) on delete cascade,
  private boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table public.book_prefs enable row level security;
-- Whether a map is private isn't secret (the site needs it to say "This map is private").
drop policy if exists "book prefs are readable" on public.book_prefs;
create policy "book prefs are readable" on public.book_prefs for select to anon, authenticated using (true);
drop policy if exists "set own book prefs" on public.book_prefs;
create policy "set own book prefs" on public.book_prefs for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists "change own book prefs" on public.book_prefs;
create policy "change own book prefs" on public.book_prefs for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select on public.book_prefs to anon, authenticated;
grant insert, update on public.book_prefs to authenticated;

-- Books on a private map can only be read by their owner. Enforced here, not just hidden in the page.
drop policy if exists "book logs are public" on public.book_logs;
drop policy if exists "book logs are public unless private" on public.book_logs;
create policy "book logs are public unless private" on public.book_logs for select using (
  user_id = (select auth.uid())
  or not exists (select 1 from public.book_prefs p where p.user_id = book_logs.user_id and p.private)
);

-- Reviews are read through book_community() only, so a private reader's name never leaves the database.
drop policy if exists "reviews are public" on public.book_reviews;
drop policy if exists "read own reviews" on public.book_reviews;
create policy "read own reviews" on public.book_reviews for select to authenticated using (user_id = (select auth.uid()));

-- A book's community box: average rating, spread, and reviews. Reviews by private readers are signed
-- "A fellow reader" with no link (except to the reviewer themselves, who sees their own as usual).
create or replace function public.book_community(p_key text, p_limit integer default 20)
returns json language sql stable security definer set search_path to 'public' as $$
  with r as (select rating from book_logs where book_key = p_key and rating between 1 and 5),
  rv as (
    select v.body, v.updated_at, v.user_id = auth.uid() as mine,
           coalesce((select pr.private from book_prefs pr where pr.user_id = v.user_id), false) as private,
           p.username, coalesce(nullif(p.display_name, ''), p.username) as name,
           (select l.rating from book_logs l where l.user_id = v.user_id and l.book_key = v.book_key limit 1) as rating
    from book_reviews v join profiles p on p.id = v.user_id
    where v.book_key = p_key
    order by v.updated_at desc
    limit least(greatest(coalesce(p_limit, 20), 1), 50)
  )
  select json_build_object(
    'ratings', (select count(*) from r),
    'average', (select round(avg(rating)::numeric, 2) from r),
    'spread', json_build_array((select count(*) from r where rating = 1), (select count(*) from r where rating = 2), (select count(*) from r where rating = 3), (select count(*) from r where rating = 4), (select count(*) from r where rating = 5)),
    'review_count', (select count(*) from book_reviews where book_key = p_key),
    'reviews', coalesce((select json_agg(json_build_object(
        'username', case when private and not mine then null else username end,
        'name', case when private and not mine then 'A fellow reader' else name end,
        'mine', mine, 'rating', rating, 'body', body, 'at', updated_at)) from rv), '[]'::json)
  );
$$;

-- Maps to explore on the Community tab: public maps with the most countries, with a sample of pin
-- positions for a small preview. Runs as the caller, so private maps are left out by the rule above.
create or replace function public.book_maps(n integer default 12)
returns table(id uuid, username text, display_name text, books bigint, countries bigint, latest timestamptz, pts json)
language sql stable set search_path to 'public' as $$
  select p.id, p.username, p.display_name, count(b.id) as books, count(distinct b.country) as countries, max(b.created_at) as latest,
         (select json_agg(json_build_array(round(s.lon::numeric, 1), round(s.lat::numeric, 1)))
            from (select l.lon, l.lat from book_logs l where l.user_id = p.id and l.lat is not null limit 120) s) as pts
  from profiles p join book_logs b on b.user_id = p.id
  group by p.id
  order by count(distinct b.country) desc, count(b.id) desc
  limit least(greatest(n, 1), 50);
$$;
grant execute on function public.book_maps(integer) to anon, authenticated;
