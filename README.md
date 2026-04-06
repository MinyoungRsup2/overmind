# OVERMIND

> *Your Claude Code agents are Marines. Your tokens are Zerglings.*
>
> *Power Overwhelming.*

A StarCraft: Brood War themed live dashboard for Claude Code agents.

Every active session becomes a Terran Marine defending a chokepoint on the map. Token usage spawns waves of Zerglings from the top-right that rush diagonally toward your Marines. Marines fire back, killing each Zergling in a spray of death frames. The heavier your token burn, the thicker the swarm.

## At A Glance

- **Marines** -- your active Claude Code sessions, clustered at the bottom-left rally point
- **Zerglings** -- token consumption visualized as an incoming swarm from the top-right
- **HP** -- remaining context window for each session
- **Kill cadence** -- Marines proactively engage the closest Zergling, cycling attack and cooldown
- **Zerg console HUD** -- the actual ControlPanel.png sprite from SC:BW, with the organic Zerg border-image tiling across the center info panel
- **SC cursor** -- the green arrow and yellow targeting circle, straight from the game
- **Unit Archive** -- tracks every SC unit type you've ever spawned across sessions

## Quick Start

```bash
git clone <this-repo>
cd overmind
node tools/setup_poke_assets.js   # download sprite base (optional, for Pokemon fallback)
node cli.js watch
```

Open `http://127.0.0.1:8123`.

### Commands

```bash
node cli.js watch [--port 8123]   # live mode — watches ~/.claude/projects/
node cli.js mock  [--port 8123]   # demo mode — synthetic agents + token events
node cli.js hard-reset [watch|mock]
node cli.js help
```

## How It Works

### Token Battles

The dashboard tracks cumulative token spend across all active sessions. For every ~10,000 tokens consumed, a Zergling spawns at the top-right edge of the map and marches diagonally down-left. When it reaches a Marine's kill range, the Marine plays its 7-frame attack animation (direction 1, facing up-right) and the Zergling plays its 7-frame death burst from `Burst.js`. The Marine then enters a short cooldown before engaging the next target.

All sprite data is extracted from the original SC:BW game files via `tools/extract_sc_data.js`, which parses the `vendor-sc/Characters/*.js` unit definitions into `data/sc_unit_data.json`. Battle-specific directional frames (Marine attack facing up-right, Zergling moving down-left, Zergling death) are hardcoded in `app.js` as `BATTLE_DATA`.

### Architecture

```
cli.js          -- entry point, wires everything, persistence
watcher.js      -- tails ~/.claude/projects/**/*.jsonl in real-time
parser.js       -- normalizes Claude Code JSONL into typed events
state.js        -- in-memory state machine (active, sleeping, boxed)
starcraft.js    -- agentId -> SC unit ID mapping (weighted by rarity tier)
server.js       -- vanilla Node HTTP + SSE for real-time browser push
public/app.js   -- canvas renderer, battle system, HUD
```

Zero npm dependencies. Pure Node.js + browser Canvas API.

### Sprite Assets

Unit sprites come from [raydogg779/StarCraft](https://github.com/raydogg779/StarCraft), an HTML5 StarCraft clone. The `vendor-sc/` directory contains the full sprite sheets (`img/Charas/`), the Zerg console panel (`img/Menu/ControlPanel.png`), SC cursors, and map backgrounds.

49 SC units across 4 factions (Zerg, Terran, Protoss, Neutral), each with sprite sheet frame coordinates for idle, moving, and attack animations.

## Credits

This project is a StarCraft-themed fork of [**agentdex**](https://github.com/Hwiyeon/agentdex) by [Hwiyeon](https://github.com/Hwiyeon). The original agentdex is a Pokemon-themed live dashboard where Claude Code agents become Pokemon on a pixel art island. This fork replaces the Pokemon layer with StarCraft: Brood War sprites and adds a real-time battle visualization system.

**Original project:** [Hwiyeon/agentdex](https://github.com/Hwiyeon/agentdex) (MIT License)

**StarCraft sprite assets:** [raydogg779/StarCraft](https://github.com/raydogg779/StarCraft)

**StarCraft: Brood War** is a trademark of Blizzard Entertainment. All game assets are used for personal/hobby purposes under fair use. This project is not affiliated with or endorsed by Blizzard Entertainment.

## License

MIT -- see [LICENSE](./LICENSE).
