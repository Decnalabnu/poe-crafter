import json
import os
import requests
import re
from collections import defaultdict
from datetime import datetime, timezone

WIKI_API_URL = "https://www.poewiki.net/api.php"
OUTPUT_FILE = os.path.join(os.path.dirname(__file__), 'src', 'data', 'map_cards.json')
# We will look for a local weights file, if you have one.
WEIGHTS_FILE = os.path.join(os.path.dirname(__file__), 'src', 'data', 'card_weights.json')

HEADERS = {
    "User-Agent": "poe-crafter-scrying-module/1.0 (personal research tool)"
}

def load_weights():
    """Loads datamined card weights if you have them downloaded."""
    if os.path.exists(WEIGHTS_FILE):
        with open(WEIGHTS_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    return {}

def fetch_cards_from_wiki():
    """
    Uses the poewiki.net Cargo API to fetch all Divination Cards and 
    the areas they drop in.
    """
    print("Fetching Divination Card locations from poewiki.net...")
    session = requests.Session()
    session.headers.update(HEADERS)
    
    all_cards = []
    offset = 0
    limit = 500
    
    while True:
        params = {
            "action": "cargoquery",
            "format": "json",
            "tables": "items",
            "fields": "name, drop_areas",
            "where": 'class="Divination Card"',
            "limit": limit,
            "offset": offset
        }
        
        response = session.get(WIKI_API_URL, params=params)
        response.raise_for_status()
        
        data = response.json()
        results = data.get("cargoquery", [])
        
        if not results:
            break
            
        all_cards.extend([item["title"] for item in results])
        offset += limit
        print(f"  Fetched {len(all_cards)} cards so far...")
        
    return all_cards

def process_card_data(wiki_cards, weights):
    """
    Inverts the Wiki data from Card -> Maps into Map -> Cards,
    filtering out campaign zones since we only care about Maps for scrying.
    """
    map_drops = defaultdict(list)
    
    for card in wiki_cards:
        card_name = card.get("name")
        # Cargo API replaces underscores with spaces in JSON keys unless aliased
        drop_areas_str = card.get("drop_areas") or card.get("drop areas") or ""
        
        if not card_name or not drop_areas_str:
            continue
            
        # The wiki returns drop areas as a comma-separated string
        areas = [area.strip() for area in drop_areas_str.split(",")]
        
        for area in areas:
            # The Wiki uses internal Area IDs like 'MapWorldsJungleValley' or 'MapAtlasToxicSewer'
            if "Map" in area and not area.startswith("MapDevice"):
                # Strip the prefix to get 'JungleValley'
                clean_id = re.sub(r'^(MapWorlds|MapAtlas|MapZana|MapTier\d+|Map)', '', area)
                # Inject spaces before capital letters to get 'Jungle Valley'
                clean_map_name = re.sub(r'([a-z])([A-Z])', r'\1 \2', clean_id).strip()

                # Strip " Map" suffix if the Wiki returns plain English names (e.g. "Jungle Valley Map")
                if clean_map_name.endswith(" Map"):
                    clean_map_name = clean_map_name[:-4]

                # Clean up trailing underscores from Wiki weirdness (e.g., "Racecourse_")
                clean_map_name = clean_map_name.strip("_")

                # Lowercase common prepositions ("Chambers Of Impurity" -> "Chambers of Impurity")
                lowercase_words = {"Of", "The", "In", "And", "To", "At", "On", "A"}
                parts = clean_map_name.split(" ")
                clean_map_name = " ".join(
                    p.lower() if i > 0 and p in lowercase_words else p
                    for i, p in enumerate(parts)
                )

                # Filter out non-scryable maps (T17s, Guardians, Uniques, Fragments)
                excluded_exact = {"Sanctuary", "Citadel", "Fortress", "Abomination", "Ziggurat", "Chimera", "Hydra", "Minotaur", "Phoenix", "Vaal Temple"}
                if clean_map_name in excluded_exact:
                    continue
                if any(x in clean_map_name for x in ["Unique", "Synthesis", "Side Area", "Atziri"]):
                    continue

                # Prevent duplicates if the wiki lists multiple map versions (e.g. MapWorlds and MapAtlas)
                if not any(c["name"] == card_name for c in map_drops[clean_map_name]):
                    weight = weights.get(card_name)
                    if weight is None:
                        if not hasattr(process_card_data, "warned"):
                            process_card_data.warned = set()
                        if card_name not in process_card_data.warned:
                            print(f"Warning: '{card_name}' missing from weights, defaulting to 0.")
                            process_card_data.warned.add(card_name)
                        weight = 0
                    
                    map_drops[clean_map_name].append({
                        "name": card_name,
                        "weight": weight
                    })
                
    return map_drops

def main():
    weights = load_weights()
    if not weights:
        print("Warning: No card_weights.json found. Defaulting missing weights to 0.")
        
    wiki_cards = fetch_cards_from_wiki()
    map_drops = process_card_data(wiki_cards, weights)
    
    # Sort cards in each map by weight (highest first)
    for map_name in map_drops:
        map_drops[map_name] = sorted(map_drops[map_name], key=lambda x: x["weight"], reverse=True)
        
    output = {
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "total_maps": len(map_drops),
        "maps": map_drops
    }
    
    os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(output, f, indent=2)
        
    print(f"Successfully processed and saved {len(map_drops)} maps to {OUTPUT_FILE}")

if __name__ == "__main__":
    main()