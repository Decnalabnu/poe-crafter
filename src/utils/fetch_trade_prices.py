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
MIN_PLAY_PCT = 1.0      # build must have at least this play_pct to be priced at all
MIN_FREQ_PCT = 30.0     # mod must appear in >=30% of sampled items to be "required"
MIN_SLOT_SAMPLES = 5    # minimum items sampled in a slot before trusting the data
MAX_QUERY_MODS = 4      # AND logic explodes result sets; cap at this many mods per query
LISTINGS_PER_QUERY = 10 # listings fetched per target (trade API: max 10 per fetch)
MIN_BASE_SAMPLES = 3    # minimum listings for base price to be trusted (avoids 1-listing flukes)
CACHE_TTL_HOURS = 4     # stale price cache beyond this age is re-fetched

SEARCH_DELAY = 8.0      # seconds between POST /search requests
FETCH_DELAY  = 4.0      # seconds between GET /fetch requests
RATE_LIMIT_COOLDOWN = 120  # seconds to wait after a 403/429 before resuming

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
    text = re.sub(r"\s*\[[^\]]+\]$", "", text).strip()                    # strip [Tag suffix]
    text = re.sub(r"\(\s*\d+\s*[-\u2013\u2014]\s*\d+\s*\)", "#", text)   # (X-Y) / (X — Y) → #
    text = re.sub(r"\b\d+(?:\.\d+)?\b", "#", text)                        # bare numbers → #
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


# Influence name (from items.json) → GGG trade misc_filter key
INFLUENCE_FILTER_KEYS = {
    "shaper":   "shaper_item",
    "elder":    "elder_item",
    "crusader": "crusader_item",
    "hunter":   "hunter_item",
    "redeemer": "redeemer_item",
    "warlord":  "warlord_item",
}


def _is_pct_mod(text: str) -> bool:
    """Return True if the mod text is a percentage stat (contains % before a keyword)."""
    return bool(re.search(r"%", text))


def find_stat_id_and_influence(group: str, item_tag: str, items_db: dict,
                               stat_map: dict) -> tuple[str | None, str | None]:
    """
    Find the trade stat ID for a mod group on a given item type.
    Returns (stat_id, influence_name | None).

    Search order: non-influenced first (most ladder items are uninfluenced), then
    influenced. If only an influenced version exists, returns its influence type so
    the caller can add the appropriate misc_filter to the trade query.

    Normalization variants tried against the stat map:
      1. as-is
      2. '+' prepended  (items.json drops leading '+' on pct mods)
      3. '(local)' appended  (trade API appends this on local defence mods)
      4. '+' prepended AND '(local)' appended  (flat local mods, e.g. '+# to armour (local)')
      5. '-#' → '+#' swap  (cost-reduction mods stored negative in RePoE)

    For local defence mods we try to match flat vs % correctly:
      - Mod text containing '%' → try the '% increased ... (local)' trade stat first
      - Mod text without '%' → try '+# to ... (local)' first (flat value)
    """
    pool = items_db.get(item_tag, {})
    influenced_candidate: tuple[str, str] | None = None  # (stat_id, influence)

    for section in ("prefixes", "suffixes"):
        for mod in pool.get(section, []):
            if mod.get("group") != group:
                continue
            text = mod["text"]
            normalized = _normalize_text(text)
            is_pct = _is_pct_mod(text)

            # Build candidate list prioritising the correct flat/% form for (local) mods
            candidates: list[str] = []
            if is_pct:
                candidates = [
                    normalized,
                    normalized + " (local)",
                    "+" + normalized,
                    "+" + normalized + " (local)",
                ]
            else:
                # flat value mod — try '+# to X (local)' before bare forms
                candidates = [
                    "+" + normalized + " (local)",
                    normalized + " (local)",
                    "+" + normalized,
                    normalized,
                ]

            # Also try '-#' → '+#' swap for signed cost-reduction mods
            if "-#" in normalized:
                swapped = normalized.replace("-#", "+#")
                candidates.append(swapped)
                candidates.append(swapped + " (local)")

            for variant in candidates:
                if variant in stat_map:
                    if not mod.get("influence"):
                        return stat_map[variant], None
                    elif influenced_candidate is None:
                        influenced_candidate = (stat_map[variant], mod["influence"])
                    break  # first match per mod — don't add more candidates for same mod

    if influenced_candidate:
        return influenced_candidate
    return None, None


