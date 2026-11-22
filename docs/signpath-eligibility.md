# SignPath Foundation — eligibility checklist (diskmap)

Checked against https://signpath.org/terms.html and the promptbox SIGNPATH.md template.
Status: **eligible in principle, pending account + application** (A11–A13).

## Conditions

| Condition | diskmap status | Evidence |
|---|---|---|
| No malware / PUP | ✅ | SECURITY.md; sondes host/csrf/filet/elevation; no network exfiltration |
| OSI-approved license, no dual-licensing | ✅ | `LICENSE` = MIT |
| No proprietary / non-open-source components | ✅ | Rust std + Windows SDK (system libraries); no vendored proprietary code |
| Actively maintained | ✅ | Commits through 2026-11; CI green on `master` |
| Already released in the form to be signed | ✅ | Releases `v0.1.89`…`v0.1.117` published from CI artifact ; the PE-resources build ships since `v0.1.115`. The binary submitted to SignPath is `v0.1.117` (commit `f192e3d`, asset `diskmap.exe` 740 864 o, sha256 `767362C1…ED4B0`). Hashes differ between releases because `build.rs` embeds the commit hash, not because the source changed |
| Documented functionality | ✅ | README.md (what it does, deleting, security, build) |
| Verifiable automated builds from source | ✅ | `.github/workflows/build.yml`: single artifact, hash verified by consuming jobs, provenance (commit, tree state, agent) embedded in binary |
| Signed binaries carry product name/version metadata | ✅ | Added via `build.rs` + `winres` crate: `ProductName=diskmap`, `ProductVersion=0.1.0`, `FileVersion=0.1.0` (commit `0956adb`) |
| Uninstallation capability | N/A | No installer (portable .exe); nothing to uninstall. Document in application. |
| No unrequested network transfers | ✅ | Fully local; only `http://127.0.0.1` for the UI |
| Team owns source repo + build scripts | ✅ | Roger364 owns `Roger364/diskmap` |
| Team responsible for dev + maintenance | ✅ | Solo maintainer |
| MFA on GitHub + SignPath | ✅ GitHub / ⚠️ SignPath | GitHub (Roger364) enabled 2026-11-22 ; SignPath: to enable when the account is created |
| Code signing policy published on home page | ✅ | README.md § "Code signing policy" (added 2026-11-22) |
| Team structure with roles (author/reviewer/approver) | ✅ | Named in the policy (solo: maintainer holds all three) |
| Privacy statement | ✅ | In the policy (fully local, no telemetry) |
| Manual approval of every signing request | ✅ | Maintainer approves in SignPath dashboard |
| Artifact configuration (PE metadata enforced) | ⚠️ | PE metadata present in the binary (`0956adb`, verified via `VersionInfo`) ; artifact configuration still to create in SignPath (`ProductName`, `ProductVersion` enforced) |
| `SIGNPATH_API_TOKEN` only at gate 4 | ✅ | Not created yet (correct) |

## Prerequisites to complete before applying

1. ~~Enable MFA on the GitHub account (`Roger364`).~~ Done (2026-11-22).
2. ~~Add PE version resources (`ProductName` = `diskmap`, `ProductVersion` = `0.1.0`) to the binary
   (via `build.rs` with `winres` or post-build `rcedit`). Currently the binary reports identity
   only through `--version`.~~ Done (2026-11-22) — `build.rs` + `winres` crate.
3. Publish the code signing policy (done in README.md).
4. Ensure the README download/release pages mention "Code signing policy" (done).
5. Verify no proprietary component is shipped (done — only Rust std + Windows SDK).

## Risk

SignPath Foundation may **reject** the application for insufficient external traction
(stars, forks, contributors, third-party references), as happened to the docent
project. The free path is blocked on reputation, not on engineering. Mitigation:
- Build GitHub traction (stars, issues, releases) in parallel.
- Prepare the Microsoft Store (MSIX) route as a fallback that does not depend
  on community approval.

## Application

- URL: https://signpath.org/apply (or https://signpath.org/open-source)
- Required inputs: project name, homepage, repository URL, license (MIT), description,
  evidence of activity (release history), CI system (GitHub Actions), link to release workflow.
- After approval: create project `diskmap`, policies `test-signing` / `release-signing`,
  artifact configuration (zip with `diskmap.exe`), then `SIGNPATH_API_TOKEN` secret.

## References

- SignPath Foundation terms: https://signpath.org/terms.html
- SignPath for OSS: https://about.signpath.io/product/open-source
- PromptBox SIGNPATH.md template: https://github.com/sebbourgeois/promptbox/blob/master/docs/SIGNPATH.md