-- Location test: allow the owner's own Goodreads Read shelf (ids 1001+) alongside the 999 picked books.
-- (Already applied to the live database by hand on 2026-10-26; repeated here so the repo matches.)
alter table public.loc_test_books drop constraint if exists loc_test_books_pool_check;
alter table public.loc_test_books add constraint loc_test_books_pool_check check (pool in ('real','invented','nosetting','goodreads'));
alter table public.loc_test_books drop constraint if exists loc_test_books_band_check;
alter table public.loc_test_books add constraint loc_test_books_band_check check (band in ('popular','lesser','owner'));
