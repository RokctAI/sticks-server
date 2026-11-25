# Task 25: hub-token SDK (lives in RokctAI/users)

Status: not started (draft PR holds the task and notes).

## What to do

See BUILD-BRIEF 'Task 25'. The code goes in private RokctAI/users under auth/hub-token/{ts,py}, tagged hub-token-vX.Y.Z, installed with MONOREPO_PAT (git insteadOf in CI, BuildKit secret in Docker). Envelope v2 accepted alongside v1. Source to extract: overlay/apps/sticks-engine/src/pulsar-token.ts. Then switch this repo to import it. Gravity uses it; Orbit does not need it. This PR tracks the work; the code PR is in the users repo.

## Rules

One PR per task off main, no stacking. Raw SQL tables; no secrets, model names or personal names (public repo). Tests in overlay vitest or tests/ (Python).
