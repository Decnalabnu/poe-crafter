import requests
import json
import os
import re

REPOE_MODS_URL = "https://raw.githubusercontent.com/brather1ng/RePoE/master/RePoE/data/mods.json"
REPOE_TRANSLATIONS_URL = "https://raw.githubusercontent.com/brather1ng/RePoE/master/RePoE/data/stat_translations.json"
REPOE_ESSENCES_URL = "https://raw.githubusercontent.com/brather1ng/RePoE/master/RePoE/data/essences.json"

ITEMS_OUTPUT_FILE = "src/data/items.json"
ESSENCES_OUTPUT_FILE = "src/data/essences.json"

ITEM_TAGS = ["ring", "amulet", "belt", "body_armour", "boots", "gloves", "helmet"]

# Maps RePoE spawn-weight codename → display name used in items.json "influence" field
INFLUENCE_CODENAMES = {
    "shaper":     "shaper",
    "elder":      "elder",
    "crusader":   "crusader",
    "basilisk":   "hunter",
    "eyrie":      "redeemer",
    "adjudicator": "warlord",
}

def fetch_data(url):
    response = requests.get(url)
    response.raise_for_status()
    return response.json()

def build_translation_dicts(raw_translations):
    trans_dict_multi = {}
    trans_dict_single = {}
    for block in raw_translations:
        if not block.get("ids") or not block.get("English"):
            continue
        ids_tuple = tuple(block["ids"])
        best_string = block["English"][0].get("string", "")
        trans_dict_multi[ids_tuple] = best_string
        if len(ids_tuple) == 1:
            trans_dict_single[ids_tuple[0]] = best_string
    return trans_dict_multi, trans_dict_single

def get_translated_string(stats_list, trans_dict_multi, trans_dict_single):
    if not stats_list: return ""
    stat_ids = tuple(s.get("id", "") for s in stats_list)
    values = [f"{s.get('min', 0)}" if s.get('min', 0) == s.get('max', 0) else f"({s.get('min', 0)}-{s.get('max', 0)})" for s in stats_list]

    if stat_ids in trans_dict_multi:
        trans_str = trans_dict_multi[stat_ids]
        for i, val in enumerate(values):
            trans_str = re.sub(r"\{" + str(i) + r"[^}]*\}", val, trans_str)
        return trans_str.replace("+-", "-") 

    translated_lines = []
    skip_next = False
    for i in range(len(stat_ids)):
        if skip_next:
            skip_next = False
            continue
        if i + 1 < len(stat_ids):
            pair_ids = (stat_ids[i], stat_ids[i+1])
            if pair_ids in trans_dict_multi:
                trans_str = trans_dict_multi[pair_ids]
                trans_str = re.sub(r"\{0[^}]*\}", values[i], trans_str)
                trans_str = re.sub(r"\{1[^}]*\}", values[i+1], trans_str)
                translated_lines.append(trans_str.replace("+-", "-"))
                skip_next = True
                continue
        single_str = trans_dict_single.get(stat_ids[i], "")
        if single_str:
            single_str = re.sub(r"\{0[^}]*\}", values[i], single_str)
            translated_lines.append(single_str.replace("+-", "-"))
    return " / ".join(translated_lines)

def assign_tiers_to_pool(mod_list):
    """
    Within each mod group, assign tier numbers.
    T1 = best = highest required_level (tiebreak: lowest weight = rarer = better).
    The _required_level field is dropped from the final output.
    """
    from collections import defaultdict
    group_indices = defaultdict(list)
    for i, mod in enumerate(mod_list):
        group_indices[mod["group"]].append(i)

    result = list(mod_list)
    for indices in group_indices.values():
        sorted_indices = sorted(
            indices,
            key=lambda i: (
                -result[i].get("_required_level", 0),
                result[i]["spawn_weights"][0].get("weight", 0),
            ),
        )
        for tier, idx in enumerate(sorted_indices, 1):
            result[idx] = {**result[idx], "tier": tier}

    return [{k: v for k, v in mod.items() if k != "_required_level"} for mod in result]


