# Patch set

Our changes on top of upstream, as `git format-patch` style files, listed in `series` (top to
bottom). Currently empty: nothing is customised yet (backend customising comes after the app is
tested).

Rules:
- Small and separate: one purpose per patch, a one-line reason in the commit message.
- Prefer new files over edits inside upstream files (new files never conflict).
- Anything generally useful goes upstream as a PR to elie222/rakazo from a personal fork, then the
  patch is dropped here once it lands in a tag. There is no mirror to PR from.
- Create a patch from a checkout of the pinned tag: commit, then
  `git format-patch -1 -o <this folder> HEAD` and add the file name to `series`.

## Patches copied from upstream PRs (Ray, 2026-11-28)
An upstream PR that is not merged yet (a security fix, say) can be carried as a patch. Put this line in
the patch header, above the first `diff --git`:

    Upstream: elie222/rakazo#6961

The weekly sync (`scripts/sync_upstream.py`) then checks each such PR on GitHub and reports it under
"Patches copied from upstream PRs": still open, merged but not released, in the new tag, or closed
without merging (decide whether to keep it). A patch whose PR is in the new tag is not applied on that
tag, and it is removed from `series` and deleted only in the pin-moving PR, so our copy stays for as
long as we run the older pinned version. Patches without the line are ours and are never dropped.
