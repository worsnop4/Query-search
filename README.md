# Query Search

Internal web app for searching warehouse stock by part number. Public search,
admin-only uploads.

- **Frontend:** React 19 + Vite
- **Database & auth:** Supabase (Postgres)
- **Hosting:** Vercel
- **Excel parsing:** SheetJS, in the browser

## Setup

```bash
npm install
cp .env.example .env    # then fill in the Supabase URL and anon key
npm run dev
```

Node is required. If `node` is not found, it is installed portable at
`%LOCALAPPDATA%\nodejs` — open a fresh terminal or add that folder to PATH.

## Supabase

Run these in the SQL Editor, in order. All are safe to re-run.

| File | What it creates |
|---|---|
| `supabase/setup.sql` | Tables, indexes, staging tables, swap functions, area mapping, RLS |
| `supabase/02_search_helpers.sql` | `found_part_numbers` RPC, `search_results` view |
| `supabase/03_upload_log.sql` | `upload_log` table, logging swaps, `latest_upload` view |
| `supabase/04_fix_upload_log_backfill.sql` | One-off repair, only if you ran the first version of 03 |

Admin accounts are created by hand in **Authentication → Users** with
*Auto Confirm* ticked. Public sign-up must stay **off**.

## How the data works

Two source files, uploaded separately and never touching each other's table:

- **Query** (`.xlsm`) — the daily WMS stock export → `inventory`
- **Master Data** (`.xlsb`, PFEP) — part names, car type, DLOC → `master_data`

### Column layout is not stable

The daily export changes shape depending on who produced it — 10, 11 or 12
columns, sometimes with an unnamed blank column between Quantity and Status.
The parser therefore maps columns **by header name**, never by position, and
refuses a file that is missing a required column. See the comment at the top of
`src/lib/parse.js`.

### Uploads are atomic

Rows are inserted into a staging table first. Only once every row has arrived
does `swap_inventory(n)` verify the count and replace the live table in a
single transaction. A failed, cancelled or abandoned upload leaves the live
data untouched, and searches never see a half-empty table.

### Zone Type → Area

The two Excel formula columns (`Zonetype 1`, `Area`) are **not** imported. They
are recomputed in Postgres by `calc_zonetype()` and `calc_area()` during the
swap. This was verified against all 194,731 rows of a real export: every one of
the 15 area buckets matched Excel exactly. If the mapping rules change, edit
those functions and re-run the `UPDATE` at the bottom of `setup.sql` — no
re-upload needed.

## Scripts

| Command | Purpose |
|---|---|
| `node scripts/test-parser.mjs` | Runs the real parser against local `.xlsm`/`.xlsb` files and checks every field lands in the right column |
| `node --env-file=.env scripts/smoke-test.mjs` | Runs the search page's queries against live Supabase |
| `scripts/export-csv.ps1` | Converts the workbooks to CSV for manual Supabase import (needs Excel; only used for the initial load) |
