import json
import os
import requests
from datetime import datetime, timezone

# Make sure this matches your active league
LEAGUE = "Mirage"
URL = f"https://poe.ninja/api/data/itemoverview?league={LEAGUE}&type=DivinationCard"
OUTPUT_FILE = os.path.join(os.path.dirname(__file__), 'src', 'data', 'div_cards_economy.json')

def fetch_card_prices():
    print(f"Fetching Divination Card prices for {LEAGUE} league from poe.ninja...")
    response = requests.get(URL)
    response.raise_for_status()
    
    data = response.json()
    cards = {}
    
    for item in data.get('lines', []):
        name = item.get('name')
        chaos_value = item.get('chaosValue')
        
        if name and chaos_value is not None:
            cards[name] = {
                "chaosValue": chaos_value,
                "divineValue": item.get('divineValue', 0),
                "stackSize": item.get('stackSize', 1)
            }
            
    return cards

def main():
    try:
        card_data = fetch_card_prices()
        
        output = {
            "league": LEAGUE,
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "cards": card_data
        }
        
        os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
        with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
            json.dump(output, f, indent=2)
            
        print(f"Successfully saved {len(card_data)} card prices to {OUTPUT_FILE}")
    except Exception as e:
        print(f"Error fetching card data: {e}")

if __name__ == "__main__":
    main()