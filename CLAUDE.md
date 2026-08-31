# Query Search — context for Claude

Internal web app: public search over warehouse stock by part number, with
admin-only data uploads. React 19 + Vite → Vercel, Supabase Postgres, SheetJS
parsing in the browser.

Read this before changing anything. Most of it was learned the hard way from
real data and is not obvious from the code.

---

## Current state

| Feature | Status |
|---|---|
| Search page (public) | **Working, verified against live data** |
| Query upload — 39 raw `.xls` files at once | **Working end to end** (194,278 rows, ~4 min) |
| Master Data upload (`.xlsb` PFEP) | Built, shares the same UI — **never run by the user** |
| Upload log / "Last update" header | Working |
| Admin presence + exclusive upload claim | **Working, verified with two real accounts** |
| Search filter by zone type | **Working** — needs `02_search_helpers.sql` re-run for the `zone_types` view |
| Admin export of all inventory | **Working, verified** — zipped CSV, ~1.8 MB from ~24 MB |
| Copy search results to clipboard | **Working, verified** — TSV, all matching rows not just the page |
| WhatsApp "notify group" after an upload | **Working** — pre-fills the message; the group is picked by hand, see below |
| Partial search by last 4 digits | **Working** — needs `06_partial_search.sql` for the trigram index, or it is ~0.8s per search |
| Search by case number | **Built** — needs `07_case_search.sql`, or it is ~0.8-1.4s per search |
| Vercel deploy | Live, auto-deploys from `main` |
| Dashboard | **Not started** |
| Breakdown pivot | **Not started** — has open questions, see below |

Repo: `https://github.com/worsnop4/Query-search.git` (private)
Supabase project URL: `https://smjzdmcaojaumdtrqdpg.supabase.co`

---

## The user

Warehouse/inventory engineer, non-native English speaker — keep explanations
plain and concrete. Prefers to build one feature at a time and discuss before
committing to the next. Has been consistently right about their own data when
correcting assumptions, so **ask rather than assume** about warehouse process.

They cannot upload files to chat. Source workbooks live on disk and are read
locally — see "Reading the source files" below.

---

## Architecture, and why

### Uploads are atomic, via staging tables

Rows are inserted into `inventory_staging` / `master_data_staging` in chunks of
2,000. Only when every chunk has landed does the app call
`swap_inventory(n, session_id)` / `swap_master_data(n, session_id)`, which
verifies the row count matches and replaces the live table **in a single
transaction**.

Both take a session id because the upload is exclusive per target — see below.
The one-argument signatures no longer exist; `05_admin_presence.sql` dropped
them deliberately, so a stale bundle cannot call an unprotected version.

Two things make this work at all, both easy to undo by accident:

- `set statement_timeout = '5min'` on the swap functions. Supabase caps the
  `authenticated` role at 8s, which a 195k-row swap blows through every time.
  Without it no upload can ever complete.
- The retry in `upload.js` re-checks the staging row count before re-sending a
  chunk. A request that failed *after* the server committed it would otherwise
  be inserted twice, and the exact row-count check would then reject the whole
  upload at the very end.

Consequences that matter: a failed, cancelled or abandoned upload leaves live
data completely untouched; searches never see a half-filled table; and nothing
writes to the live tables directly — the swap functions are `SECURITY DEFINER`
and are the only path in.

Never "simplify" this to a delete-then-insert.

### One admin uploads a table at a time

