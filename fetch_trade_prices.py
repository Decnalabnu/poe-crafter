"""
Trade price fetcher: queries the GGG trade API for current market prices
of rare items matching popular build mod requirements from build_items.json.

Outputs src/data/trade_prices.json — the market-value side of the profitability
equation. Craft cost is computed separately by the EV calculator engine.

Pipeline position:
    scrape_builds.py → build_items.json (what mods are popular)
    fetch_trade_prices.py → trade_prices.json  (what those items sell for)
    calculator.js → craft_cost per method
    heatmap UI → profit = trade_price - craft_cost

Usage:
    python3 fetch_trade_prices.py               # fetch fresh prices
    python3 fetch_trade_prices.py --dry-run     # show targets without fetching
    python3 fetch_trade_prices.py --rebuild-map # force-refresh the stat ID cache
"""

import argparse
import json
import os
import re
import time
from datetime import datetime, timezone
from statistics import median

import requests

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
LEAGUE = json.load(open("src/data/active_economy.json")).get("league", "Mirage")
OUTPUT_FILE = "src/data/trade_prices.json"
STAT_ID_CACHE = "data/trade_stat_ids.json"
PRICE_CACHE_DIR = "data/build_cache"

TOP_BUILDS = 8          # number of build archetypes to price
MIN_FREQ_PCT = 50.0     # mod must appear in >=50% of sampled items to be "required"
MIN_SLOT_SAMPLES = 5    # minimum items sampled in a slot before trusting the data
LISTINGS_PER_QUERY = 10 # listings fetched per target (trade API: max 10 per fetch)
CACHE_TTL_HOURS = 4     # stale price cache beyond this age is re-fetched

SEARCH_DELAY = 3.0      # seconds between POST /search requests
FETCH_DELAY  = 1.5      # seconds between GET /fetch requests

GGG_TRADE_BASE = "https://www.pathofexile.com/api/trade"
HEADERS = {"User-Agent": "poe-crafter-price-fetcher/1.0 (personal research tool)"}

# Our item slot tags → GGG trade category option
CATEGORY_MAP = {
    "ring":        "accessory.ring",
    "amulet":      "accessory.amulet",
    "belt":        "accessory.belt",
    "helmet":      "armour.helmet",
    "gloves":      "armour.gloves",
    "boots":       "armour.boots",
    "body_armour": "armour.chest",
}

# ---------------------------------------------------------------------------
# Stat ID mapping  (mod text → trade explicit.stat_XXXX)
# ---------------------------------------------------------------------------

def _normalize_text(text: str) -> str:
    """
    Reduce a mod text to a format comparable with trade API stat texts.
    '+#' is the trade API's placeholder for numeric values.

      '+(80-99) to maximum Life [Athlete]'  →  '+# to maximum life'
      '+# to maximum Life'                  →  '+# to maximum life'
    """
    text = re.sub(r"\s*\[[^\]]+\]$", "", text).strip()  # strip  [Tag suffix]
    text = re.sub(r"\(\d+[-–]\d+\)", "#", text)          # (X-Y)  → #
    text = re.sub(r"\b\d+(?:\.\d+)?\b", "#", text)       # bare numbers → #
    return text.lower().strip()


def build_stat_id_map(session: requests.Session, force: bool = False) -> dict:
    """
    Returns {normalized_text: stat_id} for all explicit stats.
    Cached to STAT_ID_CACHE — only refetched when force=True or cache is missing.
    """
    if not force and os.path.exists(STAT_ID_CACHE):
        with open(STAT_ID_CACHE, encoding="utf-8") as f:
            cached = json.load(f)
        print(f"  [cache] stat ID map ({len(cached)} entries)")
        return cached

    print("  Fetching explicit stat IDs from trade API...")
    resp = session.get(f"{GGG_TRADE_BASE}/data/stats", timeout=15)
    resp.raise_for_status()

    stat_map: dict[str, str] = {}
    for category in resp.json()["result"]:
        if category["label"] != "Explicit":
            continue
        for entry in category["entries"]:
            stat_map[_normalize_text(entry["text"])] = entry["id"]

    os.makedirs(os.path.dirname(STAT_ID_CACHE), exist_ok=True)
    with open(STAT_ID_CACHE, "w", encoding="utf-8") as f:
        json.dump(stat_map, f)
    print(f"  Stat ID map built: {len(stat_map)} explicit stats")
    return stat_map


