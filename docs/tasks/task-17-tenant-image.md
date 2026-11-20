# Task 17: tenant image

Status: not started (draft PR holds the task and notes).

## What to do

See BUILD-BRIEF 'Task 17'. One docker per tenant: Pulsar (Ignition serve) + engine + headless sandbox helper, no computer. Pin Pulsar by docker/PULSAR_COMMIT. The 'Image builds (not pushed)' CI job is the check.

## Rules

One PR per task off main, no stacking. Raw SQL tables; no secrets, model names or personal names (public repo). Tests in overlay vitest or tests/ (Python).
