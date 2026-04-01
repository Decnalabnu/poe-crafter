# PoE Crafter — Roadmap to Craft of Exile Replica

## Current State (~60% Complete)

### Working
- Monte Carlo EV engine (500k iterations) — `src/utils/calculator.js`
- Essence + Fossil crafting with multiplicative fossil weight stacking
- Fractured bases support
- Live economy integration via poe.ninja ETL pipeline
- 7 item classes with full mod pools from RePoE

### Architecture
```
Python ETL (build_db.py, fetch_economy.py, update_data.py)
    ↓  produces
items.json + essences.json + fossils.json + active_economy.json
    ↓  consumed by
React App (App.jsx) → calculator.js (Monte Carlo) → profitability output
```

---

## Phase 1 — Complete the Crafting Engine

### 1.1 Influenced Mod Support (HIGHEST PRIORITY)
Nearly every BiS rare on poe.ninja has at least one influenced mod.
Without this, the build analyzer will miss the most profitable targets.

- [ ] Extend `build_db.py` to pull influenced mod pools from RePoE `mods.json`
  - Filter by spawn_weight tags: `shaper_item`, `elder_item`, `crusader_item`,
    `hunter_item`, `warlord_item`, `redeemer_item`
- [ ] Update `items.json` schema to include influence source per mod
- [ ] Update `src/utils/calculator.js` to accept an influence type parameter
- [ ] Add influence selector UI in `src/App.jsx` (6 influences + none)

### 1.2 Chaos / Alchemy Spam
Most popular crafting path — already ~90% there.

- [ ] Add rarity transition logic to calculator (normal → magic → rare)
- [ ] Cost model: alchemy orb price (1 use) vs chaos orb price (re-roll)
- [ ] Implement "chaos spam until target mods hit" simulation loop
- [ ] Add "Alchemy" and "Chaos Spam" as crafting method tabs in UI

### 1.3 Bench Crafts / Metamods
Essential for hybrid strategies (block prefixes, then chaos roll suffixes).

- [ ] Fetch `crafting_bench_options.json` from RePoE in `build_db.py`
- [ ] Add metamod support to calculator:
  - "Prefixes Cannot Be Rolled"
  - "Suffixes Cannot Be Rolled"
  - "Cannot Roll Attack Modifiers"
- [ ] Add bench cost to total crafting cost
- [ ] UI: show available bench crafts for selected item class

### 1.4 Exalted Orb Slam Simulation
Post-essence / post-fossil finishing step.

- [ ] Simulate single-mod addition to an existing rare
- [ ] Calculate probability of hitting target mod given open prefix/suffix slots
- [ ] Cost = exalted orb price (fetch from poe.ninja)
- [ ] Show as optional "finishing step" in results panel

### 1.5 Veiled Mods
Many BiS suffixes are veiled (e.g. "of the Crusade", movement speed + attribute).

- [ ] Fetch `veiled_mods.json` from RePoE
- [ ] Add veiled mod entries to items.json per item class
- [ ] Model Betrayal encounter cost (community estimate) as crafting input

### 1.6 Awakener Orb (Dual Influence)
Combines two influenced items — required for top-tier crafts.

- [ ] Model as two-item input (source influence + target influence)
- [ ] Simulate which mod transfers from source item
- [ ] Calculate combined cost: 2 influenced bases + awakener orb price

---

## Phase 2 — Build Analyzer (poe.ninja Integration)

Goal: Scrape popular builds, extract item requirements, reverse-engineer optimal craft paths.

### 2.1 Build Scraper (`scrape_builds.py`)
- [ ] Fetch poe.ninja `/builds` endpoint for top 5-10 popular build archetypes
- [ ] Extract equipped rare items per character (body, helm, gloves, boots, rings, amulet, belt)
- [ ] Parse item mods into structured mod IDs (match against items.json)
- [ ] Store: `build_items.json` — list of high-value item mod targets per slot

### 2.2 Mod Requirement Extractor
- [ ] Identify the "required" mods (appear in >80% of that build's items) vs "nice to have"
- [ ] Determine min tier thresholds from sampled items (e.g., T1-T2 life on rings)
- [ ] Output: ranked list of mod combos per item slot per build archetype

### 2.3 Market Value Estimator
- [ ] Cross-reference target mod combos against poe.ninja trade data
- [ ] Estimate item value based on mod combination rarity + demand
- [ ] Feed market value estimate into existing profitability calculator

### 2.4 Craft Path Ranker
- [ ] For each target item: run Monte Carlo across all viable crafting methods
  - Essence spam, fossil spam, chaos spam, influenced essence, etc.
- [ ] Rank by expected profit: `market_value - (base_cost + expected_craft_cost)`
- [ ] Surface top 3 methods with probability, avg tries, and expected cost

---

## Phase 3 — Strategy Optimizer UI

Goal: Surface the single best crafting strategy for a given target item.

### 3.1 Item-Centric Workflow (like Craft of Exile)
- [ ] Replace current "select mods manually" flow with "select a target item archetype"
- [ ] Auto-populate target mods from build analyzer output
- [ ] Show all crafting paths side-by-side in a comparison table

### 3.2 Comparison Table
| Path | Avg Tries | Expected Cost | Success Rate | Profit |
|------|-----------|---------------|--------------|--------|
| Essence of Rage × 3 → Exalt | 12 | 180c | 8.3% | +420c |
| 4-Fossil Resonator | 28 | 420c | 3.6% | +180c |
| Chaos Spam | 847 | 1270c | 0.12% | -250c |

### 3.3 "Craft This" Mode
- [ ] Step-by-step crafting instructions with current prices
- [ ] Decision points: "If you hit X, proceed to step 3. If not, scour and repeat."
- [ ] Estimated total budget needed for 90% confidence of success

### 3.4 Historical Profitability Tracking
- [ ] Store daily snapshots of active_economy.json
- [ ] Plot craft EV over time (prices change as league progresses)
- [ ] Alert when a craft crosses from loss → profit territory

---

## Data Sources Reference

| Data | Source | Script |
|------|--------|--------|
| Mod pools | RePoE GitHub (`mods.json`) | `build_db.py` |
| Essences | RePoE GitHub (`essences.json`) | `build_db.py` |
| Fossils | RePoE GitHub | `build_db.py` |
| Bench crafts | RePoE (`crafting_bench_options.json`) | to add |
| Veiled mods | RePoE (`veiled_mods.json`) | to add |
| Live prices | poe.ninja currency + essence APIs | `fetch_economy.py` |
| Build data | poe.ninja `/builds` endpoint | to add (`scrape_builds.py`) |
| Trade prices | poe.ninja trade search API | to add |

---

## Recommended Implementation Order

1. **Influenced mods** — unlocks 80% of the profitable item space
2. **Chaos/alchemy spam** — most-used crafting method by players
3. **Bench crafts / metamods** — enables hybrid strategies
4. **poe.ninja build scraper** — drives auto-population of targets
5. **Mod requirement extractor** — core of the "reverse engineer" vision
6. **Exalt slam + Awakener** — completes the high-end crafting coverage
7. **Strategy optimizer UI** — the final polished product
