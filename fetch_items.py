"""
fetch_items.py — Regenerate src/data/items.json

Strategy:
  - RePoE   → mod IDs, spawn weights, stat IDs, required levels  (authoritative)
  - poedb   → current text/value ranges                           (authoritative)
  Matched by: (item_class, gen_type, required_level, stat_category)

Run: python fetch_items.py
Requires: pip install requests beautifulsoup4
"""

import json, re, sys, time, urllib.request
import requests
from bs4 import BeautifulSoup
from collections import defaultdict

OUTPUT_FILE = "src/data/items.json"
REPOЕ_URL   = "https://raw.githubusercontent.com/brather1ng/RePoE/master/RePoE/data/mods.json"
POEDB_URL   = "https://poedb.tw/us/Modifiers_list"

HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120"}

# Our item classes → RePoE spawn_weight tags (ordered: specific first, then default)
ITEM_TAGS = {
    "ring":        ["ring", "default"],
    "amulet":      ["amulet", "default"],
    "belt":        ["belt", "default"],
    "helmet":      ["helmet", "default"],
    "body_armour": ["body_armour", "chest", "default"],
    "boots":       ["boots", "default"],
    "gloves":      ["gloves", "default"],
}

# poedb item class labels in the Tags column
POEDB_LABELS = {
    "ring":        "Rings",
    "amulet":      "Amulets",
    "belt":        "Belts",
    "helmet":      "Helmets",
    "body_armour": "Body Armours",
    "boots":       "Boots",
    "gloves":      "Gloves",
}

# RePoE influence suffix → our name
INFLUENCE_TAG_MAP = {
    "shaper":      "shaper",
    "elder":       "elder",
    "crusader":    "crusader",
    "adjudicator": "redeemer",
    "basilisk":    "hunter",
    "eyrie":       "warlord",
}

