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
(`tests/sondes/sonde-generation.mjs:37`, summary at `tests/sondes/sonde-generation.mjs:131`).
The harness refuses the silence: no count means the exit code is forced to `1`
(`tests/sondes/lancer.mjs:753`) and the reason is printed (`tests/sondes/lancer.mjs:827`).
Without the second half, the first would have prevented nothing — the next summary-less probe
would have gone green again.

Both directions are measured. Summary deleted, guard in place: `ROUGE generation SANS
SYNTHESE`, run exits `1`, and the log says *no count written* while displaying the five `ok`
lines — which is the whole point. One condition falsified instead (`409` → `418`): `4/5
checks green`, exit `1`, and the measurement it quotes is the real one (`HTTP 409`), so the
count moves rather than sitting there as a literal. Both restored: `5/5`, then `20/20` with
not one `SANS SYNTHESE` left in the log.

**The second guard, found by looking for the first one's limit.** What precedes only
forbids silence. A probe writing its count *before* its checks still passed: the word
was there, correct, and wrong. The harness recounted nothing — it took the probe at its word.

> A count has to be a faithful account of the verdicts written, **both terms**. The numerator
> says what passed, the denominator says what was checked — and either one alone lets the other
> half of the lie through.

So the harness counts the verdict lines actually written and compares
(`tests/sondes/lancer.mjs:776`); the gap is named with both measurements
(`tests/sondes/lancer.mjs:830`). One term would not have been enough: a count written in
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

What it still does **not** cover: it counts verdict lines by a given prefix (`ok`, `ROUGE`). A
probe writing its verdict anywhere else — at the end of a line, inside a table — would not be
counted, and the count would call it false when it is true. That is a refusal in the right
direction: a verdict the harness cannot read is a verdict it cannot check. But it has to be
known, and said. The two-way reference check has the same blind spot, and is next on the list.

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
