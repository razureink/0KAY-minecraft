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
