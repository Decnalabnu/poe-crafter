"""
Gem XP profit fetcher: queries the GGG trade API for uncorrupted gem prices
at their starting (level 1) and max-level uncorrupted state.

For each gem we price:
  - level 1, any quality, uncorrupted  -> "buy price"
  - level MAX, any quality, uncorrupted -> "sell price"

Max level depends on gem type:
  - Exceptional (Enlighten/Empower/Enhance Support): 3
  - Awakened support gems:                           5
  - All other skill/support gems:                    20

Quality-agnostic by design: we take the cheapest uncorrupted listing at each
level, regardless of quality, because quality is obtained separately via
Gemcutter's Prisms and distorts the raw XP-leveling profit signal.

Outputs src/data/gem_prices.json. Per-gem results cached in data/gem_cache/.

Usage:
    python3 src/utils/fetch_gem_prices.py              # fetch fresh prices
    python3 src/utils/fetch_gem_prices.py --dry-run    # print gem list and exit
    python3 src/utils/fetch_gem_prices.py --limit N    # price only first N gems
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
OUTPUT_FILE = "src/data/gem_prices.json"
GEM_CACHE_DIR = "data/gem_cache"

LISTINGS_PER_QUERY = 10
MIN_SAMPLES = 1             # need at least this many listings to trust a price
CACHE_TTL_HOURS = 4

SEARCH_DELAY = 8.0
FETCH_DELAY  = 4.0
RATE_LIMIT_COOLDOWN = 120

GGG_TRADE_BASE = "https://www.pathofexile.com/api/trade"
HEADERS = {"User-Agent": "poe-crafter-gem-price-fetcher/1.0 (personal research tool)"}

EXCEPTIONAL_GEMS = {"Enlighten Support", "Empower Support", "Enhance Support"}


class RateLimitAbort(Exception):
    """Raised when GGG temp-bans the session; caller should stop and save progress."""
    def __init__(self, wait_seconds: int, kind: str):
        super().__init__(f"{kind} — stop for at least {wait_seconds}s before retrying")
        self.wait_seconds = wait_seconds
        self.kind = kind

# ---------------------------------------------------------------------------
# Gem enumeration
# ---------------------------------------------------------------------------

def fetch_gem_catalog(session: requests.Session) -> list[dict]:
    """
    Returns a list of {name, max_level} for every tradeable gem.

    Source: GGG trade /data/items, filtered to categories whose label
    contains 'Gem'. This covers Skill Gems, Support Gems, Awakened Support
    Gems, and any Exceptional categorization GGG has added.
    """
    resp = session.get(f"{GGG_TRADE_BASE}/data/items", timeout=15)
    resp.raise_for_status()
    data = resp.json()

    gems: list[dict] = []
    for category in data.get("result", []):
        label = category.get("label", "")
        if "Gem" not in label:
            continue
        is_awakened = "Awakened" in label
        for entry in category.get("entries", []):
            name = entry.get("type") or entry.get("name")
            if not name:
                continue
            # Skip Vaal and alternate-quality gems: their uncorrupted max
            # price isn't meaningful (Vaal skills must be corrupted to use
            # their Vaal variant; alt-quality gems are corrupted-only).
            if name.startswith("Vaal "):
                continue
            if "Anomalous " in name or "Divergent " in name or "Phantasmal " in name:
                continue

            if name in EXCEPTIONAL_GEMS:
                max_level = 3
            elif is_awakened or name.startswith("Awakened "):
                max_level = 5
            else:
                max_level = 20

            gems.append({"name": name, "max_level": max_level, "category": label})

    # Deduplicate by name (a gem may appear under multiple labels)
    seen: set[str] = set()
    unique: list[dict] = []
    for g in gems:
        if g["name"] in seen:
            continue
        seen.add(g["name"])
        unique.append(g)

    return unique

# ---------------------------------------------------------------------------
# Pricing
# ---------------------------------------------------------------------------

def load_currency_rates(economy: dict) -> dict[str, float]:
    divine = economy.get("divine_price", 150.0)
    exalted = economy.get("exalted_price") or (divine / 6.0)  # rough fallback
    mirror = economy.get("mirror_price") or (divine * 400.0)
    return {
        "chaos":    1.0,
        "divine":   divine,
        "exalted":  exalted,
        "exa":      exalted,
        "mirror":   mirror,
        "mir":      mirror,
        "mirror-shard": mirror / 20.0,
    }


_unknown_currencies: dict[str, int] = {}


def price_to_chaos(price: dict, rates: dict) -> float | None:
    currency = price.get("currency", "")
    amount = price.get("amount", 0)
    rate = rates.get(currency)
    if rate is None:
        if currency:
            _unknown_currencies[currency] = _unknown_currencies.get(currency, 0) + 1
        return None
    if amount <= 0:
        return None
    return round(amount * rate, 2)


def _cache_path(gem_name: str, level: int) -> str:
    safe = re.sub(r"[^\w]", "_", gem_name).lower()
    return os.path.join(GEM_CACHE_DIR, f"gem_{safe}_lvl{level}.json")


def _cache_is_fresh(path: str) -> bool:
    if not os.path.exists(path):
        return False
    return (time.time() - os.path.getmtime(path)) / 3600 < CACHE_TTL_HOURS


def fetch_gem_price(gem_name: str, level: int, league: str,
                    session: requests.Session, rates: dict) -> dict | None:
    """
    Query cheapest uncorrupted listings of a gem at the given exact level,
    quality-agnostic. Returns {median, p10, samples, total_listings} or None.
    """
    cache_path = _cache_path(gem_name, level)
    if _cache_is_fresh(cache_path):
        with open(cache_path, encoding="utf-8") as f:
            return json.load(f)

    payload = {
        "query": {
            "status": {"option": "online"},
            "type":   gem_name,
            "filters": {
                "misc_filters": {
                    "filters": {
                        "gem_level": {"min": level, "max": level},
                        "corrupted": {"option": "false"},
                    }
                }
            },
        },
        "sort": {"price": "asc"},
    }

    time.sleep(SEARCH_DELAY)
    data = None
    for attempt in range(2):
        try:
            resp = session.post(f"{GGG_TRADE_BASE}/search/{league}", json=payload, timeout=15)
            if resp.status_code == 403:
                # Temp ban — further requests will extend it. Abort the run.
                wait = max(int(resp.headers.get("Retry-After", 1800)), 1800)
                raise RateLimitAbort(wait, "Forbidden (temp ban)")
            if resp.status_code == 429:
                wait = max(int(resp.headers.get("Retry-After", RATE_LIMIT_COOLDOWN)),
                           RATE_LIMIT_COOLDOWN)
                if attempt == 0:
                    print(f"    Rate limited — cooling down {wait}s, will retry once")
                    time.sleep(wait)
                    continue
                # Second 429 in a row: server is serious, stop the run.
                raise RateLimitAbort(wait, "Rate limited (persistent)")
            resp.raise_for_status()
            data = resp.json()
            break
        except RateLimitAbort:
            raise
        except Exception as e:
            print(f"    Search error ({gem_name} lvl {level}): {e}")
            return None
    if data is None:
        return None

    result_ids = data.get("result", [])
    search_id  = data.get("id", "")
    total      = len(result_ids)
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
        if resp.status_code == 403:
            wait = max(int(resp.headers.get("Retry-After", 1800)), 1800)
            raise RateLimitAbort(wait, "Forbidden (temp ban)")
        if resp.status_code == 429:
            wait = max(int(resp.headers.get("Retry-After", RATE_LIMIT_COOLDOWN)),
                       RATE_LIMIT_COOLDOWN)
            raise RateLimitAbort(wait, "Rate limited on fetch")
        resp.raise_for_status()
        listings = resp.json().get("result", [])
    except RateLimitAbort:
        raise
    except Exception as e:
        print(f"    Fetch failed ({gem_name} lvl {level}): {e}")
        return None

    prices = sorted(filter(None, (
        price_to_chaos(item.get("listing", {}).get("price", {}), rates)
        for item in listings
    )))
    if len(prices) < MIN_SAMPLES:
        return None

    result = {
        "gem":            gem_name,
        "level":          level,
        "total_listings": total,
        "samples":        len(prices),
        "prices_chaos":   prices,
        "p10":            round(prices[max(0, len(prices) // 10)], 2),
        "median":         round(median(prices), 2),
    }

    os.makedirs(GEM_CACHE_DIR, exist_ok=True)
    with open(cache_path, "w", encoding="utf-8") as f:
        json.dump(result, f)
    return result

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true",
                        help="Print the gem catalog and exit")
    parser.add_argument("--limit", type=int, default=0,
                        help="Only price the first N gems (useful for testing)")
    args = parser.parse_args()

    print(f"=== PoE Gem XP Price Fetcher (league: {LEAGUE}) ===\n")

    economy = json.load(open("src/data/active_economy.json", encoding="utf-8"))
    rates   = load_currency_rates(economy)
    print(f"  divine rate: {rates['divine']}c\n")

    session = requests.Session()
    session.headers.update(HEADERS)

    print("Fetching gem catalog...")
    gems = fetch_gem_catalog(session)
    print(f"  Found {len(gems)} gems")

    if args.dry_run:
        print("\n--- Gem catalog (dry run) ---")
        for g in gems:
            print(f"  {g['name']:40s} max={g['max_level']:2d}  [{g['category']}]")
        return

    if args.limit > 0:
        gems = gems[:args.limit]
        print(f"  Limited to first {len(gems)} gems")

    # Seed from existing output so an aborted run doesn't wipe prior progress.
    priced_by_name: dict[str, dict] = {}
    if os.path.exists(OUTPUT_FILE):
        try:
            existing = json.load(open(OUTPUT_FILE, encoding="utf-8"))
            for g in existing.get("gems", []):
                priced_by_name[g["name"]] = g
            print(f"  Loaded {len(priced_by_name)} prior-run entries (will refresh)")
        except Exception as e:
            print(f"  Could not read existing output: {e}")

    print(f"\nPricing {len(gems)} gems (level 1 + max-level uncorrupted)...")
    aborted_msg = None
    try:
        for i, gem in enumerate(gems, 1):
            name = gem["name"]
            max_level = gem["max_level"]
            print(f"  [{i:3d}/{len(gems)}] {name} (max lvl {max_level})")

            base = fetch_gem_price(name, 1, LEAGUE, session, rates)
            top  = fetch_gem_price(name, max_level, LEAGUE, session, rates)

            if not base or not top:
                why = []
                if not base: why.append("base lvl 1 has no usable listings")
                if not top:  why.append(f"top lvl {max_level} has no usable listings")
                print(f"    skipped: {'; '.join(why)}")
                continue

            base_price = base["p10"]
            top_price  = top["p10"]
            profit = round(top_price - base_price, 2)
            pct_gain = round((top_price / base_price - 1) * 100, 1) if base_price > 0 else None

            priced_by_name[name] = {
                "name":        name,
                "max_level":   max_level,
                "category":    gem["category"],
                "base_price":  base_price,
                "top_price":   top_price,
                "profit":      profit,
                "pct_gain":    pct_gain,
                "base_samples": base["samples"],
                "top_samples":  top["samples"],
                "base_listings": base["total_listings"],
                "top_listings":  top["total_listings"],
            }
            print(f"    lvl 1: {base_price:>7.2f}c   lvl {max_level}: {top_price:>7.2f}c   "
                  f"profit: {profit:>+8.2f}c  ({pct_gain}%)")
    except RateLimitAbort as e:
        aborted_msg = str(e)
        print(f"\n!!! Aborting: {e}")
        print(f"    Saving {len(priced_by_name)} entries so far. "
              f"Wait ~{e.wait_seconds//60} min before retrying.")
    except KeyboardInterrupt:
        aborted_msg = "interrupted by user"
        print(f"\n!!! Interrupted. Saving {len(priced_by_name)} entries so far.")

    priced = sorted(priced_by_name.values(), key=lambda g: -g["profit"])

    output = {
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "league":     LEAGUE,
        "divine_price": rates["divine"],
        "gems":       priced,
    }
    if aborted_msg:
        output["aborted"] = aborted_msg
    os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print(f"\nDone. {len(priced)} gems in output -> {OUTPUT_FILE}")

    if _unknown_currencies:
        print("\nUnknown currencies encountered (listings dropped):")
        for c, n in sorted(_unknown_currencies.items(), key=lambda kv: -kv[1]):
            print(f"  {c}: {n}")


if __name__ == "__main__":
    main()
