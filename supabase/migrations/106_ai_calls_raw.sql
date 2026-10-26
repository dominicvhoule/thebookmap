-- TheBookMap: keep Claude's full reply for each book-setting call, so we can see exactly what it wrote
-- (and what we're paying for), not just the JSON the function keeps.
alter table public.ai_calls add column if not exists raw text check (char_length(raw) <= 20000);

-- Single-use tickets for re-running a book through book-setting to inspect the reply ("replay").
-- A replay ignores the saved pin and the limits, saves nothing to book_settings or book_summaries, and
-- returns Claude's raw reply. Tickets are created by hand (SQL) and deleted when used. Private: row level
-- security on, no policies.
create table if not exists public.ai_replay_tokens (
  token       text primary key check (char_length(token) between 24 and 100),
  book_key    text not null check (char_length(book_key) <= 300),
  created_at  timestamptz not null default now()
);
alter table public.ai_replay_tokens enable row level security;
