# Book Club site

A single-page web app for our book club: polls for the next book, meeting-date scheduling, a library with genre tags, scored reviews (overall plus category scores in quarter points), rankings, meetings with attendance, hosts, minutes and shared recipes/links, a members roster with Goodreads links, and a filterable Recipes page.

## Important: this is source code, not a standalone site

`index.html` is the exact page published as a Claude artifact. It stores votes, reviews, meetings and the roster in the artifact's built-in database and signs members in through Claude (`claude.use("db")`, `claude.use("user")`). Outside that environment, for example on GitHub Pages, it loads but shows a "shared data isn't available" message.

No club data is stored in this repo. The data lives in the artifact's database.

Running it from GitHub Pages would need a rewrite against a real backend (for example Firebase or Supabase) for the database and sign-in.
