# overlay/

Our engine code, as new files only. `scripts/build_engine.py` copies everything in this folder onto a
checkout of the pinned upstream tag, at the same relative path, after the patches in `patches/series`
have been applied.

Rules:

- **New files only.** If a file here has the same path as an existing upstream file, the build refuses
  (exit 2) and lists the clashes. Changing an upstream file is a patch in `patches/`, not an overlay file.
- This `README.md` is documentation and is never copied.
- Tests here are vitest files (`*.test.ts`). The build runs only these, through a temporary config
  outside this repo, after upstream's typecheck passes.
- Keep the code free of model names and personal names, and keep it free of secrets: settings come from
  the environment or from files under `/run/secrets/`.

Build: `python scripts/build_engine.py --workdir <empty folder>`. CI runs it in the Engine job after
`corepack enable` on Node 24; pnpm comes from upstream's own `packageManager` field.