# RePoE stat_id → human-readable group name
STAT_GROUP = {
    "base_maximum_life":                                    "Increased Life",
    "base_maximum_mana":                                    "IncreasedMana",
    "base_maximum_energy_shield":                           "IncreasedEnergyShield",
    "attack_minimum_added_cold_damage":                     "Cold Damage",
    "attack_minimum_added_fire_damage":                     "Fire Damage",
    "attack_minimum_added_lightning_damage":                "Lightning Damage",
    "attack_minimum_added_physical_damage":                 "Physical Damage",
    "spell_minimum_added_cold_damage":                      "Added Cold Damage Spells",
    "spell_minimum_added_fire_damage":                      "Added Fire Damage Spells",
    "spell_minimum_added_lightning_damage":                 "Added Lightning Damage Spells",
    "spell_minimum_added_chaos_damage":                     "Added Chaos Damage Spells",
    "cold_damage_+%":                                       "Cold Damage Percentage",
    "fire_damage_+%":                                       "Fire Damage Percentage",
    "lightning_damage_+%":                                  "Lightning Damage Percentage",
    "chaos_damage_+%":                                      "Increased Chaos Damage",
    "physical_damage_+%":                                   "Physical Damage Percentage",
    "elemental_damage_with_attack_skills_+%":               "Elemental Damage With Attacks",
    "additional_strength":                                  "Strength",
    "additional_dexterity":                                 "Dexterity",
    "additional_intelligence":                              "Intelligence",
    "additional_all_attributes":                            "AllAttributes",
    "base_fire_damage_resistance_%":                        "Fire Resistance",
    "base_cold_damage_resistance_%":                        "Cold Resistance",
    "base_lightning_damage_resistance_%":                   "Lightning Resistance",
    "base_chaos_damage_resistance_%":                       "Chaos Resistance",
    "base_resist_all_elements_%":                           "All Resistances",
    "base_cast_speed_+%":                                   "Increased Cast Speed",
    "base_attack_speed_+%":                                 "Increased Attack Speed",
    "critical_strike_chance_+%":                            "Critical Strike Chance",
    "global_critical_strike_chance_+%":                     "Critical Strike Chance",
    "base_critical_strike_multiplier_+":                    "Critical Strike Multiplier",
    "global_critical_strike_multiplier_+":                  "Critical Strike Multiplier",
    "mana_regeneration_rate_+%":                            "Mana Regeneration",
    "base_life_regeneration_rate_per_minute":               "Life Regeneration",
    "base_mana_regeneration_rate_per_minute":               "Mana Regeneration",
    "base_item_found_rarity_+%":                            "Item Rarity",
    "movement_speed_+%":                                    "Movement Speed",
    "base_movement_velocity_+%":                            "Movement Speed",
    "base_evasion_rating":                                  "Evasion Rating",
    "base_physical_damage_reduction_rating":                "Physical Damage Reduction Rating",
    "evasion_rating_+%":                                    "Global Evasion Rating Percent",
    "physical_damage_reduction_rating_+%":                  "Global Physical Damage Reduction Rating Percent",
    "maximum_energy_shield_+%":                             "Global Energy Shield Percent",
    "local_energy_shield":                                  "Local Energy Shield",
    "local_base_evasion_rating":                            "Local Evasion Rating",
    "local_base_physical_damage_reduction_rating":          "Local Armour",
    "local_evasion_rating_+%":                              "Local Evasion Rating Percent",
    "local_energy_shield_+%":                               "Local Energy Shield Percent",
    "local_physical_damage_reduction_rating_+%":            "Local Armour Percent",
    "local_evasion_and_energy_shield_+%":                   "Local Evasion And Energy Shield",
    "local_physical_and_chaos_damage_reduction_rating_%":   "Local Armour And Energy Shield",
    "local_armour_and_evasion_+%":                          "Local Armour And Evasion",
    "minion_maximum_life_+%":                               "Minion Life",
    "minion_damage_+%":                                     "Minion Damage",
    "minion_movement_speed_+%":                             "Minion Run Speed",
    "physical_damage_to_return_to_melee_attacker":          "Attacker Takes Damage No Range",
    "flask_life_recovery_rate_+%":                          "Belt Flask Life Recovery Rate",
    "flask_mana_recovery_rate_+%":                          "Belt Flask Mana Recovery Rate",
    "base_stun_duration_+%":                                "Stun Duration Increase Percent",
    "base_stun_threshold_reduction_+%":                     "Stun Threshold Reduction",
    "base_avoid_chill_%":                                   "Avoid Elemental Status Ailments",
    "base_avoid_freeze_%":                                   "Avoid Elemental Status Ailments",
    "base_avoid_ignite_%":                                  "Avoid Elemental Status Ailments",
    "base_avoid_shock_%":                                   "Avoid Elemental Status Ailments",
    "life_gain_per_target":                                 "Life Gain Per Target",
    "mana_gain_per_target":                                 "Mana Gain Per Target",
    "life_gained_from_enemy_death":                         "Life Gained From Enemy Death",
    "mana_gained_from_enemy_death":                         "Mana Gained From Enemy Death",
    "life_leech_from_physical_attack_damage_permyriad":     "Life Leech Permyriad",
    "mana_leech_from_physical_attack_damage_permyriad":     "Mana Leech Permyriad",
    "maximum_life_leech_rate_+%":                           "Maximum Life Leech Rate",
    "damage_taken_+%_from_hits_as_life":                    "Damage Taken Gained As Life",
    "base_mana_reservation_efficiency_+%":                  "Mana Reservation Efficiency",
    "base_skill_area_of_effect_+%":                         "Area Of Effect",
    "supported_by_life_leech":                              "Supported By Life Leech",
    "cold_damage_taken_%_as_fire":                          "Cold Damage Taken As Fire",
    "physical_damage_taken_%_as_cold":                      "Physical Damage Taken As Cold",
    "physical_damage_taken_%_as_fire":                      "Physical Damage Taken As Fire",
    "physical_damage_taken_%_as_lightning":                 "Physical Damage Taken As Lightning",
    "base_avoid_ailments_%":                                "Avoid Elemental Status Ailments",
    "non_ailment_cold_damage_taken_%_to_gain_as_life":      "Damage Taken Gained As Life",
    "base_life_regeneration_rate_per_minute":               "Life Regeneration",
    "socketed_attacks_have_%_mana_cost":                    "Socketed Attacks Mana Cost",
    "local_gem_level_bonus_attack_skills":                  "Socketed Attacks Gem Level",
    "display_minion_monster_level":                         "Minion Life Supported",
    "minion_life_+%_per_level":                             "Minion Life",
    "enemies_can_have_%_additional_curse":                  "Additional Curses",
}


def get_stat_group(stat_id):
    g = STAT_GROUP.get(stat_id)
    if g:
        return g
    # Fallback: prettify stat_id
    label = stat_id.replace("base_", "").replace("_+%", "").replace("_%", "").replace("_", " ").strip().title()
    return label