def extract_min_value(group: str, item_tag: str, target_tier: int, items_db: dict,
                      influence: str | None = None) -> int | None:
    """
    Return the trade query min_value for a mod group at a specific tier.

    For positive mods (life, resistance, etc.): returns the lower bound of the
    stat range so the query filters out low rolls.
    For signed negative mods (e.g. 'Socketed Attacks have -15 to Total Mana Cost'):
    returns the negative value because the GGG trade API stores these as negative
    integers and filters use 'min' in the signed direction.
    """
    pool = items_db.get(item_tag, {})
    for section in ("prefixes", "suffixes"):
        for mod in pool.get(section, []):
            if mod.get("group") != group:
                continue
            if mod.get("tier") != target_tier:
                continue
            if influence and mod.get("influence") != influence:
                continue
            text = mod["text"]
            # Signed range like "(-20 to -16)" or bare signed value "-15"
            m = re.search(r"\(\s*(-\d+)\s*[-\u2013\u2014]\s*-?\d+\s*\)", text)
            if m:
                return int(m.group(1))  # negative lower bound for cost-reduction mods
            # Positive range "(X-Y)" or "(X — Y)" → X
            m = re.search(r"\(\s*(\d+)\s*[-\u2013\u2014]\s*\d+\s*\)", text)
            if m:
                return int(m.group(1))
            # Bare signed number e.g. "-15"
            m = re.search(r"(?<!\d)(-\d+)\b", text)
            if m:
                return int(m.group(1))
            # Bare positive number
            m = re.search(r"\b(\d+)\b", text)
            if m:
                return int(m.group(1))
    return None

# ---------------------------------------------------------------------------
# Target construction from build_items.json
# ---------------------------------------------------------------------------

