# Roster & training policy

## Building a team

A team is exactly 5 species with **ready** sprites. Prefer teams with:

- type coverage across likely terrain (see `terrainMoveBonus` in `/api/rules`)
- one durable defender and one fast finisher
- trained species where it matters
- local-observed species when the goal is tile contests
- species whose type is favored by biomes you hold (held-tile buffs)

Avoid putting missing/queued species on a team — they cannot battle. If
`snapshot.roster.readyCount < 5`, the human needs more sprites generated or more
observations imported (`POST /api/import`); say so instead of forcing a team.

## Training

Training points come from observations and are scarce. Spend them with a clear
gameplay reason:

- concentrate points on a few core team members rather than spreading thin
- raise the stat that fixes a real weakness (e.g. Tempo to outspeed, Guard to
  survive)
- use respec rather than guessing repeatedly

Do not spend points just because they are available.

## When you lack a credential

Produce a concrete recommendation: which 5 species to run, what to train, and
why — referencing the roster you can read via `GET /api/roster?userId=`. Do not
call write endpoints.
