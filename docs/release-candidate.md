# Windows/Linux release candidate

This procedure prepares evidence; it does not approve tagging or publication.
Issue [#119](https://github.com/atk0309/project_Examify/issues/119) stays open until
its release gates are satisfied. Windows/Linux x64 only, with no macOS/ARM claim.

## Portable image policy

The desktop builder sets `EXAMIFY_PORTABLE_BUILD=1` for its build subprocess only.
This disables Next's unused image optimization endpoint and excludes Sharp/@img
from standalone server and route traces. The application has no direct Sharp or
Next Image dependency: uploads retain validated PDF/text bytes, optional PDF page
rasterization uses external `pdftoppm`, and AI source images are read as bytes.
Hosted/default builds retain their existing configuration and image optimizer.
Portable builds do not provide automatic image resizing, compression or format
conversion. Future use of Next Image needs an explicit portable fallback/review.

Packaging must verify the serialized standalone server really has optimization
disabled, and inspect actual files, runtime links and package/native inventories.
The distribution gate independently extracts the completed archive and repeats
those checks, comparing internal identity/policy to its hashed sidecars. It also
checks every retained evidence file against its recorded hash, compares shipped
package manifests with the inventory, and checks exact supplemental notice bytes.
Embedded-only helper dependencies are identified by their retained source manifest,
not an invented runtime directory. CI packages from outside the repository to test
bundle-input path resolution. CI cannot upload the app archive if this gate or native
acceptance fails. There is no environment/input bypass.

The former libvips source/replacement gate is inapplicable only when the archive
inspection proves those unused native image packages are absent. Reintroducing
them or another unreviewed native library fails closed and requires a new notice,
source/replacement review. SQLite's native module and the private Node runtime
remain; their licenses/notices are retained. This is technical evidence, not a
complete SBOM, independent publisher authentication or legal certification.

## Freeze and preserve one candidate

1. Choose a reviewed clean source commit. Record its full SHA and successful full
   CI/CodeQL run URLs for that exact commit, not a nearby PR merge-ref badge
2. Manually run **Solo desktop preview** with `release_version` set to the intended
   stable numeric version, for example `0.1.0`. Candidate status belongs in the
   evidence record: safe upgrades deliberately do not order `ci-*` or prerelease
   labels. Never reuse a version previously used for a legacy preview
3. Both native package/browser/upgrade jobs and candidate assembly must pass.
   The combined set contains Windows CMD/PowerShell/zip, Linux shell/tar.gz,
   matching archive checksums, platform identities/runtime policies, complete
   checksum lists and `release-set.json`. Source, lockfile, pinned Node and all
   installer/archive bytes are recorded. Never replace tested bytes silently
4. Preserve the complete unmodified bundle in durable maintainer-controlled
   storage before expiry. Actions retention is **90 days** for candidates, seven
   for previews, and is not permanent hosting. Record run/artifact URLs, expiry
   and durable storage privately; do not publish private paths or credentials
5. Verify `SHA256SUMS` after download (`sha256sum --check SHA256SUMS` on Linux;
   compare `Get-FileHash -Algorithm SHA256` on Windows). Retain evidence separately
   from the download location. Changed bytes require a new candidate/test record

The local integrity tools never tag, publish or overwrite an existing candidate:

```sh
node scripts/desktop/distribution-policy.mjs check build/desktop/linux-x64 linux-x64
node scripts/desktop/distribution-policy.mjs check build/desktop/win32-x64 win32-x64
node scripts/desktop/distribution.mjs assemble build/desktop build/release-candidate
```

Run each native archive policy check on its own platform. Assembly relies on both
already successful native jobs; it checks their shared version/source/lockfile.
It creates an unapproved candidate, not a publication authorization.

## Remaining consumer, security and trust gates

CI targets Ubuntu 22.04 and Windows Server 2022. These are automation environments,
not proven minimum consumer OS/browser requirements. Record actual OS edition,
version/build, architecture, filesystem, desktop and browser version for clean
ordinary-user consumer tests without development tools installed:

- Actual downloaded installer/bootstrap paths, offline archive installation and
  corrupt/wrong-version rejection. The automated local mirror changes only its
  private installer copies' HTTPS origin; it does not prove GitHub TLS/CDN or
  reputation behavior. Production installers retain fixed HTTPS-only URLs
- Real browser launch, Start-menu/Linux application shortcut and shortcut relaunch;
  browser callbacks and `--no-shortcut` automation are not substitutes
- Deterministic sample/resume, repeated authoring using approved offline fixtures,
  restart/crash recovery and upgrade/full-folder restore. Process interruption
  does not establish physical-power-loss durability
- Final private-data/secret inventory, retained license notices and remaining
  mapping/review notes in `THIRD-PARTY-LICENSES.json`. The exact missing dotenv BSD
  notices are retained using hash-pinned upstream provenance; no source offer or
  unrelated native-license obligation is asserted for excluded libraries
- Current locked production audit and native/embedded security triage. Record date,
  tool/source identity and findings; a failed Dependabot update alone is not a
  vulnerability, and package-manager audit is not complete binary analysis

Artifacts remain unsigned. Checksums establish consistency with the chosen
installer; an attacker replacing both installer and archive can replace hashes.
Before publication, the maintainer must approve unsigned distribution or a
separate signing plan. Record real browser download, Mark-of-the-Web, SmartScreen
and PowerShell behavior. The CMD installer's existing process-local execution
policy option is not a signature or permission to circumvent organizational
policy. Stop at OS/browser security warnings; do not disable system protection.

Publication requires separate approval after exact asset hashes, CI links,
consumer results and trust decision are recorded. Publish the exact tested asset
set under its pinned version, then verify remotely downloaded hashes/bootstrap.
Leave #119 open for any uncompleted manual or published-route checks.
