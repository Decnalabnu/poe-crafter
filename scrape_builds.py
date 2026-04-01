"""
Build analyzer: fetches top ladder characters from the GGG public API,
extracts rare item mods per slot, and outputs frequency statistics grouped
by build archetype (ascendancy class + primary skill) to build_items.json.

Output structure:
  {league, analyzed_at, characters_sampled,
   builds: [{char_class, primary_skill, count, play_pct, slots: {...}}]}

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
PAGE_SIZE = 200             # GGG hard cap per request
MAX_LADDER_PAGES = 10       # pages to paginate (up to 2000 ladder entries total)
TARGET_PUBLIC_CHARS = 200   # stop early once we have this many public characters fetched
REQUEST_DELAY = 6.0         # seconds between character item fetches
BATCH_SIZE = 40             # fetch this many characters, then pause
BATCH_PAUSE = 45.0          # seconds to pause between batches
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
    but items.json templates don't include it. We try raw text first, then strip '+'.
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


def fetch_ladder(league: str, session: requests.Session) -> list:
    """
    Paginates the GGG ladder API (200 entries per page) up to MAX_LADDER_PAGES.
    Each page is cached independently so re-runs don't re-fetch already-seen pages.
    Returns the combined list of all ladder entries.
    """
    all_entries = []
    for page in range(MAX_LADDER_PAGES):
        offset = page * PAGE_SIZE
        cache_key = f"ladder_{league}_{PAGE_SIZE}_{offset}"
        cached = _load_cache(cache_key)
        if cached is not None:
            print(f"  [cache] ladder page {page + 1} ({len(cached)} entries)")
            all_entries.extend(cached)
            if len(cached) < PAGE_SIZE:
                break  # last page was short — no more data
            continue

        print(f"  Fetching ladder page {page + 1} (offset={offset})...")
        try:
            resp = session.get(
                GGG_LADDER_URL.format(league=league),
                params={"limit": PAGE_SIZE, "offset": offset},
                timeout=20,
            )
            resp.raise_for_status()
            entries = resp.json().get("entries", [])
        except Exception as e:
            print(f"  Warning: ladder page {page + 1} failed: {e}")
            break

        _save_cache(cache_key, entries)
        print(f"  Got {len(entries)} entries")
        all_entries.extend(entries)
        if len(entries) < PAGE_SIZE:
            break  # reached end of ladder

    print(f"  Total ladder entries: {len(all_entries)}")
    return all_entries


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
# Primary skill extraction
# ---------------------------------------------------------------------------

def extract_primary_skill(items: list) -> str:
    """
    Find the primary active skill by locating the most-linked non-Support gem.
    Falls back to "Unknown" if no skill gems are found.
    """
    best_gem = "Unknown"
    best_links = 0

    for item in items:
        socketed = item.get("socketedItems", [])
        if not socketed:
            continue
        sockets = item.get("sockets", [])
        if not sockets:
            continue

        # Count sockets per group to find the max link count in this item
        group_counts: dict[int, int] = {}
        for sock in sockets:
            g = sock.get("group", 0)
            group_counts[g] = group_counts.get(g, 0) + 1
        max_links = max(group_counts.values(), default=0)

        if max_links < best_links:
            continue

        # Pick the first active (non-Support) skill gem
        for gem in socketed:
            type_line = gem.get("typeLine", "") or gem.get("baseType", "")
            if not type_line or "Support" in type_line:
                continue
            best_links = max_links
            best_gem = type_line
            break

    return best_gem


# ---------------------------------------------------------------------------
# Scrape
# ---------------------------------------------------------------------------

def scrape(league: str, session: requests.Session) -> dict:
    """
    Fetches ladder pages then character items until TARGET_PUBLIC_CHARS fetched.
    Returns raw: {account/char: {"items": [...], "char_class": "..."}}
    """
    entries = fetch_ladder(league, session)
    public_entries = [e for e in entries if e.get("public")]
    print(f"  {len(public_entries)} public characters out of {len(entries)}")

    raw = {}
    fetched = 0  # counts actual network requests made this run (cached don't count)
    for i, entry in enumerate(public_entries, 1):
        if len(raw) >= TARGET_PUBLIC_CHARS:
            print(f"  Reached TARGET_PUBLIC_CHARS={TARGET_PUBLIC_CHARS}, stopping early")
            break
        acct = entry["account"]["name"]
        char = entry["character"]["name"]
        char_class = entry["character"].get("class", "Unknown")
        key = f"{acct}/{char}"

        # Skip if already cached — no network request needed
        already_cached = _load_cache(f"items_{acct}_{char}") is not None
        print(f"  [{i}/{len(public_entries)}] {char_class}: {char} ({acct}){' [cached]' if already_cached else ''}")

        items = fetch_character_items(acct, char, session)
        if items:
            raw[key] = {"items": items, "char_class": char_class}

        if not already_cached:
            fetched += 1
            if fetched % BATCH_SIZE == 0:
                print(f"  --- Batch pause {BATCH_PAUSE}s to avoid rate limiting ---")
                time.sleep(BATCH_PAUSE)

    return raw


# ---------------------------------------------------------------------------
# Analyze
# ---------------------------------------------------------------------------

def _aggregate_slots(chars_items: list, pattern_index: list) -> dict:
    """
    Aggregates mod frequency per slot across a list of character item lists.
    Returns {slot_tag: {sample_count, mod_frequency}} filtered by MIN_FREQUENCY_PCT.
    """
    slot_mod_tiers: dict[str, dict[str, list]] = defaultdict(lambda: defaultdict(list))
    slot_sample_counts: dict[str, int] = defaultdict(int)

    for items in chars_items:
        seen_slots: set[str] = set()
        for item in items:
            inv_id = item.get("inventoryId", "")
            item_tag = SLOT_MAP.get(inv_id)
            if item_tag is None:
                continue
            if item.get("frameType") != FRAME_TYPE_RARE:
                continue

            slot_key = inv_id  # Ring vs Ring2 counted separately
            if slot_key not in seen_slots:
                slot_sample_counts[item_tag] += 1
                seen_slots.add(slot_key)

            all_mods = (
                item.get("explicitMods", [])
                + item.get("fracturedMods", [])
                + item.get("craftedMods", [])
            )
            for mod_text in all_mods:
                match = match_mod_text(mod_text, pattern_index, item_tag)
                if match:
                    slot_mod_tiers[item_tag][match["group"]].append(match["tier"])

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
        if mod_freq:
            slots_out[item_tag] = {"sample_count": sample_n, "mod_frequency": mod_freq}

    return slots_out


def analyze(raw: dict, pattern_index: list) -> list:
    """
    Groups characters by (char_class, primary_skill) build archetype.
    Returns list of build dicts sorted by play_pct descending.
    """
    total_chars = len(raw)

    # Group characters by build archetype
    build_groups: dict[tuple, list] = defaultdict(list)
    build_meta: dict[tuple, dict] = {}

    for char_key, char_data in raw.items():
        items = char_data["items"]
        char_class = char_data["char_class"]
        primary_skill = extract_primary_skill(items)
        key = (char_class, primary_skill)
        build_groups[key].append(items)
        build_meta[key] = {"char_class": char_class, "primary_skill": primary_skill}

    builds_out = []
    for key, chars_items in sorted(build_groups.items(), key=lambda x: -len(x[1])):
        meta = build_meta[key]
        count = len(chars_items)
        play_pct = round(count / total_chars * 100, 1) if total_chars > 0 else 0

        slots_out = _aggregate_slots(chars_items, pattern_index)

        builds_out.append({
            "char_class": meta["char_class"],
            "primary_skill": meta["primary_skill"],
            "count": count,
            "play_pct": play_pct,
            "slots": slots_out,
        })

    return builds_out


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
        # Re-build raw from the ladder cache, looking up each character's item
        # cache by the same key used to write it — avoids brittle filename parsing.
        print("Loading from cache...")
        ladder_entries = []
        for page in range(MAX_LADDER_PAGES):
            offset = page * PAGE_SIZE
            page_data = _load_cache(f"ladder_{LEAGUE}_{PAGE_SIZE}_{offset}")
            if page_data is None:
                break
            ladder_entries.extend(page_data)
            if len(page_data) < PAGE_SIZE:
                break
        print(f"  {len(ladder_entries)} ladder entries loaded from cache")
        raw = {}
        for entry in ladder_entries:
            acct = entry.get("account", {}).get("name", "")
            char = entry.get("character", {}).get("name", "")
            char_class = entry.get("character", {}).get("class", "Unknown")
            if not acct or not char:
                continue
            items = _load_cache(f"items_{acct}_{char}")
            if items:
                raw[f"{acct}/{char}"] = {"items": items, "char_class": char_class}
        print(f"  {len(raw)} cached characters found")
    else:
        print("Scraping ladder + character items...")
        raw = scrape(LEAGUE, session)
        print(f"  Collected items for {len(raw)} characters")

    print("Analyzing mod frequencies by build archetype...")
    builds_out = analyze(raw, pattern_index)

    output = {
        "league": LEAGUE,
        "analyzed_at": datetime.now(timezone.utc).isoformat(),
        "characters_sampled": len(raw),
        "builds": builds_out,
    }

    os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print(f"\nDone. Output: {OUTPUT_FILE}")
    for build in builds_out[:8]:
        print(f"  {build['char_class']} / {build['primary_skill']}: {build['count']} chars ({build['play_pct']}%)")


if __name__ == "__main__":
    main()
