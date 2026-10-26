-- TheBookMap: community reviews. Anyone can read them; each reader writes, edits and deletes only their own,
-- one per book. The star rating shown with a review is the one on that reader's map (book_logs).
-- book_community(key) returns what a book card shows: average rating, how ratings spread, recent reviews.
-- Already applied on the live database.
create table if not exists public.book_reviews (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  book_key   text not null check (char_length(book_key) <= 300),
  body       text not null check (char_length(btrim(body)) between 1 and 5000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, book_key)
);
create index if not exists book_reviews_key on public.book_reviews (book_key, updated_at desc);
alter table public.book_reviews enable row level security;
drop policy if exists "reviews are public" on public.book_reviews;
create policy "reviews are public" on public.book_reviews for select using (true);
drop policy if exists "write own review" on public.book_reviews;
create policy "write own review" on public.book_reviews for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "edit own review" on public.book_reviews;
create policy "edit own review" on public.book_reviews for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "delete own review" on public.book_reviews;
create policy "delete own review" on public.book_reviews for delete to authenticated using (user_id = auth.uid());
grant select on public.book_reviews to anon, authenticated;
grant insert, update, delete on public.book_reviews to authenticated;
create index if not exists book_logs_key on public.book_logs (book_key);

create or replace function public.book_community(p_key text, p_limit int default 20)
returns json language sql stable security definer set search_path = public as $$
  with r as (select rating from book_logs where book_key = p_key and rating between 1 and 5),
  rv as (
    select v.body, v.updated_at, p.username, coalesce(nullif(p.display_name, ''), p.username) as name,
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
    'reviews', coalesce((select json_agg(json_build_object('username', username, 'name', name, 'rating', rating, 'body', body, 'at', updated_at)) from rv), '[]'::json)
  );
$$;
revoke all on function public.book_community(text, int) from public;
grant execute on function public.book_community(text, int) to anon, authenticated;
