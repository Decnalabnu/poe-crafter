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
TARGET_PUBLIC_CHARS = 5000  # stop early once we have this many public characters fetched
REQUEST_DELAY = 2.5         # seconds between character item fetches (~24 req/min, adaptive backoff handles 429s)
BATCH_SIZE = 40             # fetch this many characters, then pause
BATCH_PAUSE = 20.0          # seconds to pause between batches
CONVERGENCE_MIN_SAMPLES = 150  # top builds need at least this many samples before early-stop is considered
CONVERGENCE_TOP_N = 5          # number of top builds to monitor for stability
CONVERGENCE_CHECK_INTERVAL = 250  # check convergence every N characters collected
MIN_FREQUENCY_PCT = 0.15    # mod must appear in ≥15% of sampled items to be reported
MIN_FREQUENCY_ABS = 3       # OR at least this many absolute hits (for small samples)
MIN_LADDER_LEVEL  = 90      # skip ladder entries below this level (non-endgame gear pollutes the stats)
EMPTY_CACHE_TTL_DAYS  = 7   # re-fetch character caches that were empty (private/404) after this many days
LADDER_CACHE_TTL_HRS  = 24  # re-fetch ladder pages older than this so we pick up meta shifts across days
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

FRAME_TYPE_RARE   = 2
FRAME_TYPE_UNIQUE = 3

# Minimum share of sampled items that must carry an influence before we
# call a slot "dominantly influenced". Below this threshold the occasional
# influenced item is noise, not a strategy worth filtering the trade query by.
INFLUENCE_MIN_PCT = 0.30

# GGG `influences` field on items uses these keys. They already match our
# canonical influence names, so no remapping is needed.
INFLUENCE_KEYS = ("shaper", "elder", "crusader", "hunter", "redeemer", "warlord")

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
                # Skip essence/influence-exclusive (weight=0) mods: their numeric
                # ranges often overlap naturally-rollable tiers, and ladder items
                # are overwhelmingly chaos/exalt-rolled. Including them would
                # mis-tag common rolls as an unreachable tier.
                if (mod.get("spawn_weights") or [{}])[0].get("weight", 0) <= 0:
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


def _cache_age_hours(key: str) -> float | None:
    """Age of a cache file in hours, or None if it doesn't exist."""
    path = _cache_path(key)
    if not os.path.exists(path):
        return None
    try:
        return (time.time() - os.path.getmtime(path)) / 3600.0
    except OSError:
        return None


def _empty_cache_is_stale(key: str) -> bool:
    """
    True when an item cache file exists, is empty ([] — private/404 at scrape time),
    and is older than EMPTY_CACHE_TTL_DAYS. Used to periodically re-check profiles
    that were private when first scraped in case they've flipped public.
    """
    path = _cache_path(key)
    if not os.path.exists(path):
        return False
    try:
        age_days = (time.time() - os.path.getmtime(path)) / 86400.0
    except OSError:
        return False
    if age_days < EMPTY_CACHE_TTL_DAYS:
        return False
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return False
    return data == []


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
        # Re-fetch ladder pages older than LADDER_CACHE_TTL_HRS so meta shifts
        # (new chars pushing old ones off, rerolls, deletions) are captured.
        age_hrs = _cache_age_hours(cache_key)
        if cached is not None and age_hrs is not None and age_hrs < LADDER_CACHE_TTL_HRS:
            print(f"  [cache] ladder page {page + 1} ({len(cached)} entries, {age_hrs:.1f}h old)")
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
            # If we had stale-but-valid data for this page, use it rather than
            # losing coverage of this entire slice of the ladder.
            if cached is not None:
                print(f"    Falling back to stale cache ({len(cached)} entries)")
                all_entries.extend(cached)
                if len(cached) < PAGE_SIZE:
                    break
                continue
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
    if cached:
        # Non-empty cache hit — always serve from disk.
        return cached
    if cached == [] and not _empty_cache_is_stale(cache_key):
        # Recently-cached empty (private/404) — skip re-fetch until TTL expires.
        return []

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
                # Private/missing profile.  If we previously scraped this char
                # successfully, KEEP the last-known-good snapshot — a character
                # going private later shouldn't erase the mod data we already
                # collected.  Just touch the file so the TTL clock restarts.
                if cached:
                    try:
                        os.utime(_cache_path(cache_key), None)
                    except OSError:
                        pass
                    return cached
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

