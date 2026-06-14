# Live Real-Time Battles — Infrastructure Plan

**Status:** Design only — nothing built. The biggest infra lift on the roadmap.
**Decided to record:** 2026-06-14.

## Where live battles fit (and where they don't)

The game has two pillars, both fed by your iNaturalist roster:

- **Territory** — *async, always available.* Tile contests resolve as **ghost battles**
  (the defender's snapshotted team piloted by `chooseNpcAction`). This is correct and built;
  it must stay async because you can't gate taking a tile on its owner being awake.
- **Live PvP** — *synchronous, social.* Two players present at once, watching the battle
  unfold turn-by-turn, for ELO. The natural home for the **Buddy presence list** (already
  built, currently underused): see who's green → challenge them now.

**The bridge between them:** when you contest a tile and the owner is **online** (the
presence feed knows), offer a *"defend live"* prompt — a real-time battle for the tile, with
the **ghost as the automatic fallback** if they don't accept within ~20s. Async by default,
live when both are present, for the same stakes. So live isn't a side-show — it's the
social/ladder pillar *and* an optional high-stakes layer on territory.

The catch is infrastructure: live needs a **stateful, low-latency coordinator per battle**.
That's a Cloudflare **Durable Object** (DO). Workers are stateless and can't hold a
websocket pair or authoritative turn state; a DO can.

## Architecture

```
 Player A ──ws──┐                          ┌──ws── Player B
                ▼                          ▼
        ┌──────────────────────────────────────────┐
        │  BattleRoom (Durable Object, 1 per battle)│
        │  - holds authoritative battle state       │
        │  - runs resolveTurn() (the SAME engine)   │
        │  - turn timer, disconnect handling        │
        │  - broadcasts turn results to both sockets│
        └───────────────┬──────────────────────────┘
                        │ on finish
                        ▼
              D1: battle_instances + battle_results
              (+ resolveTileContest if tileH3)
```

- **One `BattleRoom` DO instance per live battle**, addressed by `battleId`
  (`env.BATTLE_ROOM.idFromName(battleId)`). The DO is the single source of truth for that
  battle — no race conditions, strong consistency.
- **The engine is reused unchanged.** `src/game.js` is already pure and seeded
  (`resolveTurn`, `createSeededRng`). The DO imports it and calls `resolveTurn` exactly like
  the async path does. **No engine fork** — async and live produce identical results for the
  same inputs.
- **WebSocket Hibernation API.** Use `state.acceptWebSocket(ws)` (hibernatable) so the DO can
  evict from memory between turns while keeping the sockets open — this is what keeps idle
  live battles from burning DO duration/cost. State lives in `state.storage`.

## Protocol (JSON over WebSocket)

Client → DO:
- `{ t: "hello", battleId, sessionToken }` — auth handshake (validate the session cookie /
  token, resolve which side this player is).
- `{ t: "action", moveId }` or `{ t: "action", switchIndex }` — this turn's choice.
- `{ t: "ping" }` — keepalive.

DO → client:
- `{ t: "state", battle }` — full battle state on join / reconnect.
- `{ t: "waiting", who }` — the other side hasn't chosen yet.
- `{ t: "turn", battle, log }` — both chose; resolved turn + new state.
- `{ t: "timeout", side }` — a side ran out of time (auto-Struggle or auto-loss).
- `{ t: "end", status, ratingUpdate }` — battle finished.

**Turn flow:** both sides submit an action → when both are in (or the **turn timer** fires),
the DO runs one `resolveTurn`, persists to `state.storage`, broadcasts `turn`. A turn timer
(~30s) keeps games moving; on expiry the slow side auto-Struggles (or forfeits after N
missed turns). Seeded RNG per turn = `seed:turn` so it's deterministic and replayable.

## Matchmaking / invitation (via presence)

1. Buddies tab already classifies mutuals online/idle/offline from the Jetstream firehose.
2. "Challenge live" on an **online** buddy → server creates a `battle_instances` row
   (`mode: "live_pvp"`, status `pending`) + a `BattleRoom` and notifies the opponent (a
   lightweight poll/SSE, or piggyback the existing challenge surface).
3. Opponent accepts → both open `wss://…/api/battles/live/{battleId}` → the DO pairs them.
4. **Territory variant:** a contest where the defender is online inserts an `accept-live`
   window before falling back to the ghost; on accept it's the same `BattleRoom` with
   `tileH3` set, so winning still calls `resolveTileContest`.

## Disconnect / reconnect

- DO keeps state in `state.storage`; a dropped socket doesn't end the battle. On reconnect
  with the same `battleId` + session, the DO re-sends `state` and resumes.
- Grace period (~60s) before a persistent disconnect counts as a forfeit. Hibernation means
  the DO survives even with no active connections.

## Persistence & integration

- During the battle: authoritative state in `state.storage` (DO).
- On finish: write `battle_instances` (final `state_json`, status) + `battle_results`, run
  `applyBattleResultToRatings` (reuse existing ELO), and `resolveTileContest` if `tileH3`.
  This mirrors the async resolver's completion block, so all downstream (leaderboards, tile
  flips, ratings) is shared.

## wrangler / config

```jsonc
// wrangler.jsonc
"durable_objects": { "bindings": [{ "name": "BATTLE_ROOM", "class_name": "BattleRoom" }] },
"migrations": [{ "tag": "v1", "new_classes": ["BattleRoom"] }]
```
`BattleRoom` is a new exported class (its own module, e.g. `src/battle-room.js`, importing
`./game.js`). Add a `mode` value `live_pvp` and a `live_contest` flag where relevant.

## Cost & scale (Workers Paid, $5/mo)

- **DOs are included** on the paid plan: ~1M requests/mo + 400k GB-s duration included, then
  cheap overage. **Hibernation is the key lever** — an idle live battle (waiting on a turn)
  consumes ~no duration because the DO is evicted while sockets stay open. Only active turn
  resolution costs compute.
- WebSocket messages count as requests; a full battle is a few dozen messages. Thousands of
  live battles/mo fit comfortably.
- No new D1 load beyond the single finish-write already done for async battles.

## Build phases

1. **`BattleRoom` DO + protocol** — pair two sockets, run `resolveTurn`, broadcast, turn
   timer, finish-write. Standalone "challenge a specific mutual" entry first (no territory).
2. **Client live-battle UI** — reuse the existing battle renderer; swap the
   submit-action call for a websocket send and render on `turn` messages. Add a turn timer
   bar + "waiting for opponent" state.
3. **Presence wiring** — "Challenge live" buttons in Buddies (online mutuals), accept flow.
4. **Territory "defend live"** — the accept-window-then-ghost-fallback on contests.
5. **Polish** — reconnect UX, spectate (optional), forfeit handling, anti-stall.

## Open decisions (when we build)

- Invitation transport: short-poll vs. Server-Sent Events vs. a presence DO. (Poll is
  simplest first.)
- Turn timer length and missed-turn forfeit count.
- Whether live PvP uses **normalized stats** (the ranked-mode idea) so the collection/
  territory edge doesn't decide synchronous ladder play — recommended, decouple from
  territory buffs in live mode.
- Spectating (let a third socket watch read-only) — nice, not MVP.