def find_stat_id(group: str, item_tag: str, items_db: dict, stat_map: dict) -> str | None:
    """
    Find the trade stat ID for a mod group on a given item type.
    All tiers of a mod group share one stat ID — we just need any tier's text.

    items.json omits the leading '+' on many percentage mods while the trade API
    includes it (e.g. '#% to Global Critical Strike Multiplier' vs
    '+#% to Global Critical Strike Multiplier'). We try both variants.
    """
    pool = items_db.get(item_tag, {})
    for section in ("prefixes", "suffixes"):
        for mod in pool.get(section, []):
            if mod.get("group") != group:
                continue
            normalized = _normalize_text(mod["text"])
            for variant in (normalized, "+" + normalized, normalized + " (local)"):
                if variant in stat_map:
                    return stat_map[variant]
    return None


def extract_min_value(group: str, item_tag: str, target_tier: int, items_db: dict) -> int | None:
    """
    Return the lower bound of the numeric range for a mod group at a specific tier.
    e.g. group='Increased Life', item_tag='ring', tier=2 → 80
    Used as the trade query minimum so we only price items worth crafting.
    """
    pool = items_db.get(item_tag, {})
    for section in ("prefixes", "suffixes"):
        for mod in pool.get(section, []):
            if mod.get("group") != group or mod.get("tier") != target_tier:
                continue
            # Prefer range lower bound (X-Y) → X; fall back to first bare number
            m = re.search(r"\((\d+)[-–]\d+\)", mod["text"])
            if m:
                return int(m.group(1))
            m = re.search(r"\b(\d+)\b", mod["text"])
            if m:
                return int(m.group(1))
    return None

# ---------------------------------------------------------------------------
# Target construction from build_items.json
# ---------------------------------------------------------------------------

def build_targets(build_items: dict, items_db: dict, stat_map: dict) -> list:
    """
    Constructs one trade-query target per (build, slot) with ≥2 required mods.
    Required = frequency_pct >= MIN_FREQ_PCT in the sampled build data.
    """
    builds = sorted(build_items["builds"], key=lambda b: -b["play_pct"])[:TOP_BUILDS]
    targets = []
    unmapped = []

    for build in builds:
        build_label = f"{build['char_class']} / {build['primary_skill']}"

        for slot, slot_data in build.get("slots", {}).items():
            if slot not in CATEGORY_MAP:
                continue
            if slot_data.get("sample_count", 0) < MIN_SLOT_SAMPLES:
                continue

            required_mods = []
            for group, freq in slot_data.get("mod_frequency", {}).items():
                if freq["frequency_pct"] < MIN_FREQ_PCT:
                    continue

                stat_id = find_stat_id(group, slot, items_db, stat_map)
                if not stat_id:
                    unmapped.append(f"{slot}/{group}")
                    continue

                # Use round(avg_tier) as quality floor — conservative but realistic
                avg_tier = freq.get("avg_tier")
                target_tier = round(avg_tier) if avg_tier is not None else None
                min_val = extract_min_value(group, slot, target_tier, items_db) if target_tier else None

                required_mods.append({
                    "group":     group,
                    "stat_id":   stat_id,
                    "avg_tier":  avg_tier,
                    "min_value": min_val,
                })

            # Need at least 2 mods to get a meaningful price signal
            if len(required_mods) < 2:
                continue

            safe_build = re.sub(r"[^\w]", "_", build_label).lower()
            targets.append({
                "id":            f"{safe_build}_{slot}",
                "build":         build_label,
                "play_pct":      build["play_pct"],
                "slot":          slot,
                "category":      CATEGORY_MAP[slot],
                "required_mods": required_mods,
            })

    if unmapped:
        unique_unmapped = sorted(set(unmapped))
        print(f"  Warning: {len(unique_unmapped)} mod groups had no stat ID match "
              f"(influenced/veiled mods not yet in items.json):")
        for u in unique_unmapped[:8]:
            print(f"    {u}")

    print(f"  Built {len(targets)} targets from top {len(builds)} builds")
    return targets

