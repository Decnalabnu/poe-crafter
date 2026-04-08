import json
import os

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
GOLD_COSTS_FILE = os.path.join(os.path.dirname(__file__), '..', 'data', 'faustus_gold_costs.json')
OUTPUT_FILE = os.path.join(os.path.dirname(__file__), '..', 'data', 'card_weights.json')

def generate_weights():
    print("Generating Divination Card weights from Faustus gold costs...")
    
    if not os.path.exists(GOLD_COSTS_FILE):
        print(f"Error: Could not find {GOLD_COSTS_FILE}")
        print("Please create this file with a mapping like: {\"The Apothecary\": 85400}")
        return

    with open(GOLD_COSTS_FILE, 'r', encoding='utf-8') as f:
        gold_costs = json.load(f)

    weights_out = {}
    for card_name, gold_cost in gold_costs.items():
        if gold_cost <= 0:
            continue
        
        # The intersection of the two curves is at exactly sqrt(13000) ≈ 114 gold.
        if gold_cost <= 114:
            # Common cards: 1 million / cost
            calculated_weight = 1_000_000 / gold_cost
        else:
            # Uncommon and Rare cards: 13 billion / (cost^3)
            calculated_weight = 13_000_000_000 / (gold_cost ** 3)
        
        # Round to nearest integer (weights are whole numbers in PoE)
        weights_out[card_name] = max(1, int(round(calculated_weight)))

    os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
    
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(weights_out, f, indent=2, sort_keys=True)

    print(f"Successfully generated weights for {len(weights_out)} cards!")
    print(f"Saved to {OUTPUT_FILE}")

if __name__ == "__main__":
    generate_weights()