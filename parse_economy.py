import json
import os

MOCK_DATA_PATH = "src/data/mockData.json"
LIVE_DATA_PATH = "src/data/live_economy.json"
OUTPUT_PATH = "src/data/active_economy.json"

def update_prices():
    print("Merging live poe.ninja prices into our app schema...")

    # 1. Load our baseline structural data (has the guaranteed_mod info)
    with open(MOCK_DATA_PATH, 'r') as f:
        economy_data = json.load(f)

    # 2. Load the raw poe.ninja dump
    with open(LIVE_DATA_PATH, 'r') as f:
        poe_ninja_data = json.load(f)

    # 3. Update Divine Orb Price
    for item in poe_ninja_data.get('currency', []):
        if item['currencyTypeName'] == 'Divine Orb':
            live_price = item.get('chaosEquivalent', 1)
            economy_data['basic_currency']['divine_orb']['cost'] = live_price
            print(f"Updated Divine Orb -> {live_price}c")
            break

    # 4. Update Essence Prices
    updated_essences = 0
    for item in poe_ninja_data.get('essences', []):
        live_name = item['name']
        live_price = item.get('chaosValue', 1)

        # Find the matching essence in our app's dictionary and update its cost
        for essence_key, essence_dict in economy_data['essences'].items():
            if essence_dict['name'] == live_name:
                economy_data['essences'][essence_key]['cost'] = live_price
                updated_essences += 1

    print(f"Updated {updated_essences} Essence prices.")

    # 5. Save the final, merged file for React to use
    with open(OUTPUT_PATH, 'w') as f:
        json.dump(economy_data, f, indent=2)
    
    print(f"Success! Final data saved to {OUTPUT_PATH}")

if __name__ == "__main__":
    update_prices()