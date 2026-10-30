# Distribution

Where Lithic could be published, and what each target actually asks for. Scratch list, not a plan: tick what you decide to chase.

## Already shipped (kept here so the list does not re-propose it)

- **GitHub Releases** is the real storefront today: Windows setup `.exe` + `.msi`, two Linux AppImages (shim and WebKitGTK), macOS `.dmg` + `.app.tar.gz`, Android `.apk`, `lithic-server.tar.gz`.
- **lithic.uk** direct download, plus the launcher as a **PWA** (add to home screen / install in Chrome).
- **Docker**: `ghcr.io` image from `build-server.yml`; **Railway** via `railway.json`; **LXC** via `deploy/install-lxc.sh`.
- **Homebrew tap**: `brew install --cask xyvir/tap/lithic` (`Xyvir/homebrew-tap`).
- **Discoverium**: `discoverium.yml` already in the repo root.

## Android

The premise that sideloading ends in 2027 is too strong. Google's verification started **2026-09-30**, but only for installs from seven named stores in Brazil, Indonesia, Singapore and Thailand; the global expansion is announced for 2027 with no date. A user-side "advanced flow" (developer options, one day wait, one-time approval) shipped in August 2026, and ADB installs were never blocked. So Obtainium and Discoverium stay usable; what changes is that an *unverified* publisher's APK gets an extra warning and a one-time unlock.

- [ ] **Google Play** ($25 one-time). The actual big name, and the cheapest way to satisfy verification everywhere else: registering the package name and signing certificate in Play Console covers the GitHub APK too, so do this even if Play itself ends up unloved. Needs an `.aab`, the data safety form, a listing, and an account that passes identity checks. Watch the new-account gate: a personal account has to run a closed test with 12 testers for 14 days before production (an organisation account skips that, but needs a D-U-N-S number).
  - Register the sideload signing key alongside Play's, or the GitHub APK is a different developer as far as verification is concerned.
- [ ] **IzzyOnDroid** (best value for FOSS Android). Reuses the developer-signed APK from the GitHub release, no rebuild, and its audience is exactly the Obtainium crowd. Submission is an issue on `IzzyOnDroid/repo`.
- [ ] **F-Droid** (the big name, the big cost). Builds from source with its own key, needs FOSS-only dependencies and a `fdroiddata` metadata file that a Tauri/Rust project makes awkward. Real reach, permanent maintenance.
- [ ] **Obtainium** needs no submission at all: anyone can point it at the releases page. Worth a line in the README rather than work.
- [ ] **Accrescent**: alive, registered itself with Google so it keeps working, but **not accepting new allowlist requests** right now. Revisit later.
- [ ] **Samsung Galaxy Store / Amazon Appstore / Huawei AppGallery**: each wants its own review and account for the same APK. Skip until Play exists.

## Windows

- [ ] **winget** (biggest reach per hour spent). Manifest PR to `microsoft/winget-pkgs`, one folder per version pointing at the version-tagged setup `.exe` with a SHA256. Then `winget install Lithic`. Unsigned installers pass validation but still raise SmartScreen on first run, so it looks better with signing.
- [ ] **Microsoft Store** (MSIX, $19 one-time individual account). The one place an unsigned app arrives without a SmartScreen warning, because the Store re-signs it, and it updates itself. Tauri does not emit MSIX, so this is extra packaging work on top of the NSIS build, plus Store policy review.
- [ ] **Chocolatey** (`choco install lithic`). A package that downloads the release `.exe` with a checksum, pushed to community.chocolatey.org, moderated in days. Dev/ops audience.
- [ ] **Scoop**: either submit to `ScoopInstaller/Extras` or keep a two-file bucket of your own (`checkver` + `autoupdate` handle releases). An hour of work, small audience, zero review.

## macOS

- [ ] **homebrew-cask official**: blocked, and this is the reason the tap exists. An unsigned bundle cannot be accepted; it needs a Developer ID and notarization, which needs the paid Apple Developer Program ($99/yr).
- [ ] **Mac App Store**: $99/yr plus App Sandbox, and the app writes beside itself and registers file types. Assume never.
- [ ] **Setapp**: curated paid Mac subscription store, invite-only. Not a fit.

## Linux