# Transfigured-skill → canonical base skill.  PoE transfigured gems use two
# forms: "<Base> of <Modifier>" (e.g. "Kinetic Blast of Clustering") and a
# handful of renamed variants (e.g. "Kinetic Fusillade" for KB).  The "of X"
# form is handled generically by _canonicalize_skill; the renamed variants
# need an explicit map.
TRANSFIG_RENAME_MAP = {
    "Kinetic Fusillade": "Kinetic Blast",
}

# Matches "Grants Level N <Skill Name> Skill" / "Triggers Level N <Skill> ..."
_GRANTS_SKILL_RE  = re.compile(r"Grants Level \d+ (.+?) Skill", re.IGNORECASE)
_TRIGGERS_SKILL_RE = re.compile(r"Triggers?\s+Level \d+ (.+?)\s+(?:when|on|every|each|after)", re.IGNORECASE)


def _canonicalize_skill(skill: str) -> str:
    """Fold transfigured variants onto their base skill for build grouping."""
    if not skill or skill == "Unknown":
        return skill
    if skill in TRANSFIG_RENAME_MAP:
        return TRANSFIG_RENAME_MAP[skill]
    # "Kinetic Blast of Clustering" → "Kinetic Blast"
    base = re.sub(r"\s+of\s+[A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)*$", "", skill).strip()
    return base or skill


def _skill_from_item_mods(items: list) -> str:
    """
    Scan implicit/explicit/enchant mods across all items for skill-granting text.
    Returns the granted skill name, or "" if none found.  Prefers the first
    match on a non-swap slot (Weapon > Weapon2) since swap gear often carries
    flask/utility grants unrelated to the main skill.
    """
    # Walk main-hand first, then everything else, so the active-slot grant wins.
    ordered = sorted(items, key=lambda it: 0 if it.get("inventoryId") == "Weapon" else 1)
    for item in ordered:
        for key in ("enchantMods", "implicitMods", "explicitMods"):
            for mod in item.get(key, []):
                m = _GRANTS_SKILL_RE.search(mod)
                if m:
                    return m.group(1).strip()
                m = _TRIGGERS_SKILL_RE.search(mod)
                if m:
                    return m.group(1).strip()
    return ""


