# StarCraft Reskin Plan

## Status: In Progress

## Steps

1. [x] Extract SC sprite frame data from vendor-sc JS files → `data/sc_unit_data.json`
2. [ ] Create `starcraft.js` backend module (replace `pokemon.js`)
3. [ ] Update `paths.js` — point at sprite sheet directory
4. [ ] Update `server.js` — serve sprite sheets from `/sprites/sheet/`
5. [ ] Update `state.js` — change ID range 251→49
6. [ ] Update `cli.js` — wire starcraft.js, update persistence
7. [ ] Update `app.js` frontend — canvas sprite sheet rendering
8. [ ] Test with `node cli.js mock`

## Key Decisions
- Use Canvas drawImage() to clip frames from sprite sheets (zero dependencies)
- Direction index 3 (south-facing) as default for all agents
- Status→animation mapping: Thinking→dock, Tool-Running→attack, Sleeping→burrow, Outputting→moving
- Cache data URLs for HTML contexts (panel, tooltips, box)
- 49 SC units replacing 251 Pokemon, same weighted-tier pool system
