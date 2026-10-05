# Retained upstream license evidence

The two license files in this directory are original upstream bytes for
`dotenv@16.3.1` and `dotenv-expand@10.0.0`, embedded in `@next/env@16.3.6` and `@next/env@16.3.8`.
`provenance.json` records their exact source URLs, package associations and SHA-256
digests. The recovered files were checked against the previously verified hashes.

The 16.3.8 association was checked on 2026-10-05 against Next.js release commit
`b0fad0d45eb4c4430fda5eeeb442e8a5af08a5f6`: its
[package manifest](https://github.com/vercel/next.js/blob/b0fad0d45eb4c4430fda5eeeb442e8a5af08a5f6/packages/next-env/package.json)
still pins dotenv 16.3.1 and dotenv-expand 10.0.0; `packages/next-env/index.ts` is
byte-identical to the source at 16.3.6. Fresh upstream license retrievals match the
retained bytes and hashes. This source check does not replace native packaging and
final archive verification.

Do not format these files or normalize their line endings. Packaging must verify
their hashes and associate them only with the exact shipped package version.

This collection addresses identified embedded-dependency notices. It is not a
complete SBOM or a legal compliance certification. Native Sharp/libvips reference
materials are not part of this recovered set; the approved portable-only build
exclusion must be verified separately against each final platform archive.
