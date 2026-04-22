import csv
import io
import json
import os
import sys
import urllib.request

SHEET_ID = "1J9NyhPFm3DdoKDfamykTaSuX9Z1WyF5ZVyyjO2_rngs"
SHEET_NAME = "Weights"
PATCH_COLUMN = "3.28"

DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
GOLD_COSTS_FILE = os.path.join(DATA_DIR, "faustus_gold_costs.json")
OUTPUT_FILE = os.path.join(DATA_DIR, "card_weights.json")


def faustus_weight(gold_cost):
    if gold_cost <= 0:
        return None
    if gold_cost <= 114:
        return max(1, int(round(1_000_000 / gold_cost)))
    return max(1, int(round(13_000_000_000 / (gold_cost ** 3))))


def fetch_sheet_csv():
    url = (
        f"https://docs.google.com/spreadsheets/d/{SHEET_ID}"
        f"/gviz/tq?tqx=out:csv&sheet={SHEET_NAME}"
    )
    print(f"Fetching {SHEET_NAME} tab from stacked-decks spreadsheet...")
    with urllib.request.urlopen(url, timeout=30) as resp:
        return resp.read().decode("utf-8")


def parse_sheet(csv_text, patch):
    rows = list(csv.reader(io.StringIO(csv_text)))
    header = rows[0]
    try:
        col_idx = header.index(patch)
    except ValueError:
        raise SystemExit(f"Patch column '{patch}' not found in sheet header: {header}")

    weights = {}
    for row in rows[2:]:
        if not row or not row[0] or row[0] == "Sample Size":
            continue
        name = row[0]
        raw = row[col_idx] if col_idx < len(row) else ""
        if raw == "" or raw is None:
            continue
        try:
            w = int(raw)
        except ValueError:
            try:
                w = int(round(float(raw)))
            except ValueError:
                continue
        weights[name] = w
    return weights


def faustus_fallback():
    if not os.path.exists(GOLD_COSTS_FILE):
        return {}
    with open(GOLD_COSTS_FILE, "r", encoding="utf-8") as f:
        costs = json.load(f)
    out = {}
    for name, cost in costs.items():
        w = faustus_weight(cost)
        if w is not None:
            out[name] = w
    return out


def main():
    sheet_weights = parse_sheet(fetch_sheet_csv(), PATCH_COLUMN)
    fallback = faustus_fallback()

    merged = {}
    merged.update(fallback)
    merged.update(sheet_weights)  # sheet wins

    sheet_only = sum(1 for n in sheet_weights if n not in fallback)
    fallback_only = sum(1 for n in fallback if n not in sheet_weights)
    both = sum(1 for n in sheet_weights if n in fallback)

    print(
        f"Sheet {PATCH_COLUMN}: {len(sheet_weights)} cards · "
        f"Faustus fallback: {len(fallback)} cards"
    )
    print(
        f"  from sheet only: {sheet_only} · from fallback only: {fallback_only} · "
        f"both (sheet wins): {both}"
    )
    print(f"  merged total: {len(merged)} cards")

    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(merged, f, indent=2, sort_keys=True)
    print(f"Wrote {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
