# Idle: count streams and scripts, push on every change, sleeping notice

Status: not started (draft PR holds the task and notes).

## What to do

idle.ts has IdleTracker; engine.ts passes `untracked` for open streams and live scripts, so a tenant is never reported idle through them. Left: count open streams through a patch in patches/ (no upstream hook), track script process groups (pgid) in helper-computer.ts, push to Pulsar on every state change, and show the sleeping notice.

## Rules

One PR per task off main, no stacking. Raw SQL tables; no secrets, model names or personal names (public repo). Tests in overlay vitest or tests/ (Python).
