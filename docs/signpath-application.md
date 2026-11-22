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
- Releases: 51 public releases since 2026-09-25, published from CI artifacts
  (GitHub Releases). Reference form: v0.1.117 (commit f192e3d, sha256
  767362C1E859D761041C7DFA237A4AA80EB7A4109F07F40AF407A7644CEED4B0).
  Under the Open Source Code Signing edition the artifact actually signed must
  come from the CI run that carries the signing request; that file will differ
  from v0.1.117 (commit hash embedded by `build.rs`), and its sha256 is
  recalculated before the signing request.
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

## Form fields — signpath.org/apply

Values in the order the form presents them. Legal name, email and discovery
channel belong to the maintainer and are deliberately not stored in this
repository.

| Field | Value |
|---|---|
| Project Name | `diskmap` |
| Repository URL | `https://github.com/Roger364/diskmap` |
| Homepage URL | `https://github.com/Roger364/diskmap` |
| Download URL | `https://github.com/Roger364/diskmap#build-and-run` |
| Privacy Policy URL | empty — no account, no telemetry, nothing collected. If the form insists: `https://github.com/Roger364/diskmap#code-signing-policy` (Privacy bullet) |
| Wikipedia URL | empty |
| Tagline | A fast, local disk-space explorer for Windows that shows what is big and what is old, and deletes only what you have previewed. |
| Category | Other |
| Description | diskmap is a disk space explorer for Windows. For every volume it shows the size and last-activity date of folders and files, sortable, with tree navigation, a treemap and a global search; the scan is written in Rust and runs in parallel. A local HTTP server serves a single-page interface, so nothing leaves the machine. Deletion is guarded: a full dry run first, a one-shot token, the Recycle Bin by default where one exists, protected paths, and an audit log — a file that was not previewed cannot be deleted. |
| Reputation | Early-stage, solo-maintained project, two months old: the evidence is a public, reproducible release history rather than reach. 51 releases since 2026-09-25, each built and tested by GitHub Actions from the tagged commit and published with the SHA-256 of the uploaded `diskmap.exe`; the binary embeds its commit hash, so a download can be traced back to a commit. GitHub records 67 downloads of the asset. No third-party coverage (articles, community threads) to cite yet. |
| Maintainer Type | Individual |
| Build System | GitHub Actions — `https://github.com/Roger364/diskmap/blob/master/.github/workflows/build.yml` |
| First Name / Last Name | the maintainer's legal name (account holder) |
| Email | the maintainer's address, used for the account and notifications |
| Company Name | empty (individual) |
| Primary Discovery Channel | maintainer only — if the route was the promptbox `SIGNPATH.md` template, the honest answer is *GitHub repository* |
| Please specify the exact source | the exact URL if the channel was a page, e.g. `https://github.com/sebbourgeois/promptbox/blob/master/docs/SIGNPATH.md` — to confirm, do not guess |

### Why this Download URL

The form requires the download page to mention that the project uses the
SignPath Foundation for code signing. `releases/latest` is the direct download
page, but its notes still say *unsigned, no certificate configured*: the release
job writes that body. The README page holds both the download instructions
(*Build and run*) and the code signing policy naming SignPath Foundation, so it
satisfies the condition today. The permanent fix is one line in the release-body
template of `build.yml`, so that every future release page carries the mention;
that is a workflow change and a release, not part of this document.

### Category

The Foundation's public categories are Accessibility, Audio, Developer tools,
Educational, Gaming, Graphics, Productivity, Science, Other. There is no
System/Utilities category; *Other* is the honest grouping for a disk-space
tool. *Productivity* is the nearest alternative if a reviewer prefers it.