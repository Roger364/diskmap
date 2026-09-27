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
  for: a rule that fires too often is a rule you stop reading.
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

The binary opens `http://127.0.0.1:8756/` automatically. Options: `--port 9000`,
`--no-browser`.

Two cases are handled rather than failing silently: if an instance is already
running, a browser is opened onto it instead of starting a second one (two
instances would scan the same disks twice); if the port is taken by something
else, the next free port is used and the address is printed.

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
