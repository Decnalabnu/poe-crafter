import json
import os
from datetime import datetime, timezone

DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
MAP_CARDS_FILE = os.path.join(DATA_DIR, "map_cards.json")
WEIGHTS_FILE = os.path.join(DATA_DIR, "card_weights.json")


def main():
    with open(MAP_CARDS_FILE, "r", encoding="utf-8") as f:
        map_cards = json.load(f)
    with open(WEIGHTS_FILE, "r", encoding="utf-8") as f:
        weights = json.load(f)

    updated = 0
    unchanged = 0
    missing = 0
    for map_name, cards in map_cards["maps"].items():
        for card in cards:
            new_w = weights.get(card["name"])
            if new_w is None:
                missing += 1
                continue
            if card["weight"] != new_w:
                card["weight"] = new_w
                updated += 1
            else:
                unchanged += 1
        cards.sort(key=lambda c: c["weight"], reverse=True)

    map_cards["updated_at"] = datetime.now(timezone.utc).isoformat()

    with open(MAP_CARDS_FILE, "w", encoding="utf-8") as f:
        json.dump(map_cards, f, indent=2)

    print(
        f"Entries: updated={updated} unchanged={unchanged} "
        f"missing_from_weights={missing}"
    )
    print(f"Wrote {MAP_CARDS_FILE}")


if __name__ == "__main__":
    main()
