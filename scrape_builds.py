"""
Build analyzer: fetches top ladder characters from the GGG public API,
extracts rare item mods per slot, and outputs frequency statistics to
src/data/build_items.json.

Rate limiting: REQUEST_DELAY seconds between character item fetches.
All raw responses are cached to data/build_cache/ so re-runs are free.

Usage:
    python3 scrape_builds.py              # scrape + analyze
    python3 scrape_builds.py --analyze    # re-analyze from cache only
"""

import argparse
import json
import os
import re
import time
from collections import defaultdict
from datetime import datetime, timezone

import requests

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
LEAGUE = json.load(open("src/data/active_economy.json")).get("league", "Mirage")
LADDER_LIMIT = 200          # max entries to pull from the ladder (GGG cap = 200)
REQUEST_DELAY = 3.0         # seconds between character item fetches
MIN_FREQUENCY_PCT = 0.15    # mod must appear in ≥15% of sampled items to be reported
CACHE_DIR = "data/build_cache"
OUTPUT_FILE = "src/data/build_items.json"
ITEMS_DB_FILE = "src/data/items.json"

# GGG item slot → our item class tag
SLOT_MAP = {
    "Ring":        "ring",
    "Ring2":       "ring",
    "Amulet":      "amulet",
    "Belt":        "belt",
    "BodyArmour":  "body_armour",
    "Helm":        "helmet",
    "Gloves":      "gloves",
    "Boots":       "boots",
}

FRAME_TYPE_RARE = 2

GGG_LADDER_URL = "https://api.pathofexile.com/ladders/{league}"
GGG_ITEMS_URL  = "https://www.pathofexile.com/character-window/get-items"

HEADERS = {"User-Agent": "poe-crafter-build-analyzer/1.0 (personal research tool)"}


# ---------------------------------------------------------------------------
# Mod pattern index
# ---------------------------------------------------------------------------

def _text_to_pattern(text: str) -> str:
    """
    Convert an items.json mod text to a regex pattern that matches any rolled value.

    The GGG API returns mods as single rolled values, e.g.:
      "+114 to maximum Life"
    items.json stores templates with ranges, e.g.:
      "+(80-99) to maximum Life [Athlete]"

    Both numeric literals and range expressions are normalised to r"\d+".
    """
    # Strip bracket suffix like " [Athlete]"
    text = re.sub(r"\s*\[[^\]]+\]$", "", text).strip()
    # Replace range expressions "(X-Y)" with a placeholder before escaping
    text = re.sub(r"\(\d+[-–]\d+\)", "NUM", text)
    # Replace any remaining bare numbers
    text = re.sub(r"\b\d+\b", "NUM", text)
    # Now escape regex metacharacters in the cleaned template
    escaped = re.escape(text)
    # Restore placeholder as a digit matcher
    escaped = escaped.replace("NUM", r"\d+")
    return escaped


def build_mod_pattern_index(items_db: dict) -> list:
    """
    Returns a list of (compiled_regex, {group, tier, id, item_tag, is_prefix})
    sorted longest-pattern-first so more specific patterns match before general ones.

    Note: the same text template may appear for multiple item classes (e.g. Maximum Life
    on rings and helmets). Each (item_tag, pattern) pair gets its own entry so that
    match_mod_text can filter by item_tag correctly.
    """
    entries = []
    seen: set[tuple[str, str]] = set()  # (item_tag, full_pattern)

    for item_tag, pools in items_db.items():
        for is_prefix, mods in [(True, pools["prefixes"]), (False, pools["suffixes"])]:
            for mod in mods:
                text = mod.get("text", "")
                if not text:
                    continue
                pattern_str = _text_to_pattern(text)
                full_pattern = r"^" + pattern_str + r"$"
                key = (item_tag, full_pattern)
                if key in seen:
                    continue
                seen.add(key)
                try:
                    compiled = re.compile(full_pattern, re.IGNORECASE)
                except re.error:
                    continue
                entries.append((compiled, {
                    "group": mod["group"],
                    "tier": mod.get("tier"),
                    "id": mod["id"],
                    "item_tag": item_tag,
                    "is_prefix": is_prefix,
                }))

    # Longer patterns are more specific — sort descending by pattern length
    entries.sort(key=lambda e: -len(e[0].pattern))
    return entries


