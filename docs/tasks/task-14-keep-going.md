# Task 14: keep-going inside the engine

Status: not started (draft PR holds the task and notes).

## What to do

See BUILD-BRIEF 'Task 14' (spec 7.5). Needs task 12. Defaults and hub caps already live in settings.ts (keepGoing: enabled, maxNoProgress 3, maxPerDay 20, gapSeconds 60; hub keep_going_max_per_day caps maxPerDay). Read them with SettingsStore.get().

## Rules

One PR per task off main, no stacking. Raw SQL tables; no secrets, model names or personal names (public repo). Tests in overlay vitest or tests/ (Python).
