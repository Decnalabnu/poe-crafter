import requests
import json
import os
import shutil

LEAGUE = "Mirage" 
OUTPUT_FILE = "src/data/active_economy.json"

def fetch_ninja_data(type, league):
    url = f"https://poe.ninja/api/data/itemoverview?league={league}&type={type}"
    try:
        response = requests.get(url)
        response.raise_for_status()
        return response.json().get("lines", [])
    except Exception as e:
        print(f"Failed to fetch {type}: {e}")
        return []

def update_economy():
    print(f"Fetching live prices for {LEAGUE} league...")
    
    currency_url = f"https://poe.ninja/api/data/currencyoverview?league={LEAGUE}&type=Currency"
    currency_data = requests.get(currency_url).json().get("lines", [])
    divine_price = next((item["chaosEquivalent"] for item in currency_data if item["currencyTypeName"] == "Divine Orb"), 150)

    essence_lines = fetch_ninja_data("Essence", LEAGUE)
    essence_prices = {}
    for item in essence_lines:
        name = item.get("name")
        price = item.get("chaosValue")
        if name and "Deafening" in name or name in ["Essence of Horror", "Essence of Delirium", "Essence of Hysteria", "Essence of Insanity"]:
            clean_id = name.lower().replace(" ", "_")
            # We are saving ONLY the price number here
            essence_prices[clean_id] = price

    fossil_lines = fetch_ninja_data("Fossil", LEAGUE)
    fossil_prices = {}
    for item in fossil_lines:
        name = item.get("name")
        price = item.get("chaosValue")
        if name:
            clean_id = name.lower().replace(" " , "_").replace("_fossil", "")
            fossil_prices[clean_id] = price

    resonator_lines = fetch_ninja_data("Resonator", LEAGUE)
    resonator_prices = {}
    resonator_map = {
        "Primitive Chaotic Resonator": "primitive_chaotic_resonator",
        "Potent Chaotic Resonator": "potent_chaotic_resonator",
        "Powerful Chaotic Resonator": "powerful_chaotic_resonator",
        "Prime Chaotic Resonator": "prime_chaotic_resonator",
    }
    for item in resonator_lines:
        name = item.get("name")
        price = item.get("chaosValue")
        if name in resonator_map:
            resonator_prices[resonator_map[name]] = price

    economy_data = {
        "league": LEAGUE,
        "divine_price": divine_price,
        "essences": essence_prices,
        "fossils": fossil_prices,
        "resonators": resonator_prices
    }

    os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
    with open(OUTPUT_FILE, "w") as f:
        json.dump(economy_data, f, indent=2)

    # Mirror to public/ so the running app can fetch fresh values without a rebuild
    public_path = "public/active_economy.json"
    os.makedirs("public", exist_ok=True)
    shutil.copy2(OUTPUT_FILE, public_path)

    print(f"Economy updated! Divine Price: {divine_price}c")

if __name__ == "__main__":
    update_economy()