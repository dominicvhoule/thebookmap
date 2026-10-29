-- Same search as similar_books(), from an embedding and the book's attributes (for a book that isn't stored).
create or replace function public.similar_books_v(q_embedding extensions.vector(384), q_key text, q_author_key text,
  q_place text, q_country text, q_world text, p_exclude text[] default '{}', p_n int default 12)
returns table (book_key text, title text, author text, year int, ol text, cover_id bigint, place text, country text,
               world text, lat double precision, lon double precision, ap boolean, note text, score double precision)
language sql stable security definer set search_path = public, extensions as $$
  with near as (
    select v.*, -(v.embedding <#> q_embedding) as sim
    from public.book_vectors v
    where v.book_key <> coalesce(q_key, '') and v.author_key <> coalesce(q_author_key, '')
      and not (v.book_key = any(coalesce(p_exclude, '{}')))
      and (v.cover_id is not null or v.ol is not null)
    order by v.embedding <#> q_embedding
    limit 200
  )
  select near.book_key, near.title, near.author, near.year, near.ol, near.cover_id, near.place, near.country,
         near.world, near.lat, near.lon, near.ap, near.note,
         near.sim + case when q_world is not null and near.world = q_world then 0.08 else 0 end
                  + case when q_place is not null and near.place = q_place then 0.05 else 0 end
                  + case when q_country is not null and near.country = q_country then 0.03 else 0 end as score
  from near order by score desc limit least(greatest(p_n, 1), 30);
$$;
revoke all on function public.similar_books_v(extensions.vector, text, text, text, text, text, text[], int) from public;
grant execute on function public.similar_books_v(extensions.vector, text, text, text, text, text, text[], int) to service_role;

-- The stored-book version simply looks the book up and calls the vector version.
create or replace function public.similar_books(p_key text, p_exclude text[] default '{}', p_n int default 12)
returns table (book_key text, title text, author text, year int, ol text, cover_id bigint, place text, country text,
               world text, lat double precision, lon double precision, ap boolean, note text, score double precision)
language sql stable security definer set search_path = public, extensions as $$
  select s.* from public.book_vectors q,
    lateral public.similar_books_v(q.embedding, q.book_key, q.author_key, q.place, q.country, q.world, p_exclude, p_n) s
  where q.book_key = p_key;
$$;

-- Generic caller for private edge-function actions from SQL (single-use ticket, like _lt_call).
-- (The key below is the site's public anon key, already in config.js; the ticket is what authorises.)
create or replace function public._fn_call(fn text, body jsonb, timeout_ms int default 120000)
returns bigint language plpgsql security definer set search_path = public, extensions as $$
declare t text := rtrim(replace(replace(encode(gen_random_bytes(32), 'base64'), '+', '-'), '/', '_'), '=');
        k text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh3enh5ZnBxeHFuZGdqYmlhaWVjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIwMDcwNTUsImV4cCI6MjEwNzU4MzA1NX0.S_hcRPnvgmq5uMyKWU2i8W0AJ97tuJ8lAbBgPhYPP04';
begin
  if fn !~ '^[a-z0-9-]{1,40}$' then raise exception 'bad function name'; end if;
  insert into loc_test_tickets(token) values (t);
  return net.http_post(url := 'https://hwzxyfpqxqndgjbiaiec.supabase.co/functions/v1/' || fn,
    body := body || jsonb_build_object('ticket', t),
    headers := jsonb_build_object('Content-Type','application/json','apikey',k,'Authorization','Bearer '||k),
    timeout_milliseconds := timeout_ms);
end $$;
revoke all on function public._fn_call(text, jsonb, int) from public, anon, authenticated;