def build_targets(build_items: dict, items_db: dict, stat_map: dict,
                   builds_key: str = "builds") -> list:
    """
    Constructs one trade-query target per (build, slot) with ≥2 required mods.
    Required = frequency_pct >= MIN_FREQ_PCT in the sampled build data.

    Tier floor: uses min_tier_seen (the best tier actually found on sampled ladder
    items) rather than avg_tier. This keeps min_value thresholds tight — e.g.
    T2 life on rings requires min 60 HP, not the T8 floor of 3 HP from avg_tier.

    Influence detection: if a mod group only exists in influenced form in items.json,
    the target is tagged with that influence type and the trade query will include the
    appropriate misc_filter (shaper_item, elder_item, etc.).
    """
    builds = sorted(build_items.get(builds_key, build_items["builds"]),
                     key=lambda b: -b["play_pct"])[:TOP_BUILDS]
    builds = [
        b for b in builds
        if b.get("play_pct", 0) >= MIN_PLAY_PCT
        and b.get("primary_skill", "Unknown") != "Unknown"
    ]
    targets = []
    unmapped = []

    for build in builds:
        if "char_class" in build:
            build_label = f"{build['char_class']} / {build['primary_skill']}"
        else:
            build_label = build["primary_skill"]

        for slot, slot_data in build.get("slots", {}).items():
            if slot not in CATEGORY_MAP:
                continue
            if slot_data.get("sample_count", 0) < MIN_SLOT_SAMPLES:
                continue

            required_mods = []
            influence_votes: dict[str, int] = {}  # influence → count of mods requiring it

            for group, freq in slot_data.get("mod_frequency", {}).items():
                if freq["frequency_pct"] < MIN_FREQ_PCT:
                    continue

                stat_id, mod_influence = find_stat_id_and_influence(group, slot, items_db, stat_map)
                if not stat_id:
                    unmapped.append(f"{slot}/{group}")
                    continue

                if mod_influence:
                    influence_votes[mod_influence] = influence_votes.get(mod_influence, 0) + 1

                # Use min_tier_seen — the best tier actually seen on sampled items.
                # This gives a tighter min_value than avg_tier, filtering out cheap
                # items where only a single worthless stat happens to be present.
                target_tier = freq.get("min_tier_seen")
                min_val = (
                    extract_min_value(group, slot, target_tier, items_db, mod_influence)
                    if target_tier is not None else None
                )

                required_mods.append({
                    "group":      group,
                    "stat_id":    stat_id,
                    "influence":  mod_influence,
                    "tier_floor": target_tier,
                    "min_value":  min_val,
                    "_freq_pct":  freq["frequency_pct"],  # used for sorting; dropped below
                })

            if len(required_mods) < 2:
                continue

            # Sort by frequency descending and cap at MAX_QUERY_MODS.
            # AND logic over many mods causes exponential result set shrinkage —
            # cap to the top N most-common mods which carry the most price signal.
            required_mods.sort(key=lambda m: -m["_freq_pct"])
            required_mods = required_mods[:MAX_QUERY_MODS]
            for m in required_mods:
                del m["_freq_pct"]

            # If influenced mods agree on a single influence type, tag the target.
            # Conflicting influences (e.g. shaper + elder) signal an Awakener orb
            # craft — skip the influence filter and note the conflict.
            # Recount votes after capping mods.
            influence_votes_capped: dict[str, int] = {}
            for m in required_mods:
                if m["influence"]:
                    influence_votes_capped[m["influence"]] = influence_votes_capped.get(m["influence"], 0) + 1

            target_influence: str | None = None
            if influence_votes_capped:
                top_inf, top_count = max(influence_votes_capped.items(), key=lambda x: x[1])
                if len(influence_votes_capped) == 1 or top_count >= len(required_mods) * 0.6:
                    target_influence = top_inf
                else:
                    print(f"    {build_label}/{slot}: conflicting influences "
                          f"{influence_votes_capped} — skipping influence filter")

            # Fallback: when no required mod is influenced-only, the mod-inferred
            # signal above is blank even if ladder items are overwhelmingly on an
            # influenced base (e.g. a Hunter ring whose mods are all plain Life /
            # Damage). Use the ladder-observed dominant influence in that case so
            # the trade query filters to the base type the meta actually uses.
            if target_influence is None:
                ladder_inf = slot_data.get("dominant_influence")
                if ladder_inf:
                    target_influence = ladder_inf

            # Fractured base detection: the scraper tags a slot with
            # fractured_group when a meaningful share of ladder items are on a
            # base fractured at that mod group. We propagate the group + its
            # resolved stat ID so fetch_base_price can price a fractured base
            # instead of a plain one, and the profit engine can pass the
            # fractured mod to routePlanner so rolling EV excludes it.
            fractured_group = slot_data.get("fractured_group")
            fractured_stat_id: str | None = None
            fractured_min_value: int | None = None
            fractured_freq_pct = slot_data.get("fractured_freq_pct") or 0.0
            if fractured_group:
                fractured_stat_id, _ = find_stat_id_and_influence(
                    fractured_group, slot, items_db, stat_map
                )
                if fractured_stat_id:
                    # Use the same tier floor as the required mod, if the same
                    # group is required — otherwise fall back to T1 for pricing.
                    req = next(
                        (m for m in required_mods if m["group"] == fractured_group),
                        None,
                    )
                    frac_tier_floor = req["tier_floor"] if req else 1
                    fractured_min_value = extract_min_value(
                        fractured_group, slot, frac_tier_floor, items_db, None
                    )

            safe_build = re.sub(r"[^\w]", "_", build_label).lower()
            targets.append({
                "id":                   f"{safe_build}_{slot}",
                "build":                build_label,
                "play_pct":             build["play_pct"],
                "slot":                 slot,
                "category":             CATEGORY_MAP[slot],
                "influence":            target_influence,
                "required_mods":        required_mods,
                "fractured_group":      fractured_group if fractured_stat_id else None,
                "fractured_stat_id":    fractured_stat_id,
                "fractured_min_value":  fractured_min_value,
                "fractured_freq_pct":   fractured_freq_pct,
            })

    if unmapped:
        unique_unmapped = sorted(set(unmapped))
        print(f"  Warning: {len(unique_unmapped)} mod groups had no stat ID match:")
        for u in unique_unmapped[:10]:
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

    # Base filters: rarity + item category
    query_filters: dict = {
        "type_filters": {
            "filters": {
                "rarity":   {"option": "rare"},
                "category": {"option": target["category"]},
            }
        }
    }

    # Add influence filter when the target requires a specific influence type.
    # This restricts results to e.g. shaper items only, so influenced-exclusive
    # mods (like Enemies Explode or Mana Cost on Socketed Attacks) are reachable.
    influence = target.get("influence")
    if influence and influence in INFLUENCE_FILTER_KEYS:
        filter_key = INFLUENCE_FILTER_KEYS[influence]
        query_filters["misc_filters"] = {
            "filters": {filter_key: {"option": True}}
        }

    def _do_search(filters_subset: list, with_influence: bool) -> tuple[list, str] | None:
        """POST /search and return (result_ids, search_id) or None on failure."""
        qf = dict(query_filters)
        if not with_influence:
            qf = {k: v for k, v in qf.items() if k != "misc_filters"}
        payload = {
            "query": {
                "status": {"option": "online"},
                "filters": qf,
                "stats": [{"type": "and", "filters": filters_subset}],
            },
            "sort": {"price": "asc"},
        }
        time.sleep(SEARCH_DELAY)
        for attempt in range(3):
            try:
                resp = session.post(f"{GGG_TRADE_BASE}/search/{league}", json=payload, timeout=15)
                if resp.status_code in (429, 403):
                    wait = max(
                        int(resp.headers.get("Retry-After", RATE_LIMIT_COOLDOWN)),
                        RATE_LIMIT_COOLDOWN,
                    )
                    kind = "Forbidden (temp ban)" if resp.status_code == 403 else "Rate limited"
                    print(f"    {kind} — cooling down {wait}s (attempt {attempt + 1}/3)")
                    time.sleep(wait)
                    continue
                resp.raise_for_status()
                data = resp.json()
                return data.get("result", []), data.get("id", "")
            except requests.exceptions.HTTPError:
                print(f"    Search HTTP error {resp.status_code}")
                return None
            except Exception as e:
                print(f"    Search error: {e}")
                return None
        print(f"    Search gave up after 3 rate-limit retries")
        return None

    # Progressive fallback strategy:
    #  1. All mods + influence filter (if any)
    #  2. All mods, no influence filter
    #  3. Top 2 mods only (highest frequency), no influence filter
    influence = target.get("influence")
    attempts = [
        (stat_filters,        bool(influence)),
        (stat_filters,        False),
        (stat_filters[:2],    False),
    ]
    # Deduplicate identical attempts
    seen_attempts: list[tuple] = []
    unique_attempts = []
    for sf, wi in attempts:
        key = (tuple(f["id"] for f in sf), wi)
        if key not in seen_attempts:
            seen_attempts.append(key)
            unique_attempts.append((sf, wi))

    result_ids: list = []
    search_id: str = ""
    used_mods_count = len(stat_filters)
    for attempt_sf, attempt_wi in unique_attempts:
        res = _do_search(attempt_sf, attempt_wi)
        if res is None:
            return None
        result_ids, search_id = res
        if result_ids:
            used_mods_count = len(attempt_sf)
            if attempt_sf is not stat_filters or (not attempt_wi and influence):
                suffix = "no-influence" if (not attempt_wi and influence) else f"top-{len(attempt_sf)}-mods"
                print(f"    Fell back to {suffix} ({len(result_ids)} results)")
            break
        # Only log when we exhausted all attempts

    total = len(result_ids)
    if total == 0:
        print(f"    {target['id']}: 0 listings after all fallbacks")
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

    # Extract the most common base type from sampled listings.
    # The GGG fetch response nests item data under item["item"]; the base type
    # is in "baseType" (or "typeLine" as fallback).
    base_counts: dict[str, int] = {}
    for listing in items:
        item_obj = listing.get("item", {})
        base = (item_obj.get("baseType") or item_obj.get("typeLine", "")).strip()
        if base:
            base_counts[base] = base_counts.get(base, 0) + 1
    common_base = max(base_counts, key=base_counts.get) if base_counts else None

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
        "common_base":    common_base,
    }

    os.makedirs(PRICE_CACHE_DIR, exist_ok=True)
    with open(cache_path, "w", encoding="utf-8") as f:
        json.dump(result, f)

    inf_label = f" [{influence}]" if influence else ""
    mod_summary = " + ".join(m["group"] for m in target["required_mods"][:3])
    if len(target["required_mods"]) > 3:
        mod_summary += f" (+{len(target['required_mods']) - 3} more)"
    base_label = f"  base={common_base}" if common_base else ""
    print(f"    {target['slot']:12s}{inf_label:12s} median {result['median']:>5}c  "
          f"[{total} listings]{base_label}  {mod_summary}")
    return result


