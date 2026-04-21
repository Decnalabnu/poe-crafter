# PoE Crafter — Roadmap to Craft of Exile Replica

## Current State (~75% Complete)

### Working end-to-end

- Exact decision-tree EV engine (replaces Monte Carlo) — [calculator.js](src/utils/calculator.js)
- Essence + fossil crafting with multiplicative fossil weight stacking
- Fractured bases supported end-to-end (pre-placed mod consumes a slot, excluded from rolling EV)
- Live economy integration via poe.ninja ETL pipeline ([update_data.py](src/utils/update_data.py))
- 7 item classes with full mod pools from RePoE, including armour subtype first-match weights
- Build scraper — GGG ladder → mod frequency by archetype ([scrape_builds.py](src/utils/scrape_builds.py))
- Trade price fetcher — GGG trade API → market value per target ([fetch_trade_prices.py](src/utils/fetch_trade_prices.py))
- Route planner — enumerates chaos / essence / fossil-pair / harvest routes, remaps essence-only tiers ([routePlanner.js](src/utils/routePlanner.js))
- Profit engine — resolves target mods → routes → `profit = median_price − (base_cost + rollCost)` ([profitEngine.js](src/utils/profitEngine.js))
- Profit heatmap UI — the flagship surface ([ProfitHeatmap.jsx](src/components/ProfitHeatmap.jsx))
- Item import → EV optimizer ([CraftOptimizer.jsx](src/components/CraftOptimizer.jsx))
- Influence-aware calculator + CrafterTab influence selector (data pool already keyed by influence)

### Architecture

```
Python ETL
  update_data.py         → active_economy.json   (poe.ninja material costs)
  scrape_builds.py       → build_items.json      (mod frequency by archetype)
  fetch_trade_prices.py  → trade_prices.json     (market value per target)
  build_db.py            → items.json, essences.json (RePoE mod pools)
      ↓
React App (App.jsx)
  calculator.js          → EV per method (chaos/essence/fossil/harvest)
  routePlanner.js        → all viable routes, cheapest-first
  profitEngine.js        → profit = sell − (base + rollCost)
  ProfitHeatmap.jsx      → heatmap UI
```

---

## Gameplan — Next Steps (ranked by profit-signal ROI)

### 1. Influenced mods end-to-end (IN PROGRESS)

The calculator engine and `items.json` schema already support influence — the remaining work is pipeline hygiene so profit numbers on influenced targets are actually trustworthy.

- [x] RePoE influenced mod ingestion in [build_db.py](src/utils/build_db.py) (shaper/elder/crusader/hunter/redeemer/warlord tagged via `ring_shaper` etc. spawn-weight tags)
- [x] `items.json` schema includes `influence` field per influenced mod
- [x] `calculator.js` influence filter — excludes mods with non-matching influence
- [x] CrafterTab influence selector UI
- [x] App.jsx auto-detects influence from required mods on "Craft this slot"
- [ ] **scrape_builds.py** — record influence observed on ladder items per (build, slot); expose `slot_influence_freq`
- [ ] **fetch_trade_prices.py** — include influence filter in trade query when target is influenced; add influenced stat IDs to mod→stat map
- [ ] **profitEngine.js** — when target has mixed influences on a single item, currently bails with `multi_influence` (Awakener-only); verify single-influence path is selected when influence is dominant

### 2. Base cost hygiene

`profitEngine.js` currently falls back to `baseCost = 0` when `base_cost_chaos` is missing — this silently inflates profit on fractured/influenced bases.

- [ ] Audit `trade_prices.json` for targets missing `base_cost_chaos`
- [ ] Backfill base cost queries in `fetch_trade_prices.py` (fractured + influenced base variants)
- [ ] ProfitHeatmap: surface a "no base cost" badge when the field is absent rather than silently treating it as free

### 3. Min-value filter tuning

Low-tier (T8+) thresholds produce weak trade filters → listings don't represent the intended target → median is noisy, causing false-positive profit cells.

- [ ] Raise min_value floor proportional to tier in `fetch_trade_prices.py`
- [ ] Re-scrape and diff price distributions
- [ ] Add a listings-count warning when < 10 online matches (already scaffolded via `SPARSE_LISTING_THRESHOLD`)

### 4. Finishing steps: bench metamods + exalt slam

Most real crafts end with a bench block + exalt; skipping them makes chaos spam look worse and overstates essence routes that should finish with a bench step.

- [ ] Fetch `crafting_bench_options.json` from RePoE in `build_db.py`
- [ ] Extend calculator with "add exalt to open prefix/suffix" and "bench-add specific mod" finishing steps
- [ ] Route objects grow a `finishingSteps` array; `routePlanner` attaches the optimal finisher per route
- [ ] `profitEngine` already has the surface — just sum finisher cost into `bestCraftCost`

### 5. Strategy-optimizer UI consolidation

`ProfitHeatmap`, `BuildAnalyzer`, `CrafterTab`, and `CraftOptimizer` are three overlapping views of the same concepts. Consolidate into one item-centric comparison table (Craft-of-Exile style).

- [ ] Single "Target" picker: item class + build archetype OR item-paste import
- [ ] Comparison table: path | avg tries | expected cost | success rate | profit (one row per route)
- [ ] "Craft this" mode — step-by-step instructions with live prices

### 6. Veiled mods + Awakener's Orb (lower priority — unlocks high-end only)

- [ ] Fetch `veiled_mods.json` from RePoE; add veiled entries to items.json
- [ ] Model Betrayal encounter cost as crafting input
- [ ] Awakener: two-item input, simulate mod transfer, combined cost of 2 bases + Awakener orb

---

## Completed (deferred from original roadmap)

- Build scraper (ladder → mod freq)
- Mod requirement extractor (frequency/tier thresholds, min-value bounds)
- Market value estimator (trade API, p10/p25/median/p75/p90, 4h cache)
- Fractured base support
- Harvest reforge route modeling
- Fossil pair enumeration with solo-cheapness pruning
- Essence-only tier remapping (lets chaos/fossil routes plan for essence-exclusive targets)

---

## Data Sources Reference

| Data         | Source                                | Script                    |
| ------------ | ------------------------------------- | ------------------------- |
| Mod pools    | RePoE (`mods.json`)                   | `build_db.py`             |
| Essences     | RePoE (`essences.json`)               | `build_db.py`             |
| Fossils      | RePoE                                 | `build_db.py`             |
| Bench crafts | RePoE (`crafting_bench_options.json`) | to add                    |
| Veiled mods  | RePoE (`veiled_mods.json`)            | to add                    |
| Live prices  | poe.ninja currency + essence APIs     | `update_data.py`          |
| Build data   | GGG ladder API                        | `scrape_builds.py`        |
| Trade prices | GGG trade search API                  | `fetch_trade_prices.py`   |
