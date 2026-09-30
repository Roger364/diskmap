# diskmap

A disk space explorer for Windows: for every volume, the size and date of
folders **and** files, sortable, with tree navigation and a global search.

A local HTTP server serves a single-page interface; the volume scan itself is
written in Rust and runs in parallel.

## Status

**Version 0.1.0 — early, and explicit about what that means.** It does what the
next section describes, on Windows, and it has been measured on one machine.

- **The interface is in French**, as are the code, the comments and the commit
  messages. An English interface is not planned yet.
- **The binary is not signed.** Windows will show a SmartScreen warning on first
  run, and an unsigned executable that walks an entire disk is the kind of thing
  antivirus heuristics dislike. Signing is a per-year certificate cost this
  project has not paid — see *Build and run* to compile it yourself instead.
- **There is no installer.** Every push on `master` that passes the CI publishes a
  tagged release with the Windows binary attached, so you can download a tested
  build from the Releases page without installing anything. The binary is taken
  from the job's artifact rather than rebuilt: what you download is the one that
  passed `fmt`, `clippy`, `test` and the probes.

## What it does

- **A folder's size includes everything under it**, not just the files directly
  inside.
- **Last activity** is the most recent write anywhere in the subtree. This is the
  column that drives decisions: a 100 GB folder untouched for two years stands out
  immediately.
- Sort by size, last activity, name or file count.
- Case-insensitive global search across the whole volume — searching
  `node_modules` returns every occurrence with its size and path.
- **Map** view (treemap) alongside the table.
- Open any entry in Windows Explorer.
- **Delete** selected entries — see below.

## Deleting

Select rows, then *Delete*. Nothing is removed before a dry run has listed
exactly what will disappear and issued a one-shot token; the execution must
present that token, and it expires after ten minutes. So it is impossible to
delete something that was not shown first, or on the strength of a stale list.

The list is shown in full, scrollable, and a selection larger than **5 000
entries is refused outright** rather than truncated: an earlier version showed
the first 25 paths and then deleted the whole lot, which is precisely the
"deleted something that was not shown" case it claimed to make impossible.

Defaults and guards:

- **Recycle Bin by default**, so the operation stays reversible — *where a
  Recycle Bin exists*. A volume can have none: an exFAT volume has no
  `$RECYCLE.BIN` at all, and `FOF_ALLOWUNDO` only ever meant "move to the
  Recycle Bin *if possible*". There, Windows destroys the file instead. So the
  preview says which case you are in **before** you confirm, and afterwards the
  app reports what actually happened rather than what was asked for: an entry
  requested for the Recycle Bin but destroyed is counted, named, and logged as
  such. Permanent deletion is available but requires typing `EFFACER`.
- **The Recycle Bin's capacity is measured, not assumed.** A Bin exists, and
  the file is in it — that is a fact, and the app checks it against the `$I`
  records after the fact. It is *not* a promise that the file stays there.
  Windows caps every volume's Bin (`MaxCapacity`) and purges its oldest entries
  when it feels like it, without asking. So the preview reads the cap and the
  current occupancy and shows them: *"15 o inside, 53.5 MB cap — this 20 o lot
  fits."* When the lot would go past the cap, it says so **before** you
  confirm, and says what was actually measured: nothing is destroyed at the
  moment of deletion — measured on 27/09/2026, a 72 MB lot left the Bin at
  **1.66×** its cap with every file still in it — but Windows decides when to
  purge, and it does not say so.  When the cap cannot be read, the app says
  nothing rather than falling back on a default it has not measured.
- **Running elevated changes what a deletion means, so it changes what it
  costs.** Windows stops enforcing ACLs when the token is elevated: the files
  your account could not touch become deletable. A banner said so; a banner is
  not a rule, and the app decided the `EFFACER` word itself. The server now
  decides, and says which word it wants for which mode — elevated asks for the
  same word as permanent deletion, **added to** whatever the lot already
  required, not in place of it. And when nothing is at stake, no word is asked
  for: a rule that fires too often is a rule you stop reading. Checked
  end-to-end by `sonde-elevation.mjs` — see "The CI runner is always
  elevated" below.
- **A big enough lot has to be spelled out.** Under 20 GB, one click is the
  whole ceremony. Over it, you type `SUPPRIMER`; over 500 GB, `SUPPRIMER TOUT`.
  The thresholds are not a guess — the incident of 26/09/2026 moved **74.2 GB**
  in a single gesture, and before this rule that gesture asked for nothing while
  a 2 MB photo asked for its folder's name. The words **add up** rather than
  replace each other: a 600 GB permanent deletion asks for both, and each field
  says which rule it stands for. A rule that fires on every ordinary deletion
  stops being read, so below the threshold nothing is asked at all.
- **A folder whose loss is not trivial has to be named.** Two families, one
  rule. The personal ones — `Desktop`, `Documents`, `Pictures`, `Music`,
  `Videos`, `Downloads`, `Bureau`, `Images`, `Téléchargements` and their
  localised names. And the ones that hold keys and history: `AppData`, `.git`,
  `.ssh`, `.gnupg`, `.aws`, `.kube`. A repository whose `.git` you delete loses
  its history; a key pair you delete has to be reissued. Neither is recoverable
  by restoring from the Recycle Bin. When the lot touches one, the preview says
  so and asks you to **type the name of each one** — one field per folder —
  before the button comes alive. Open `Pictures`, select, delete: one field, type `Pictures`, done.
  Select everything in a user profile: six fields, because that is the case where
  slowing down is the point. The rule is **not a setting**: there is no switch to
  turn it off, and the server recomputes the folders from the frozen preview
  paths rather than trusting a list the client sends, so an empty `noms` buys
  nothing. It matches whole path **segments**, not prefixes: `.gitignore` beside
  a repository asks for nothing, because the comparison is exact. It matches
  on **names**, not on meaning: a work directory that happens to be called
  `Documents` on a data disk is protected too. That is the price of a rule that
  can be checked instead of guessed.
- **Protected paths are refused**: volume roots, `Windows`, `Program Files`,
  `ProgramData`, `System Volume Information`, `$Recycle.Bin`, `Recovery`, and
  whole user profiles.
- **Reparse points are refused again at execution time**. A path that changed
  into a junction or symbolic link after the preview is not deleted.
- The preview re-checks that each path still exists, and warns above 20 GB.
- Every deletion is appended to `%LOCALAPPDATA%\diskmap\suppressions.log`
  (timestamp, **outcome**, size, path, then `lot=`, `gen=`, `sel=`, `prevu=`,
  `motif=`). The outcome is one of `corbeille`, `corbeille-refusee`,
  `definitif` or `refuse` — it records what took place, not what was requested,
  and refusals are logged too. `prevu` is the path the preview showed and the
  fifth column the one actually processed: they are equal by construction, and
  they are two columns so that this equality is checked by reading the log
  rather than by re-reading the code. The `lot` groups every line of one
  execution. The first five fields are unchanged, so older lines stay readable.
- Identifiers are **positions in a snapshot**, and a position only means
  anything in the snapshot that produced it. Every snapshot therefore carries a
  generation number, served with the rows; a dry run that quotes a stale
  generation is refused with `409` instead of being resolved against the
  current index. The paths themselves are then frozen by the preview, and the
  execution deletes exactly those — it resolves nothing.
- The type of a row is carried **inside** its identifier (the high bit, see
  `Row.sel` in `src/scan.rs`), never as a separate field the client could get
  wrong. Directory and file positions overlap on any volume — folder 34 and
  file 34 coexist — so a separate `is_dir` let a wrong flag designate a
  *different* path, with that other path's size. A mistyped selector now
  designates nothing at all, and the preview says so.
- A successful deletion triggers a re-scan of the volume, so totals do not keep
  showing entries that no longer exist.