def fetch_repoе_mods():
    print(f"Fetching RePoE mods...")
    req = urllib.request.Request(REPOЕ_URL, headers={"User-Agent": "poe-crafter"})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.load(r)
    print(f"  Loaded {len(data)} mods.")
    return data


def get_ring_weight(mod, tags_priority):
    """Return (weight, influence) for this mod given the item's tag priority list."""
    sw_dict = {s["tag"]: s["weight"] for s in mod.get("spawn_weights", [])}

    # Check for influence-specific tags
    for tag in sw_dict:
        for inf_suffix, inf_name in INFLUENCE_TAG_MAP.items():
            for item_tag in tags_priority[:-1]:  # exclude "default"
                inf_tag = f"{item_tag}_{inf_suffix}"
                if tag == inf_tag:
                    w = sw_dict.get(inf_tag, 0)
                    if w > 0:
                        return w, inf_name

    # Base mod: check item-specific tags first, then default
    for tag in tags_priority:
        if tag in sw_dict:
            w = sw_dict[tag]
            if w > 0:
                return w, None
            elif w == 0 and tag != "default":
                # Explicitly 0 for this item class — blocked
                return 0, None

    return 0, None


def fetch_poedb_rows():
    print(f"Fetching poedb mod table...")
    sess = requests.Session()
    sess.headers.update(HEADERS)
    resp = sess.get(POEDB_URL, timeout=60)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")
    table = soup.find("table")
    rows = []
    for tr in table.find("tbody").find_all("tr"):
        cells = [td.get_text(separator=" ", strip=True) for td in tr.find_all("td")]
        if len(cells) == 4:
            text = cells[2].replace("\u2013", "-").replace("\ufffd", "-")
            text = re.sub(r"\s+", " ", text).strip()
            rows.append({
                "level":    int(cells[0]) if cells[0].isdigit() else 0,
                "gen_type": cells[1].lower(),
                "text":     text,
                "tags":     cells[3],
            })
    print(f"  Loaded {len(rows)} rows.")
    return rows


def build_poedb_index(rows, item_class):
    """
    For a given item class, build two indexes:
      by_level:  (gen_type, required_level) → list of text strings
      by_text:   list of all (gen_type, level, text) tuples for this class
    Only include rows where this item class is referenced in tags.
    """
    label = POEDB_LABELS[item_class]
    tags_priority = ITEM_TAGS[item_class]
    inf_prefixes = [f"{t}_" for t in tags_priority if t != "default"]

    by_level = defaultdict(list)
    all_rows = []
    for row in rows:
        tags = row["tags"]
        matched = False
        # Base mod for this class
        if label in tags:
            matched = True
        else:
            # Influence mod for this class
            for pfx in inf_prefixes:
                if pfx in tags:
                    m = re.search(re.escape(pfx) + r'(\w+)\s+(\d+)', tags)
                    if m and int(m.group(2)) > 0:
                        matched = True
                        break
        if matched:
            by_level[(row["gen_type"], row["level"])].append(row["text"])
            all_rows.append((row["gen_type"], row["level"], row["text"]))
    return by_level, all_rows