`05_admin_presence.sql` adds `admin_session`, one row per browser **tab**
(not per user — a second idle tab's heartbeat would otherwise overwrite the
uploading tab's status and drop its claim).

Pressing Replace calls `claim_upload(session_id, target)`. `reset_*_staging()`
and `swap_*()` then refuse to run without a live claim, so the exclusivity
holds even against someone calling PostgREST directly with a valid JWT. It is
per target: Query and Master Data can upload concurrently, since they share no
staging table.

A claim is live only while its heartbeat is fresh (90s, beaten every 30s), so a
tab that dies mid-upload frees the table by itself. There is no lock to clear
by hand — and `admin_release()` deliberately will not delete a row that is
mid-upload, because chunks may still be arriving.

The `active_admins` view is readable by `anon` so the login page can show who
is in. It exposes the display name, status and timestamps only. Names come from
`email_display_name(auth.jwt() ->> 'email')` — derived server-side, never sent
by the client, so they cannot be forged, and the domain is stripped because
that page is reachable by anyone with the URL.

Test it with `scripts/test-presence.mjs`, which needs two real admin accounts
and asserts the enforcement from outside the UI.

### PostgREST returns at most 1,000 rows per request

Measured on this project, not a guess: `.limit(5000)` and `.range(0, 4999)`
both come back with exactly 1,000 rows and no error. Anything that reads a
large slice of `inventory` must paginate — the full CSV export is ~195
requests, five at a time, about 17 seconds for 194k rows.

Always `.order('id')` when paging. Without a stable sort Postgres may hand back
the same row on two pages and skip another, producing a file that looks
complete and is not. `scripts/test-export.mjs` asserts exactly this.

The search page needs the same tiebreaker for the same reason, and it is easy
to miss because the visible sort *looks* specific enough: `part_number`,
`location` and `case_no` together are **not unique** in this data. A single
result set of six part numbers contained 83 rows sharing all three. That is
harmless for a 100-row page but would corrupt the multi-page clipboard copy, so
`resultQuery()` in `SearchPage.jsx` ends with `.order('id')`.

Note what this bug is like: an unstable sort is *permitted* to return correct
results, and in testing it did. It cannot be reliably reproduced, only
prevented. Don't remove the tiebreaker because a run looked fine without it.

An export must not run during an upload: `swap_inventory()` truncates and
re-inserts, so every id changes mid-read. The download button is disabled while
an admin holds the inventory claim, and the row count is compared before and
after as a backstop.

### The export is a zipped CSV, and Excel formats were measured, not assumed

Asked whether `.xlsb` would shrink the 24 MB export. Measured on a real
194,731-row export:

```
CSV        24.1 MB     0.2s
CSV.zip     1.8 MB      22s     <- 7.6% of the CSV
XLSX       23.9 MB     150s
XLSB          did not finish in over 7 minutes, twice
```

`.xlsx` is itself a zip container, but its XML is verbose enough that
compressing it lands back where the plain CSV started — 0.2 MB saved for 150
seconds. `.xlsb` never completed at all in Node with a 4 GB heap, and this runs
in a **browser tab**. Zipping the CSV is 13x smaller and `.zip` opens natively
on Windows Explorer, so the CSV inside opens in Excel as usual.

Compression is level 6, not 9: on this data 9 saves under 2% for roughly twice
the time, spent on the user's main thread.

`src/lib/exportFormat.js` holds the columns, the zip call and the file naming,
and imports nothing from Supabase — `supabase.js` reads `import.meta.env`,
which only exists under Vite, so anything importing it cannot be tested in
plain Node. That is the same reason `csv.js` is separate. `export.js` does the
paging and re-exports the rest, so callers still import from one place.

`scripts/test-export-zip.mjs` covers the round trip. Two traps it hit while
being written, both of which made a correct implementation look broken:

- **A three-row fixture gets BIGGER when zipped** (462 bytes from 438) — zip
  headers cost ~100 bytes and there is nothing to compress. Size is asserted on
  a 20,000-row payload instead, where it lands at ~3%.
- **`strFromU8` strips the BOM.** It decodes via `TextDecoder`, which drops a
  leading U+FEFF unless told not to, so checking the decoded string reported
  the BOM missing when it was present. Check `EF BB BF` as raw bytes.

The BOM belongs **inside** the zip entry, not on the archive — it is what makes
Excel read the extracted file as UTF-8.

### Partial search: contains, not ends-with

The operation team asks for parts by the **last 4 digits**. `src/lib/searchTerms.js`
decides what typed text means: a single entry of 4–7 characters is a *partial*
search; a pasted list, or anything 8+ characters, stays an exact `.in()` match,
which is both faster and precise.

Two decisions in there that look arbitrary and are not:

- **Contains, not ends-with.** 683 parts end in letters, so `10189242-PHD` does
  not end with `9242` even though that is the part someone means. Measured:
  `9242` ends-with returns **0 rows**, contains returns **158**. Ends-with looks
  broken exactly when it matters.
- **Minimum 4 characters.** 3 characters identifies exactly one part only 1.2%
  of the time and `00` alone matches 8,822 rows. At 4 the median is **1 match**
  and the 90th percentile is 3. Do not lower it — a trigram index also cannot
  help below 3 characters.

The term is stripped to `[A-Z0-9-/]` before it reaches the query. `%` and `_`
are ILIKE wildcards; a stray `%` would otherwise match the entire table.

**`supabase/06_partial_search.sql` is required for this to be usable.** A
`contains` match cannot use a btree index, so without the pg_trgm GIN index
Postgres scans all ~197k rows: measured 700–1000ms per search. With it, well
under 100ms. `scripts/test-search-terms.mjs` prints a warning if a partial
search takes over 300ms, which is the tell that the file has not been run.

### Case numbers are not part numbers, and the rules do not transfer

A second box above the part numbers searches `case_no`. It looks like the same
feature and is governed by opposite rules, all of them measured on 207,633 live
rows / 147,090 distinct case numbers:

- **Always a contains match. There is no exact mode.** The median case number is
  **42 characters** and the longest is 100 — `PALET OF 2026
  0213&0010007029_10003993_SMC2C4_2200.0_B16608901_740A_`. Nobody types one in
  full; they read a fragment off the label.
- **The input cannot be split into a list.** 54,728 case numbers contain
  **spaces** and 4 contain **commas**, so every separator that works for part
  numbers would cut real case numbers in half. Hence a single-line box holding
  one fragment, not a textarea. Newline, tab and semicolon are the only safe
  separators if a list is ever wanted.
- **Wildcards are ESCAPED, not stripped.** The exact opposite of
  `sanitizeTerm()`. 3,213 case numbers contain `_` and 555 contain `\`, both
  special to ILIKE — stripping them would make those cases permanently
  unfindable. `escapeLike()` backslash-escapes `\`, `%` and `_`. Verified
  through PostgREST: `%SMC_C4%` raw matches **1,349** rows because `_` means
  any character; escaped it matches **0**, which is correct.
- **Not upper-cased.** 20,314 case numbers contain lowercase letters, and ILIKE
  is case-insensitive anyway.
- **`CASE_MIN` is 6, not 4.** How much the last *n* characters actually narrow
  things, over 300 real case numbers:

  ```
   n    median rows matched    worst
   4            291           11,903
   6             50            2,382
   8             29              624
  12              7              196
  ```

  At 4 it is a browse, not a search. Do not reuse `PARTIAL_MIN`.
- The last-4-digits trick that works for parts **does not work here**: the last
  4 characters identify exactly one case only **2.6%** of the time, and even the
  last 8 only reach 11.5%.

The two boxes AND together. When a case fragment is present the "Not in query"
list is **deliberately not computed** — that message means a part has no stock
anywhere, and a part absent from *this case* is a different claim.

`supabase/07_case_search.sql` is required. `inventory` never had any index on
`case_no`, so a case search was a full sequential scan: measured 1,029ms exact
and 1,394ms contains, against 295ms for an indexed part-number search.
`test-search-terms.mjs` compares against the measured network floor and names
the file if it has not been run.

### WhatsApp cannot be deep-linked to a group

After a successful upload the admin gets a **Notify group on WhatsApp** button.
It opens WhatsApp Web with the message already written; the admin then picks
the group and presses send.

That last step cannot be automated, and it is not for want of trying:
WhatsApp's click-to-chat scheme accepts a phone number (`wa.me/<number>`) or no
recipient at all, and group chats have no addressable id in it. The
`chat.whatsapp.com/<code>` links are **invite** links — following one offers to
*join* the group, it does not open a compose box. There is no API for posting
to a group without WhatsApp Business, which is a different product with its own
onboarding.

So do not "fix" this by putting a group invite link in the button. It would
send people a join prompt instead of a message. `src/lib/notify.js` builds the
text; `scripts/test-notify.mjs` covers the message shape and the URL encoding
(a bare `&` or newline in the text would otherwise truncate the query string).

### Columns are mapped by HEADER NAME, never by position

**This is the single most important thing in the codebase.** The daily WMS
export is not a stable shape. Real files from one week:

```
14-08  11 cols  ... Quantity | <BLANK> | Status | Is Case Opened | ...
13-08  11 cols  ... Quantity | <BLANK> | Status | Is Case Opened | ...
12-08  12 cols  ... Quantity | Status  | Is Case Opened | ... | Zonetype 1 | Area
11-08  11 cols  ... Quantity | <BLANK> | Status | Is Case Opened | ...
07-08  10 cols  ... Quantity | Status  | Is Case Opened | ...
```

An unnamed empty column appears between Quantity and Status in files that have
passed through the user's macro/template; the true raw WMS export does not have
it. Reading fixed positions 1–10 (as the original project brief specified) puts
Status into `is_case_opened` and shifts both timestamps — and it *looks* like it
worked, because "Available" is a plausible-looking string.

`src/lib/parse.js` therefore reads the header row, finds each field wherever it
actually is, ignores everything else, and **refuses the file** if a required
column is missing. The canary tests in `scripts/test-parser.mjs` assert that
`is_case_opened` only ever contains Yes/No and `status` never does — if columns
shift, those two swap and both fail.

### The WMS exports ~39 files, not one

One day arrives as about 39 separate `.xls` files of ~5,000 rows each, with
machine-generated filenames **and a different sheet name in every file** (which
is why the parser falls back to the first sheet rather than looking for
"Sheet1"). The user used to merge them with a macro; that step is no longer
needed. `parseInventoryFiles` / `parseMasterDataFiles` take many files and
concatenate.

Sample folder: `C:\Users\INV-ENGINEER\Downloads\query raw`

### Zone Type → Area is computed in Postgres, not imported

The two Excel formula columns (`Zonetype 1`, `Area`) are deliberately **not**
imported. `calc_zonetype()` and `calc_area()` in `supabase/setup.sql` recompute
them during the swap.

This lives in SQL rather than the parser so that changing the mapping rules
doesn't require re-uploading 195k rows — edit the functions and run the `UPDATE`
at the bottom of `setup.sql`.

**Verified**: against all 194,731 rows of a real export, every one of the 15
area buckets matched Excel's own formula output exactly. Zero mismatches. Don't
casually "fix" this logic; re-verify if you touch it.

### Search does three queries, not a join

`SearchPage` queries `inventory` directly (paginated, `count: 'exact'`), fetches
part names from `master_data` once per search rather than per page, and calls
the `found_part_numbers` RPC to report which searched parts have no stock at
all. That last one exists because pagination means page 1 can't tell you what
*isn't* there.

---

## Verified facts about the data

Re-deriving these costs 15+ minutes of Excel COM scans. They were true as of
August 2026:

- **Part numbers are a mix of number and text cells** in both files. A numeric
  cell must render as a plain integer string — never `"23588931.0"`, never
  `"2.3588931e+7"` — or the join to `master_data` silently breaks for ~97% of
  rows. Real non-numeric values exist: `11559571-PMC`, `SM1367`, `1261/1262`.
- **All part numbers are uppercase**, so the search box upper-cases input safely.
- **Join health**: 11,458 of 11,462 inventory part numbers match master data.
  The 4 that don't: `11753213-PHD`, `26168234`, `11753212-PHD`, `27251632`.
  They render as `—` in search.
- **7,172 master parts have no inventory rows** — relevant to the Breakdown
  open question below.
- **Duplicate rows by (part+case+location) run at 6–8%** — inside a single raw
  file as well as in merged output, so not a merge artifact and not something
  the parser introduced.

  What they are, established 15 Aug 2026: **data-entry mistakes made by whoever
  updates the WMS.** The user identified them and is fixing them at source; they
  are not a warehouse concept the app needs to model. Examples at the time:
  part `10625728` had 15 byte-identical rows for one case (qty 6 each, same
  location, same timestamps, consecutive ids); `10218431` had one case repeated
  17 times. Of the repeating groups sampled, 7 in 10 were identical in every
  column and 3 in 10 differed only in the timestamps — **none** differed in
  quantity, location, case or zone.

  **Do not de-duplicate inventory, and do not aggregate it away in the UI.** The
  user chose to fix the source rather than hide it downstream, so the search
  page showing every exported row is deliberate: it surfaces the mistake instead
  of masking it. How results should ultimately be displayed (per row vs per
  case) is **deferred, not decided** — do not implement grouping unprompted.

  Worth re-measuring after a WMS-side fix has landed: if the rate drops, the
  cleanup is working; if it does not, the diagnosis needs revisiting.
- **Case numbers**, measured Aug 2026 over 207,633 rows: 147,090 distinct, none
  blank. Median length **42**, max 100. 54,728 contain spaces, 20,314 contain
  lowercase, 3,213 contain `_`, 555 contain `\`, 4 contain a comma, and none
  contain `%`. 16 are 3 characters or shorter, one of them just `-`.
  **A case number is not a unique location**: 2,774 (1.93%) sit in more than
  one location, up to 18. **Nor is it one part**: 8,107 (5.65%) hold more than
  one part number, max 705. Both matter for the Breakdown and Cycle Count.
- **The biggest "locations" are not physical places** — `NEED-CHECK-CASE`
  (8,824 cases), `BATTERY-SHOP` (7,760), `DUMMY` (3,926), `TRANSIT` (2,834).
  Anything that counts or reconciles stock has to decide what to do with these.
- **`is_case_opened`** is exactly `Yes` / `No`, no blanks.
- **`status`** is `Available` on every row — useless as a filter.
- **Rows per part**: median 6, 99th percentile 183, max 4,205 (part `26184917`).
  Pagination is not optional.
- **PFEP master data has no duplicates today** (18,630 rows, 18,630 distinct
  parts) despite the brief saying it would. De-dup logic stays as a safety net.
- PFEP contains inactive parts (`DLOC = INACTIVE-PART`, `Car Type = INACTIVE`).

---

## Environment quirks

- **Node is a portable install** at `%LOCALAPPDATA%\nodejs`. `winget install`
  fails because it needs an admin UAC prompt a non-interactive shell can't
  answer (exit 1602). If `node` is "not found", prepend:
  `$env:Path = "$env:Path;$env:LOCALAPPDATA\nodejs"`
- **Git is portable MinGit** at `%LOCALAPPDATA%\mingit\cmd`, same reason, same
  fix. It has no credential popup — the user pushes from their own terminal
  with a GitHub Personal Access Token.
- **VS Code terminals inherit PATH from when VS Code started.** After installing
  anything, VS Code needs a full restart, not just a new terminal.
- **SheetJS must come from the SheetJS CDN, not npm.** npm's `xlsx` is stuck at
  0.18.5 (2022) with known CVEs. Installed as
  `npm install https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`.
- **Commit messages: use `git commit -F <file>`.** PowerShell here-strings get
  mangled and split the message into pathspec errors.
- **PowerShell variables are case-insensitive** — `$C` and `$c` are the same
  variable. This silently clobbered a data array with a loop counter once.
- **`Select-String` is case-insensitive by default** — pass `-CaseSensitive`.
- Avoid `2>&1` on native commands in PowerShell 5.1; git writing to stderr on
  success gets rendered as a red error even when the exit code is 0.

### Reading the source files

Excel 16 is installed; read `.xlsm`/`.xlsb` via PowerShell COM. Read whole
ranges into an array in one `.Value2` call, in blocks of ~20k rows —
cell-by-cell over 195k rows is unusably slow. Always release COM objects in a
`finally` block. `scripts/export-csv.ps1` is the working example.

---

## Verification

Run these before claiming anything works:

```powershell
$env:Path = "$env:Path;$env:LOCALAPPDATA\nodejs"

node scripts/test-parser.mjs        # parser vs the real files, all layouts
node scripts/test-multifile.mjs     # 39 raw files parsed as one upload
node --env-file=.env scripts/smoke-test.mjs   # search queries vs live Supabase
npm run build
```

The workbook scripts take a path, or read `$QUERY_DATA_DIR`, falling back to
the Windows paths of the machine the data lives on. **A run that finds no files
exits 1.** It used to skip them and still print `ALL CHECKS PASSED`, so away
from that one machine a broken parser was indistinguishable from a working one
— do not reintroduce a silent skip.

`scripts/test-presence.mjs` needs two admin accounts, passed as
`ADMIN_A_EMAIL` / `ADMIN_A_PASSWORD` / `ADMIN_B_EMAIL` / `ADMIN_B_PASSWORD`.
It never calls `swap_*()`, so live data is safe.

`scripts/inspect-raw.mjs` and `scripts/dupcheck.mjs` are diagnostic, for when a
new file shape appears.

---

## Decisions already made — do not re-litigate

- **Search is fully public.** The user was shown that the anon key ships in the
  JS bundle and anyone with the URL can read all 194k rows, and chose public
  anyway. RLS: anon SELECT on `inventory`, `master_data`, `upload_log`.
- **Admin accounts are created by hand** in Supabase → Authentication → Users.
  No signup page.
- ~~**Exact match** on part numbers, not partial.~~ **Reversed 15 Aug 2026** —
  the operation team does not memorise 8-digit numbers, they remember the last
  four. A single entry of 4–7 characters now matches part numbers *containing*
  it; a pasted list, or anything 8 characters or longer, is still exact. See
  "Partial search" below.
- **Database keeps the name `inventory`** even though the UI says "Query". The
  user explicitly asked for website-only renaming. Do not rename DB objects.
- **Master data imports four columns**: Part Number, Part Name, Car Type,
  NEW DLOC (index 9 — *not* OLD DLOC at index 8, they sit adjacent).

---

## Pending work

### Needs the user, blocking nothing

1. **Test the Master Data upload once.** Built and sharing the same UI as Query,
   but never actually run. ~10 chunks, finishes in seconds.
2. **Re-check the Vercel site** — three commits have deployed since the user
   last looked at it.
3. **Confirm public signup is OFF** in Supabase → Authentication → Sign In /
   Providers. Asked twice, never confirmed. The site is public, so if signups
   are on, anyone can create an account and replace the data. **Security
   relevant — check this early.**

### Open questions, blocking the Breakdown feature

4. **Should the Breakdown show only parts with stock, or all active master parts
   including zero-stock ones?** 7,172 master parts have no inventory rows. A
   zero-stock part is exactly what the min-stock Status/GAP column is meant to
   catch, so it arguably belongs — but PFEP also contains `INACTIVE` parts that
   would clutter it. Recommendation given: build from `master_data` outward with
   inactive filtered out. **Not answered.**
5. **Does `Transit` collapse into one column?** It is reachable two ways — Stage
   1 (`Stock Area-Temp`, `Hold Area`) and the OW location match (`LOC` →
   Transit). Currently one column. **Not answered.**
6. **Is the NON-SAIC group only XIN1 and XIN2**, with every other OW area in the
   SAIC group? Assumed yes. **Not confirmed.**
7. **Dashboard "per Location" — raw location string or grouped by Area?** Raw
   locations are numerous; Area is probably more useful. Both views exist
   (`dashboard_by_location`, `dashboard_by_area`). **Not answered.**

### Known issues, not yet raised as urgent

8. **Timestamp timezone.** `inbound_time` / `first_inbound_time` arrive as text
   (`"2026-01-11 19:10:32"`), almost certainly local WIB (UTC+7), and are stored
   into `timestamptz` where Postgres reads them as UTC — a 7-hour shift. Nothing
   displays these columns yet, so it is currently harmless. Fix before building
   any feature that shows or filters by time.
9. `package.json` still has `"name": "inventory-search"`. Cosmetic, internal.
10. `XIN1` has a column and mapping but zero rows in every file seen so far.
    Expected, not a bug.

---

## Not yet built, from the original brief

- **Dashboard**: per-location/area distinct part count + total quantity, grand
  total, optional recharts bar chart. Views already exist in Postgres.
- **Breakdown pivot**: one row per part, columns per site, LOC / OW-SAIC /
  NON-SAIC groups with subtotals, Status + GAP against editable minimum-stock
  thresholds (LOC 200, OW SAIC 500). The `breakdown` view in `setup.sql` already
  computes the pivot and subtotals; Status/GAP are deliberately left to the app
  so the thresholds stay editable. Resolve question 4 first.
