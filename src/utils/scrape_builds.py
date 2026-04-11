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
MAX_LADDER_PAGES = 75       # GGG ladder hard cap: 15,000 entries total (75 × 200)
TARGET_PUBLIC_CHARS = 2000  # stop early once we have this many public characters fetched
REQUEST_DELAY = 2.5         # seconds between character item fetches (~24 req/min, adaptive backoff handles 429s)
BATCH_SIZE = 40             # fetch this many characters, then pause
BATCH_PAUSE = 20.0          # seconds to pause between batches
CONVERGENCE_MIN_SAMPLES = 150  # top builds need at least this many samples before early-stop is considered
CONVERGENCE_TOP_N = 5          # number of top builds to monitor for stability
CONVERGENCE_CHECK_INTERVAL = 250  # check convergence every N characters collected
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
    items.json stores templates with ranges using various dash characters + spaces, e.g.:
      "+(80-99) to maximum Life [Athlete]"   (hyphen)
      "(3 — 9) to maximum Life [Hale]"       (em-dash with spaces, U+2014)
      "(25–39) to maximum Life"              (en-dash, U+2013)

    Strategy:
      1. Strip [Tag] suffixes.
      2. Collapse entire parenthesised range expressions — including any dash variant
         and surrounding whitespace — into a bare NUM placeholder. The enclosing
         parens are also removed so the pattern matches the bare rolled value.
      3. Strip a leading '+' from the template (GGG client adds/removes it
         inconsistently; match_mod_text tries both forms at match time).
      4. Replace remaining bare integers with NUM.
      5. re.escape then restore NUM → r"\d+".
    """
    # 1. Strip bracket suffix like " [Athlete]"
    text = re.sub(r"\s*\[[^\]]+\]$", "", text).strip()

    # 2. Collapse parenthesised ranges like (3 — 9), (80-99), (25–39) → NUM.
    #    Dash variants: hyphen-minus (-), en-dash (–, U+2013), em-dash (—, U+2014).
    #    Surrounding whitespace inside the parens is optional.
    text = re.sub(r"\(\s*\d+\s*[-\u2013\u2014]\s*\d+\s*\)", "NUM", text)

    # 3. Strip leading '+' so the pattern matches both "+47 to X" and "47 to X".
    #    match_mod_text already tries both forms, but stripping here keeps the
    #    compiled pattern anchored to the bare-value form.
    text = text.lstrip("+")

    # 4. Replace any remaining bare integers (e.g. tier values, flat numbers).
    text = re.sub(r"\b\d+\b", "NUM", text)

    # 5. Escape then restore placeholders.
    escaped = re.escape(text)
    escaped = escaped.replace("NUM", r"\d+")
    return escaped


def build_mod_pattern_index(items_db: dict) -> list:
    """
    Returns a list of (compiled_regex, {group, item_tag, is_prefix})
    deduplicated by (item_tag, pattern_str) — one entry per unique pattern per item class.
    Tier resolution is done separately by build_tier_ranges / resolve_tier.
    Sorted longest-pattern-first so more specific patterns match before general ones.
    """
    entries = []
    seen: set[tuple[str, str]] = set()  # (item_tag, pattern_str)

    for item_tag, pools in items_db.items():
        for is_prefix, mods in [(True, pools["prefixes"]), (False, pools["suffixes"])]:
            for mod in mods:
                text = mod.get("text", "")
                if not text:
                    continue
                pattern_str = _text_to_pattern(text)
                key = (item_tag, pattern_str)
                if key in seen:
                    continue
                seen.add(key)
                full_pattern = r"^" + pattern_str + r"$"
                try:
                    compiled = re.compile(full_pattern, re.IGNORECASE)
                except re.error:
                    continue
                entries.append((compiled, {
                    "group":     mod["group"],
                    "item_tag":  item_tag,
                    "is_prefix": is_prefix,
                }))

    # Longer patterns are more specific — sort descending by pattern length
    entries.sort(key=lambda e: -len(e[0].pattern))
    return entries


def build_tier_ranges(items_db: dict) -> dict:
    """
    Returns {(item_tag, group): [(tier, min_val, max_val), ...]} sorted by min_val desc
    (highest values = lowest tier number = best quality first).

    Used by resolve_tier to determine which tier a GGG API rolled value belongs to.
    """
    ranges: dict[tuple, list] = {}

    for item_tag, pools in items_db.items():
        for mods in (pools["prefixes"], pools["suffixes"]):
            for mod in mods:
                tier = mod.get("tier")
                if tier is None:
                    continue
                text = mod.get("text", "")
                if not text:
                    continue
                # Extract the numeric range from items.json template text.
                # Handles: (3 — 9), (80-99), (25–39), and bare numbers.
                m = re.search(r"\(\s*(\d+)\s*[-\u2013\u2014]\s*(\d+)\s*\)", text)
                if m:
                    min_val, max_val = int(m.group(1)), int(m.group(2))
                else:
                    bare = re.search(r"\b(\d+)\b", text)
                    if not bare:
                        continue
                    min_val = max_val = int(bare.group(1))

                key = (item_tag, mod["group"])
                if key not in ranges:
                    ranges[key] = []
                ranges[key].append((tier, min_val, max_val))

    # Sort each list by min_val descending so T1 (highest values) is checked first
    for key in ranges:
        ranges[key].sort(key=lambda x: -x[1])

    return ranges


def resolve_tier(group: str, item_tag: str, mod_text: str,
                 tier_ranges: dict) -> int | None:
    """
    Given a matched mod group and the GGG API mod text (e.g. '+47 to maximum Life'),
    extract the rolled numeric value and return the corresponding tier from items.json.

    Returns None when no tier range is found or no number can be extracted.
    """
    key = (item_tag, group)
    tiers = tier_ranges.get(key)
    if not tiers:
        return None

    # Extract the first integer from the mod text (absolute value for sign-negative mods)
    m = re.search(r"\d+", mod_text)
    if not m:
        return None
    val = int(m.group())

    # Find the tier whose range contains this value
    for tier, min_val, max_val in tiers:
        if min_val <= val <= max_val:
            return tier

    # Fallback: return the tier with the closest lower bound (handles elevated mods)
    # tiers is sorted min_val desc, so tiers[-1] has the smallest min_val (lowest quality)
    best_diff = None
    best_tier = None
    for tier, min_val, max_val in tiers:
        diff = abs(val - min_val)
        if best_diff is None or diff < best_diff:
            best_diff = diff
            best_tier = tier
    return best_tier


def match_mod_text(mod_text: str, pattern_index: list, item_tag: str) -> dict | None:
    """
    Try to match a single mod string against the pattern index for a given slot.
    Returns {group, item_tag, is_prefix} on match, or None.

    The GGG client adds a leading '+' to flat stat mods (e.g. '+47 to maximum Life')
    but our patterns are built without it. We try raw text first, then strip '+'.
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
            if resp.status_code in (403, 404):
                # Private/missing profile — cache empty list so we don't retry
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
        except requests.exceptions.Timeout:
            print(f"    Timeout fetching {char} (attempt {attempt + 1}/3), retrying in {delay:.0f}s...")
            delay *= 2
            continue
        except requests.exceptions.ConnectionError:
            print(f"    Connection error fetching {char} (attempt {attempt + 1}/3), retrying in {delay:.0f}s...")
            delay *= 2
            continue
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
    start_time = time.time()
    _prev_top_builds: list = []  # for convergence check

    def _top_build_signature(raw_data: dict) -> list:
        """
        Returns an ordered list of (char_class, primary_skill) for the top
        CONVERGENCE_TOP_N builds by character count.  Used to detect when the
        meta has stabilised and further sampling won't change the picture.
        """
        counts: dict[tuple, int] = defaultdict(int)
        for char_data in raw_data.values():
            skill = extract_primary_skill(char_data["items"])
            counts[(char_data["char_class"], skill)] += 1
        ordered = sorted(counts.items(), key=lambda x: -x[1])
        return [k for k, _ in ordered[:CONVERGENCE_TOP_N]]

    def _builds_converged(raw_data: dict) -> bool:
        """
        True when: (a) we have at least CONVERGENCE_MIN_SAMPLES chars per top
        build, and (b) the identity of the top CONVERGENCE_TOP_N builds hasn't
        changed since the last check.
        """
        nonlocal _prev_top_builds
        counts: dict[tuple, int] = defaultdict(int)
        for char_data in raw_data.values():
            skill = extract_primary_skill(char_data["items"])
            counts[(char_data["char_class"], skill)] += 1
        ordered = sorted(counts.items(), key=lambda x: -x[1])
        if not ordered:
            return False
        # Require the top build to have at least CONVERGENCE_MIN_SAMPLES
        if ordered[0][1] < CONVERGENCE_MIN_SAMPLES:
            return False
        sig = [k for k, _ in ordered[:CONVERGENCE_TOP_N]]
        stable = sig == _prev_top_builds
        _prev_top_builds = sig
        return stable

    for i, entry in enumerate(public_entries, 1):
        if len(raw) >= TARGET_PUBLIC_CHARS:
            print(f"  Reached TARGET_PUBLIC_CHARS={TARGET_PUBLIC_CHARS}, stopping early")
            break
        acct = entry["account"]["name"]
        char = entry["character"]["name"]
        char_class = entry["character"].get("class", "Unknown")
        key = f"{acct}/{char}"

        already_cached = _load_cache(f"items_{acct}_{char}") is not None

        items = fetch_character_items(acct, char, session)
        if items:
            raw[key] = {"items": items, "char_class": char_class}

        if not already_cached:
            fetched += 1
            if fetched % BATCH_SIZE == 0:
                elapsed = (time.time() - start_time) / 60
                rate = fetched / elapsed if elapsed > 0 else 0
                remaining = TARGET_PUBLIC_CHARS - len(raw)
                eta_min = remaining / rate if rate > 0 else 0
                print(
                    f"  --- Batch {fetched // BATCH_SIZE}: "
                    f"{len(raw)} collected / {i} scanned "
                    f"({elapsed:.0f}m elapsed, ~{eta_min:.0f}m remaining) "
                    f"--- pausing {BATCH_PAUSE}s ---"
                )
                time.sleep(BATCH_PAUSE)

            # Convergence check: if the top-N build meta is stable we have enough data
            if len(raw) > 0 and len(raw) % CONVERGENCE_CHECK_INTERVAL == 0:
                if _builds_converged(raw):
                    print(
                        f"  Top-{CONVERGENCE_TOP_N} builds converged at {len(raw)} characters "
                        f"— stopping early (use --analyze to re-run analysis on existing cache)"
                    )
                    break
        elif i % 200 == 0:
            # Periodic heartbeat for cached runs so the terminal isn't silent
            print(f"  [{i}/{len(public_entries)}] {len(raw)} collected (from cache)")

    return raw