One implementation note: deletion deliberately uses normal paths (`C:\...`),
never the verbatim `\\?\` form used for scanning. With that prefix,
`SHFileOperationW` bypasses the Recycle Bin and deletes permanently — the exact
opposite of the intended default.

## Local only, and why that is not enough by itself

The server binds `127.0.0.1` and nothing else, so it is unreachable from the
network. Two further guards close what a loopback binding leaves open — worth
knowing if you script the API, since both answer `403`:

- **Every mutating route is a `POST` and requires the header `X-Diskmap: 1`.**
  A custom header is not a "simple" header, so a browser must request a
  preflight before sending one, and none is ever served. A plain `text/plain`
  POST from another page therefore cannot reach them.
- **Every route, reads included, requires `Host` to name this machine**
  (`127.0.0.1`, `localhost` or `::1`; the port is free). Without that check,
  **DNS rebinding** would defeat the first guard entirely: once the attacker's
  hostname resolves to `127.0.0.1`, the browser considers the requests
  same-origin, sends them itself, preflights nothing, and sets the custom header
  freely. Measured with the check removed — a page served under a rebinding
  hostname loads the real interface and reads the whole tree, `/api/tree`
  included.

## Why it is fast

Two causes, only one of which could actually be addressed.

**The MFT is not reachable without elevation.** Reading the file table directly
would take a few seconds, but opening a handle on a volume's raw device
requires administrator rights. Measured on an unelevated session: the NTFS
volumes refuse to open, only the exFAT one succeeds. Speed therefore comes from
parallelism: rayon fork/join, one job per subdirectory down to 16 levels deep.

**Aggregation was moved out of the walk.** Rolling sizes up to parents *during*
the scan costs a lock per file and per depth level. Instead the scan keeps only
`(parent, size, date)` and aggregates afterwards in two linear passes: a
directory is always given an id before its children, so `parent < child`, and the
roll-up is a single descending loop over indices.

Paths use the verbatim form `\\?\C:\`, otherwise the 260-character `MAX_PATH`
limit breaks deep `node_modules` trees. Junctions and symbolic links are not
followed: doing so would double-count (`C:\Documents and Settings` points at
`C:\Users`) and risks cycles.

### Measurements

Measured on a 24-core machine with NVMe drives, then rounded — the figures are
here for the order of magnitude, not as a promise, and a release build on
another machine will differ:

| Volume | Files | Folders | Size | Cold scan |
|---|---|---|---|---|
| system | ~2.3 M | ~300 k | ~870 GB | **35 s** |
| data | ~1.1 M | ~180 k | ~440 GB | 9 s |
| external | ~24 k | ~1 k | ~40 GB | 0.45 s |

About 73,000 entries/s. The result is cached in binary form under
`%LOCALAPPDATA%\diskmap\`, so later launches load in about a second instead of
walking the disk again.

One counter-test worth keeping: `DirEntry::metadata()` was suspected of opening a
handle per file. Measured on `System32`, 2.15 ms against 2.91 ms for raw
`FindFirstFileW`. The hypothesis was wrong, so the standard API stays.

## Build and run

Download `diskmap.exe` from the [Releases page](https://github.com/Roger364/diskmap/releases)
and run it, or build from source:

```bat
cargo build --release
diskmap.bat
```

The binary opens `http://127.0.0.1:8756/` **when you launched it yourself** —
by double-clicking, or from a terminal. A launch with no console, which is what a
script or an agent does, does **not** open anything, and the server says so
rather than leaving you to guess. Options: `--port 9000`, `--browser`,
`--no-browser`.

Two cases are handled rather than failing silently: if an instance is already
running, a browser is opened onto it instead of starting a second one (two
instances would scan the same disks twice); if the port is taken by something
else, the next free port is used and the address is printed.

> The browser opens for an interactive launch only. A script that starts the
> server does not get a window on your desktop, and `--browser` forces one
> anyway. Opening a window nobody asked for is an intrusion, however innocent
> the code.

`diskmap bench <LETTER>` times the walk of a single volume with no server and no
interface — useful to check performance on another machine instead of assuming it.

### Which code is this binary

```bat
diskmap.exe --version
```

```
diskmap 0.1.0 — 73aa8e20e550
73aa8e20e550 · arbre propre · construit par opencode le 2026-09-27 01:48 UTC
```

The binary carries its own commit, the state of the working tree at build time
and the agent that built it. A binary compiled with uncommitted changes says
**`arbre SALLE`**, because that is exactly the case nobody could account for on
26/09/2026: good code, never versioned, and no way to say which commit it came
from. The same line is printed at startup, before the address.

Set `DISKMAP_AGENT=<who>` when building to fill in the last field. Leaving it
unset does not fail the build — it prints `agent NON DECLARE`, which is the
point.

## Tests

```bat
node tests\sondes\lancer.mjs --liste      the probe table, runs nothing
node tests\sondes\lancer.mjs --volume V   everything, on a disposable volume
cd tests\sondes && npm test               the disposable-volume rule, on its own
```

The probes that create and delete test files may only run on a **disposable
volume**. Not a disposable folder: on 26/09/2026 a probe ran on a working data
volume and destroyed 79 real files permanently, sending 89 more to the
Recycle Bin, scattered across the whole disk. The paths it aimed at were
resolved against a rescanned index, so they designated other files than its own
— see `SECURITY.md` and §3.7 of that report.

### The CI runner is always elevated, and it cost seven probes

Nothing in the repository asks for elevation, and the workflow does not
either: GitHub Actions jobs run as administrator by construction. So the
first run after the elevation rule landed read it as a product defect when it
was seven probes asserting, in hardcoded text, that no word is required in
Recycle Bin mode — true on the maintainer's machine, false there, with not
one line of application behaviour having changed. The test was wrong, not
the product.

The rule that came out of it is about how a probe is written:

> A probe never assumes the instance. It reads it from `/api/state`, and
> derives the rule it is going to test from that.

`tests\sondes\config.mjs` carries `estEleve()` and `motsExiges()` — a
**second implementation** of the server's rule, derived from the facts and
never copied from its answer, since a copy would verify nothing. Seven probes
use it, and `sonde-elevation.mjs` checks the whole chain in a real browser:
the banner, the instance token, the exact agreement between the words the
interface asks for and the words the server requires of the same lot, the
destination still announced when a word is required, and the button that
lights up on the exact word and not before. It states a **law** rather than a
branch — Recycle Bin present, lot under the threshold, Recycle Bin mode ⇒
`EFFACER` required if and only if the instance is elevated — so the runner
exercises one half and a developer's machine the other, and neither can
vouch for the other.

Measured 27/09/2026, run `36329398102`: **19/19** elevated, **16/16** not.
The gap is not noise; it is the checks that only mean something on one side.

### Two rules that cost seven probes each, on 27/09/2026

**A diagnostic is not destroyed by the tool that shows it.** The harness kept the last
twenty-four lines of a red probe. That is the right call when a probe *crashes* — the
call stack is last — and the wrong one when a probe fails on its third check out of forty.
The interface probe went red on a click that had not navigated, waited sixty seconds, then
read the screen: the log showed a directory belonging to the runner's own temporary
folder, and nothing about the click. Same class, twice more that day: a window of 400
results that discarded the match, and a syntax check that passed on a stale copy of the
file the browser was not reading. Red verdicts are now printed wherever they are, with
their measurement, before the tail.

> A verdict is only worth what its measurement is worth. If the thing under test cannot
> change the outcome, the check is not evidence — say so, in the same line, or fix it.

The two verdicts that could not fail on 27/09 are the reason this rule exists. One
required a row to keep its name across a sort change, which sorting is supposed to
change. The other checked the order of a list with **one row**, where every order is the
same order — it passed while the server served the reverse, and it would have kept
passing. A probe now states its own support ("this folder has several rows to order")
before drawing a conclusion from it, and the UI probe's sort check is measured on four
files whose names and sizes do not rank alike.

### A wait is not a fact, and a reading is not a measurement either

A browser is always showing *something*, so a wait that requires "at least three rows" is
satisfied by the list that is **already there** — the folder listing still on screen while
the server answers the query that is about to replace it. The wait returns, the probe
captures the list from *before*, and the verdict measures a comparison nobody intended.

The interface probe had this twice, in two blocks of one run. The first was fixed on
27/09/2026 — the rupture test showed three red verdicts where there should have been one —
and it now waits for the breadcrumb, since no real folder carries `« ` in its trail. The
second waited on a row count, and it took a runner to expose it: run `36358128603` went
red with `avant` holding **eight** rows of assorted names and `après` holding the three
support files. Not a volume churning under the measurement — the folder, compared against
its own search. `V:` never showed it: there, the search answers before the capture.

Reproduced locally by putting 4 s of latency on `/api/search`, byte for byte the same
measurement. The wait is now the verdict's own criterion — every row carries the query's
token — and it holds at 4 s. With the guard put back, exactly one verdict goes red, and it
is the right one.

> A wait returns the list that is on screen. If that list is not the one the verdict is
> about, the wait is the defect, and the red it causes is true.

The same mistake one step later hides a **product** defect instead of causing a false red. The
probe read the screen at the *first* re-render, so it reported a list that a slower response
repainted two seconds later — the bug is `SECURITY.md` R11, two reloads that cross and the
older one paints last. The probe's green proved nothing about the last response, and its red
came down to chance of load: once in a full local run, never on a fast volume. It now records
**every** painting and reads only after the screen has held still for two seconds, and the
verdict that follows is the only one that sees the intermediate states. With the sequencing
removed, that verdict names the contradiction; with it, 36/36.

> Read the screen after it stops moving, and read it more than once. A probe that samples one
> instant measures the speed of the machine, not the behaviour of the code.

