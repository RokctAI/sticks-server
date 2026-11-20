# Onboarding Stick at first boot

Status: not started (draft PR holds the task and notes).

## What to do

Hub onboarding plugin merged in #69. Left: at first boot with STICKS_HUB_ONBOARDING=1, create one Stick named "Onboarding" whose instruction is templates/onboarding-bot.md (embed it as a string module, since esbuild bundles cannot read files through import.meta.url), with only the hub-onboarding plugin's 3 tools enabled. Idempotent like ensureTenantSpace in first-boot.ts. Add a Python test that the embedded text equals templates/onboarding-bot.md (pattern: tests/test_first_boot_block.py).

## Rules

One PR per task off main, no stacking. Raw SQL tables; no secrets, model names or personal names (public repo). Tests in overlay vitest or tests/ (Python).
