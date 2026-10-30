# Offline, fictional test fixtures

All member names, user/group identifiers, personal attributes and conversations in these fixtures are synthetic. Do not copy private profiles, credentials, memory databases or installed profile `dist` artifacts here.

- `memory-store.mjs` creates only the nine SQLite columns exercised by memory-gate/digest. Those tests set an isolated temporary HOME before helper setup and seed fictional rows/people; no existing database is opened or cloned.
- `person-feedback.json` holds test-only per-person rules and classifier hints. Production defaults must not carry this member registry. The role-skills test already constructs its fictional registry and skill text inside its temporary profile, without reading production seeds.
- `outbound-router.mjs` is a deliberately minimal synthetic transport contract with the exact patch anchor. It exercises the real web-fetch classifier/guard and deployment idempotence offline, including flat and legacy error shapes, group/private boundaries and recovery. It does **not** claim upstream transport compatibility; that requires a separate integration test against an explicitly version-locked public package.

Tests must continue to work on a machine with no QQ profile, private datasets, API credentials, or network access. Temporary fixture databases contain no imported real data.