def build_databases():
    print("Downloading RePoE Databases...")
    raw_mods = fetch_data(REPOE_MODS_URL)
    raw_translations = fetch_data(REPOE_TRANSLATIONS_URL)
    raw_essences = fetch_data(REPOE_ESSENCES_URL)

    trans_dict_multi, trans_dict_single = build_translation_dicts(raw_translations)
    final_db = {tag: {"prefixes": [], "suffixes": []} for tag in ITEM_TAGS}

    # 1. PARSE ESSENCES FIRST to find the 0-weight VIP mods
    print("Building Endgame Essences Database...")
    essence_db = {}
    class_map = { "Amulet": "amulet", "Belt": "belt", "Body Armour": "body_armour", "Boots": "boots", "Gloves": "gloves", "Helmet": "helmet", "Ring": "ring" }
    
    essence_mods_map = {} # Tracks which mods must be saved { mod_id: set(tags) }

    for ess_data in raw_essences.values():
        name = ess_data.get("name", "")
        if not name:
            continue
            
        is_endgame = any(keyword in name for keyword in ["Deafening", "Horror", "Delirium", "Hysteria", "Insanity"])
        if not is_endgame:
            continue
            
        clean_id = name.lower().replace(" ", "_")
        guaranteed_mods = { class_map[k]: v for k, v in ess_data.get("mods", {}).items() if k in class_map }
        
        # Add these guaranteed mods to the VIP list
        for tag, mod_id in guaranteed_mods.items():
            if mod_id not in essence_mods_map:
                essence_mods_map[mod_id] = set()
            essence_mods_map[mod_id].add(tag)
            
        essence_db[clean_id] = { "name": name, "cost": 3, "guaranteed_mods": guaranteed_mods }

    # 2. PARSE MODS AND SAVE THE VIPs
    print("Building Item Modifiers Database...")
    for mod_id, mod_data in raw_mods.items():
        if mod_data.get("domain") != "item" or mod_data.get("generation_type") not in ["prefix", "suffix"]:
            continue
            
        mod_tags = [str(t).lower() for t in mod_data.get("types", [])]
        mod_name = mod_data.get("name", "")
        mod_group_raw = mod_data.get("type", "") or mod_data.get("group", "Unknown Group")
        mod_group = re.sub(r'(?<=[a-z])(?=[A-Z])', ' ', mod_group_raw).replace("_", " ").title()
        
        translated_text = get_translated_string(mod_data.get("stats", []), trans_dict_multi, trans_dict_single)
        final_text = f"{translated_text} [{mod_name}]" if mod_name and translated_text else (translated_text or f"{mod_name} ({mod_group})")
            
        spawn_weights = mod_data.get("spawn_weights", [])
        default_weight = next((sw["weight"] for sw in spawn_weights if sw["tag"] == "default"), 0)

        for tag in ITEM_TAGS:
            # Specific tag entry takes priority; fall back to 'default' (applies to all item types)
            specific = next((sw["weight"] for sw in spawn_weights if sw["tag"] == tag), None)
            tag_weight = specific if specific is not None else default_weight

            # Check if it's naturally rollable OR if it's an Essence exclusive mod
            is_essence_mod = mod_id in essence_mods_map and tag in essence_mods_map[mod_id]

            if tag_weight > 0 or is_essence_mod:
                formatted_mod = {
                    "id": mod_id,
                    "group": mod_group,
                    "text": final_text,
                    "mod_tags": mod_tags,
                    "spawn_weights": [{"tag": tag, "weight": tag_weight}],
                    "_required_level": mod_data.get("required_level", 0),
                }
                if mod_data.get("generation_type") == "prefix":
                    final_db[tag]["prefixes"].append(formatted_mod)
                else:
                    final_db[tag]["suffixes"].append(formatted_mod)

            # Check influence-specific variants: tags like "ring_shaper", "ring_elder", etc.
            for codename, display_name in INFLUENCE_CODENAMES.items():
                inf_tag = f"{tag}_{codename}"
                inf_weight = next((sw["weight"] for sw in spawn_weights if sw["tag"] == inf_tag), 0)
                if inf_weight > 0:
                    influenced_mod = {
                        "id": mod_id,
                        "group": mod_group,
                        "text": final_text,
                        "mod_tags": mod_tags,
                        "spawn_weights": [{"tag": inf_tag, "weight": inf_weight}],
                        "_required_level": mod_data.get("required_level", 0),
                        "influence": display_name,
                    }
                    if mod_data.get("generation_type") == "prefix":
                        final_db[tag]["prefixes"].append(influenced_mod)
                    else:
                        final_db[tag]["suffixes"].append(influenced_mod)

    print("Assigning tiers...")
    for tag in ITEM_TAGS:
        final_db[tag]["prefixes"] = assign_tiers_to_pool(final_db[tag]["prefixes"])
        final_db[tag]["suffixes"] = assign_tiers_to_pool(final_db[tag]["suffixes"])

    os.makedirs(os.path.dirname(ITEMS_OUTPUT_FILE), exist_ok=True)
    with open(ITEMS_OUTPUT_FILE, "w", encoding="utf-8") as f: json.dump(final_db, f, indent=2, ensure_ascii=False)
    with open(ESSENCES_OUTPUT_FILE, "w", encoding="utf-8") as f: json.dump(essence_db, f, indent=2, ensure_ascii=False)

    print("Success! Built databases with tier assignments.")

if __name__ == "__main__":
    build_databases()