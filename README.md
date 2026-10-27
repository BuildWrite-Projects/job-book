# Job Book

What's next on every job — one running list per job, shared between Stephen
and Joe so either can add items and check them off.

Built for Roberts & Associates, with separate books for BuildWrite Projects
and personal items.

## What it does

- Separate books (Roberts & Associates, BuildWrite Projects, Personal), each
  with its own jobs
- Each job keeps a running list of what's next; Enter adds a bullet under an item
- Urgent items float to the top in red; Waiting items (someone else's move)
  sink to the bottom and don't count as open work
- Job status — Prospect, Contracted, Active — and NC residential permit
  tracking, which flips a contracted job to Active once the five pre-start
  permits are done or n/a
- Assign items to a person, see who checked what off and when
- Each job records its folder on the F: drive, which receipt filing reads
- Archive, restore, rename and delete jobs
- Changes show on the other person's phone without a refresh

## How it's put together

Plain HTML, CSS and JavaScript — no build step. Hosted on GitHub Pages,
installable to an iPhone home screen. Data lives in the shared Supabase project
alongside Field Measure, in tables prefixed `jobbook_`.

- `index.html` — the whole app. Originally built as a claude.ai artifact; the
  app code is unchanged apart from the lines that load the files below.
- `store.js` — the only file that knows where data lives. It answers the same
  calls the app made on claude.ai, using Supabase.
- `config.js` — connection settings (public by design; access is controlled
  by the database's security rules)
- `supabase-setup.sql` — the tables, security rules and live sync
- `manifest.webmanifest`, `icons/` — the home-screen app

## Signing in

Same email and password as Field Measure. Only accounts on the Job Book
members list can see or change anything; `supabase-setup.sql` shows how to
add someone. To sign out, open the app with `#signout` on the end of the address.

## Not here yet

Ask Claude, emailing a contact through Gmail, and sending an item to Google
Calendar ran on claude.ai's built-in features. They're hidden in this version
until they're rebuilt.
