import requests
import json
import time
import os

# Configuration
LEAGUE = "Standard" # Change this to the current active league (e.g., "Necropolis")
CACHE_FILE = "src/data/live_economy.json"
CACHE_EXPIRATION_SECONDS = 3600  # 1 Hour

# Good Netiquette: Always tell the API owner who you are
HEADERS = {
    "User-Agent": "Personal PoE EV Calculator - Hobby Project - Contact: your.email@example.com"
}

def is_cache_valid():
    """Checks if our local file exists and is less than 1 hour old."""
    if not os.path.exists(CACHE_FILE):
        return False
    
    file_age = time.time() - os.path.getmtime(CACHE_FILE)
    if file_age < CACHE_EXPIRATION_SECONDS:
        print(f"Cache is still fresh ({int(file_age / 60)} mins old). Skipping API call.")
        return True
    return False

def fetch_poe_ninja_data():
    """Safely pulls data from poe.ninja with rate-limiting delays."""
    
    # 1. Check our safety lock
    if is_cache_valid():
        return

    print("Fetching fresh data from poe.ninja...")
    
    # poe.ninja uses different base URLs depending on the item type
    base_currency_url = f"https://poe.ninja/api/data/currencyoverview?league={LEAGUE}&type="
    base_item_url = f"https://poe.ninja/api/data/itemoverview?league={LEAGUE}&type="

    raw_data = {}

    try:
        # Request 1: Basic Currency (Chaos, Divines, Annuls)
        print("Pulling Currency...")
        response = requests.get(base_currency_url + "Currency", headers=HEADERS)
        response.raise_for_status()
        raw_data['currency'] = response.json()['lines']
        
        # Rule 2: Sleep to prevent rate-limiting bans
        time.sleep(2)

        # Request 2: Essences
        print("Pulling Essences...")
        response = requests.get(base_item_url + "Essence", headers=HEADERS)
        response.raise_for_status()
        raw_data['essences'] = response.json()['lines']

        # Save the raw dump to our local file
        # We ensure the src/data directory exists
        os.makedirs(os.path.dirname(CACHE_FILE), exist_ok=True)
        with open(CACHE_FILE, "w") as f:
            json.dump(raw_data, f, indent=2)
            
        print("Successfully saved live_economy.json!")

    except requests.exceptions.RequestException as e:
        print(f"API Request Failed: {e}")

if __name__ == "__main__":
    fetch_poe_ninja_data()