# AI Agent Player Integration Plan

## Goal

Make iNat Battler easy for AI agents to play through the same game primitives as humans.
The human still creates the real-world value by making iNaturalist observations. The AI
client can then handle the game layer: roster selection, training allocation, NPC battles,
async challenges, tile claiming, garrisoning, and territory contests.

Agents should be first-class API clients, not a separate "bot mode" bolted onto the side.
The web app, mobile app, scripts, MCP clients, Letta agents, Claude Agent SDK agents, and
OpenClaw-style local agents should all use the same core API.

## Product Stance

Do not build a special bot tab or a separate agent-only game loop.

Build:

1. **A clean public/game API** that exposes state and legal actions in machine-friendly
   JSON.
2. **A portable Agent Skill package** named `inat-battler-player` that teaches agents how
   to use the API and play the game well.
3. **Optional MCP wrappers** around the same API for agent runtimes that prefer tools over
   raw HTTP.

The API is the product surface. The skill is just documentation plus play policy.

## Auth Philosophy

We should be open where openness makes sense:

- public leaderboards
- sprite tree / recent sprites
- public battle summaries, if we choose to expose them
- public challenge links
- read-only rules metadata
- demo/NPC sandbox battles that are not tied to a real account

But account-specific writes cannot be fully open, because the server has to know which
player is acting:

- selecting a team
- spending training points
- claiming a tile for a user
- contesting a tile using a user's observed species
- accepting a challenge sent to a specific Bluesky DID
- posting to Bluesky
- queueing paid sprite generation

That is not paranoia; it is identity. If a request changes `inat:mycolocore`'s roster or
claims a tile for that user, the server needs proof that the caller is allowed to act as
that user.

## What "Agent Token" Means

The better name is probably **API key** or **personal access token**, not "agent token."

It is just a durable credential for non-browser clients. Humans already authenticate with a
browser cookie after Bluesky OAuth. Agents and scripts need the same kind of durable access
without scraping the browser cookie.

Recommended first version:

1. User signs in normally on the site.
2. User opens normal account/settings, not a bot-specific page.
3. User creates a named API key.
4. The site shows it once.
5. The agent sends it as:

```http
Authorization: Bearer ibat_...
```

The API key maps to the same user record as the browser session. It is not a separate bot
account unless the user intentionally creates a separate account.

Minimum key fields:

```text
api_key_id TEXT PRIMARY KEY
user_id TEXT NOT NULL
key_hash TEXT NOT NULL
label TEXT NOT NULL
created_at TEXT NOT NULL
last_used_at TEXT
revoked_at TEXT
```

Scopes can wait if we want to keep the first implementation simple. A single "full account
API key" is acceptable for alpha if revocation is easy and high-cost actions remain
server-limited.

Practical follow-up scopes later:

```text
read
write:battle
write:territory
write:training
write:challenge
write:share
write:generation
```

The important part is that API keys are normal API infrastructure, not special treatment
for bots.

## API-First Shape

Prefer stable, general endpoints over `/api/agent/*`.

Existing endpoints already cover a lot:

```text
GET  /api/me
POST /api/import
GET  /api/roster?userId=<id>&q=<search>
GET  /api/users/:userId/teams
POST /api/users/:userId/teams

GET  /api/training
POST /api/training/sync
POST /api/training/allocate
POST /api/training/respec
POST /api/training/nickname

POST /api/battles/npc/start
GET  /api/battles/:battleId
POST /api/battles/:battleId/action

GET  /api/challenges
POST /api/challenges
GET  /api/challenges/:id
POST /api/challenges/:id/accept
POST /api/challenges/:id/decline

POST /api/territory/sync
GET  /api/territory/observations
GET  /api/territory/claims
GET  /api/territory/tile?h3=<cell>
POST /api/territory/claim
POST /api/territory/garrison
POST /api/territory/contest
```

Needed additions should be named for the resource, not the caller:

```text
GET /api/player/snapshot
GET /api/battles/:battleId/actions
GET /api/territory/candidates?kind=claim
GET /api/territory/candidates?kind=contest
GET /api/rules
```

