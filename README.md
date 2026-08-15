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

## Moving to another machine

Supabase and Vercel are both cloud services — **nothing needs migrating there.**
The database, its data, the SQL functions and the admin accounts all stay exactly
as they are. Only the local development setup has to be rebuilt.

### 1. Install Node.js

With admin rights, the normal installer is fine:

```powershell
winget install OpenJS.NodeJS.LTS
```

Without admin rights, use the portable build (this is what the first machine
has, because the UAC prompt could not be answered):

```powershell
$ver = 'v24.19.0'; $dest = "$env:LOCALAPPDATA\nodejs"
Invoke-WebRequest "https://nodejs.org/dist/$ver/node-$ver-win-x64.zip" -OutFile "$env:TEMP\node.zip"
Expand-Archive "$env:TEMP\node.zip" "$env:LOCALAPPDATA\node-tmp" -Force
Move-Item (Get-ChildItem "$env:LOCALAPPDATA\node-tmp" -Directory)[0].FullName $dest
[Environment]::SetEnvironmentVariable('Path',
  [Environment]::GetEnvironmentVariable('Path','User') + ";$dest", 'User')
```

### 2. Install Git

`winget install Git.Git` with admin, or the portable MinGit zip from
[git-for-windows releases](https://github.com/git-for-windows/git/releases)
extracted to `%LOCALAPPDATA%\mingit`, adding `%LOCALAPPDATA%\mingit\cmd` to PATH
the same way as above.

**Restart VS Code completely afterwards** — terminals inherit PATH from when
VS Code started, so a new terminal alone is not enough.

### 3. Clone and install

```powershell
git clone https://github.com/worsnop4/Query-search.git
cd Query-search
npm install
```

### 4. Recreate `.env`

`.env` is deliberately not committed. Copy it across from the old machine, or
rebuild it from **Supabase → Project Settings → API Keys** (the same values are
also in **Vercel → Settings → Environment Variables**):

```
VITE_SUPABASE_URL=https://smjzdmcaojaumdtrqdpg.supabase.co
VITE_SUPABASE_ANON_KEY=<publishable key>
```

### 5. Check it works

```powershell
npm run dev
node --env-file=.env scripts/smoke-test.mjs
```

The smoke test queries live Supabase, so it confirms the whole chain in one go.

### Optional — the source workbooks

Only needed to re-run the parser tests. They are gitignored (large, and internal
data), so copy them across by hand if you want `scripts/test-parser.mjs` and
`scripts/test-multifile.mjs` to run:

| Script expects | What it is |
|---|---|
| `D:\project\template querry upload.xlsm` | a merged query export |
| `D:\project\PFEP Simple Master Data_*.xlsb` | the PFEP master data |
| `C:\Users\<you>\Downloads\query raw\*.xls` | the ~39 raw WMS files |
| `C:\Users\<you>\Downloads\Query - *.xlsm` | dated merged exports |

Those are the fallback paths. If your folders differ, pass the path as an
argument or set `$QUERY_DATA_DIR` — see [Scripts](#scripts) below; there is no
longer anything to edit inside the scripts. Nothing else depends on these
files — the app itself never reads from disk.

## Supabase

Run these in the SQL Editor, in order. All are safe to re-run.

| File | What it creates |
|---|---|
| `supabase/setup.sql` | Tables, indexes, staging tables, swap functions, area mapping, RLS |
| `supabase/02_search_helpers.sql` | `found_part_numbers` RPC, `search_results` view |
| `supabase/03_upload_log.sql` | `upload_log` table, logging swaps, `latest_upload` view |
| `supabase/04_fix_upload_log_backfill.sql` | One-off repair, only if you ran the first version of 03 |
| `supabase/05_admin_presence.sql` | `admin_session` table, `active_admins` view, the upload claim, and claim-checked `reset_*`/`swap_*` |

Re-running `setup.sql` reverts objects that 02, 03 and 05 replace — run those
three again afterwards, in order.

**05 is a breaking change.** It drops the old `reset_*_staging()` and
`swap_*(bigint)` signatures in favour of versions that take a session id, so
run it and deploy the frontend together. In between, uploads fail with
*function does not exist*.

Admin accounts are created by hand in **Authentication → Users** with
*Auto Confirm* ticked. Public sign-up must stay **off**.

### One admin per table at a time

Signing in is never blocked — two admins can be in at once. What is exclusive
is *uploading a given table*: pressing Replace takes a claim, and the second
admin's card locks with the holder's name until they finish. Uploads to
**different** tables run concurrently, since they share nothing.

The claim is enforced in Postgres, not the browser: `reset_*_staging()` and
`swap_*()` refuse to run without one, so calling the API directly with a valid
JWT gets you nowhere. A tab that dies mid-upload holds the claim until its
heartbeat goes stale, 90 seconds, and then the table frees itself — there is no
lock to clear by hand.

Names are the email's local part (`dian.ayu@panli.com` → `dian.ayu`), computed
in the database from the caller's JWT, so nobody can display as someone else.
The domain is dropped deliberately.

The `active_admins` view is readable anonymously, so the login page can show
who is in before you sign in. It exposes **only** the name, status and
timestamps — never the email or user id. Be aware this does publish valid
email local parts on a page anyone with the URL can reach; that is an accepted
trade-off for an internal site, and the reason the domain is left off.

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
does `swap_inventory(n, session_id)` verify the count and replace the live
table in a single transaction. A failed, cancelled or abandoned upload leaves
the live data untouched, and searches never see a half-empty table.

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
| `node scripts/test-parser.mjs [path...]` | Runs the real parser against local `.xlsm`/`.xlsb` files and checks every field lands in the right column |
| `node scripts/test-multifile.mjs [folder]` | Parses a whole folder of raw exports as one upload, as the admin page does |
| `node scripts/inspect-raw.mjs [folder]` | Surveys the raw exports: sheet names, distinct header layouts, duplicate counts |
| `node scripts/dupcheck.mjs [folder]` | Compares the duplicate rate in a merged workbook against a single raw file |
| `node --env-file=.env scripts/smoke-test.mjs` | Runs the search page's queries against live Supabase |
| `node --env-file=.env scripts/test-presence.mjs` | Signs in as two admins and proves one blocks the other, including via direct API calls |
| `scripts/export-csv.ps1` | Converts the workbooks to CSV for manual Supabase import (needs Excel; only used for the initial load) |

The four workbook scripts take a path, or read `$QUERY_DATA_DIR`; with neither
they fall back to the Windows paths of the machine the data was captured on.
`test-parser.mjs` also takes `--master=<file>` (or `$QUERY_MASTER`).

```bash
node scripts/test-parser.mjs ~/data/exports
QUERY_DATA_DIR=~/data/exports node scripts/test-multifile.mjs
```

A script that finds no data **exits non-zero**. It used to skip the missing
files and still print `ALL CHECKS PASSED`, so on any machine but that one a
broken parser was indistinguishable from a working one.
