// BookMap's starter shelf, shown to visitors who aren't signed in.
// Since 2026-10-27 Emily's books live in the database (table book_starter): 150 of Open Library's most-read books,
// each placed by the v2 location algorithm (Claude Opus 5.5; see claude/location-pipeline-v2.md), 120 on Earth and
// 30 in invented worlds (shown on the "Other worlds" map). The site loads them when her map opens.
// Her earlier shelf is kept in test/emily-shelf.json.
window.FEATURED = {
  username:"bookmap", name:"Emily", featured:true, count:150,
  bio:"150 of the world's most-read books, from Atomic Habits to Anne Frank's diary, each pinned where its story happens, plus the invented worlds of Middle-earth, Narnia and more.",
  books:[]
};
