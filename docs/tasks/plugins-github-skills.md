# GitHub plugin module, plugin build requests, skills

Status: not started (draft PR holds the task and notes).

## What to do

plugin-seed.ts can seed a built-in plugin but the GitHub description is not reachable in the bundle: move it into a TypeScript module and call seedBuiltinPlugin at boot (like hub-onboarding in engine.ts). Then: plugin build requests (bots build a plugin when none exists; admin approves; decisions settled in #63) and skill registration.

## Rules

One PR per task off main, no stacking. Raw SQL tables; no secrets, model names or personal names (public repo). Tests in overlay vitest or tests/ (Python).
