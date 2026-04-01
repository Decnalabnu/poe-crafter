# PoE Crafter — Roadmap to Craft of Exile Replica

## Current State (~65% Complete)

### Working

- Exact decision tree EV engine (replaces Monte Carlo) — `src/utils/calculator.js`
- Essence + Fossil crafting with multiplicative fossil weight stacking
- Fractured bases support
- Live economy integration via poe.ninja ETL pipeline
- 7 item classes with full mod pools from RePoE
- Build scraper — GGG ladder → mod frequency by archetype (`scrape_builds.py`)
- Trade price fetcher — GGG trade API → market value for crafting targets (`fetch_trade_prices.py`)

### Architecture

```
Python ETL
  update_data.py       → active_economy.json   (poe.ninja material costs)
  scrape_builds.py     → build_items.json       (mod frequency by build archetype)
  fetch_trade_prices.py → trade_prices.json     (market value of finished items)
      ↓
React App (App.jsx)
  calculator.js        → expected craft cost per method
  heat map UI          → profit = market_value - craft_cost
```

### Trade API Integration (new)
- `fetch_trade_prices.py` constructs trade queries from `build_items.json` targets
- Mod texts normalized and mapped to GGG stat IDs (88% match rate; 3 variants tried)
- Prices fetched as top-10 cheapest listings, converted to chaos, cached 4h
- Output: `src/data/trade_prices.json` with p10/p25/median/p75/p90 per target

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

### 2.1 Build Scraper (`scrape_builds.py`) ✅ DONE

- [x] Fetch GGG ladder API for top characters by build archetype
- [x] Extract equipped rare items per character (body, helm, gloves, boots, rings, amulet, belt)
- [x] Parse item mods into structured mod IDs (matched against items.json via regex)
- [x] Store: `build_items.json` — mod frequency + tier stats per slot per build archetype

### 2.2 Mod Requirement Extractor ✅ DONE (integrated into scraper + price fetcher)

- [x] Required mods = frequency_pct >= 50% threshold in build_items.json
- [x] Min tier thresholds from avg_tier field (round to nearest tier)
- [x] Min values extracted from items.json mod text range lower bounds

### 2.3 Market Value Estimator (`fetch_trade_prices.py`) ✅ DONE

- [x] Map mod groups → GGG trade stat IDs (88% coverage, 3 normalization variants)
- [x] Construct trade search queries per (build, slot) target
- [x] Fetch top-10 cheapest online listings, convert to chaos (divine rate from economy)
- [x] Output: `trade_prices.json` with p10/p25/median/p75/p90 per target, 4h cache
- [ ] Refine min_value thresholds — low-tier mods (T8+) produce weak filters → prices noisy
- [ ] Add influenced mod stat IDs once influence support lands in items.json

### 2.4 Craft Path Ranker

- [ ] Load trade_prices.json + run calculator.js EV engine for each crafting method
- [ ] Compute: `profit = median_market_price - (base_cost + expected_craft_cost)`
- [ ] Output heat map data structure: {target_id, craft_method, profit, craft_cost, market_price}

---

## Phase 3 — Strategy Optimizer UI

Goal: Surface the single best crafting strategy for a given target item.

### 3.1 Item-Centric Workflow (like Craft of Exile)

- [ ] Replace current "select mods manually" flow with "select a target item archetype"
- [ ] Auto-populate target mods from build analyzer output
- [ ] Show all crafting paths side-by-side in a comparison table

### 3.2 Comparison Table

| Path                        | Avg Tries | Expected Cost | Success Rate | Profit |
| --------------------------- | --------- | ------------- | ------------ | ------ |
| Essence of Rage × 3 → Exalt | 12        | 180c          | 8.3%         | +420c  |
| 4-Fossil Resonator          | 28        | 420c          | 3.6%         | +180c  |
| Chaos Spam                  | 847       | 1270c         | 0.12%        | -250c  |

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

| Data         | Source                                | Script                      |
| ------------ | ------------------------------------- | --------------------------- |
| Mod pools    | RePoE GitHub (`mods.json`)            | `build_db.py`               |
| Essences     | RePoE GitHub (`essences.json`)        | `build_db.py`               |
| Fossils      | RePoE GitHub                          | `build_db.py`               |
| Bench crafts | RePoE (`crafting_bench_options.json`) | to add                      |
| Veiled mods  | RePoE (`veiled_mods.json`)            | to add                      |
| Live prices  | poe.ninja currency + essence APIs     | `fetch_economy.py`          |
| Build data   | poe.ninja `/builds` endpoint          | to add (`scrape_builds.py`) |
| Trade prices | poe.ninja trade search API            | to add                      |

---

## Recommended Implementation Order

1. **Influenced mods** — unlocks 80% of the profitable item space
2. **Chaos/alchemy spam** — most-used crafting method by players
3. **Bench crafts / metamods** — enables hybrid strategies
4. **poe.ninja build scraper** — drives auto-population of targets
5. **Mod requirement extractor** — core of the "reverse engineer" vision
6. **Exalt slam + Awakener** — completes the high-end crafting coverage
7. **Strategy optimizer UI** — the final polished product