def extract_primary_skill(items: list) -> str:
    """
    Find the primary active skill.  Resolution order:
      1. Most-linked non-Support socketed gem (original behaviour).
      2. Skill-granting item mod ("Grants Level N <Skill> Skill" / "Triggers ...").
    Returns a canonicalized skill name (transfigured variants folded to base),
    or "Unknown" if nothing can be determined.
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

    if best_gem == "Unknown":
        granted = _skill_from_item_mods(items)
        if granted:
            best_gem = granted

    return _canonicalize_skill(best_gem)


# ---------------------------------------------------------------------------
# Scrape
# ---------------------------------------------------------------------------

def scrape(league: str, session: requests.Session) -> dict:
    """
    Fetches ladder pages then character items until TARGET_PUBLIC_CHARS fetched.
    Returns raw: {account/char: {"items": [...], "char_class": "..."}}
    """
    entries = fetch_ladder(league, session)
    # Only keep public characters at endgame level — sub-90 chars pollute slot
    # samples with early-mapping gear that doesn't reflect what the build runs.
    public_entries = [
        e for e in entries
        if e.get("public") and e.get("character", {}).get("level", 0) >= MIN_LADDER_LEVEL
    ]
    print(
        f"  {len(public_entries)} public characters (level ≥{MIN_LADDER_LEVEL}) "
        f"out of {len(entries)} total ladder entries"
    )

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

        _cached = _load_cache(f"items_{acct}_{char}")
        # Treat empty+stale caches as uncached so they get retried this run.
        already_cached = (
            _cached is not None
            and not (_cached == [] and _empty_cache_is_stale(f"items_{acct}_{char}"))
        )

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
    slot_sample_counts: dict[str, int] = defaultdict(int)     # rare items sampled
    slot_unique_counts: dict[str, int] = defaultdict(int)     # unique items seen in the same slot
    slot_equipped_counts: dict[str, int] = defaultdict(int)   # any-rarity items seen (denominator for unique_rate)
    slot_base_counts: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    # fractured-mod tracking: per slot, count how many sampled items fracture each group
    slot_fractured_counts: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    # influence tracking: per slot, count how many rare items carry each influence
    # ("none" = no influence). Dual-influence items count toward both.
    slot_influence_counts: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))

    for items in chars_items:
        seen_slots: set[str] = set()   # for rare-mod aggregation (skips non-rare)
        seen_any:   set[str] = set()   # for slot-occupancy (any rarity)
        for item in items:
            inv_id = item.get("inventoryId", "")
            item_tag = SLOT_MAP.get(inv_id)
            if item_tag is None:
                continue

            # Track occupancy (any rarity) and unique rate per slot.  This lets
            # the UI flag "most chars wear a unique here — trade, don't craft"
            # even when rare-mod sample is tiny.
            frame = item.get("frameType")
            if inv_id not in seen_any:
                slot_equipped_counts[item_tag] += 1
                if frame == FRAME_TYPE_UNIQUE:
                    slot_unique_counts[item_tag] += 1
                seen_any.add(inv_id)

            if frame != FRAME_TYPE_RARE:
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

            # Influence observed on this rare item. GGG returns e.g.
            # {"shaper": true, "elder": true} on the item object. Dual-influence
            # items contribute to both counts so we can still detect them.
            influences_on_item = item.get("influences") or {}
            any_influence = False
            for inf_key in INFLUENCE_KEYS:
                if influences_on_item.get(inf_key):
                    slot_influence_counts[item_tag][inf_key] += 1
                    any_influence = True
            if not any_influence:
                slot_influence_counts[item_tag]["none"] += 1

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
        # Scale the threshold so small samples need MIN_FREQUENCY_ABS absolute hits
        # rather than MIN_FREQUENCY_PCT of a tiny denominator.  Keeps the high bar
        # on big samples but stops single-appearance mods from passing on n=10 slots.
        threshold_pct = max(MIN_FREQUENCY_PCT, MIN_FREQUENCY_ABS / sample_n)
        for group, tiers in sorted(group_tiers.items(), key=lambda x: -len(x[1])):
            count = len(tiers)
            pct = count / sample_n
            if pct < threshold_pct:
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

        # Unique-rate: share of sampled characters that wear a unique in this
        # slot (regardless of whether they also have a rare variant).  High
        # rates mean the heatmap's rare-mod stats are statistically weak for
        # this build + slot — user should trade a unique instead of crafting.
        equipped_n = slot_equipped_counts.get(item_tag, 0)
        unique_n   = slot_unique_counts.get(item_tag, 0)
        unique_rate = round(unique_n / equipped_n * 100, 1) if equipped_n else 0.0

        # Influence distribution: share of rare sampled items per influence,
        # plus a single dominant influence when one clearly dominates. Consumers
        # (fetch_trade_prices, profit engine) use dominant_influence to decide
        # whether to filter trade queries to influenced bases.
        infl_counts = slot_influence_counts.get(item_tag, {})
        influence_freq: dict[str, float] = {}
        dominant_influence: str | None = None
        if sample_n:
            for inf_key, cnt in infl_counts.items():
                influence_freq[inf_key] = round(cnt / sample_n * 100, 1)
            influenced_only = {k: v for k, v in infl_counts.items() if k != "none"}
            if influenced_only:
                top_inf, top_cnt = max(influenced_only.items(), key=lambda x: x[1])
                if top_cnt / sample_n >= INFLUENCE_MIN_PCT:
                    dominant_influence = top_inf

        if mod_freq:
            slots_out[item_tag] = {
                "sample_count": sample_n,
                "equipped_count": equipped_n,
                "unique_rate":   unique_rate,
                "mod_frequency": mod_freq,
                "common_base":   common_base,
                "base_type_freq": base_type_freq,
                "fractured_group":   fractured_group,
                "fractured_freq_pct": fractured_freq_pct,
                "influence_freq":     influence_freq,
                "dominant_influence": dominant_influence,
            }

    return slots_out


EXAMPLE_CHARS_PER_BUILD = 3  # max character references saved per build archetype


def _group_and_aggregate(
    raw: dict,
    pattern_index: list,
    tier_ranges: dict,
    group_by: str,   # "class_skill" (default) or "skill"
) -> list:
    """
    Groups characters by the requested keying and runs slot aggregation on each.
    group_by="class_skill"  → (char_class, primary_skill) — the granular view.
    group_by="skill"        → primary_skill only — the cross-ascendancy meta view
                              that pools all classes playing the same skill, so
                              per-slot samples are 2-3× larger for common mods.
    """
    total_chars = len(raw)

    build_groups: dict = defaultdict(list)
    build_chars:  dict = defaultdict(list)
    build_meta:   dict = {}
    # Track ascendancy distribution inside skill-only buckets so the UI can
    # flag "this skill meta is 70% Hierophant" vs "evenly split".
    build_class_mix: dict = defaultdict(lambda: defaultdict(int))

    for char_key, char_data in raw.items():
        items = char_data["items"]
        char_class = char_data["char_class"]
        primary_skill = extract_primary_skill(items)

        if group_by == "skill":
            key = primary_skill
            meta = {"primary_skill": primary_skill}
        else:
            key = (char_class, primary_skill)
            meta = {"char_class": char_class, "primary_skill": primary_skill}

        build_groups[key].append(items)
        build_meta[key] = meta
        build_class_mix[key][char_class] += 1

        if "/" in char_key:
            account, char = char_key.split("/", 1)
            build_chars[key].append({"account": account, "char": char})

    builds_out = []
    for key, chars_items in sorted(build_groups.items(), key=lambda x: -len(x[1])):
        meta = build_meta[key]
        count = len(chars_items)
        play_pct = round(count / total_chars * 100, 1) if total_chars > 0 else 0
        slots_out = _aggregate_slots(chars_items, pattern_index, tier_ranges)
        example_chars = build_chars[key][:EXAMPLE_CHARS_PER_BUILD]

        entry = {
            **meta,
            "count": count,
            "play_pct": play_pct,
            "slots": slots_out,
            "example_chars": example_chars,
        }
        if group_by == "skill":
            # Top ascendancies playing this skill (for the UI to surface)
            mix_items = sorted(build_class_mix[key].items(), key=lambda x: -x[1])
            entry["class_mix"] = [
                {"char_class": c, "count": n, "pct": round(n / count * 100, 1)}
                for c, n in mix_items
            ]
        builds_out.append(entry)

    return builds_out


def analyze(raw: dict, pattern_index: list, tier_ranges: dict) -> list:
    """Granular view: grouped by (char_class, primary_skill)."""
    return _group_and_aggregate(raw, pattern_index, tier_ranges, group_by="class_skill")


def analyze_by_skill(raw: dict, pattern_index: list, tier_ranges: dict) -> list:
    """Cross-ascendancy view: grouped by primary_skill only."""
    return _group_and_aggregate(raw, pattern_index, tier_ranges, group_by="skill")


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
        skipped_low_level = 0
        for entry in ladder_entries:
            acct = entry.get("account", {}).get("name", "")
            char = entry.get("character", {}).get("name", "")
            char_class = entry.get("character", {}).get("class", "Unknown")
            level = entry.get("character", {}).get("level", 0)
            if not acct or not char:
                continue
            if level < MIN_LADDER_LEVEL:
                skipped_low_level += 1
                continue
            items = _load_cache(f"items_{acct}_{char}")
            if items:
                raw[f"{acct}/{char}"] = {"items": items, "char_class": char_class}
        if skipped_low_level:
            print(f"  Skipped {skipped_low_level} sub-level-{MIN_LADDER_LEVEL} characters")
        print(f"  {len(raw)} cached characters found")
    else:
        print("Scraping ladder + character items...")
        raw = scrape(LEAGUE, session)
        print(f"  Collected items for {len(raw)} characters")

    print("Analyzing mod frequencies by build archetype...")
    builds_out = analyze(raw, pattern_index, tier_ranges)
    builds_by_skill_out = analyze_by_skill(raw, pattern_index, tier_ranges)

    output = {
        "league": LEAGUE,
        "analyzed_at": datetime.now(timezone.utc).isoformat(),
        "characters_sampled": len(raw),
        "builds": builds_out,
        "builds_by_skill": builds_by_skill_out,
    }

    os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print(f"\nDone. Output: {OUTPUT_FILE}")
    print("Top builds by (class, skill):")
    for build in builds_out[:8]:
        print(f"  {build['char_class']} / {build['primary_skill']}: {build['count']} chars ({build['play_pct']}%)")
    print("Top builds by skill (cross-ascendancy):")
    for build in builds_by_skill_out[:8]:
        mix = ", ".join(f"{m['char_class']} {m['pct']}%" for m in build.get("class_mix", [])[:3])
        print(f"  {build['primary_skill']}: {build['count']} chars ({build['play_pct']}%) — {mix}")


if __name__ == "__main__":
    main()