def build_items_json(repoе_mods, poedb_rows):
    result = {}

    for item_class, tags_priority in ITEM_TAGS.items():
        print(f"  Processing {item_class}...")
        poedb_by_level, poedb_all = build_poedb_index(poedb_rows, item_class)

        prefixes_raw = []
        suffixes_raw = []

        for mod_id, mod in repoе_mods.items():
            if mod.get("domain") != "item":
                continue
            gen_type = mod.get("generation_type", "")
            if gen_type not in ("prefix", "suffix"):
                continue
            # Skip Royale/race-season/descent mods — not in standard item pool
            if any(x in mod_id for x in ("Royale", "Descent", "race_")):
                continue

            weight, influence = get_ring_weight(mod, tags_priority)
            if weight == 0:
                continue

            stats = mod.get("stats", [])
            primary_stat = stats[0]["id"] if stats else ""
            group = get_stat_group(primary_stat)
            req_level = mod.get("required_level", 0)

            # Patch: Leech mods were moved from Prefix → Suffix in a balance patch.
            # RePoE still lists them as prefix, so override here.
            LEECH_PREFIX_OVERRIDES = {
                "life_leech_from_physical_attack_damage_permyriad",
                "mana_leech_from_physical_attack_damage_permyriad",
            }
            if primary_stat in LEECH_PREFIX_OVERRIDES and gen_type == "prefix":
                gen_type = "suffix"

            # Get updated text from poedb — first try exact level match with keyword filter,
            # then search all rows for this item class by keyword only
            level_candidates = poedb_by_level.get((gen_type, req_level), [])
            text = pick_best_poedb_text(level_candidates, group, mod, poedb_all, gen_type)

            entry = {
                "mod_id":      mod_id,
                "group":       group,
                "text":        text,
                "weight":      weight,
                "influence":   influence,
                "req_level":   req_level,
                "primary_stat": primary_stat,
            }
            if gen_type == "prefix":
                prefixes_raw.append(entry)
            else:
                suffixes_raw.append(entry)

        result[item_class] = {
            "prefixes": assign_tiers(prefixes_raw, item_class, "prefix"),
            "suffixes": assign_tiers(suffixes_raw, item_class, "suffix"),
        }
        np = len(result[item_class]["prefixes"])
        ns = len(result[item_class]["suffixes"])
        total_pw = sum(m["spawn_weights"][0]["weight"] for m in result[item_class]["prefixes"])
        total_sw = sum(m["spawn_weights"][0]["weight"] for m in result[item_class]["suffixes"])
        print(f"    {np} prefixes (w={total_pw}), {ns} suffixes (w={total_sw})")

    return result


# Keywords per group to help pick the right poedb text when multiple rows share a level
GROUP_KEYWORDS = {
    "Increased Life":              ["maximum Life"],
    "IncreasedMana":               ["maximum Mana"],
    "IncreasedEnergyShield":       ["maximum Energy Shield"],
    "Cold Damage":                 ["Cold Damage to Attacks"],
    "Fire Damage":                 ["Fire Damage to Attacks"],
    "Lightning Damage":            ["Lightning Damage to Attacks"],
    "Physical Damage":             ["Physical Damage to Attacks"],
    "Added Cold Damage Spells":    ["Cold Damage to Spells"],
    "Added Fire Damage Spells":    ["Fire Damage to Spells"],
    "Added Lightning Damage Spells":["Lightning Damage to Spells"],
    "Strength":                    ["to Strength"],
    "Dexterity":                   ["to Dexterity"],
    "Intelligence":                ["to Intelligence"],
    "AllAttributes":               ["to all Attributes"],
    "Fire Resistance":             ["to Fire Resistance"],
    "Cold Resistance":             ["to Cold Resistance"],
    "Lightning Resistance":        ["to Lightning Resistance"],
    "Chaos Resistance":            ["to Chaos Resistance"],
    "All Resistances":             ["to all Elemental Resistances"],
    "Increased Cast Speed":        ["Cast Speed"],
    "Increased Attack Speed":      ["Attack Speed"],
    "Critical Strike Chance":      ["Critical Strike Chance"],
    "Critical Strike Multiplier":  ["Critical Strike Multiplier"],
    "Mana Regeneration":           ["Mana Regeneration"],
    "Life Regeneration":           ["Life Regenerated"],
    "Item Rarity":                 ["Rarity"],
    "Movement Speed":              ["Movement Speed"],
    "Evasion Rating":              ["Evasion Rating"],
    "Life Gain Per Target":        ["Life gained for each"],
    "Mana Gain Per Target":        ["Mana gained for each"],
    "Life Gained From Enemy Death":["Life gained on Kill"],
    "Mana Gained From Enemy Death":["Mana gained on Kill"],
    "Mana Reservation Efficiency": ["Mana Reservation Efficiency"],
    "Area Of Effect":              ["Area of Effect"],
    "Attacker Takes Damage No Range":["Physical Damage taken"],
    "Belt Flask Life Recovery Rate":["Life Recovery Rate"],
    "Belt Flask Mana Recovery Rate":["Mana Recovery Rate"],
    "Stun Duration Increase Percent":["Stun Duration"],
    "Stun Threshold Reduction":    ["Stun Threshold"],
    "Elemental Damage With Attacks":["Elemental Damage with Attack"],
    "Minion Life":                 ["Minion", "Life"],
    "Minion Damage":               ["Minion", "Damage"],
    "Physical Damage Reduction Rating":["to Armour"],
    "Life Leech Permyriad":        ["Leeched as Life"],
    "Mana Leech Permyriad":        ["Leeched as Mana"],
    "Maximum Life Leech Rate":     ["Life Leech Rate"],
    "Damage Taken Gained As Life": ["Damage taken"],
    "Avoid Elemental Status Ailments": ["Avoid being"],
    "Additional Curses":           ["additional Curse"],
    "Mana Reservation Efficiency": ["Mana Reservation Efficiency"],
}