### A probe that counts nothing is not green, it is absent

One probe had been printing this on every green run since it was written:

```
vert   generation      SANS SYNTHESE
```

`SANS SYNTHESE` — *no summary*. The word was accurate: `sonde-generation.mjs` never wrote a
count. The other nineteen go through a shared `verifier()` that keeps it. This one kept an
array of **failures** and never a total: five checks, all performed, all correct, none
counted.

What made it survive so long is worth more than the bug. `SANS SYNTHESE` had been introduced
on purpose, to make the symptom visible — and it did its job. It just happened to narrow the
gap instead of opening it. A missing summary and a **dead** probe then both exited `0`, and
both printed a dash. The word reported; nothing failed; so nothing could ever be fixed.

> A probe that exits `0` without having written its count has measured nothing. That is a
> failure, not a score — and it differs from a dead probe only because it had the courtesy
> to speak.

The fix has to be in two places, or it does not hold. The probe keeps a count
(`tests/sondes/sonde-generation.mjs:37`, summary at `tests/sondes/sonde-generation.mjs:167`).
The harness refuses the silence: no count means the exit code is forced to `1`
(`tests/sondes/lancer.mjs:684`) and the reason is printed (`tests/sondes/lancer.mjs:1552`). A zero summary has its own door: `tests/sondes/lancer.mjs:677`, reason `tests/sondes/lancer.mjs:1493`.
Without the second half, the first would have prevented nothing — the next summary-less probe
would have gone green again.

Both directions are measured. Summary deleted, guard in place: `ROUGE generation SANS
SYNTHESE`, run exits `1`, and the log says *no count written* while displaying the five `ok`
lines — which is the whole point. One condition falsified instead (`409` → `418`): `4/5
checks green`, exit `1`, and the measurement it quotes is the real one (`HTTP 409`), so the
count moves rather than sitting there as a literal. Both restored: `5/5`, then `20/20` with
not one `SANS SYNTHESE` left in the log.

**The third and fourth guards, found by asking what the harness could not see about itself —
30/09/2026.** The two above watch a *probe*. Nothing watched the counts themselves: delete
three assertions from a probe and no control in this repository turns red — the run prints
`24/24 sondes vertes`, `npm test` passes, and the suite files a degradation as an improvement.
Nothing constrained a probe's *confessions* either. On 29/09 the run carried
`l'analyse n'a pas été vue en vol — scan_running non exercé ici`; on 30/09 it did not. A hole
that vanishes on a lucky run is worse than a permanent one: the green run denies it, and nobody
re-reads the log.

So two instruments, both with a floor and both counter-proved on the real harness:

- **A floor per probe** (`lancer.mjs:381`). Twenty-four values, each the *smallest* count
  observed across the 29 and 30/09 runs, never the largest: a floor taken on a lucky run turns
  red the day the machine changes. Two probes vary and the table says so — `tickets` is 9 or 10
  depending on whether a scan was caught in flight, `elevation` is 18 here and 19 on the runner,
  which is always elevated. The floor only speaks about **green** probes: a red one writes fewer
  checks — it skips a whole block when a gesture fails — and its red is enough. Three controls
  come with it, one of them free: a floor higher than what the probe wrote, a floor whose probe
  **no longer exists** (a rename, leaving a guard that can never fire again), and a printed count
  of how many green probes have *no* floor — a choice, and an invisible choice is not one.
- **An admission register** (`lancer.mjs:432`). An admission must justify itself, and the
  justification is verified. `couvert par <file> : <verification name>` means another probe
  *asserts* the same thing: the file must be in the catalogue and its source must contain a
  `verifier(` carrying that name — which is the answer to a third hole, *cited is not exercised*:
  `scan_running` was named by six probes and triggered by none. `structurel : <reason>` means
  nobody covers it, and the reason must be declared in `AVEURS_STRUCTURELS`: a **new** structural
  hole cannot slip in, it has to be written once, in a place that gets read.

The floor is *zero unjustified admissions*, not *zero admissions*: it bites, and it does not lie
about how many holes there are — the run prints that count every time. Eight admissions in seven
probes are now annotated. The detector was calibrated on the notes the past runs really wrote —
sixteen distinct notes, **two admissions and fourteen explanations, no false positive**: *"c'est
normal : un disque a des centaines de dossiers du même nom"* stays an explanation. Counter-proof:
a note that admits without justifying prints `AVEUX SANS JUSTIFICATION : 1 — le run est ROUGE`,
and the probes stay **2/2 green**. That is the only case where a green probe and a red run point
the same way: the refusal is the harness's, not a probe's.

**The branch that was measured instead of written.** I meant to add a probe for the
`négligeable` gap branch, then measured it. The threshold is `min(0.5% of root, 20 MiB)`. On the
disposable volume it is **38 bytes** against a **15 MB** gap — entirely NTFS and VHDX metadata the
application cannot see, and is right not to see. On `C:` the gap is **33.8 GB** against a 20 MiB
ceiling. No readable volume on this machine passes under the threshold, and none will: the branch
needs a volume built to be entirely readable. A probe for it could never run, so its green would
prove nothing — a report of holes wearing a probe's clothes. It is not written. The hole is in the
**Asking which guard no probe sees, and measuring the answer — 30/09/2026.** `verifier-preuves.mjs` counted
**3 of 23** findings with a replayable bite proof, and named the way to change it: `epreuve.mjs`, one guard at a
time. That is the queue 7/28 recommends abandoning — half an hour of thought per finding, for one line of catalogue.

The cost was never the compute. Measured: an incremental release build takes **4.3 s**. What cost was the
*decision* — which probe sees which guard — and that decision is made blind whenever a proof is written without
measuring it first. So the tool grew a `decouverte` mode: neutralise the guard, run **several candidate probes**
against it, and record which ones go red **and what they say**. The red lines are the raw material for the strict
`mesure`, written afterwards from an observed fact. And it has a floor: **an entry left in `decouverte` makes the
tool exit red**. A permanent discovery is a catalogue that no longer requires anything.

Six guards measured. **One had a witness.**

| guard | finding | candidate probes | result |
|---|---|---|---|
| `hote_local` | 3.4 | `host` | **33/33 to 14/33** — promoted to a proof |
| `gen_vue != snap.gen` | 3.1 | `generation` | red — **already proven**, same guard and same probe |
| `escapeHtml(d.label)` | R1 | `ui`, `erreurs` | 39/39, 46/46 — **no witness** |
| `mien !== requete` | R11 | `ui` | 39/39 — **no witness** |
| `scan_completed >= ticket` | R15 | `tickets`, `ui` | 9/9, 39/39 — **no witness** |
| purge of `pending` | R7 | `corps`, `suppression` | 4/4, 34/34 — **no witness** |

`3/23` becomes **`4/23`**, on the strength of `hote_local` alone: its verdict on `127.0.0.1.evil.test` goes from
*refused* to *refused **with HTTP 200***, and the `mesure` requires that 200 on the following line — the label
alone reads "refused" either way, and would prove nothing.

The result that matters is not the 4. It is the four holes **named**. R11 is the sharpest: its fix is
`if (mien !== requete) return;`, three times in the interface, and the probe that measures paintings does not see
it. The fix is real, the finding is real, and both would stay true if the guard vanished entirely. What each of the
four would need is written out in SECURITY.md §7/31; the cheapest by far is R7, whose invariant is a **pure**
`p.retain` on a `HashMap` — a Rust unit test would bite it in milliseconds, with no browser, no volume, no
elevation. It does not exist.

One pattern crosses the last three: the findings describe **interface-side** invariants, and their probes check the
*state* without ever provoking the *race*. `3/23` understates the work — R1, R7, R11 and R15 have no proof because
their probes have no scene, not because their fixes are doubtful. Naming the pattern is worth more than twenty
hand-written proofs.

**What the CI said, and it said two things — 30/09/2026.** Run `36598186930` came back
**red**. It is the first time the CI has had a verdict on the harness itself, and it pointed at
the harness rather than the product. Three defects, one of them mine.

*A floor that lied about what it measured.* The number is in the probe's own admission: the trash
ceiling of `D:` on the runner is **9727 MiB**, **38×** the 256 MiB bound the probe gave itself. Past
that bound the overflow branch is skipped — the probe's own summary reads `4/4` there, so **two** of
the six verdicts are not written. A floor of
6 was therefore **unsatisfiable by construction** on that machine, while here it is exact and
`plafond` writes all 6. A floor cannot be true everywhere: it has to say *which* one, and say it from
a measurement.

