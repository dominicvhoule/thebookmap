-- TheBookMap: test bench for the location pipeline v2 (see the Project doc location-pipeline-v2.md).
-- Holds the test books, the batches sent to Claude and every model's answer. Private: row level security
-- on with no policies, so only the edge functions (service role) and the owner's SQL can see it.

create table if not exists public.loc_test_books (
  id          int primary key,
  pool        text not null check (pool in ('real', 'invented', 'nosetting')),   -- the type we picked it for
  band        text not null check (band in ('popular', 'lesser')),
  title       text not null,
  author      text not null,
  year        int,
  ol_key      text,
  wd_qid      text,
  cover_id    bigint,
  description text,
  source      text                                   -- where the book came from (Open Library subject, starter shelf)
);

create table if not exists public.loc_test_batches (
  batch_id    text primary key,
  model       text not null,
  variant     text not null default 'v2',
  books       int not null,
  status      text not null default 'submitted',
  created_at  timestamptz not null default now(),
  collected_at timestamptz
);

create table if not exists public.loc_test_results (
  book_id     int not null references public.loc_test_books(id),
  model       text not null,
  variant     text not null default 'v2',
  answer      jsonb,                                 -- the parsed JSON, null if it didn't parse
  raw         text,
  in_tokens   int,
  out_tokens  int,
  error       text,
  created_at  timestamptz not null default now(),
  primary key (book_id, model, variant)
);

-- Single-use tickets for calling the location-test function (made by hand in SQL, deleted when used).
create table if not exists public.loc_test_tickets (
  token       text primary key check (char_length(token) between 24 and 100),
  created_at  timestamptz not null default now()
);

alter table public.loc_test_books enable row level security;
alter table public.loc_test_batches enable row level security;
alter table public.loc_test_results enable row level security;
alter table public.loc_test_tickets enable row level security;

-- The owner's verdicts from the review page (one per book): which models were right, the correct type and
-- place when none were, whether several places are fine, skipped books, notes.
create table if not exists public.loc_test_verdicts (
  book_id     int primary key references public.loc_test_books(id),
  verdict     jsonb not null,
  updated_at  timestamptz not null default now()
);
alter table public.loc_test_verdicts enable row level security;
