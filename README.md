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
- **There is no installer and no published release.** Build from source, or take
  the binary the CI workflow produces as an artifact.

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

Defaults and guards:

- **Recycle Bin by default**, so the operation stays reversible — *where a
  Recycle Bin exists*. A volume can have none: an exFAT volume has no
  `$RECYCLE.BIN` at all, and `FOF_ALLOWUNDO` only ever meant "move to the
  Recycle Bin *if possible*". There, Windows destroys the file instead. So the
  preview says which case you are in **before** you confirm, and afterwards the
  app reports what actually happened rather than what was asked for: an entry
  requested for the Recycle Bin but destroyed is counted, named, and logged as
  such. Permanent deletion is available but requires typing `EFFACER`.
- **Protected paths are refused**: volume roots, `Windows`, `Program Files`,
  `ProgramData`, `System Volume Information`, `$Recycle.Bin`, `Recovery`, and
  whole user profiles.
- The preview re-checks that each path still exists, and warns above 20 GB.
- Every deletion is appended to `%LOCALAPPDATA%\diskmap\suppressions.log`
  (timestamp, **outcome**, size, path). The outcome is one of `corbeille`,
  `corbeille-refusee` or `definitif` — it records what took place, not what was
  requested.
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
would take a few seconds, but opening a handle on `\\.\C:` requires
administrator rights. Measured on an unelevated session: `C:`, `D:` and `G:`
refuse to open, only `E:` succeeds. Speed therefore comes from parallelism:
rayon fork/join, one job per subdirectory down to 16 levels deep.

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

On a machine with 24 logical cores and NVMe drives:

| Volume | Files | Folders | Size | Cold scan |
|---|---|---|---|---|
| `C:` | 2,256,830 | 297,990 | 873 GB | **35 s** |
| `G:` | 1,086,153 | 179,309 | 438 GB | 9 s |
| `E:` | 24,350 | 1,044 | 40 GB | 0.45 s |

About 73,000 entries/s. The result is cached in binary form under
`%LOCALAPPDATA%\diskmap\`, so later launches load in about a second instead of
walking the disk again.

One counter-test worth keeping: `DirEntry::metadata()` was suspected of opening a
handle per file. Measured on `System32`, 2.15 ms against 2.91 ms for raw
`FindFirstFileW`. The hypothesis was wrong, so the standard API stays.

## Build and run

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