*And a correction, to that very paragraph.* The first version claimed "3 verdicts out of 6 on the
runner". That is a **reconstruction** from the probe's structure, not a measurement: the `windows`
job of the previous run never executed a single probe, `D:` having produced no snapshot. The right
figure is in the 30/09 log — `plafond 4/4`, floor relaxed by `6 - 2 = 4`. Passing a reconstruction off
as a measurement is precisely the sort of thing this document condemns elsewhere, and catching
oneself is no easier than catching code.

*The harness died exactly when it had to speak.* The floor message printed, then
`TypeError: Assignment to constant variable`: `code` was declared `const` and reassigned further
down. The process died, and **seven probes behind it — `elevation`, `csrf`, `erreurs`, `arret`,
`arret-idle`, `arret-running`, `reversibilite` — never ran**. They are not red. They do not exist.

Nothing local could see it: `node --check` passes, all three `npm test` verifiers pass, all 216
documentation references pass. Every one of those stops before the faulty line, or never runs it.
**A control that does not execute is not a green control** — it is an absent one, and it presents
itself as the opposite.

*And the fix of the fix was broken too.* The repair sitting in the working tree did not change
`const` to `let`; it **deleted the declaration**. `code` became undeclared, and a module raises a
`ReferenceError` on the first read. The diff said so in one line; no automatic control saw it.

**What changed.** `AVEURS_STRUCTURELS` gained a `couts` field (`lancer.mjs:9999`): a structural hole
no longer merely names itself, it **declares what it costs in verdicts**, and the floor relaxes by
exactly that — and by nothing else, because an unjustified admission relaxes nothing at all. The
number is not guessed; it is read from one place and recounted every run (`PLANCHERS RELACHES`). A
probe cannot buy its floor: it can only declare, once, in writing, the hole it just named. And if
the hole is ever closed, the note disappears, the floor goes back up, and the probe has to write its
verdicts again — which is the direction this mechanism can close in.

**Three guards nobody was looking at, which now look at themselves.**

- **The probe checks its own admission.** `noter()` (`sonde-corbeille-plafond.mjs:9999`) refuses to
  write an admission lacking the mark (`non exercée`) and the justification (`structurel : …`) the
  collector can read. The defect was on that side too: the admission said « NON ÉPROUVÉE » while
  `MOT_AVEU` only knows `non exercée` — so it was filed as an *explanation* and **swallowed**. An
  invisible hole is a hole absent from the register, which is what it already was.
- **A justification fits on one line.** The collector reads line by line, so a `structurel :`
  followed by a newline leaves the reason empty and the admission becomes "bare" — red, but for a
  *shape* error, wrongly accusing a hole that is properly declared. That is precisely the form I had
  written.
- **Both tables prove themselves before a single probe runs.** `TABLE_RECONNAISSANCE` pushes five
  real sentences through the real classifier and compares the category each one claims;
  `TABLE_PLANCHER` checks the relaxation arithmetic against the 30/09 measurements — including the
  case that matters: *an unjustified admission relaxes nothing*. A two-letter edit in `MOT_AVEU`
  would otherwise erase the whole register while the run printed `24/24 sondes vertes`, lying about
  its only subject.

The table bit on its first execution: a badly written test case — a note with no admission mark —
classified as *explanation* rather than *bare admission*. The control was right; the measurement was
wrong. That is what a counter-proof is for.

**Measured after the fix**, on the local disposable volume: **24/24 probes green**, `plancher :
24/24 gardées`, `aveux : 1 — 0 covered, 1 structural, 0 unjustified`, and the seven probes from the
crash list execute for the first time. On that volume the trash ceiling is under 256 MiB, so the
branch runs and the relaxation does not fire — which is exactly why it is proven by table rather
than by a run.

*What I did not do: `plafond` still has a floor of 6, and the overflow branch remains unexercised on
any machine whose trash exceeds 256 MiB. Relaxing the floor makes the run honest; it does not close
the run honest; it does not close the hole.*
**Fixing a crash reveals the defect it was hiding — 30/09/2026.** Run `36606537220` confirmed the
relaxation works: `plafond 4/4`, `6 - 2 = 4`, one more structural admission in the register, and the
seven probes the `TypeError` had killed all ran. `windows` stayed **red** for an unexpected reason,
and that is what this is about.

**The harness, returned to itself, immediately had something else to say.** With the crash repaired,
`palier` went red: **1 verdict written, 5 in the floor**. The same defect as `plafond`, on the same
kind of machine, for a different reason — the twenty-gigabyte threshold rule can only be exercised if
a folder above 20 GB exists, and on the runner none does. The probe has been saying so all along:

> `palier non éprouvé : aucun dossier de plus de 20 Go trouvé sur cette machine`

in two lines, in a dialect (`non **éprouvé**`) that matches none of the marks `MOT_AVEU` recognises,
and without the `note :` line the collector expects. The same pattern, the same consequence: **the
probe tells the truth, and the truth is not in a shape the control can read.**

The hole is now declared like `plafond`'s, with its cost: four verdicts, a floor taken from 5 to 1.
That is 7/32's mechanism applied to the second case, with no new code.

**What this episode costs, and why it gets written down.** The `TypeError` did not only kill seven
probes. It killed the harness **at the first floor**, so it **hid** every floor further down the
list. `palier` was already wrong on that machine; it was not *red*, it was *unseen*. The first defect
served as cover for the second, and the second would have been caught on the first run without the
first.

It is the counterpart of a defect this document has already written down: *a hole that vanishes on a
lucky run is worse than a permanent one*. Here it was not a hole that vanished, it was a **red** that
ate a red. A control that dies before the end protects nothing after it — and the fact that it died
*red* makes it easier to ignore, not harder.

**The infrastructure, meanwhile, is not a defect of this repository.** The `sondes` job failed twice on
a timeout and then succeeded on the third attempt, on the **same** `D:`, accepted on **declaration**
— the log says so in as many words. A volume accepted on declaration is one whose snapshot nothing
guarantees, and the 900 s are a constant, not a measurement. I did not touch the timeout: raising
it to 1800 s would move the failure to the next step rather than fix it, and a longer timeout on a
slow runner is not a correction, it is waiting. The finding stands: **the availability of the test
infrastructure is measured by no control in this repository.**

**When the snapshot does arrive, there is still one more.** On the next run the `sondes` job did not
time out: `D:` produced its snapshot and the run reached **23/24**. The remaining red is `csrf`, and
it is the **fourth** defect of the same family.

```
vert   csrf            9/9
       PLANCHER : csrf a ecrit 9 verification(s), son
       plancher est 12. Une sonde verte qui en ecrit moins a
       perdu des assertions — et rien d autre dans ce depot ne le voit.
```

`csrf` runs three cases: a local page, a private-network page, a `file://` page. Each silent case
costs one, and the probe writes three assertions per case — four when the page answers, one when it
does not. On the runner **one case in three did not answer**: 9 verdicts instead of 12.

And the probe had the right idea, written out in a nine-line comment:

> On distingue donc l'INACCESSIBILITÉ de l'ÉCHEC : la première se dit, la seconde se prouve. Un
> cas non mesuré n'est jamais compté ni comme réussite ni comme échec.

The distinction existed. It was invisible: the line it produced was
*"(page inatteignable sur « C » : … — rien n'a été mesuré)"* — no `note :` prefix, so the collector
filed it as an explanation. A fourth instance of the same fact: **the probe tells the truth, and the
truth is not in a shape the control can read.**

This one has a property the other three lacked: the cost **adds up**. The hole is declared once, with
`couts: 3`, and the harness sums one entry per silent case — so the floor drops by 3 per case, not once
for all. The table checks both: one silent case gives 9, two give 6.

**The infrastructure, meanwhile, is not a defect of this repository.** The `sondes` job failed twice
in a row on a timeout, then succeeded on the third attempt, on the **same** `D:`, which is accepted
on **declaration** — the log says so in as many words. A volume accepted on declaration is one whose
snapshot nothing guarantees, and the 900 s are a constant, not a measurement. I did not touch the
timeout: raising it to 1800 s would move the failure to the next step rather than fix it, and a longer
timeout on a slow runner is not a correction, it is waiting. The finding stands: **the availability of
the test infrastructure is measured by no control in this repository.**

**Fifth instance, and the most trivial: a dead register entry.** A local run reddened `tickets` twice
in a row, for two neighbouring reasons. First its admission came through as **"unjustified"**: the
register's motif said "la coalescence reste prouvée côté Rust" while the probe writes "**elle** reste
prouvée côté Rust". The register therefore never matched its own motif — an entry that matches nothing
declares nothing, and it had never known it, because the case had not come up. Then its floor of 9
went red: the conditional branch is worth **one** verdict, and the floor of 9 came from a run in which
that branch had been exercised.