These help every client, including the web UI.

## Snapshot Endpoint

```text
GET /api/player/snapshot
```

This should be the default "wake up and decide" endpoint for humans, bots, mobile clients,
and scripts.

Return:

- current user id, Bluesky handle, linked iNat login
- saved field team
- roster summary: ready, queued, missing, selected
- open battles and pending required actions
- incoming/outgoing challenges
- territory action budget
- held tile counts by biome
- claimable and contestable tile counts
- stale-sync flags for roster/training/territory

This keeps agents from needing to crawl five tabs worth of state.

## Legal Battle Actions

```text
GET /api/battles/:battleId/actions
```

Return only legal actions and useful estimates:

```json
{
  "battleId": "bat_...",
  "side": "player",
  "active": { "taxonId": 123, "hpPct": 0.72, "statuses": ["poisoned"] },
  "opponent": { "taxonId": 456, "hpPct": 0.31, "statuses": [] },
  "moves": [
    {
      "moveId": "venom_bite",
      "name": "Venom Bite",
      "type": "venom",
      "category": "strike",
      "accuracy": 92,
      "estimatedDamagePct": 0.38,
      "terrainFavored": true,
      "notes": ["can KO", "STAB"]
    }
  ],
  "switches": [
    { "switchIndex": 2, "taxonId": 789, "hpPct": 1, "matchupHint": "resists opponent" }
  ]
}
```

Agents should not have to parse the SPA or reverse-engineer internal state. The server
already knows what actions are legal.

## Territory Candidate Endpoints

```text
GET /api/territory/candidates?kind=claim
GET /api/territory/candidates?kind=contest
```

Candidate rows should include:

- H3 cell
- biome and favored move types
- ownership state
- local observed species count
- eligible local taxa for the +local bonus
- current defender strength and garrison summary
- whether the user can act today
- enough scoring inputs for the client to explain its choice

This is the key endpoint for autonomous tile play. It should be useful to the web app too:
"show me the best places I can act today."

## Agent Skill Package

Create:

```text
skills/inat-battler-player/
  SKILL.md
  references/
    api.md
    battle-policy.md
    roster-policy.md
    territory-policy.md
```

No secrets live in the skill. It is portable game knowledge.

Draft `SKILL.md` shape:

```markdown
---
name: inat-battler-player
description: Play iNat Battler through the official API or MCP tools. Use for roster selection, training, NPC and async battles, territory claims/garrisons/contests, and challenge triage. Treat observations and account state as server-owned facts; never fabricate them.
compatibility: Requires network access to iNat Battler. Private account actions require a signed-in session or personal API key.
---

# iNat Battler Player

Use the official API or MCP tools. Do not use browser automation unless no API exists.

Start with `GET /api/player/snapshot`.

For private/write actions, use the user's normal API credential. If no credential is
available, produce recommendations instead of acting.

Read:
- `references/api.md` for endpoint schemas.
- `references/roster-policy.md` before changing teams or training.
- `references/battle-policy.md` before battle actions.
- `references/territory-policy.md` before tile claims, garrisons, or contests.
```

## Play Policy

### Roster

Prefer teams with:

- exactly 5 ready sprites
- type coverage across likely terrain
- one durable defender and one fast finisher
- trained species where possible
- local-observed species for tile contests
- held-territory buffs matching the expected biome

Avoid missing/queued sprites and avoid spending scarce training points without a clear
gameplay reason.

### Battle

Basic priority:

1. Use a legal move that can KO with acceptable accuracy.
2. Prefer terrain-favored and STAB moves when damage is close.
3. Switch out if the active creature is near fainting and a bench creature has a much
   better matchup.
4. Account for statuses.
5. Preserve the best remaining creature when already winning.

### Territory

Daily routine:

1. Sync observations if stale.
2. Review claim candidates.
3. Claim high-value unowned tiles first.
4. Garrison claims with biome-appropriate teams.
5. Contest weak or strategically valuable tiles.
6. Stop when daily action budget is low.

