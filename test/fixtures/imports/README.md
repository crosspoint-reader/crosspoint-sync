# Import fixtures

These CSVs contain invented books and exercise export headers, quoting, unknown
dates, rereads and ratings. They contain no user account data.

- Goodreads: standard library-export headers; `Date Added` is deliberately different
  from `Date Read` to catch fabricated reading dates.
- StoryGraph: headers and date shapes checked against the user-supplied example in
  https://github.com/mateusz-bak/openreads/issues/525 (including DD/MM/YYYY display
  dates and YYYY/MM/DD-YYYY/MM/DD reading periods).
- KOReader schema fixtures are generated in `koinsight-import.test.ts` from the raw
  `book` and `page_stat_data` structure in
  https://github.com/koreader/koreader/blob/master/plugins/statistics.koplugin/main.lua.
  The importer must never execute the uploaded `page_stat` view.