def match_mod_text(mod_text: str, pattern_index: list, item_tag: str) -> dict | None:
    """
    Try to match a single mod string against the pattern index for a given slot.

    The GGG client adds a leading '+' to flat stat mods (e.g. '+47% to Fire Resistance')
    but items.json templates don't include it (e.g. '(18-23)% to Fire Resistance').
    We try the raw text first, then strip a leading '+' as a fallback.
    """
    candidates = [mod_text.strip()]
    if mod_text.startswith("+"):
        candidates.append(mod_text[1:].strip())

    for compiled, info in pattern_index:
        if info["item_tag"] != item_tag:
            continue
        for text in candidates:
            if compiled.match(text):
                return info
    return None


# ---------------------------------------------------------------------------
# GGG API helpers (with disk cache)
# ---------------------------------------------------------------------------

def _cache_path(key: str) -> str:
    safe = re.sub(r"[^\w\-]", "_", key)
    return os.path.join(CACHE_DIR, safe + ".json")


def _load_cache(key: str):
    path = _cache_path(key)
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return None


def _save_cache(key: str, data):
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(_cache_path(key), "w", encoding="utf-8") as f:
        json.dump(data, f)


def fetch_ladder(league: str, limit: int, session: requests.Session) -> list:
    cache_key = f"ladder_{league}_{limit}"
    cached = _load_cache(cache_key)
    if cached is not None:
        print(f"  [cache] ladder ({len(cached)} entries)")
        return cached

    print(f"  Fetching top {limit} ladder entries for {league}...")
    resp = session.get(
        GGG_LADDER_URL.format(league=league),
        params={"limit": limit},
        timeout=20,
    )
    resp.raise_for_status()
    entries = resp.json().get("entries", [])
    _save_cache(cache_key, entries)
    print(f"  Got {len(entries)} entries")
    return entries


def fetch_character_items(account: str, char: str, session: requests.Session) -> list:
    cache_key = f"items_{account}_{char}"
    cached = _load_cache(cache_key)
    if cached is not None:
        return cached

    delay = REQUEST_DELAY
    for attempt in range(3):
        time.sleep(delay)
        try:
            resp = session.get(
                GGG_ITEMS_URL,
                params={"accountName": account, "character": char},
                timeout=15,
            )
            if resp.status_code == 403:
                # Private profile — cache empty list so we don't retry
                _save_cache(cache_key, [])
                return []
            if resp.status_code == 429:
                retry_after = int(resp.headers.get("Retry-After", 60))
                print(f"    Rate limited — waiting {retry_after}s before retry {attempt + 1}/3")
                time.sleep(retry_after)
                delay *= 2
                continue
            resp.raise_for_status()
            items = resp.json().get("items", [])
            _save_cache(cache_key, items)
            return items
        except Exception as e:
            print(f"    Warning: failed to fetch {char}: {e}")
            return []
    print(f"    Giving up on {char} after 3 attempts")
    return []


# ---------------------------------------------------------------------------
# Scrape
# ---------------------------------------------------------------------------

def scrape(league: str, session: requests.Session) -> dict:
    """
    Fetches ladder + character items.
    Returns raw: {account_char_key: [item, ...], ...}
    """
    entries = fetch_ladder(league, LADDER_LIMIT, session)
    public_entries = [e for e in entries if e.get("public")]
    print(f"  {len(public_entries)} public characters out of {len(entries)}")

    raw = {}
    for i, entry in enumerate(public_entries, 1):
        acct = entry["account"]["name"]
        char = entry["character"]["name"]
        char_class = entry["character"].get("class", "Unknown")
        key = f"{acct}/{char}"
        print(f"  [{i}/{len(public_entries)}] {char_class}: {char} ({acct})")
        items = fetch_character_items(acct, char, session)
        if items:
            raw[key] = items

    return raw


# ---------------------------------------------------------------------------
# Analyze
# ---------------------------------------------------------------------------