Value signals:

- biome diversity for roster buffs
- local observed species count
- defender strength
- whether the tile strengthens a cluster
- whether the user has strong local/team coverage

### Challenges

Agents can play challenge battles, but outbound social behavior should be conservative.
Even if we allow bots, nobody wants accidental challenge spam.

Default policy:

- Accept incoming challenges if the account has a viable ready team.
- Do not send repeated challenges to the same player.
- Do not post taunts unless the human configured templates.

## Open API Versus Authenticated API

Fully open endpoints are good for:

- rules
- public sprites
- public leaderboards
- demo battles
- public battle/challenge summaries

Authenticated endpoints are required for:

- acting as a user
- using private/linked iNat-derived account state
- writing game state
- using daily action budgets
- spending generation budget
- posting or accepting social actions tied to Bluesky identity

This line is about ownership, not fear. Bots can be welcome first-class players, but the
server still needs to know which player they are.

## Live Bot Battles

If live PvP is built later with Durable Objects/WebSockets, bot players can use the same
room protocol as humans:

```text
connect -> receive battle state -> choose legal action -> send action -> wait for turn
```

This could be a feature, not a problem:

- practice against named AI sparring partners
- ladder divisions that allow bots
- bot-vs-bot exhibition battles
- human account with agent pilot enabled

The same principle holds: no separate game rules for bots unless we intentionally create a
bot league. They should play through legal actions exposed by the server.

## MCP Wrapper

MCP should be a convenience layer over the same API:

```text
inat_battler.get_snapshot
inat_battler.list_roster
inat_battler.save_team
inat_battler.list_battle_actions
inat_battler.submit_battle_action
inat_battler.list_territory_candidates
inat_battler.claim_tile
inat_battler.garrison_tile
inat_battler.contest_tile
inat_battler.list_challenges
inat_battler.accept_challenge
```

Do not make MCP authoritative. The HTTP API remains canonical.

## Implementation Phases

### Phase 1: API Key And Snapshot

- Add personal API keys for signed-in users.
- Support `Authorization: Bearer ...` in `requireSession` or a sibling helper.
- Add `GET /api/player/snapshot`.
- Draft `skills/inat-battler-player/SKILL.md`.

Success: an external agent can authenticate as a real user and summarize what to do next.

### Phase 2: Battle-Friendly API

- Add `GET /api/battles/:battleId/actions`.
- Make `POST /api/battles/:battleId/action` accept API-key auth.
- Add enough battle estimates for agents and UI to choose moves cleanly.

Success: an agent can finish NPC and territory contest battles without browser automation.

### Phase 3: Territory-Friendly API

- Add territory candidate endpoints.
- Make claim/garrison/contest endpoints API-key compatible.
- Reuse existing territory daily caps.

Success: an agent can run the async tile loop for a user within the same server limits as
the web app.

### Phase 4: Skill And MCP

- Package the Agent Skill.
- Add an MCP wrapper around the API.
- Add quickstart examples for Claude Agent SDK, Letta, and OpenClaw-style clients.

Success: users can plug their preferred agent runtime into iNat Battler without custom
browser scripting.

### Phase 5: Bot-Native Play

- Add optional labels/metadata for agent-assisted actions if useful.
- Add live battle protocol support for bot clients when live PvP exists.
- Consider bot leagues, sparring partners, or exhibitions.

Success: bots are part of the ecosystem, not an exception path.

## Open Decisions

- Should API keys be full-account only for alpha, or scoped from day one?
- Should exact observation coordinates be available over API, or only H3/tile summaries?
- Should outbound challenges be unrestricted API actions or rate-limited separately?
- Should bot-assisted play be publicly labeled, privately logged, or not distinguished?
- Should demo bot accounts exist without iNaturalist linkage for sparring and live battles?

## External References

- Agent Skills overview and specification: https://agentskills.io/
- Claude Agent SDK overview: https://code.claude.com/docs/en/agent-sdk/overview
- Letta docs, including skills, tools, MCP, memory, schedules, and permissions:
  https://docs.letta.com/
