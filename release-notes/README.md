# Release Notes

Source-of-truth notes for each tagged release. Each published tag gets a
matching file named after its version (`vX.Y.Z.md`).

Conventions:

- One file per release, named exactly `vX.Y.Z.md` (matches the tag —
  `desktop-vX.Y.Z` shares the same version, but the file holds the
  combined changelog for the desktop release and the npm libraries
  published alongside it).
- Bilingual: English section first, Chinese section after. Same bullet
  list mirrored across both.
- Three categories: `Features` / `Improvements` / `Fixes` (or the
  Chinese equivalents `新功能` / `优化` / `修复`). Aggregate small changes
  into one bullet rather than enumerating each commit.
- Every bullet ends with a module-ownership tag (`— \`desktop\``,
  `— \`sidecar\` + \`cli\``, or `— \`all\`` for repo-wide changes).
- No commit SHAs in the notes — the diff between the previous and
  current release tag tells that story; the notes tell the user what
  changed in plain language.

Add a new file when cutting a new release tag. Update this README when
the convention above changes.