- [ ] **Flathub** (biggest Linux storefront). Needs an AppStream metainfo file with screenshots, an app ID on a domain you own (`uk.lithic.Lithic`), and a `flatpak-builder` manifest that Flathub builds from source itself. The WebKitGTK build is the one that ships there (the 3 MB shim needs a browser and cannot be a flatpak app). Silver lining: `platform::package_managed` already answers for flatpak and snap, so a store-managed copy is offered no Install button and no hand-delivered update, which is exactly right.
- [ ] **Snap Store**: `snapcraft.yaml` plus the desktop-integration extension; `classic` confinement means a slow manual review, strict means living in the sandbox. Medium effort, modest Linux-desktop audience.
- [ ] **AUR**: `lithic-bin` wrapping the shim AppImage, and optionally a source build. No review, just a git repo on aur.archlinux.org, and a large audience that expects it.
- [ ] **.deb / .rpm in the release**: nearly free, since Tauri already knows how to emit both; today only the AppImages ship. Add the bundles to `desktop-release.yaml` and the README table. A proper apt/dnf repo (GitHub Pages metadata, Cloudsmith, Packagecloud) is the follow-on.
- [ ] **Fedora COPR / openSUSE OBS**: free build services, as much work as writing a spec file.
- [ ] **Nixpkgs**: a PR to `NixOS/nixpkgs` building from source. Very high credibility, high effort, and a self-hosted flake is the cheap version of the same thing.
- [ ] **AppImage catalogue** (`appimage.github.io`): the README already points at it; it takes the WebKitGTK build, one entry, needs an `appdata.xml` and a PR. Cheapest Linux target of all.

## Self-host

The one you were thinking of is **community-scripts.org**, the Proxmox VE and Incus helper scripts (formerly tteck's, now `community-scripts/ProxmoxVE`, 700+ scripts). `deploy/install-lxc.sh` is most of that submission already.

- [ ] **community-scripts.org**: a GitHub issue/PR against `community-scripts/ProxmoxVE`; they want an install script that works inside a fresh Debian LXC.
- [ ] **Unraid Community Applications**: a template XML PR to `selfhosters/unRAID-CA-templates` (repo, icon URL, port, `/data` path). Very cheap, large homelab audience.
- [ ] **TrueNAS**: community apps are Docker compose based since 25.04, so it is a compose app plus catalogue metadata.
- [ ] **Umbrel**: PR to `umbrel-apps` with `docker-compose.yml` + `umbrel-app.yml` + icon.
- [ ] **CasaOS** (BigBearCasaOS store): compose file plus a PR, same shape as Umbrel.
- [ ] **Coolify / Dockge style one-click lists**: a service template in the project's repo.
- [ ] **LinuxServer.io**: they package and maintain the image themselves, so this is a request rather than a submission. Big credibility, no control.
- [ ] **YunoHost / Cloudron**: real packaging (manifest + install/backup scripts, LDAP and SSO plugins). Heavy for a single-app project, worth noting only because their users ask for one-click.
- [ ] **PikaPods / elest.io**: managed hosting, they add apps on request and usually pay open-source projects a share. A conversation, not a PR.
- [ ] **Docker Hub mirror** next to `ghcr.io`, so `docker run lithic` is a thing and every catalogue that assumes Docker Hub stops needing a caveat.

## Cross-cutting: signing

None of this is required for the GitHub release channel, and all of it is what unlocks the catalogues and kills the "unknown publisher" warning.

- **Windows**: Azure Artifact Signing (formerly Trusted Signing), $9.99/month Basic, individual applicants accepted but country-restricted (US/Canada at minimum). Cheaper than an OV certificate by an order of magnitude and the same effect on SmartScreen.
- **macOS**: Apple Developer Program, $99/yr. Buys notarization, which buys the official cask and a `.dmg` that opens without the System Settings detour.
- **Android**: $25 one-time, and it is the same purchase as Play in the section above.

## Not stores, but worth a listing

- [ ] `awesome-selfhosted` (needs a Docker image, a licence and docs, all of which exist) and `awesome-tiddlywiki`.
- [ ] `selfh.st/apps` directory and newsletter: self-hosted oriented, accepts submissions.
- [ ] `alternativeto.net` entry listing Obsidian / Logseq / Trilium as alternatives. Self-serve, free, surprisingly good for search traffic.
- [ ] Download portals (Softpedia, FileHorse and friends) wrap installers in their own ad-laden downloaders and are not worth the inbox.

## Suggested order, if it helps

1. Play ($25): unlocks verification for the APK you already ship.
2. winget, then Chocolatey: two PRs, `winget install Lithic` works.
3. `.deb`/`.rpm` in the release, then the AppImage catalogue: mostly build flags.
4. IzzyOnDroid and the AUR: issue and PKGBUILD, both cheap.
5. community-scripts.org and Unraid CA: your self-host script is already written.
6. Flathub and Microsoft Store: real packaging work, real payoff, do them when the above are done.
