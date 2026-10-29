-- 112: store every book cover in R2 ahead of time.
--
-- Cover images live in Cloudflare R2 behind the covers Worker. The Worker only keeps a cover after
-- someone first asks for it, and that first request goes to Open Library (≈0.5–2.5 s). This queue asks
-- the Worker for every cover the site knows about, at sizes S, M and L, a few per second, so readers
-- always get the fast stored copy (≈45 ms).
--
-- cover_store: one row per cover and size. priority 0 = a reader's book, 1 = pre-placed books,
-- 2 = the import-matching catalogue (book_matches). New books are queued automatically by triggers.
-- cover_store_step(n): checks answers to earlier requests, re-queues failures (up to 3 tries), and
-- sends the next n requests. pg_cron runs it every 10 seconds.

create table if not exists public.cover_store (
  cover_id   bigint   not null,
  size       char(1)  not null check (size in ('S','M','L')),
  priority   smallint not null default 2,
  req_id     bigint,
  sent_at    timestamptz,
  status     int,          -- HTTP status from the Worker: 200 stored, 404 Open Library has no image
  tries      smallint not null default 0,
  done_at    timestamptz,
  primary key (cover_id, size)
);
create index if not exists cover_store_todo on public.cover_store (priority, cover_id) where sent_at is null and done_at is null;
create index if not exists cover_store_sent on public.cover_store (sent_at) where sent_at is not null and done_at is null;
alter table public.cover_store enable row level security;
revoke all on public.cover_store from anon, authenticated;

-- Queue one cover at all three sizes (keeps the most urgent priority if already queued).
create or replace function public.cover_store_add(p_cover bigint, p_priority smallint)
returns void language sql security definer set search_path = public as $$
  insert into public.cover_store (cover_id, size, priority)
  select p_cover, s, p_priority from unnest(array['S','M','L']) s
  where p_cover is not null and p_cover > 0
  on conflict (cover_id, size) do update set priority = least(public.cover_store.priority, excluded.priority);
$$;
revoke all on function public.cover_store_add(bigint, smallint) from public, anon, authenticated;

create or replace function public.cover_store_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
declare c bigint;
begin
  if tg_table_name = 'book_starter' then c := nullif(new.book->>'coverId', '')::bigint;
  else c := new.cover_id; end if;
  perform public.cover_store_add(c, tg_argv[0]::smallint);
  return new;
exception when others then
  return new;  -- never let cover storing block saving a book
end $$;
revoke all on function public.cover_store_trigger() from public, anon, authenticated;

drop trigger if exists cover_store_q on public.book_logs;
create trigger cover_store_q after insert or update of cover_id on public.book_logs
  for each row execute function public.cover_store_trigger('0');
drop trigger if exists cover_store_q on public.book_wants;
create trigger cover_store_q after insert or update of cover_id on public.book_wants
  for each row execute function public.cover_store_trigger('0');
drop trigger if exists cover_store_q on public.book_starter;
create trigger cover_store_q after insert or update of book on public.book_starter
  for each row execute function public.cover_store_trigger('0');
drop trigger if exists cover_store_q on public.loc_test_books;
create trigger cover_store_q after insert or update of cover_id on public.loc_test_books
  for each row execute function public.cover_store_trigger('1');
drop trigger if exists cover_store_q on public.book_matches;
create trigger cover_store_q after insert or update of cover_id on public.book_matches
  for each row execute function public.cover_store_trigger('2');

-- Everything already in the database.
insert into public.cover_store (cover_id, size, priority)
select c, s, min(p) from (
  select nullif(book->>'coverId','')::bigint c, 0 p from public.book_starter
  union all select cover_id, 0 from public.book_logs
  union all select cover_id, 0 from public.book_wants
  union all select cover_id, 1 from public.loc_test_books
  union all select cover_id, 2 from public.book_matches
) x cross join unnest(array['S','M','L']) s
where c is not null and c > 0
group by c, s
on conflict (cover_id, size) do nothing;

-- One step: collect answers, retry failures, send the next batch.
create or replace function public.cover_store_step(n int default 20)
returns int language plpgsql security definer set search_path = public, net as $$
declare base text := 'https://thebookmap-covers.grant-d-houle.workers.dev'; r record; k int := 0;
begin
  -- answers that came back: record the status and drop the stored response (pg_net would otherwise
  -- keep each image body for hours, filling the database)
  with got as (
    delete from net._http_response h using public.cover_store q
     where h.id = q.req_id and q.done_at is null and q.sent_at is not null
    returning h.id, h.status_code)
  update public.cover_store q set status = got.status_code, req_id = null,
         done_at = case when got.status_code in (200, 404) then now() end
    from got where q.req_id = got.id;
  -- failed answers, or no answer after 5 minutes → try again (3 tries at most)
  update public.cover_store set sent_at = null, req_id = null
   where done_at is null and sent_at is not null
     and (req_id is null or sent_at < now() - interval '5 minutes');
  -- send the next batch (3 tries at most)
  for r in select cover_id, size from public.cover_store
            where sent_at is null and done_at is null and tries < 3
            order by priority, cover_id limit n for update skip locked loop
    update public.cover_store set sent_at = now(), tries = tries + 1, status = null,
           req_id = net.http_get(base || '/b/id/' || r.cover_id || '-' || r.size || '.jpg', timeout_milliseconds := 30000)
     where cover_id = r.cover_id and size = r.size;
    k := k + 1;
  end loop;
  return k;
end $$;
revoke all on function public.cover_store_step(int) from public, anon, authenticated;

select cron.unschedule('thebookmap-cover-store') where exists (select 1 from cron.job where jobname = 'thebookmap-cover-store');
select cron.schedule('thebookmap-cover-store', '10 seconds', $$select public.cover_store_step(20)$$);
