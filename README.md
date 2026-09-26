# 0KAY Minecraft Bot

A local HTTP service that runs a single Minecraft companion bot which plays
alongside human players. Java Edition uses [mineflayer]; Bedrock Edition uses
[bedrock-protocol]. The bot registers with 0KAY Core as a tool plugin, so L.I.F.E
can connect it, chat through it, and let its autopilot drive.

## Architecture

```
L.I.F.E / WebUI ──HTTP──► this service (:8765) ──mineflayer──► Minecraft server
                              │
                              └── Core model gateway (/api/mocr/generate) for autopilot
```

- `src/index.js` — HTTP server, routing, Core settings poll, plugin boot.
- `src/controller.js` — the single bot session, action dispatch, world knowledge.
- `src/autopilot.js` — **stateful, goal-driven planner** (see below).
- `src/java.js` / `src/bedrock.js` — edition transports.
- `src/world.js` — persistent waypoints and reusable skills per server.
- `src/plugin.js` — Core gRPC registration + heartbeat.

## Autopilot

The autopilot is a stateful decision loop, not a stateless "one call per tick"
bot. Each tick it:

1. Observes: health/food, dimension, position, held item, inventory, nearby
   players (with distance), recent chat, whether it was mentioned, known
   waypoints/skills, and the outcomes of recent actions.
2. Renders that into a compact prompt and asks Core's model gateway for a single
   JSON decision: `{thought, goal?, action, args, say?}`.
3. Validates the action against the actions allowed for the current edition.
4. Executes it and records the result.

It keeps:

- **a goal** (and a small goal stack) the model can update with the `goal` field,
- **a rolling history** of decisions and outcomes,
- **a failure memory** so it stops repeating an action that keeps failing.

Movement actions (`goto`, `waypoint_goto`) run under a timeout and check the
position delta, so a stuck path is reported back instead of hanging. Chat is
rate limited. Bedrock currently exposes only observe/talk actions (no movement).

### Feedback loop

Every failure is turned into a **teaching sentence** ("dig: 徒手挖不动… — 换/装备
合适的镐…") and kept for the session, so the model follows the "why + next step"
instead of repeating the same call. The design follows
[Numen](https://github.com/Dwinovo/minecraft-numen): a tool result should teach
the model how to play, not just report an error.

### Perception

`scan_blocks` (find blocks by name within a radius) and `scan_entities` (nearby
entities with distance) give the model eyes, so it does not have to guess
coordinates.

### Skills (Markdown)

Drop `.md` files in `skills/` (or set `MINECRAFT_SKILLS_DIR`). Each file is
shared knowledge the bot can see (names + first line) and read in full with
`skill_read` — the same zero-code "teach it a mod" idea as Numen's
`config/numen/skills/*.md`. `skills/survival-basics.md` is a shipped example.

### Background tasks

Long actions (`goto`, `follow`, `dig`, `place`, `attack`, `use`, `skill_run`,
`waypoint_goto`) can run as background tasks: call them with `background:true`
and the service returns a `task_id` immediately, emits `task_started` /
`task_finished` events, and reports live state via `task_status`. `task_stop`
aborts. ONE body, ONE job — a second long action is refused while one runs. The
autopilot uses this so it can keep thinking instead of blocking on a slow walk.

### Spatial grid

`scan_grid` returns an egocentric grid of block short-codes around the bot (feet
and eye level) plus a legend, so the model gets a picture of its surroundings
instead of a bare coordinate list.

### Route planning

`plan_route {x,y,z}` returns up to three candidate routes with a "price tag"
(roughly how many blocks must be dug / placed). Walking default does **not**
modify the world (pathfinder `canDig=false`); pass `allow_dig:true` to `goto` to
let it break through. This mirrors Numen's "list candidate routes, don't change
the world" rule.

### Consent

Breaking a block-entity block (chest/furnace/bed/door/…), placing onto an
existing block, or attacking a villager/pet/named mob raises a `consent_request`
event and waits for `consent_reply {id, approve}` (60s timeout → deny). A denied
action returns `{refused:true, reason}` and is not executed. Set
`MINECRAFT_CONSENT=allow|deny|ask` (default `ask`).

### External brain (MCP)

Set `MINECRAFT_MCP=1` to also expose the bot over the Model Context Protocol on
stdio, so an external AI client (Claude Desktop, Cursor, …) can drive it with
`tools/list` + `tools/call` (`minecraft_status`, `minecraft_action`). Because
stdio is the transport, logs are routed to stderr in this mode.

## HTTP API

All JSON. Optional `Authorization: Bearer $MINECRAFT_TOKEN`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness |
| GET | `/events` | SSE stream of bot events |
| GET | `/status` | bot + autopilot + world status |
| GET | `/world` | waypoints + skills |
| GET | `/autopilot` | autopilot status |
| POST | `/action` | `{action, args}` (also `connect`, `skill_run`, `waypoint_*`, …) |
| POST | `/autopilot/start` | `{goal?, intervalMs?, modelId?, maxTicks?, moveTimeoutMs?}` |
| POST | `/autopilot/stop` | stop the loop |

Settings (`default_edition`, `default_host`, `autopilot_default`,
`autopilot_interval_ms`, …) are polled from Core's `minecraft` settings section;
`autopilot_default` auto-starts the loop after a successful connect.

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `MINECRAFT_PORT` | `8765` | HTTP listen port |
| `MINECRAFT_BIND_HOST` | `127.0.0.1` | bind host |
| `MINECRAFT_TOKEN` | _(none)_ | static bearer token |
| `CORE_HTTP_ADDR` | `http://127.0.0.1:8080` | Core HTTP endpoint |
| `MINECRAFT_DATA_DIR` | `./data` | world/credentials storage |

MIT licensed.

[mineflayer]: https://github.com/PrismarineJS/mineflayer
[bedrock-protocol]: https://github.com/PrismarineJS/node-minecraft-protocol
