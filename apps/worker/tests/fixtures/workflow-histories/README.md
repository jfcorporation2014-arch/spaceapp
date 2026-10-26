# Workflow replay baselines

These histories contain synthetic inputs and activities from the real Temporal
time-skipping server. Normal worker tests replay every committed version against
the current production workflow bundles. The suite also exercises a test-only
extra timer and requires a `DeterminismViolationError`, proving that replay is
an effective compatibility gate.

The test-only legacy bundle suppresses `room-background-continuation-v1` while
recording. Its histories are replayed against the unchanged production bundle,
where the absence of the patch marker selects the legacy implementation.

Run from `apps/worker` with Node 22 and locked dependencies installed:

```sh
npm test -- tests/workflow-sandbox.test.ts
npm run temporal:record-histories -- reviewed-patch-v2
```

The first run downloads the SDK-compatible Temporal test server. Subsequent
runs reuse its cache. No Docker, database, provider or operator credentials are
used. The server and workers are stopped after the suite, including failures.
The public CI has an independent Ubuntu replay job, including fork PRs, with
a three-minute limit on the sandbox/replay step. Fixture dependencies are built
before that step. The ordinary worker and public suites also run these tests.

**Recording is an explicit migration operation.** After the initial baseline,
add a new version only together with a reviewed, replay-safe `patched()` change.
Keep all previous versions and their old branches. Never regenerate a baseline
to hide an incompatibility. The recorder replays all existing versions first,
refuses an existing destination, and publishes only after the complete sandbox
suite and replay of the new histories pass. Ordinary tests never write fixtures.

Worker identities and failure source paths are normalized to fixed synthetic
strings before publication; the normalized histories are replayed too. Activity
results, commands, timers, signals, patch markers and continuation inputs are
preserved.
