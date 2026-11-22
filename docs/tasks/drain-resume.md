# Drain and resume for docker moves (Ray 11-22 "Go")

Caller: control's move_runner (Paramount thread).

1. `POST /internal/drain` (Bearer engine secret) → `{draining: true, active_runs}`. From now on the front door answers every write outside `/internal/` with 503 `{error: "moving", retry: true}`; reads stay open. The flag is stored in `sticks_drain`, so it survives a restart on the new docker.
2. Poll `GET /internal/idle` (engine secret) until `idle: true`, then freeze and snapshot.
3. After the switch (or on rollback): `POST /internal/resume` → `{draining: false}`.

Not covered here: per-org export/import of the Rakazo rows (next PR), and routines/wakes queued inside the engine while draining (not yet checked; a routine that fires during drain may still start a run).