def pick_best_poedb_text(level_candidates, group, mod, all_rows, gen_type):
    """
    Pick the poedb text that best matches this mod.
    Priority:
      1. Level-matched candidate that passes keyword filter
      2. Any row across all_rows (any level) that passes keyword filter — closest level wins
      3. RePoE fallback text
    Never falls through to a wrong-keyword candidate.
    """
    keywords = GROUP_KEYWORDS.get(group, [])
    req_level = mod.get("required_level", 0)

    def matches(text):
        if not keywords:
            return True
        return all(kw.lower() in text.lower() for kw in keywords)

    # 1. Level-exact with keyword match
    for text in level_candidates:
        if matches(text):
            return text

    # 2. Search all rows by keyword, pick closest required_level
    if keywords:
        best_text = None
        best_dist = 999
        for gt, lvl, text in all_rows:
            if gt != gen_type:
                continue
            if matches(text) and abs(lvl - req_level) < best_dist:
                best_dist = abs(lvl - req_level)
                best_text = text
        if best_text:
            return best_text

    # 3. RePoE fallback — build from stat ranges
    return repoе_fallback_text(mod)


def repoе_fallback_text(mod):
    """Build text from RePoE stat data when poedb has no match."""
    stats = mod.get("stats", [])
    name = mod.get("name", "")
    parts = []
    for st in stats:
        mn, mx = st.get("min", 0), st.get("max", 0)
        val = str(mn) if mn == mx else f"({mn}-{mx})"
        parts.append(val)
    return f"{'/'.join(parts)} {name}".strip() if parts else name


def assign_tiers(mods_raw, item_class, gen_type):
    """Group by (group, influence), sort by req_level desc → T1=best, output final list."""
    by_group = defaultdict(list)
    for m in mods_raw:
        key = (m["group"], m["influence"])
        by_group[key].append(m)

    final = []
    for (group, influence), mods in by_group.items():
        mods_sorted = sorted(mods, key=lambda m: m["req_level"], reverse=True)
        for tier_num, m in enumerate(mods_sorted, start=1):
            tag = POEDB_LABELS[item_class].lower().replace(" ", "_")
            entry = {
                "id":    m["mod_id"],
                "group": group,
                "text":  m["text"],
                "mod_tags": [],
                "spawn_weights": [{"tag": tag, "weight": m["weight"]}],
                "tier": tier_num,
                "required_level": m["req_level"],
            }
            if influence:
                entry["influence"] = influence
            final.append(entry)
    return final


def verify(result):
    print("\n=== Verification ===")
    checks = [
        ("ring",   "prefixes", "Increased Life",  None),
        ("ring",   "prefixes", "Cold Damage",      None),
        ("ring",   "suffixes", "Fire Resistance",  None),
        ("ring",   "suffixes", "Strength",         None),
        ("boots",  "prefixes", "Movement Speed",   None),
        ("belt",   "prefixes", "Increased Life",   None),
    ]
    for ic, slot, group, inf in checks:
        mods = [m for m in result[ic][slot] if m["group"] == group and m.get("influence") == inf]
        t1 = next((m for m in mods if m["tier"] == 1), None)
        total_w = sum(m["spawn_weights"][0]["weight"] for m in result[ic][slot] if not m.get("influence"))
        print(f"  {ic} {slot[:-2]} T1 {group}: {t1['text'] if t1 else 'MISSING'}")
    print()
    for ic in ("ring", "amulet", "belt", "helmet", "boots", "gloves", "body_armour"):
        pw = sum(m["spawn_weights"][0]["weight"] for m in result[ic]["prefixes"])
        sw = sum(m["spawn_weights"][0]["weight"] for m in result[ic]["suffixes"])
        np = len(result[ic]["prefixes"])
        ns = len(result[ic]["suffixes"])
        print(f"  {ic}: {np} prefixes w={pw} | {ns} suffixes w={sw}")


def main():
    repoе_mods = fetch_repoе_mods()
    poedb_rows = fetch_poedb_rows()
    print("Building items.json...")
    result = build_items_json(repoе_mods, poedb_rows)
    verify(result)
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    print(f"\nWrote {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
