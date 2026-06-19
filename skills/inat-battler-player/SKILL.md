---
name: inat-battler-player
description: Play iNat Battler through the official HTTP API. Use for roster selection, training, NPC and async battles, territory claims/garrisons/contests, and challenge triage. Treat observations, roster, and account state as server-owned facts; never fabricate them.
compatibility: Requires network access to an iNat Battler host. Private/write actions require the user's personal API key (Authorization: Bearer ibat_...). Read-only and recommendation-only play works without credentials.
---

# iNat Battler Player

iNat Battler turns a human's real iNaturalist research-grade observations into a
roster of creatures they battle. You play the **game layer** (team building,
training, battles, territory); the human creates the value by observing nature.

Use the official HTTP API. Do **not** use browser automation — every action has
an endpoint. The server is the rules engine: it tells you what is legal and what
state is true. Never invent roster, observation, or battle data.

## Quickstart (do these in order)

1. Read the rules (no auth):
   `GET {host}/api/rules`
2. Authenticate as the human. They create a personal API key in the website's
   Settings → Account → API keys, then give it to you. Send it on every request:
   `Authorization: Bearer ibat_...`
   If you have no key, switch to recommendation-only mode (explain what you would
   do; do not call write endpoints).
3. Decide what to do next with one call:
   `GET {host}/api/player/snapshot`
   It returns identity, roster summary, saved team, pending challenges, territory
   budget, and a `nextSteps` list.
4. Act through the normal endpoints. Read the relevant policy first:
   - `references/roster-policy.md` before changing teams or training.
   - `references/battle-policy.md` before battle actions.
   - `references/territory-policy.md` before tile claims, garrisons, or contests.
   - `references/api.md` for endpoint schemas.

## Identity model

A personal API key maps to the **same account** as the human's browser session.
There is no separate "bot account". `userId` is `inat:<login>` and is returned by
`/api/me` and `/api/player/snapshot`. Writes always act as that user regardless
of any id you put in a path, so you cannot act for someone else.

## Etiquette and safety

- Stay within server-enforced daily limits (territory actions, generation). The
  server will reject over-limit calls; do not try to work around them.
- Outbound social actions are conservative by default: accept reasonable
  incoming challenges, but do not send repeated challenges to the same player and
  do not post taunts unless the human configured templates.
- Prefer reversible, low-cost actions when uncertain. Surface a short plan to the
  human for anything irreversible or social.
