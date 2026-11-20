# Repin upstream to v0.13.0 and redo patches

Status: not started (draft PR holds the task and notes).

## What to do

Plan: /mnt/project-files/sticks/upstream-harvest-plan-v0.13.0.md (project files). Blocked until RokctAI/sticks version.json says "upstream": "v0.13.0" (CI refuses otherwise). Redo the 5 patches: 0001's packages/db/src/client.ts and 0005's pi-runtime-models.ts were deleted upstream (moved). Stay on v0.11.0 until then. Prefer a tag that has gone about a week with no follow-up fix.

## Rules

One PR per task off main, no stacking. Raw SQL tables; no secrets, model names or personal names (public repo). Tests in overlay vitest or tests/ (Python).