# ---------------------------------------------------------------------------
# Analyze
# ---------------------------------------------------------------------------

def _aggregate_slots(chars_items: list, pattern_index: list, tier_ranges: dict) -> dict:
    """
    Aggregates mod frequency per slot across a list of character item lists.
    Returns {slot_tag: {sample_count, mod_frequency, base_type_freq, common_base,
    fractured_group, fractured_freq_pct}} filtered by MIN_FREQUENCY_PCT.

    base_type_freq tracks how often each base type appears per slot so
    fetch_trade_prices.py can price the correct raw base for craft cost.

    fractured_group is the single most-common mod group that appears as a
    fractured (locked) mod on this slot across sampled items — only set when
    at least 30% of items have a fracture in that group. This tells the profit
    engine the slot is typically crafted on a fractured base.
    """
    slot_mod_tiers: dict[str, dict[str, list]] = defaultdict(lambda: defaultdict(list))
    slot_sample_counts: dict[str, int] = defaultdict(int)
    slot_base_counts: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    # fractured-mod tracking: per slot, count how many sampled items fracture each group
    slot_fractured_counts: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))

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

                # baseType is the raw base name stripped of the rare prefix/suffix.
                # For rare items GGG uses "typeLine" for the base and "name" for the
                # rare name. "baseType" is the cleaner field when available.
                base = (
                    item.get("baseType")
                    or item.get("typeLine", "")
                ).strip()
                if base:
                    slot_base_counts[item_tag][base] += 1

            # Track fractured mods separately so we know which group is locked
            # on the base. A mod group gets counted once per item even if it
            # appears across explicit/crafted variants, since fracture is an
            # item-level property.
            fractured_groups_on_item: set[str] = set()
            for mod_text in item.get("fracturedMods", []):
                match = match_mod_text(mod_text, pattern_index, item_tag)
                if match:
                    fractured_groups_on_item.add(match["group"])
            for g in fractured_groups_on_item:
                slot_fractured_counts[item_tag][g] += 1

            all_mods = (
                item.get("explicitMods", [])
                + item.get("fracturedMods", [])
                + item.get("craftedMods", [])
            )
            for mod_text in all_mods:
                match = match_mod_text(mod_text, pattern_index, item_tag)
                if match:
                    tier = resolve_tier(match["group"], item_tag, mod_text, tier_ranges)
                    slot_mod_tiers[item_tag][match["group"]].append(tier)

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

        # Base type frequency — top 5, expressed as % of sampled items
        base_counts = slot_base_counts.get(item_tag, {})
        base_type_freq = {
            base: round(count / sample_n * 100, 1)
            for base, count in sorted(base_counts.items(), key=lambda x: -x[1])[:5]
        }
        common_base = max(base_counts, key=base_counts.get) if base_counts else None

        # Dominant fractured mod: set only when the top fractured group shows
        # up on a meaningful share of sampled items. Below this threshold the
        # slot is probably crafted on a plain base and the occasional fracture
        # is noise, not a strategy.
        FRACTURED_MIN_PCT = 0.30
        fractured_counts = slot_fractured_counts.get(item_tag, {})
        fractured_group = None
        fractured_freq_pct = 0.0
        if fractured_counts:
            top_group, top_count = max(fractured_counts.items(), key=lambda x: x[1])
            frac_pct = top_count / sample_n
            if frac_pct >= FRACTURED_MIN_PCT:
                fractured_group = top_group
                fractured_freq_pct = round(frac_pct * 100, 1)

        if mod_freq:
            slots_out[item_tag] = {
                "sample_count": sample_n,
                "mod_frequency": mod_freq,
                "common_base":   common_base,
                "base_type_freq": base_type_freq,
                "fractured_group":   fractured_group,
                "fractured_freq_pct": fractured_freq_pct,
            }

    return slots_out