# ---------------------------------------------------------------------------
# Currency conversion
# ---------------------------------------------------------------------------

def load_currency_rates(economy: dict) -> dict[str, float]:
    """
    Map trade API currency shorthand → chaos value.
    Only chaos and divine are used in serious rare item trades.
    """
    divine = economy.get("divine_price", 150.0)
    return {
        "chaos":  1.0,
        "divine": divine,
    }


def price_to_chaos(price: dict, rates: dict) -> float | None:
    """Convert a trade listing price dict → chaos. Returns None for unusual currencies."""
    currency = price.get("currency", "")
    amount = price.get("amount", 0)
    rate = rates.get(currency)
    if rate is None or amount <= 0:
        return None
    return round(amount * rate, 1)

# ---------------------------------------------------------------------------
# Trade API fetching
# ---------------------------------------------------------------------------

def _price_cache_path(target_id: str) -> str:
    safe = re.sub(r"[^\w\-]", "_", target_id)
    return os.path.join(PRICE_CACHE_DIR, f"trade_{safe}.json")


def _cache_is_fresh(path: str) -> bool:
    if not os.path.exists(path):
        return False
    return (time.time() - os.path.getmtime(path)) / 3600 < CACHE_TTL_HOURS


def fetch_target_prices(target: dict, league: str, session: requests.Session,
                        rates: dict) -> dict | None:
    """
    Execute a trade search for this target and return price statistics.
    Caches raw results for CACHE_TTL_HOURS to avoid hammering the API on re-runs.
    """
    cache_path = _price_cache_path(target["id"])
    if _cache_is_fresh(cache_path):
        with open(cache_path, encoding="utf-8") as f:
            print(f"    [cache] {target['id']}")
            return json.load(f)

    # Build stat filters; include min_value only when we have one
    stat_filters = []
    for mod in target["required_mods"]:
        f: dict = {"id": mod["stat_id"]}
        if mod["min_value"] is not None:
            f["value"] = {"min": mod["min_value"]}
        stat_filters.append(f)

    payload = {
        "query": {
            "status": {"option": "online"},
            "filters": {
                "type_filters": {
                    "filters": {
                        "rarity":   {"option": "rare"},
                        "category": {"option": target["category"]},
                    }
                }
            },
            "stats": [{"type": "and", "filters": stat_filters}],
        },
        "sort": {"price": "asc"},
    }

    # --- POST /search ---
    time.sleep(SEARCH_DELAY)
    try:
        resp = session.post(f"{GGG_TRADE_BASE}/search/{league}", json=payload, timeout=15)
        if resp.status_code == 429:
            wait = int(resp.headers.get("Retry-After", 60))
            print(f"    Rate limited — waiting {wait}s")
            time.sleep(wait)
            resp = session.post(f"{GGG_TRADE_BASE}/search/{league}", json=payload, timeout=15)
        resp.raise_for_status()
        search = resp.json()
    except Exception as e:
        print(f"    Search failed ({target['id']}): {e}")
        return None

    result_ids = search.get("result", [])
    search_id  = search.get("id")
    total      = len(result_ids)

    if total == 0:
        print(f"    {target['id']}: 0 listings found — query may be too strict")
        return None

    # --- GET /fetch ---
    fetch_ids = result_ids[:LISTINGS_PER_QUERY]
    time.sleep(FETCH_DELAY)
    try:
        resp = session.get(
            f"{GGG_TRADE_BASE}/fetch/{','.join(fetch_ids)}",
            params={"query": search_id},
            timeout=15,
        )
        resp.raise_for_status()
        items = resp.json().get("result", [])
    except Exception as e:
        print(f"    Fetch failed ({target['id']}): {e}")
        return None

    # Extract + convert prices
    prices_chaos = sorted(filter(None, (
        price_to_chaos(item.get("listing", {}).get("price", {}), rates)
        for item in items
    )))

    if not prices_chaos:
        print(f"    {target['id']}: no chaos/divine-priced listings in sample")
        return None

    def pct(p: float) -> int:
        idx = min(int(p / 100 * len(prices_chaos)), len(prices_chaos) - 1)
        return round(prices_chaos[idx])

    result = {
        "total_listings": total,
        "sampled":        len(prices_chaos),
        "prices_chaos":   prices_chaos,
        "p10":            pct(10),
        "p25":            pct(25),
        "median":         round(median(prices_chaos)),
        "p75":            pct(75),
        "p90":            pct(90),
    }

    os.makedirs(PRICE_CACHE_DIR, exist_ok=True)
    with open(cache_path, "w", encoding="utf-8") as f:
        json.dump(result, f)

    mod_summary = " + ".join(m["group"] for m in target["required_mods"][:3])
    if len(target["required_mods"]) > 3:
        mod_summary += f" (+{len(target['required_mods']) - 3} more)"
    print(f"    {target['slot']:12s} median {result['median']:>5}c  "
          f"[{total} listings]  {mod_summary}")
    return result

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run",     action="store_true",
                        help="Show targets without fetching any prices")
    parser.add_argument("--rebuild-map", action="store_true",
                        help="Force-refresh the cached stat ID map from trade API")
    args = parser.parse_args()

    print(f"=== PoE Trade Price Fetcher (league: {LEAGUE}) ===\n")

    economy     = json.load(open("src/data/active_economy.json", encoding="utf-8"))
    build_items = json.load(open("src/data/build_items.json",    encoding="utf-8"))
    items_db    = json.load(open("src/data/items.json",          encoding="utf-8"))
    rates       = load_currency_rates(economy)
    print(f"  divine rate: {rates['divine']}c\n")

    session = requests.Session()
    session.headers.update(HEADERS)

    print("Building stat ID map...")
    stat_map = build_stat_id_map(session, force=args.rebuild_map)

    print("\nBuilding trade targets from build data...")
    targets = build_targets(build_items, items_db, stat_map)

    if args.dry_run:
        print("\n--- Targets (dry run) ---")
        for t in targets:
            mods = ", ".join(
                f"{m['group']} ≥T{m['avg_tier']} (min {m['min_value']})"
                for m in t["required_mods"]
            )
            print(f"  {t['build']:40s} {t['slot']:12s} | {mods}")
        return

    print(f"\nFetching prices for {len(targets)} targets...")
    output_targets = []
    for i, target in enumerate(targets, 1):
        print(f"  [{i:2d}/{len(targets)}] {target['build']} / {target['slot']}")
        price_data = fetch_target_prices(target, LEAGUE, session, rates)
        output_targets.append({**target, "price_data": price_data})

    output = {
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "league":     LEAGUE,
        "targets":    output_targets,
    }

    os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    priced = sum(1 for t in output_targets if t.get("price_data"))
    print(f"\nDone. {priced}/{len(targets)} targets priced → {OUTPUT_FILE}")
    if priced < len(targets):
        print("  Unpriced targets likely have very strict mod requirements — "
              "consider lowering MIN_FREQ_PCT or MIN_SLOT_SAMPLES.")


if __name__ == "__main__":
    main()
