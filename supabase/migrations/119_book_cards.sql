-- TheBookMap: everything a book card shows, for every book on a map, in one read when the map loads,
-- so tapping a book opens its card at once (nothing is fetched on the tap).
--   book_cards(keys) → [{k, s: summary, src, pg: Wikipedia page, cm: readers' ratings and reviews}]
--   Only books with a saved summary or with readers' ratings/reviews are returned; cm is the same object
--   book_community gives (absent when nobody has rated or reviewed the book yet).
-- Also: bm_norm / bm_key, the site's book key (js/data.js MM.bookKey) in SQL, and _bs_missing, the
-- books still without a summary (used to fill them in ahead of time through book-summary's prefill).

create or replace function public.bm_norm(s text) returns text language sql immutable as $$
  select regexp_replace(replace(lower(translate(coalesce(s,''),
    'ÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÑÒÓÔÕÖÙÚÛÜÝàáâãäåçèéêëìíîïñòóôõöùúûüýÿĀāĂăĄąĆćĈĉĊċČčĎďĒēĔĕĖėĘęĚěĜĝĞğĠġĢģĤĥĨĩĪīĬĭĮįİĴĵĶķĹĺĻļĽľŃńŅņŇňŌōŎŏŐőŔŕŖŗŘřŚśŜŝŞşŠšŢţŤťŨũŪūŬŭŮůŰűŲųŴŵŶŷŸŹźŻżŽžƠơƯưǍǎǏǐǑǒǓǔǕǖǗǘǙǚǛǜǞǟǠǡǦǧǨǩǪǫǬǭǰǴǵǸǹǺǻȀȁȂȃȄȅȆȇȈȉȊȋȌȍȎȏȐȑȒȓȔȕȖȗȘșȚțȞȟȦȧȨȩȪȫȬȭȮȯȰȱȲȳḀḁḂḃḄḅḆḇḈḉḊḋḌḍḎḏḐḑḒḓḔḕḖḗḘḙḚḛḜḝḞḟḠḡḢḣḤḥḦḧḨḩḪḫḬḭḮḯḰḱḲḳḴḵḶḷḸḹḺḻḼḽḾḿṀṁṂṃṄṅṆṇṈṉṊṋṌṍṎṏṐṑṒṓṔṕṖṗṘṙṚṛṜṝṞṟṠṡṢṣṤṥṦṧṨṩṪṫṬṭṮṯṰṱṲṳṴṵṶṷṸṹṺṻṼṽṾṿẀẁẂẃẄẅẆẇẈẉẊẋẌẍẎẏẐẑẒẓẔẕẖẗẘẙẠạẢảẤấẦầẨẩẪẫẬậẮắẰằẲẳẴẵẶặẸẹẺẻẼẽẾếỀềỂểỄễỆệỈỉỊịỌọỎỏỐốỒồỔổỖỗỘộỚớỜờỞởỠỡỢợỤụỦủỨứỪừỬửỮữỰựỲỳỴỵỶỷỸỹ',
    'aaaaaaceeeeiiiinooooouuuuyaaaaaaceeeeiiiinooooouuuuyyaaaaaaccccccccddeeeeeeeeeegggggggghhiiiiiiiiijjkkllllllnnnnnnoooooorrrrrrssssssssttttuuuuuuuuuuuuwwyyyzzzzzzoouuaaiioouuuuuuuuuuaaaaggkkoooojggnnaaaaaaeeeeiiiioooorrrruuuusstthhaaeeooooooooyyaabbbbbbccddddddddddeeeeeeeeeeffgghhhhhhhhhhiiiikkkkkkllllllllmmmmmmnnnnnnnnoooooooopppprrrrrrrrssssssssssttttttttuuuuuuuuuuvvvvwwwwwwwwwwxxxxyyzzzzzzhtwyaaaaaaaaaaaaaaaaaaaaaaaaeeeeeeeeeeeeeeeeiiiioooooooooooooooooooooooouuuuuuuuuuuuuuyyyyyyyy')),
    '&', 'and'), '[^a-z0-9]', '', 'g') $$;

create or replace function public.bm_key(t text, a text) returns text language sql immutable as $$
  select coalesce(nullif(left(public.bm_norm(regexp_replace(regexp_replace(coalesce(t,''), '\s*\(([^()]*#\s*[\d.]+[^()]*)\)\s*$', ''), '\s*[:;(].*$', '')), 80), ''), 'untitled')
     || '|' || left(public.bm_norm(regexp_replace(coalesce(a,''), '(,| and | & ).*$', '')), 60) $$;

create or replace function public.book_cards(p_keys text[])
returns json language sql stable security definer set search_path = public as $$
  with k as (select distinct unnest(p_keys[1:3000]) as key),
  rated as (
    select key from k where exists (select 1 from book_logs l where l.book_key = k.key and l.rating between 1 and 5)
                       or exists (select 1 from book_reviews r where r.book_key = k.key)
  )
  select coalesce(json_agg(json_strip_nulls(json_build_object(
      'k', k.key,
      's', case when s.source <> 'none' then s.summary end,
      'src', case when s.source <> 'none' then s.source end,
      'pg', case when s.source = 'wikipedia' then s.wiki_page end,
      'cm', case when rated.key is not null then public.book_community(k.key, 50) end))), '[]'::json)
  from k
  left join book_summaries s on s.book_key = k.key
  left join rated on rated.key = k.key
  where (s.summary is not null and s.source <> 'none') or rated.key is not null
$$;
grant execute on function public.book_cards(text[]) to anon, authenticated;

create or replace function public._bs_missing(n int) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('key', k, 'title', t, 'author', a, 'year', y, 'ol', ol)), '[]') from (
    select k, t, a, y, ol from (
      select v.book_key k, v.title t, v.author a, v.year y, v.ol, 1 pri from book_vectors v
      union all select public.bm_key(s.book->>'t', s.book->>'a'), s.book->>'t', s.book->>'a', nullif(s.book->>'y','')::int, s.book->>'ol', 0 from book_starter s
      union all select l.book_key, l.title, l.author, l.year, l.ol_key, 2 from book_logs l
    ) x where not exists (select 1 from book_summaries b where b.book_key = x.k)
    order by pri, k limit n) z $$;
revoke all on function public._bs_missing(int) from public, anon, authenticated;
