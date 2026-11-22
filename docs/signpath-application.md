# SignPath Foundation — application text (diskmap)

To submit at https://signpath.org/apply

## Project name
diskmap

## Homepage
https://github.com/Roger364/diskmap

## Repository URL
https://github.com/Roger364/diskmap

## License
MIT — see LICENSE. No commercial dual-licensing.

## Description
A disk space explorer for Windows: for every volume, the size and date of folders
and files, sortable, with tree navigation and a global search. A local HTTP server
serves a single-page interface; the volume scan is written in Rust and runs in
parallel. The tool also performs safe, reversible deletion (Recycle Bin by
default, dry-run preview, one-shot token, protected paths, audit log).

## Why this project
diskmap helps users reclaim disk space safely. It scans entire volumes (millions
of files) in seconds, shows last-activity dates, and refuses to delete anything
that was not explicitly previewed. It is fully local, has no telemetry, and
ships as a single portable executable.

## Activity evidence
- Releases: v0.1.89 … v0.1.100 published from CI artifacts (GitHub Releases).
- CI: GitHub Actions (`build`, `windows`, `sondes`, `release`) green on every
  push to master; 25/25 probes green; 66 Rust tests.
- Source: https://github.com/Roger364/diskmap (public, MIT).
- Security: SECURITY.md documents 15 security findings and their fixes; 25
  acceptance probes cover host, CSRF, elevation, filet, deletion, reversibility.

## Build setup
- System: GitHub Actions, `windows-latest` runner.
- Build: `cargo build --release` (Rust, edition 2021).
- Single artifact: `target/release/diskmap.exe` + `target/release/diskmap.sha256`,
  uploaded by the `build` job and consumed (hash-verified) by the `windows`,
  `sondes` and `release` jobs. The release job never rebuilds.
- Provenance embedded in the binary: commit (12 chars), tree state
  (clean/dirty), agent (`github-actions`), commit date (UTC). The date is the
  commit date, not the build time, so two builds of one commit embed the same
  origin line; the SHA-256 of the uploaded file is published with each release.
- PE metadata: ProductName=diskmap, ProductVersion=0.1.0, FileDescription,
  CompanyName, LegalCopyright, OriginalFilename (via build.rs + winres).
- No signing secrets in the repository. SignPath is the intended route.

## Code signing policy
Published in README.md § "Code signing policy":
https://github.com/Roger364/diskmap#code-signing-policy

- Publisher of record: SignPath Foundation.
- Team structure (solo): maintainer holds author, reviewer and approver roles.
- MFA enabled on the GitHub account.
- What gets signed: only diskmap.exe from the build artifact.
- Privacy: fully local, no telemetry, no network transfers unless requested.
- Manual approval of every signing request in the SignPath dashboard.

## Contact
Roger364 (GitHub). MFA enabled on the account.