-- TheBookMap: "Currently reading" lives in the same private table as "Want to read".
-- shelf = 'want' (Want to read) or 'reading' (Currently reading). A book sits on one list at a time,
-- like Goodreads' exclusive shelves, so moving it between lists is an update. Already applied on the live database.
alter table public.book_wants add column if not exists shelf text not null default 'want';
alter table public.book_wants drop constraint if exists book_wants_shelf_check;
alter table public.book_wants add constraint book_wants_shelf_check check (shelf in ('want', 'reading'));
drop policy if exists "own wants: move" on public.book_wants;
create policy "own wants: move" on public.book_wants for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
grant update (shelf) on public.book_wants to authenticated;
