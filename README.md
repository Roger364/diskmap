# diskmap

A disk space explorer for Windows: for every volume, the size and date of
folders **and** files, sortable, with tree navigation and a global search.

A local HTTP server serves a single-page interface; the volume scan itself is
written in Rust and runs in parallel.

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

- **Recycle Bin by default**, so the operation stays reversible. Permanent
  deletion is available but requires typing `EFFACER`.
- **Protected paths are refused**: volume roots, `Windows`, `Program Files`,
  `ProgramData`, `System Volume Information`, `$Recycle.Bin`, `Recovery`, and
  whole user profiles.
- The preview re-checks that each path still exists, and warns above 20 GB.
- Every deletion is appended to `%LOCALAPPDATA%\diskmap\suppressions.log`
  (timestamp, mode, size, path).
- A successful deletion triggers a re-scan of the volume, so totals do not keep
  showing entries that no longer exist.

One implementation note: deletion deliberately uses normal paths (`C:\...`),
never the verbatim `\\?\` form used for scanning. With that prefix,
`SHFileOperationW` bypasses the Recycle Bin and deletes permanently — the exact
opposite of the intended default.

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