EXAMPLE_CHARS_PER_BUILD = 3  # max character references saved per build archetype


def analyze(raw: dict, pattern_index: list, tier_ranges: dict) -> list:
    """
    Groups characters by (char_class, primary_skill) build archetype.
    Returns list of build dicts sorted by play_pct descending.

    Each build now includes `example_chars`: up to EXAMPLE_CHARS_PER_BUILD
    {account, char} pairs from the ladder so the UI can link to real profiles.
    """
    total_chars = len(raw)

    # Group characters by build archetype, preserving account+char metadata
    build_groups: dict[tuple, list] = defaultdict(list)
    build_chars: dict[tuple, list] = defaultdict(list)   # (key) → [{account, char}]
    build_meta: dict[tuple, dict] = {}

    for char_key, char_data in raw.items():
        items = char_data["items"]
        char_class = char_data["char_class"]
        primary_skill = extract_primary_skill(items)
        key = (char_class, primary_skill)
        build_groups[key].append(items)
        build_meta[key] = {"char_class": char_class, "primary_skill": primary_skill}

        # char_key is "account/charname"
        if "/" in char_key:
            account, char = char_key.split("/", 1)
            build_chars[key].append({"account": account, "char": char})

    builds_out = []
    for key, chars_items in sorted(build_groups.items(), key=lambda x: -len(x[1])):
        meta = build_meta[key]
        count = len(chars_items)
        play_pct = round(count / total_chars * 100, 1) if total_chars > 0 else 0

        slots_out = _aggregate_slots(chars_items, pattern_index, tier_ranges)

        # Save a handful of example characters for direct profile linking in the UI
        example_chars = build_chars[key][:EXAMPLE_CHARS_PER_BUILD]

        builds_out.append({
            "char_class": meta["char_class"],
            "primary_skill": meta["primary_skill"],
            "count": count,
            "play_pct": play_pct,
            "slots": slots_out,
            "example_chars": example_chars,
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
    tier_ranges  = build_tier_ranges(items_db)
    print(f"  {len(pattern_index)} patterns built, {sum(len(v) for v in tier_ranges.values())} tier range entries")

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
    builds_out = analyze(raw, pattern_index, tier_ranges)

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
