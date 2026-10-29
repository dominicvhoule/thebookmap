-- "More like this", step 1 (content-based): every book TheBookMap knows gets an embedding of what it's about
-- (Supabase's built-in gte-small model, 384 numbers, made in the similar-books edge function), and the
-- nearest books by meaning are suggested, nudged towards books set in the same place or invented world.
-- Collaborative signals ("readers who loved this also loved") come later, once readers' imports build up.
create extension if not exists vector with schema extensions;

create table if not exists public.book_vectors (
  book_key   text primary key,                -- MM.bookKey: main title | first author, normalised
  title      text not null,
  author     text not null default '',
  author_key text not null default '',        -- normalised first author, to leave out the same writer
  year       int,
  ol         text,                            -- Open Library work id (OL...W)
  cover_id   bigint,
  place      text,                            -- v2 place label when known ("Salinas Valley, California")
  country    text,
  world      text,                            -- invented world, for fantasy-land books
  lat double precision, lon double precision, ap boolean not null default false,
  note       text,                            -- Claude's one-sentence reason for the place
  genres     text[] not null default '{}',
  embedding  extensions.vector(384) not null,
  source     text not null default 'seed',    -- seed (pre-placed most-read books) | reader (added on demand)
  updated_at timestamptz not null default now()
);
alter table public.book_vectors enable row level security;   -- read only through similar_books()
create index if not exists book_vectors_embedding_idx on public.book_vectors using hnsw (embedding extensions.vector_ip_ops);

-- Nearest books to one book. Embeddings are normalised, so the inner product is the cosine similarity.
-- Boosts: same invented world +0.08, same place +0.05, same country +0.03. Leaves out the book itself, the
-- same writer (other books by them, translations, series), and anything the reader already has (p_exclude).
create or replace function public.similar_books(p_key text, p_exclude text[] default '{}', p_n int default 12)
returns table (book_key text, title text, author text, year int, ol text, cover_id bigint, place text, country text,
               world text, lat double precision, lon double precision, ap boolean, note text, score double precision)
language sql stable security definer set search_path = public, extensions as $$
  with q as (select * from public.book_vectors where book_vectors.book_key = p_key),
  near as (
    select v.*, -(v.embedding <#> q.embedding) as sim,
           (q.world is not null and v.world = q.world) as same_world,
           (q.place is not null and v.place = q.place) as same_place,
           (q.country is not null and v.country = q.country) as same_country
    from public.book_vectors v, q
    where v.book_key <> q.book_key and v.author_key <> q.author_key
      and not (v.book_key = any(coalesce(p_exclude, '{}')))
      and (v.cover_id is not null or v.ol is not null)
    order by v.embedding <#> q.embedding
    limit 200
  )
  select near.book_key, near.title, near.author, near.year, near.ol, near.cover_id, near.place, near.country,
         near.world, near.lat, near.lon, near.ap, near.note,
         near.sim + case when same_world then 0.08 else 0 end + case when same_place then 0.05 else 0 end
                  + case when same_country then 0.03 else 0 end as score
  from near order by score desc limit least(greatest(p_n, 1), 30);
$$;
revoke all on function public.similar_books(text, text[], int) from public;
grant execute on function public.similar_books(text, text[], int) to anon, authenticated, service_role;
