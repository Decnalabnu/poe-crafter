import json
import os

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
GOLD_COSTS_FILE = os.path.join(os.path.dirname(__file__), 'faustus_gold_costs.json')
OUTPUT_FILE = os.path.join(os.path.dirname(__file__), 'card_weights.json')

# We need an anchor to convert Gold Cost -> Relative Weight.
# The Apothecary is historically known to have a drop weight of 13.
ANCHOR_CARD = "The Apothecary"
ANCHOR_WEIGHT = 13.0

def generate_weights():
    print("Generating Divination Card weights from Faustus gold costs...")
    
    if not os.path.exists(GOLD_COSTS_FILE):
        print(f"Error: Could not find {GOLD_COSTS_FILE}")
        print("Please create this file with a mapping like: {\"The Apothecary\": 85400}")
        return

    with open(GOLD_COSTS_FILE, 'r', encoding='utf-8') as f:
        gold_costs = json.load(f)

    if ANCHOR_CARD not in gold_costs:
        print(f"Error: Anchor card '{ANCHOR_CARD}' is missing from the gold costs file.")
        print(f"We need {ANCHOR_CARD} to establish the Gold -> Weight conversion ratio.")
        return

    # Faustus gold cost is inversely proportional to drop weight.
    # Gold_Cost * Weight = K (Constant)
    anchor_gold = gold_costs[ANCHOR_CARD]
    k_constant = anchor_gold * ANCHOR_WEIGHT
    
    print(f"Anchor: {ANCHOR_CARD} (Gold Cost: {anchor_gold}, Known Weight: {ANCHOR_WEIGHT})")
    print(f"Derived Scaling Constant (K) = {k_constant}")

    weights_out = {}
    for card_name, gold_cost in gold_costs.items():
        if gold_cost <= 0:
            continue
        
        # Inverse relation: Weight = K / Gold_Cost
        calculated_weight = k_constant / gold_cost
        
        # Round to nearest integer (weights are whole numbers in PoE)
        weights_out[card_name] = max(1, int(round(calculated_weight)))

    os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
    
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(weights_out, f, indent=2, sort_keys=True)

    print(f"Successfully generated weights for {len(weights_out)} cards!")
    print(f"Saved to {OUTPUT_FILE}")

if __name__ == "__main__":
    generate_weights()