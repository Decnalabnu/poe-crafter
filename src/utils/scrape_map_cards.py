import json
import os
import requests
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
        drop_areas_str = card.get("drop_areas", "")
        
        if not card_name or not drop_areas_str:
            continue
            
        # The wiki returns drop areas as a comma-separated string
        areas = [area.strip() for area in drop_areas_str.split(",")]
        
        for area in areas:
            # We only care about Maps for the scrying module
            if " Map" in area:
                # Clean up the map name (e.g., "Jungle Valley Map" -> "Jungle Valley")
                clean_map_name = area.replace(" Map", "")
                
                # Get the datamined weight, default to a low value if unknown
                card_weight = weights.get(card_name, 100) 
                
                map_drops[clean_map_name].append({
                    "name": card_name,
                    "weight": card_weight
                })
                
    return map_drops

def main():
    weights = load_weights()
    if not weights:
        print("Warning: No card_weights.json found. Defaulting all weights to 100.")
        
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