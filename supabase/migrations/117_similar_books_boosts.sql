-- Same country was too strong a pull ("also set in the United States" beat real similarity); keep it small.
-- Also only suggest books with a cover (the card shows covers).
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
      and v.cover_id is not null
    order by v.embedding <#> q_embedding
    limit 200
  )
  select near.book_key, near.title, near.author, near.year, near.ol, near.cover_id, near.place, near.country,
         near.world, near.lat, near.lon, near.ap, near.note,
         near.sim + case when q_world is not null and near.world = q_world then 0.08 else 0 end
                  + case when q_place is not null and near.place = q_place then 0.04 else 0 end
                  + case when q_country is not null and near.country = q_country then 0.01 else 0 end as score
  from near order by score desc limit least(greatest(p_n, 1), 30);
$$;