Nothing new here, and that is what is new: a register motif describing a **paraphrase** of what the
probe says instead of its own words. It is the fifth time the same fact shows up — a probe telling the
truth in a shape the control cannot read — and it is time to name it as such rather than fix it five
times over. Five of the twenty-four probes now carry an admission, and **all of them** write it in the
dialect.

*What I did not do: `palier` still has a floor of 5, `csrf` a floor of 12, and their branches stay
without a 20 GB folder. Relaxing the floor makes the run honest; it does not close the hole.*

**Sweeping the silent probes, and what it taught — 30/09/2026.** Four probes had never written a
single admission — `host`, `entrees`, `elevation`, `corps` — so the adversarial sweep went there.
Result: **zero verdicts lost on any machine**, and roughly ten proof defects closed in §7/37-7/41.
A replaced proof (`host`: the parser answers before the app's guard, by construction), a dialect
never shipped (`entrees` had no `noter()` at all), a floor set on the wrong of two exclusive paths
(`elevation`: floor 18 was the *short* path; the runner, always elevated, writes 21), and a silence
qualified as acceptance (`corps`: the `null` from a dead server and the `null` from a waiting server
were the same value). The count of verdicts saw none of it — it measures losses, and these probes
had none. **A probe that always writes its count is not a probe that proves what it says.**

**Closing the six opened the seventh — 30/09/2026.** The two holes left open after the adversarial
pass are now shut, and shutting them surfaced one more defect where nobody was looking.

**The register now verifies itself.** Six of the eleven motifs carried no `couts`. The note was
filed as a *structural admission* — never red — but the floor arithmetic filters on `&& n.couts` and
relaxed nothing: a healthy probe declaring a known hole went red. The harness now refuses that
silence: every motif carries a cost, **zero included**, written and justified. `le clic n` is worth
zero — the probe is already red elsewhere — and that is a legitimate answer, as long as it is
written down. The control bites: removing a single `couts` stops the run before any table.

**`couvert par` no longer reads sub-words.** `includes` accepted `couvert par <une sonde>.mjs : e`
as soon as any verification name contained the letter `e`. The citation is now matched whole-word,
in sequence, accent-insensitively — `numero` and `numéro` are the same word, and a retyping that
drops an accent must not be rejected for it. Proven both ways: `sonde-tickets`'s real citation still
passes; a bare `e` does not.

**The seventh defect: the marker that erased itself.** While attributing the costs, one hole stayed
silent: `identifiant` declared its missing support, the register knew it, and the classifier
**refused the note**. The note began with `NE PAS MESURABLE —`, the collector strips that prefix
before classifying, and the remaining text carried **no admission mark at all**. The marker of the
admission was destroyed by the collection of the admission. Three probes carried the same trap —
`identifiant`, `entrees`, `erreurs` (the window watcher) — and a fourth variant (`arret`, writing
"n'est pas exercée") missed the regex, which requires the hyphenated word. *A collector that strips
the very prefix it just matched is eating its own proof: the short form and the long form of one
admission must not differ by the mark.* All four notes now carry the mark inside the body, where it
survives.

**Proven by a run.** 24/24 green, `identifiant` writes its 15 verdicts again (the support verdict
was lost with the branch), `erreurs`' floor relaxes by its one declared cost, and `PLANCHERS
RELACHES` lists one line — every relaxation is a written debt, therefore arguable.

register, with its three numbers, and the possible closure is named: a fillable disposable volume
the application fills itself, which needs elevation and a volume this project does not have.

**The second guard, found by looking for the first one's limit.** What precedes only
forbids silence. A probe writing its count *before* its checks still passed: the word
was there, correct, and wrong. The harness recounted nothing — it took the probe at its word.

> A count has to be a faithful account of the verdicts written, **both terms**. The numerator
> says what passed, the denominator says what was checked — and either one alone lets the other
> half of the lie through.

So the harness counts the verdict lines actually written and compares
(`tests/sondes/lancer.mjs:684`); the gap is named with both measurements
(`tests/sondes/lancer.mjs:1504`). One term would not have been enough: a count written in
advance reads `5/5` and is right for as long as everything passes. It is the numerator that
shows a verdict went red afterwards, and the denominator that shows a check was added without
being counted.

Measured before written, never after. All twenty probes of a full run were dumped one by one:
all twenty numerators equalled the number of `ok` lines, all twenty denominators the number of
`ok` + `ROUGE`. No `vert` starts a line, so neither enters the count. The rule **separates
nothing today** — it only forbids what would now slip through. Checking first mattered: a
coarser « count equals totals » rule would have raised three false reds, on `aNommer`,
`recherche` and `rechercheGrande`, which print text after their summary.

Four probes falsified, one per hole:

| Probe falsified | What the harness says | Exit |
|---|---|---|
| summary deleted | `no count written: the probe reported nothing` | `1` |
| one condition falsified (`409` → `418`) | `4/5 checks green`, measurement `HTTP 409` | `1` |
| summary written **in advance**, one verdict red, **exit 0** | `announces 5/5, and wrote 4 ok and 1 ROUGE` | `1` |
| a verdict written **after** the summary | `announces 5/5, and wrote 6 ok and 0 ROUGE` | `1` |

The last two are what the silence guard alone let through, including the worst of the four: a
probe that **lies about its numerator and exits 0 anyway**. The log then shows its own
`5/5 checks green` one line away from the diagnosis that denies it — the proof, at one line of
gap, that the word said nothing.

**The limit that was supposed to be there — and what measuring it actually says.** The rule
counts verdict lines by a given prefix (`ok`, `ROUGE`). A probe writing its verdict anywhere
else — at the end of a line, inside a table — would not be counted, and the count would call it
false when it is true. That was written here as a risk of a **false green**. Falsified before
touching it, because a supposed risk does not deserve a rule:

| Falsification, one change only | What the harness said |
|---|---|
| the prefix becomes `vert` (the summary itself stays honest) | `count inconsistent: the probe announces 5/5, and wrote 0 ok and 0 ROUGE` |
| the summary is pinned to `0/0`, verdicts intact | `count inconsistent: the probe announces 0/0, and wrote 5 ok and 0 ROUGE` |

**Neither passes, and neither can pass alone.** The two-term count makes the convention
self-checking: moving the prefix without touching the summary goes red, and pinning the summary
without moving the prefix goes red too. Reaching a false green would take moving both
**together** — a coordinated edit, so a decision, not a drift. The limit is real, but it is a
refusal in the right direction, and it says so.

**The fourth guard, found by looking for that hole: a `0/0` summary.** Looking for the false
green above turned up one that took a **single** change — and it passed. A probe whose set of
cases is empty writes no verdict, and its summary, computed like every other, reads `0/0`. The
harness saw a summary, so the silence guard could not bite. Measured, on `generation` returning
before its first `verifier()`:

```
vert   generation      0/0
  1/1 probes green
  no note
```

The very same line as a probe that had done thirty-eight checks. And the harness's own tally
certified the silence: `1/1 probes green`, `no note`. The worst part was not the `0/0` — it is
that **nothing in the log could tell it apart** from work really done.

> A `0/0` summary is not a summary. *I had nothing to test* is not a measurement: it is a defect
> of the probe, not a property of the volume, and it gets fixed.

Red, not a note. A note means *this volume cannot show me that*, which is legitimate — it is
what `identifiant` has done since 28/09. Here the volume is not deciding anything: the probe
has no set of cases, or its set of cases is empty. A probe that really has nothing to test on a
given volume must **check that it has nothing to test**: the absence is a measurement, exactly
as R10 already says for the support of a demonstration.

Measured before writing the rule, over three full runs (28/09/2026, twice locally and once on
the runner): the smallest of the twenty-one probes announces `1/1` — `palier` — and the rest run
from `3/3` to `38/38`. None announces `0`. The rule **separates nothing today**; it only forbids
what would now slip through.

The falsified probe exits `1`, the reason is written, and its own output stays under the
diagnosis — `no case to test on this volume`, then `0/0 checks green` — so what it did with its
absence stays visible.

**Still open:** the two-way reference check has exactly the same limit — it reads its own `ok` /
`ROUGE` lines to count them. Its refusal is in the right direction too: it announces its own
count, so a `verifier()` that wrote nothing would be seen. But it cannot tell a renamed
`verifier()` from an absent one, and that is next on the list.

### The background watch followed the state, never the screen

The code said the opposite of what it did, two lines away from the code:

> Background watch: it only exists to follow a volume being analysed from another window.

A scan triggered **elsewhere** — from a second window, or from a probe — left this window
displaying the previous snapshot. Reloading the tree existed only in `poll()`, and `poll()` is
started by exactly two local gestures, then **switches itself off** after one turn. A foreign
scan never reaches it.

Measured on the author's machine, 28/09/2026: three readings of the client at the moment of
the gesture, then sixty seconds later.

```
avant    {gen 9, statut scanning, scanning 'C',  veille vive, requete 6}
immediat {gen 9, statut scanning, scanning 'C',  veille vive, requete 6}
final    {gen 9, statut ready,     scanning null, veille vive, requete 6}
```

**`scanning` is not a boolean.** The field carries the **letter** of the volume being scanned —
`"C"`, `"V"` — or `null` when nothing is running (`scanning: Mutex<Option<char>>`, serialised as
`Option<String>`). This table used to say `true` / `false`, because the volume's `status` field
carries the value `"scanning"`; the two differ by one word. That is not cosmetic: on 29/09
`arret-running` compared `scanning === true` to decide whether an analysis was running, so the
"server is scanning but published no number" branch was never reachable, and neutralising the
number publication did not turn the probe red — it passed 3/3 with a "volume too fast" note.

`requete` does not move: **the request never went out.** The user's gesture — changing the
sort — calls `load(true)`, which returns without painting while the displayed volume is not
ready. The gesture is lost, silently. And the watch *does* see the scan end (`scanning: null`
at `final`): it sees, and reloads nothing. The request counter proves it better than reading
code would: after sixty seconds and a full watch cycle, the screen still held exactly the same
snapshot.

**The hypothesis I checked before writing it, which was wrong.** My first idea was a race
between the end-of-scan announcement and the publication of the new snapshot — the server
saying *done* before it serves the new tree. Falsified by measurement, polling `/api/state`
and `/api/tree` every 100 ms across a rescan of `G:` (180 708 folders, 1 097 990 files):

```
13.511 s  finished_ms -> 1790584764505  (gen served : 6)
13.511 s  gen -> 6
  GAP : finished_ms at +10392 ms, gen at +10392 ms  ->  0 ms
```

Both change in the **same sample**. The window is under 100 ms and it is not the cause. Writing
the rule on that hypothesis would have produced a fix for a defect that does not exist — and a
"fixed" screen that stays wrong.

> A screen displays a snapshot of the disk. If the disk has been analysed since, the screen is
> lying, and it must reload — even if the scan came from elsewhere, and even if the user's last
> gesture was lost on the way.

The fix is one landmark: the screen notes, at every paint, the `finished_ms` of the volume it
shows (`ui/index.html:427`). The watch compares (`ui/index.html:1868`) and reloads
(`ui/index.html:1873`) as soon as it differs — through `rechargerTri()`, not `load()`, so the
**selection** is kept. It is a deletion target, and a background reload has no right to move
it; a search in progress stays a search.

A second piece, without which the first would not hold: `poll()` was not clearing its flag. It
called `clearInterval(pollTimer)` on the way out without resetting the variable, so the flag
stayed true for good after the first locally-started scan, and the watch would have stopped
doing anything, ever. The name of the flag is the contract: it means *a scan started from here
is running*, so it is false when there is none.

Both directions, on a full run:

| | `identifiant` | `ui` |
|---|---|---|
| before | `12/13`, `generation 8 -> 8` | `25/27`, *the click did not navigate* |
| after | `13/13` | `37/37` |

Both probes were red **on the same code** the runner passes: the difference is not the version,
it is the **duration**. A rescan of the runner's `D:` takes under a second and the interface
cannot miss the moment; on `G:` it lasts long enough for a gesture to land inside it and be
dropped. It is the first defect in this project that only shows up on a slow machine.

**What the rule does not cover.** It rests on `finished_ms`, which the server writes when the
scan **ends**. A change made between two scans does not move the landmark — the screen is then
legitimately behind, which is the intended behaviour. And it says nothing about a second
window: the rule assumes there is only one, which is already the binary's model.

### The background watch followed the state, never the screen

The code said the opposite of what it did, two lines away from the code:

> Background watch: it only exists to follow a volume being analysed from another window.

A scan triggered **elsewhere** — from a second window, or from a probe — left this window
displaying the previous snapshot. Reloading the tree existed only in `poll()`, and `poll()` is
started by exactly two local gestures, then **switches itself off** after one turn. A foreign
scan never reaches it.

Measured on the author's machine, 28/09/2026: three readings of the client at the moment of
the gesture, then sixty seconds later.

```
avant    {gen 9, statut scanning, scanning 'C',  veille vive, requete 6}
immediat {gen 9, statut scanning, scanning 'C',  veille vive, requete 6}
final    {gen 9, statut ready,     scanning null, veille vive, requete 6}
```

`requete` does not move: **the request never went out.** The user's gesture — changing the
sort — calls `load(true)`, which returns without painting while the displayed volume is not
ready. The gesture is lost, silently. And the watch *does* see the scan end (`scanning: null`
at `final`): it sees, and reloads nothing. The request counter proves it better than reading
code would: after sixty seconds and a full watch cycle, the screen still held exactly the same
snapshot.

**The hypothesis I checked before writing it, which was wrong.** My first idea was a race
between the end-of-scan announcement and the publication of the new snapshot — the server
saying *done* before it serves the new tree. Falsified by measurement, polling `/api/state`
and `/api/tree` every 100 ms across a rescan of `G:` (180 708 folders, 1 097 990 files):

```
13.511 s  finished_ms -> 1790584764505  (gen served : 6)
13.511 s  gen -> 6
  GAP : finished_ms at +10392 ms, gen at +10392 ms  ->  0 ms
```

Both change in the **same sample**. The window is under 100 ms and it is not the cause. Writing
the rule on that hypothesis would have produced a fix for a defect that does not exist — and a
"fixed" screen that stays wrong.

> A screen displays a snapshot of the disk. If the disk has been analysed since, the screen is
> lying, and it must reload — even if the scan came from elsewhere, and even if the user's last
> gesture was lost on the way.

The fix is one landmark: the screen notes, at every paint, the `finished_ms` of the volume it
shows (`ui/index.html:427`). The watch compares (`ui/index.html:1868`) and reloads
(`ui/index.html:1873`) as soon as it differs — through `rechargerTri()`, not `load()`, so the
**selection** is kept. It is a deletion target, and a background reload has no right to move
it; a search in progress stays a search.

A second piece, without which the first would not hold: `poll()` was not clearing its flag. It
called `clearInterval(pollTimer)` on the way out without resetting the variable, so the flag
stayed true for good after the first locally-started scan, and the watch would have stopped
doing anything, ever. The name of the flag is the contract: it means *a scan started from here
is running*, so it is false when there is none.

Both directions, on a full run:

| | `identifiant` | `ui` |
|---|---|---|
| before | `12/13`, `generation 8 -> 8` | `25/27`, *the click did not navigate* |
| after | `13/13` | `37/37` |

Both probes were red **on the same code** the runner passes: the difference is not the version,
it is the **duration**. A rescan of the runner's `D:` takes under a second and the interface
cannot miss the moment; on `G:` it lasts long enough for a gesture to land inside it and be
dropped. It is the first defect in this project that only shows up on a slow machine.

**What the rule does not cover.** It rests on `finished_ms`, which the server writes when the
scan **ends**. A change made between two scans does not move the landmark — the screen is then
legitimately behind, which is the intended behaviour. And it says nothing about a second
window: the rule assumes there is only one, which is already the binary's model.

### A scan request during a running scan was accepted, then lost

`POST /api/scan/<volume>` answered `{"ok":true}` unconditionally. The function carrying the
request did:

```rust
if *app.scanning.lock().unwrap() == Some(letter) {
    return;
}
```

A silent return inside the one function whose entire contract is to **accept**. The client gets
`ok`, believes it got a scan, and got nothing.

Measured on the author's machine, 28/09/2026. The `generation` probe creates its folder, asks
for the scan, waits for it to end, then looks the folder up through `/api/search`. It is not
there:

```
[listing] nothing named “perime” — total=356 rendered=356 truncated=false exact=true
[listing] expected folder : G:/_diskmap_sondes/perime — exists : true
```

Three facts in two lines. The folder **exists**. The search answers `exact=true,
truncated=false` — the server claims it gave everything. And all 356 results contain
`experimental`: the server searched for `perime` and did **not** find the folder it had just
created. This is not a truncated search, it is a **snapshot taken before the folder was
created**: the request was swallowed by the scan already running, which had started before the
folder existed.

Why the runner never saw it: a 511 MiB `D:` is scanned in under a second, so two requests never
cross. On `G:` — 476 GB, 180 708 folders, 1 097 990 files — a scan lasts long enough for the
window to open. Like R14, the defect depends on the **duration of a scan**, not on the version.

> What covers a scan request is a scan **later** than the request. A scan in progress does not
> cover it: its snapshot was taken before the request existed.

Each accepted scan request now gets a monotone per-volume ticket. `start_scan`
(`src/main.rs:643`) returns it, and `/api/state` exposes `scan_requested` and `scan_completed`,
so a client can wait for **its** scan without missing a short run or mistaking the current scan's
completion for the requested one. Repeated requests coalesce in the queue (`demande_couverte`,
`src/main.rs:643`, and `en_attente.push(letter)`, `src/main.rs:643`): ten requests during one
scan request just one additional pass, not ten. A scan already in progress never satisfies a
request made after it began.

Completion is published with the completed snapshot, not when the scan merely starts or its
running flag drops. Lock order remains `scanning` → `queue` → `drives`; shutdown uses the same
barrier before blocking new requests. Ticket overflow is refused rather than wrapping and making
an old ticket look current.

**Counter-proof, same probe sequence:** with the old behaviour restored, `generation` goes
back to `SANS SYNTHESE` with the same `TypeError`. What `recherche` does is unchanged — which
is what stops it taking the credit.

**What the fix alone did not settle, and which is not a product defect.** On a full run,
`generation` still raised its `TypeError`. The cause is the same, one step lower: the server no
longer loses the request, but **the client still has no way to know when its own will have run**.
Three waits turned out to be false, and none of them by accident:

- `!scanning` is **true** in the gap between the running scan ending and the queued one starting;
- `finished_ms` moves at the end of the first, not the second — waiting for "a change" is not
  waiting for "*my* change";
- only the **fact** does not lie: does the entry the probe just wrote appear in the snapshot?

`generation` now waits for the entry, and absence is a **result**: it returns `null` and the
probe says so. It no longer raises a `TypeError`. Same family as R12 seen from the other end: a
probe that crashes writes no summary, so it exits on `SANS SYNTHESE` — the exact line a *dead*
probe produces.

At the R15 stage, waiting for the fact had been factored into a by-name search
(`attendreEntree`) and two file helpers (`attendreFichier`, `attendreFichierDans`). R16 removed
`attendreEntree` and `attendreFichierDans`, and changed `attendreFichier` from volume + name
to volume + directory path + name. The current API keeps `attendreDossier` and
`attendreFichier`, both addressed by directory path; the filename is searched only inside it.

**Measured, on the full run, before and after.**

| | before | after |
|---|---|---|
| `generation` | `SANS SYNTHESE` — `TypeError` | `6/6` |
| `recherche` | `20/25` | `25/25` |
| `identifiant` | `12/13` | `13/13` |
| `ui` | `25/27` | `37/37` |
| `sans-corbeille` | `10/10` or `SANS SYNTHESE`, run to run | `10/10` |
| `csrf` | `0/3` | `12/12` |
| total | 17/21 | **21/21**, two consecutive full runs |

The last two rows came later, for the same reason. `recherche` waited for a **generation
change** — an indirect fact: it can be the running scan's, the one already in flight when the
probe wrote its files. It now waits for **its own** file, by path. `csrf` looked its folder up
by `q=csrf`, a name every `node_modules` on the disk contains: the search is capped, the folder
fell out of the first page, and `sel` was `null` — three verdicts claiming the victim was not
in the snapshot, on a probe whose whole purpose is to conclude that the attack failed. It
addresses the folder by path, which is unique by construction.

A name is an address only while it is rare. A path is one.

**The ticket, now consumed by clients — 29/09/2026.** The server-side fix was a promise no one
cashed: the UI and the probes kept waiting on the global flag, which measurement shows lies
between two scans. Now:

- `POST /api/scan` answers `{ok, ticket}`, and every client waits for **its** ticket:
  `attendreTicket` (`tests/sondes/config.mjs:428`) loops on `scan_completed >= ticket` and never
  consults `!scanning` to conclude;
- the UI records the returned ticket (`ui/index.html:681`) and `poll()` stops on its publication
  (`ui/index.html:699`); the rescan after a deletion waits on the `scan_ticket` returned by the
  execution (`ui/index.html:1566`);
- `generation` requests its scan and waits on its ticket (`tests/sondes/sonde-generation.mjs:71`)
  — the fact-based wait below remains its proof of existence;
- the `tickets` probe (`tests/sondes/sonde-tickets.mjs:62`) exercises the contract from the
  client side: ticket returned, publication, measured coalescence (two close requests during a
  scan → two distinct tickets honoured by the same publication), and a file created before the
  request present in the snapshot published under that ticket.

**What remains a limit: nothing on this point — and half of what was written never was
one.** `attendreDossier` and `attendreFichier` query `/api/tree` under `!scanning`, presented here
as a second-rank gate. It is a SERVICE guard: it keeps a snapshot from being read in the middle of
a publication, and the loop never returns on it — it returns on the fact (`r.ok` for a folder, the
row for a file) or on its bound. `attendreAnalyse` was, on the other hand, a real substitute wait:
it is what the two statements conflated.

It is **removed** (29/09/2026). Its last caller — `lot`, the probe that replays the 26/09 incident
— waited `attendreAnalyse(VOL, 0)` right after its `POST /api/scan`: the function returned at the
first turn where `scanning` was false, hence on the PREVIOUS run's snapshot, and the following
`dry` left with a stale generation. The `gen` guard pushed back, rightly, and the failure surfaced
as a silent exception on an empty list — a race accident accusing a non-existent deletion defect.
`lot` now waits for the ticket it asked for (`attendreTicket`, `tests/sondes/config.mjs:428`),
then, for each batch, for the snapshot carrying every targeted name. Measured 29/09/2026: `lot`
9/9 in the full run, safety net unchanged.

### R16 — A negative ceiling invalidates the positive-cost verdict

**What was found.** While cleaning the harness wait API, a full run turned `lot` RED on its
“no quadratic term” verdict. In run `r16b`, the marginal was **−1.8 ms/file** from 1→25 and
**54.5 ms/file** from 25→100. The verdict's limit, `slope1 * 1.5 + 2`, was about **−0.7**.
It therefore rejected every non-negative marginal slope, including zero: its RED result alone
did not prove quadratic complexity. Same family as R12, seen from the threshold rather than
the summary: in both cases the instrument reported a color without establishing a valid
measurement.

**The cause of the discrepancy is unknown.** In `r16b`, the recycle durations were 1835 ms
(N=1), 1792 ms (N=25) and 5883 ms (N=100): 25 files took less time than one. In a separate
run after a warm-up, the warm-up took 62 ms and the measured lots took 50, 906 and 2438 ms
(marginals +35.7 then +20.4 ms/file). That sequence produced a positive limit; it neither
identifies the earlier 1835 ms nor proves all runs will be stable.

**The fix changes what is measured.** A recycle-mode warm-up request runs before the measured
lots and its time is excluded. A guard checks `threshold > 0` before comparing slopes; if the
calculated limit is not positive, the probe reports invalid calibration instead of presenting
its RED result as proof of quadratic complexity.

**Exploratory counter-proof by model, not a product measurement.** The model
`T(N) = f + c·N + I·[N=1]` has three parameters fitted to the three `r16b` recycle durations:
reproducing them exactly is therefore tautological and does not explain the discrepancy.
Extrapolating the model after removing `I`, the criterion passes at `q=0` and fails at `q=0.6`,
but lets `q=0.1` and `q=0.2` pass for the parameters tried. It therefore does not prove absence
of all curvature. In six synthetic combinations of fixed and per-file costs, all linear (`q=0`) cases passed;
two additional `q=0.6` cases failed. This bounded sweep checks these examples, not every
machine or curve.

**The same family found in the same pass.** `sonde-reversibilite.mjs` had its own local
`!scanning` wait, then looked up its folder by name. Run `r16` showed `sel=null` and
`SANS SYNTHESE` for `sans-corbeille` on `E:`. The probe now waits for its file by directory
path through the shared helper. `r16b` recorded 10/10 for `sans-corbeille`; after the `lot`
verdict change, full run `r16e` recorded 21/21 probes: `lot` 9/9, `sans-corbeille` 10/10 and
`reversibilite` 8/8. These runs validate those executions, not every possible condition.

**Still not covered.** The discrepancy's cause remains unknown. The `threshold > 0` guard
rejects a non-positive calibration but does not explain it. R16 covers the cost verdict only: the
wait preceding each batch — the requested ticket, then the snapshot carrying every name — is not
covered by this finding.

### A verdict that depends on something you do not control is not a verdict

On 28/09/2026 the runner came back with `identifiant` **red**: `identifiant 10 -> 10 on this
volume`. Eleven other verdicts passed, including the one that mattered — *a folder that is gone is
said, not replaced*. What failed was a **demonstration**, not the contract.

`sonde-identifiant.mjs` does not merely claim that an identifier is a position; it insists its
support is real, because a proof that does not prove itself is not a proof. The support was 300
folders created to push the numbers around. The root cause is in the scanner: it reads directory
entries with `fs::read_dir` and **does not sort them** (`src/scan.rs:977`). The order belongs to
the filesystem, not to us, and the filler sat at the volume root as a sibling of the working root
— so NTFS could enumerate it before or after, and that day it came after. The numbers did not
move. On a calm volume the probe could not demonstrate what it claimed, and the runner showed it
by failing: punishing a probe for a calm volume is not a test, it is a coin toss.

Two changes, in this order. The filler moved **inside** the working root, where it competes for a
position with the probe's own folder in the *same parent* — the shift becomes near-certain instead
of drawn, and the cleanup comes with the root. Then the support is **verified** before anything is
concluded: *was the filler seen by the scan?* That check is deterministic, and a folder missing
from the snapshot is a genuine **red**, not an unavailable demonstration. And if the support is
there and the number still does not move, the probe **says so** and carries it in its summary
(`+1 not measurable`) instead of going red — without claiming a green it did not earn either. Same
refusal as the silence guard, applied to a demonstration.

The rupture test removed the filler just before the rescan: `the filler was seen by the scan`
went red, measured `0/300`, run exited `1` — and the unavailable-demonstration note fired **at the
same time**, which proved both paths at once. Restored: `13/13`.

> Do not write a verdict whose outcome is up to the volume, the clock, or the filesystem. Verify
> its support, and when the support is missing, say so out loud instead of guessing.

### A note nobody can read is not a note

The harness used to print a probe's own output **only when it failed**. On a green run, whatever
that probe had to say went nowhere — which turns out to matter more than it sounds, because
probes are written to *say* things.

Four of them do, on purpose. They measure what they can, note what they could not, and exit `0`
like everybody else. That is a probe behaving correctly. But its note was invisible on every
successful run, so it was impossible to see — and, worse, impossible to count.

**Measured on the first line of the new code: eight notes per run, across four probes, invisible
since forever.** The best of the eight said, in as many words:

```
erreurs : branch "negligible gap" NOT exercised — 5 volume(s), all above the threshold.
          That green proves nothing.
```

A probe stating that its own green proves nothing — and nobody could read that, for months. The
same shape as the silence guard, seen from the other end: the thing that reported could not fail,
so nothing could act on it.

So the harness now reads the notes out of **every** verdict (`tests/sondes/lancer.mjs:1425`) and
prints them at the end of the run **with their text**, not just a count
(`tests/sondes/lancer.mjs:1552`). A count that does not say what it counts teaches nothing.

Then the signal had to be cleaned, or it would have gone quiet on its own. Of those eight notes,
**five were progress**, not warnings — *corbeille: 1 readable SID folder*, *generation 32 -> 33*,
*working folder removed*. A signal that is three-quarters noise teaches you to ignore it, and the
thing that gets ignored is the part that mattered. Two probes got a separate `info()` channel, and
`noter()` now means only *you need to know this*. Three notes survive on a local run, and all
three carry weight: a search **truncated at 800** (`exact=false, tronque=true`) and the unexercised
branch above.

> A note exists to say what a green does not prove. Print it on every run, and keep the ones that
> are actually warnings — the rest is noise wearing the same mask.

### Two files of the same size, and the order the user actually sees

Sorting by size has a tie, and the tie is the whole point: without a tiebreak, two files of the
same size land in whatever order the filesystem hands them over. The server breaks the tie by
name, always ascending, in **both** directions — a deliberate choice, because a tiebreak that
followed the sort direction would make the list unreadable — and a Rust test checks it. But all
of that is server-side. **On screen, the equality was never resolved**: the probe compared
rendered order for `by name` only, and said so in a comment, blaming the support.

The excuse was a good one — *a support that proves nothing is worse than no support* — and it
was wrong. The support simply did not exist yet, so it could be made.

Two files of the **same size**, written in the **reverse** of alphabetical order
(`tests/sondes/sonde-ui-suppression.mjs:101`). A server without a tiebreak renders them
`zztaille-z` before `zztaille-a`, because that is the order they were created in. The verdict
(`tests/sondes/sonde-ui-suppression.mjs:718`) requires names to ascend within every group of
identical displayed sizes, and goes red.

The check is deliberately **independent of the server**. Asking "does the screen show what the
server said" only proves the two agree, including when they are wrong together. "At equal size,
are the names ascending" needs no reference, and can only be true if the tiebreak exists.

No unit conversion either: rows are grouped by the **size text the interface rendered**. Two
rows are equal-sized if the UI writes the same thing for both. Parsing `2,0 Ko` into bytes would
add a source of false reds for nothing — the question is never *how many bytes*, only *which rows
are equal*.

Rupture test, tiebreak removed from the server:

```
ROUGE  at equal size, the screen sorts by ascending name — even in descending order
mesure : tri=size/desc · 4 equal-size groups :
  [["2 Ko",["zztaille-z.txt","zztaille-a.txt"]], …] · OUT OF ORDER: ["zztaille-z.txt","zztaille-a.txt"]
```

One red out of 37, and the right one. It also turned out the existing support files had ties all
along — `zztri-2` and `charlie` are both 300 bytes — nobody had just named them.


A note still does **not** fail the run. That would be the same mistake as 28/09: punishing a probe
for a calm volume. It is a fact to know, not a product defect — and it can no longer be missed.

### What makes a volume disposable

The harness refuses to start, before opening a server or analysing anything,
unless the working volume is one it can *measure* as disposable. A volume
qualifies when Windows reports it as a **virtual disk** (`File Backed Virtual`) —
a VHD is a file, and destroying it destroys that file, not data that lives
beside it.

The question the rule asks is deliberately not "does this volume look
throwaway". It is **"what else dies if I destroy it?"**, and the obvious
indicators answer it backwards. A small secondary partition on a data disk — a
few dozen megabytes, neither the boot nor the system volume, often labelled
"Reserved for system" — is approved by every heuristic there is, and holds
somebody's work. Size, `IsBoot` and `IsSystem` are anti-correlated with safety:
the data disk itself reports "neither boot nor system" as well, and that is
where everything lives. This is not a hypothetical: it is the volume the audit
that produced this rule was written about.

So a **physical** disk is never accepted, even alone on its medium: a
single-partition drive can be somebody's only backup, and no size or label
distinguishes it. A "sole partition" test was written, measured, and removed —
it was wrong. And when the measurement itself fails — PowerShell unavailable,
nothing read — the run is refused rather than assumed, because a case that was
not measured is neither success nor failure, and here both readings are
destructive.

The one way through is `DISKMAP_SONDE_MACHINE_EPHEMERE=<why>`, which asserts that
the **machine** is disposable rather than the volume. No measurement can
establish that: a CI runner's spare drive is a physical disk like any other,
and it is the runner that is thrown away. It is a value, not a flag, and it is
reprinted inside a banner on every run it permits — a declaration nobody can see
is a declaration nobody read.

None of this touches the application. `diskmap` still deletes on whatever volume
you point it at, with its own protections intact; the rule governs only where
*tests* may delete, and a person using the interface never passes through it.

`tests\sondes\creer-volume-test.ps1` creates a throwaway VHD for this. It needs
administrator rights, which is the point: mounting a volume is already a
privilege.

```powershell
# elevated, once
.\tests\sondes\creer-volume-test.ps1

set DISKMAP_SONDE_VOLUME=V
set DISKMAP_SONDE_RACINE=V:\_diskmap_sondes
node tests\sondes\lancer.mjs --volume V

# when done
.\tests\sondes\creer-volume-test.ps1 -Detacher
```

Two guards stand between a probe and the disk, and the second is the one that
was missing:

- the application freezes the paths a preview listed, and refuses a list whose
  snapshot generation has moved on;
- **the probes never speak to the server directly.** `lancer.mjs` interposes
  `tests\sondes\filet.mjs`, which forwards a deletion only if the preview it
  belongs to named nothing outside the working root. A probe run on its own
  against a server bypasses that — which is why `sonde-filet.mjs` checks the
  guard is present before it acts, and why the run is reported red if any probe
  other than `filet` provoked a refusal.

The default CI job still runs only the non-destructive probes, because it may
run on a self-hosted machine where "disposable volume" is not a guarantee. A
second job, on an ephemeral `windows-latest` runner, runs the lot.

## Limitations

- **Windows only**: direct Win32 calls, verbatim paths, launching Explorer. No
  POSIX abstraction was attempted.
- Without elevation some entries stay inaccessible (registry hives, protected
  system directories): 123 on the reference `C:`. They are counted and shown, not
  hidden.
- The `*.bin` caches contain the full tree of the volumes scanned. They are
  excluded by `.gitignore` and must never be committed.

## License

MIT — see `LICENSE`.