def analyze(raw: dict, pattern_index: list) -> dict:
    """
    Aggregates mod frequency per slot across all sampled characters.
    Returns the build_items.json structure.
    """
    # slot_tag → {group → [tier_or_None, ...]}
    slot_mod_tiers: dict[str, dict[str, list]] = defaultdict(lambda: defaultdict(list))
    slot_sample_counts: dict[str, int] = defaultdict(int)

    for char_key, items in raw.items():
        seen_slots_this_char: set[str] = set()
        for item in items:
            inv_id = item.get("inventoryId", "")
            item_tag = SLOT_MAP.get(inv_id)
            if item_tag is None:
                continue
            if item.get("frameType") != FRAME_TYPE_RARE:
                continue

            # Count each slot once per character (Ring appears twice, count both)
            slot_key = inv_id  # use inventoryId (Ring vs Ring2) to count separately
            if slot_key not in seen_slots_this_char:
                slot_sample_counts[item_tag] += 1
                seen_slots_this_char.add(slot_key)

            all_mods = (
                item.get("explicitMods", [])
                + item.get("fracturedMods", [])
                + item.get("craftedMods", [])
            )
            for mod_text in all_mods:
                match = match_mod_text(mod_text, pattern_index, item_tag)
                if match:
                    slot_mod_tiers[item_tag][match["group"]].append(match["tier"])

    # Build output per slot
    slots_out = {}
    for item_tag, group_tiers in slot_mod_tiers.items():
        sample_n = slot_sample_counts[item_tag]
        if sample_n == 0:
            continue

        mod_freq = {}
        for group, tiers in sorted(group_tiers.items(), key=lambda x: -len(x[1])):
            count = len(tiers)
            pct = count / sample_n
            if pct < MIN_FREQUENCY_PCT:
                continue
            valid_tiers = [t for t in tiers if t is not None]
            mod_freq[group] = {
                "count": count,
                "frequency_pct": round(pct * 100, 1),
                "min_tier_seen": min(valid_tiers) if valid_tiers else None,
                "avg_tier": round(sum(valid_tiers) / len(valid_tiers), 1) if valid_tiers else None,
            }

        slots_out[item_tag] = {
            "sample_count": sample_n,
            "mod_frequency": mod_freq,
        }

    return slots_out


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--analyze", action="store_true", help="Re-analyze from cache only, skip network fetch")
    args = parser.parse_args()

    print(f"=== PoE Build Analyzer (league: {LEAGUE}) ===")

    print("Building mod pattern index from items.json...")
    items_db = json.load(open(ITEMS_DB_FILE, encoding="utf-8"))
    pattern_index = build_mod_pattern_index(items_db)
    print(f"  {len(pattern_index)} patterns built")

    session = requests.Session()
    session.headers.update(HEADERS)

    if args.analyze:
        # Load existing cached item data
        print("Loading from cache...")
        raw = {}
        if os.path.exists(CACHE_DIR):
            for fname in os.listdir(CACHE_DIR):
                if fname.startswith("items_") and fname.endswith(".json"):
                    with open(os.path.join(CACHE_DIR, fname), encoding="utf-8") as f:
                        items = json.load(f)
                    if items:
                        key = fname[len("items_"):-len(".json")].replace("_", "/", 1)
                        raw[key] = items
        print(f"  {len(raw)} cached characters found")
    else:
        print("Scraping ladder + character items...")
        raw = scrape(LEAGUE, session)
        print(f"  Collected items for {len(raw)} characters")

    print("Analyzing mod frequencies...")
    slots_out = analyze(raw, pattern_index)

    output = {
        "league": LEAGUE,
        "analyzed_at": datetime.now(timezone.utc).isoformat(),
        "characters_sampled": len(raw),
        "slots": slots_out,
    }

    os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print(f"\nDone. Output: {OUTPUT_FILE}")
    for slot, data in slots_out.items():
        top = list(data["mod_frequency"].items())[:3]
        top_str = ", ".join(f"{g} ({v['frequency_pct']}%)" for g, v in top)
        print(f"  {slot} (n={data['sample_count']}): {top_str}")


if __name__ == "__main__":
    main()