def fetch_base_price(base_type: str, slot: str, league: str,
                     session: requests.Session, rates: dict,
                     fractured_stat_id: str | None = None,
                     fractured_min_value: int | None = None) -> float | None:
    """
    Fetch the going rate for a crafting blank of this base type.

    Two modes:
      - Plain base (fractured_stat_id=None): iLvl 85+ normal-rarity base, the
        cheapest crafting blank for chaos/essence/fossil spam.
      - Fractured base (fractured_stat_id set): iLvl 85+ rare-rarity item with
        the fracture filter enabled and a stat filter matching the locked mod.
        This is more expensive but is what the craft actually starts from when
        the build uses a fractured base.

    Returns median chaos price, or None if unavailable / too few listings.
    """
    frac_suffix = f"_frac_{fractured_stat_id.split('.')[-1]}" if fractured_stat_id else ""
    cache_key = f"base_{re.sub(r'[^\w]', '_', base_type).lower()}_ilvl85{frac_suffix}"
    cache_path = os.path.join(PRICE_CACHE_DIR, f"trade_{cache_key}.json")

    if _cache_is_fresh(cache_path):
        with open(cache_path, encoding="utf-8") as f:
            cached = json.load(f)
        return cached.get("median")

    category = CATEGORY_MAP.get(slot)
    if not category:
        return None

    if fractured_stat_id:
        # Fractured base: rare rarity + fractured misc filter + stat filter
        # on the fractured mod to match what the build actually starts from.
        type_filters: dict = {
            "rarity":   {"option": "rare"},
            "category": {"option": category},
            "ilvl":     {"min": 85},
        }
        stat_filter: dict = {"id": fractured_stat_id}
        if fractured_min_value is not None:
            stat_filter["value"] = {"min": fractured_min_value}
        payload = {
            "query": {
                "status":  {"option": "online"},
                "type":    base_type,
                "filters": {
                    "type_filters": {"filters": type_filters},
                    "misc_filters": {"filters": {"fractured_item": {"option": True}}},
                },
                "stats": [{"type": "and", "filters": [stat_filter]}],
            },
            "sort": {"price": "asc"},
        }
    else:
        payload = {
            "query": {
                "status": {"option": "online"},
                "type":   base_type,
                "filters": {
                    "type_filters": {
                        "filters": {
                            "rarity":   {"option": "normal"},
                            "category": {"option": category},
                            "ilvl":     {"min": 85},
                        }
                    }
                }
            },
            "sort": {"price": "asc"},
        }

    time.sleep(SEARCH_DELAY)
    data = None
    for attempt in range(3):
        try:
            resp = session.post(f"{GGG_TRADE_BASE}/search/{league}", json=payload, timeout=15)
            if resp.status_code in (429, 403):
                wait = max(
                    int(resp.headers.get("Retry-After", RATE_LIMIT_COOLDOWN)),
                    RATE_LIMIT_COOLDOWN,
                )
                kind = "Forbidden (temp ban)" if resp.status_code == 403 else "Rate limited"
                print(f"    {kind} (base price) — cooling down {wait}s (attempt {attempt + 1}/3)")
                time.sleep(wait)
                continue
            resp.raise_for_status()
            data = resp.json()
            break
        except Exception as e:
            print(f"    Base price search failed ({base_type}): {e}")
            return None
    if data is None:
        print(f"    Base price search gave up after 3 rate-limit retries ({base_type})")
        return None

    result_ids = data.get("result", [])
    search_id  = data.get("id", "")
    if not result_ids:
        return None

    fetch_ids = result_ids[:LISTINGS_PER_QUERY]
    time.sleep(FETCH_DELAY)
    try:
        resp = session.get(
            f"{GGG_TRADE_BASE}/fetch/{','.join(fetch_ids)}",
            params={"query": search_id},
            timeout=15,
        )
        resp.raise_for_status()
        listings = resp.json().get("result", [])
    except Exception as e:
        print(f"    Base price fetch failed ({base_type}): {e}")
        return None

    prices = sorted(filter(None, (
        price_to_chaos(item.get("listing", {}).get("price", {}), rates)
        for item in listings
    )))
    if len(prices) < MIN_BASE_SAMPLES:
        print(f"    Base '{base_type}': only {len(prices)} listing(s) — skipping (need {MIN_BASE_SAMPLES})")
        return None

    med = round(median(prices), 1)
    cached_result = {"base_type": base_type, "median": med, "sampled": len(prices),
                     "prices_chaos": prices}
    os.makedirs(PRICE_CACHE_DIR, exist_ok=True)
    with open(cache_path, "w", encoding="utf-8") as f:
        json.dump(cached_result, f)

    print(f"    Base '{base_type}': {med}c median ({len(prices)} sampled, {len(result_ids)} listings)")
    return med

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run",     action="store_true",
                        help="Show targets without fetching any prices")
    parser.add_argument("--rebuild-map", action="store_true",
                        help="Force-refresh the cached stat ID map from trade API")
    parser.add_argument("--by-skill", action="store_true",
                        help="Use cross-ascendancy builds_by_skill (fewer, larger-sample targets)")
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

    builds_key = "builds_by_skill" if args.by_skill else "builds"
    print(f"\nBuilding trade targets from {builds_key}...")
    targets = build_targets(build_items, items_db, stat_map, builds_key=builds_key)

    if args.dry_run:
        print("\n--- Targets (dry run) ---")
        for t in targets:
            inf_label = f" [{t['influence']}]" if t.get("influence") else ""
            frac_label = (
                f" [FRAC:{t['fractured_group']} {t.get('fractured_freq_pct', 0):.0f}%]"
                if t.get("fractured_group") else ""
            )
            mods = ", ".join(
                f"{m['group']} >=T{m['tier_floor']} (min {m['min_value']})"
                + (f" [{m['influence']}]" if m.get("influence") else "")
                for m in t["required_mods"]
            )
            print(f"  {t['build']:40s} {t['slot']:12s}{inf_label:12s}{frac_label} | {mods}")
        return

    print(f"\nFetching prices for {len(targets)} targets...")
    output_targets = []
    for i, target in enumerate(targets, 1):
        print(f"  [{i:2d}/{len(targets)}] {target['build']} / {target['slot']}")
        price_data = fetch_target_prices(target, LEAGUE, session, rates)

        # Base item cost: use common_base from sampled listings when available,
        # falling back to build_items.json scrape data.
        common_base = None
        base_cost_chaos = None
        if price_data and price_data.get("common_base"):
            common_base = price_data["common_base"]
        else:
            # Look up the base type from the build scrape data as fallback
            build_data = next(
                (b for b in build_items["builds"]
                 if f"{b['char_class']} / {b['primary_skill']}" == target["build"]),
                None,
            )
            if build_data:
                slot_info = build_data.get("slots", {}).get(target["slot"], {})
                common_base = slot_info.get("common_base")

        is_fractured_base = False
        if common_base:
            use_fractured = bool(target.get("fractured_stat_id"))
            label = "fractured base" if use_fractured else "base"
            print(f"    Fetching {label} price: {common_base}")
            base_cost_chaos = fetch_base_price(
                common_base, target["slot"], LEAGUE, session, rates,
                fractured_stat_id=target.get("fractured_stat_id") if use_fractured else None,
                fractured_min_value=target.get("fractured_min_value") if use_fractured else None,
            )
            if use_fractured and base_cost_chaos is None:
                # Fractured query returned too few listings — fall back to the
                # plain base price so the profit calc still has a cost floor.
                print(f"    Fractured base had no listings, falling back to plain base")
                base_cost_chaos = fetch_base_price(
                    common_base, target["slot"], LEAGUE, session, rates,
                )
            else:
                is_fractured_base = use_fractured

        output_targets.append({
            **target,
            "price_data":       price_data,
            "common_base":      common_base,
            "base_cost_chaos":  base_cost_chaos,
            "is_fractured_base": is_fractured_base,
        })

    output = {
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "league":     LEAGUE,
        "targets":    output_targets,
    }

    os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    priced = sum(1 for t in output_targets if t.get("price_data"))
    print(f"\nDone. {priced}/{len(targets)} targets priced -> {OUTPUT_FILE}")
    if priced < len(targets):
        print("  Unpriced targets likely have very strict mod requirements — "
              "consider lowering MIN_FREQ_PCT or MIN_SLOT_SAMPLES.")


if __name__ == "__main__":
    main()
