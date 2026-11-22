# MSIX packaging feasibility — diskmap

Analysis of whether diskmap can be distributed as an MSIX package through the
Microsoft Store (free signing, no SmartScreen, automatic updates).

## What diskmap is

- Single Rust binary `diskmap.exe` (no installer, portable).
- Opens `http://127.0.0.1:8756/` in the user's browser for the UI.
- Reads every volume on the machine (scanning), writes a cache under
  `%LOCALAPPDATA%\diskmap\`, writes a deletion log under `%LOCALAPPDATA%\diskmap\`,
  and deletes files via `SHFileOperationW` (Recycle Bin by default).
- Needs no elevation for normal operation (elevation only changes deletion
  semantics).
- Dependencies: Rust std + Windows SDK only; UI is embedded (`ui/index.html`).

## MSIX constraints that matter

1. **Install location is read-only.** The app may not write to its own install
   folder. diskmap writes only to `%LOCALAPPDATA%` and deletes user files — both
   are allowed in full-trust MSIX. ✅
2. **Full-trust (desktop bridge) is required.** diskmap needs raw file-system
   access (volume scanning, deletion, opening Explorer). A pure UWP sandbox would
   block this. Desktop Bridge (runFullTrust capability) is the correct model. ✅
3. **Registry virtualization.** Full-trust MSIX apps can write to HKCU; HKLM
   writes are virtualized. diskmap does not write to the registry: `src/win32.rs`
   only reads the per-volume `BitBucket` keys under `HKCU` through `RegGetValueW`,
   and declares no `RegSetValueW`/`RegCreateKeyW`. ✅
4. **Startup / background.** The app is launched by the user (double-click or
   terminal). No service or background task needed. ✅
5. **Network.** Localhost only. MSIX allows localhost loopback for full-trust
   apps. ✅
6. **File associations / protocol handlers.** None declared today. Optional
   (e.g. open a `.diskmap` cache). Not a blocker.
7. **Update mechanism.** MSIX via the Store handles updates automatically —
   this replaces the current "download from Releases" flow. The CI would publish
   to the Store instead of (or in addition to) GitHub Releases.

## Blockers / open questions

- **MSIX manifest + packaging.** Need a `Package.appxmanifest`, assets (icons),
  and a build step producing an `.msix`/`.msixbundle`. Tooling: `makeappx.exe`
  (Windows SDK) or `msix-packaging` Rust crate. The CI already runs on
  `windows-latest` with the SDK available.
- **Full-trust declaration.** Must declare `runFullTrust` capability and the
  desktop extension. Store certification for full-trust apps requires justification
  (diskmap's justification: local disk-space explorer, no network, no elevation
  required for normal use).
- **Store certification.** Full-trust apps are reviewed; SmartScreen-equivalent
  warnings are avoided once certified. Certification can take days to weeks and
  may require changes (e.g. no arbitrary file deletion without confirmation —
  diskmap already has dry-run + token + `EFFACER`, which helps).
- **Architecture.** MSIX is per-architecture (x64). diskmap is x64 only today.
  ✅ no extra work.
- **Cache path stability.** `%LOCALAPPDATA%\diskmap\` must remain valid under
  MSIX virtualization. Full-trust apps see the real `%LOCALAPPDATA%`. ✅
- **Explorer integration.** "Open in Explorer" via `explorer.exe` works from a
  full-trust MSIX. ✅

## Verdict

**Feasible, with moderate effort.** The app is a single portable binary with no
installer and no registry writes, which is the ideal MSIX candidate. The main
cost is the packaging step in CI and Store certification review. The benefit is
large: free signing, no SmartScreen, automatic updates, no dependency on
SignPath's community-approval gate.

## Recommended next step

1. Prototype locally: create a minimal `Package.appxmanifest` + icon set, build an
   `.msix` with `makeappx.exe`, install it locally (Add-AppxPackage) and verify
   scanning + deletion + cache + Explorer integration work inside the container.
2. If the prototype passes, add an MSIX build job to `build.yml` (parallel to the
   existing .exe job) and keep both outputs.
3. Submit to the Microsoft Partner Center (free developer account) for
   certification.

This route does not replace SignPath (which signs the raw .exe for users who
prefer portable binaries); it complements it. If SignPath is rejected for low
traction, MSIX becomes the primary trusted-distribution channel at zero cost.