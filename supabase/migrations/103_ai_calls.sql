-- TheBookMap: a log of every call the book-setting function makes to Claude.
-- Used to enforce daily limits (site-wide and per reader), to avoid re-asking about books Claude couldn't
-- place, and to see what the AI is costing. Only the edge functions (service role) read or write it.

create table if not exists public.ai_calls (
  id          bigserial primary key,
  fn          text not null check (char_length(fn) <= 40),
  book_key    text not null check (char_length(book_key) <= 300),
  user_id     uuid,
  result      text not null check (result in ('ok', 'unknown', 'error')),
  in_tokens   int,
  out_tokens  int,
  created_at  timestamptz not null default now()
);
create index if not exists ai_calls_created_idx on public.ai_calls (created_at desc);
create index if not exists ai_calls_user_idx on public.ai_calls (user_id, created_at desc);
create index if not exists ai_calls_book_idx on public.ai_calls (book_key, created_at desc);

-- Row level security on with no policies: invisible to the site's public and signed-in keys.
alter table public.ai_calls enable row level security;
