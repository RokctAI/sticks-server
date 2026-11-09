# Patch set

Our changes on top of upstream, as `git format-patch` style files, listed in `series` (top to
bottom). Currently empty: nothing is customised yet (backend customising comes after the app is
tested).

Rules:
- Small and separate: one purpose per patch, a one-line reason in the commit message.
- Prefer new files over edits inside upstream files (new files never conflict).
- Anything generally useful goes upstream as a PR to elie222/rakazo from a personal fork, then the
  patch is dropped here once it lands in a tag. Never PR from the RokctAI/rakazo mirror.
- Create a patch from a checkout of the pinned tag: commit, then
  `git format-patch -1 -o <this folder> HEAD` and add the file name to `series`.
