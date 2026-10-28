-- Location v2: Open Library's most-read books (ids 2001+), pre-placed with Opus + prompt v2.4 using the owner's remaining credit.
alter table public.loc_test_books drop constraint if exists loc_test_books_pool_check;
alter table public.loc_test_books add constraint loc_test_books_pool_check check (pool in ('real','invented','nosetting','goodreads','mostread'));
