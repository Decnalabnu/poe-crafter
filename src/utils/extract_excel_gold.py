import json
import os
import pandas as pd

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
# Finds the path to your Documents folder automatically
EXCEL_FILE = os.path.expanduser(r"~\Documents\gog.xlsx")
OUTPUT_FILE = os.path.join(os.path.dirname(__file__), 'faustus_gold_costs.json')

# *** YOU MAY NEED TO CHANGE THESE IF HIS SPREADSHEET HEADERS ARE DIFFERENT ***
NAME_COLUMN = "Card"                 # The exact column header for the card name
GOLD_COLUMN = "Gold Cost Per Div"    # The exact column header for the Faustus gold cost

def main():
    print(f"Attempting to read Excel file at: {EXCEL_FILE}")
    if not os.path.exists(EXCEL_FILE):
        print("Error: Could not find the Excel file. Please double-check the file name and make sure it's in Documents.")
        return

    try:
        # Read all sheets to automatically find the one with the right columns
        print("Scanning spreadsheet tabs for Divination Card data...")
        df_dict = pd.read_excel(EXCEL_FILE, sheet_name=None)
        df = None
        
        for sheet_name, sheet_df in df_dict.items():
            if NAME_COLUMN in sheet_df.columns and GOLD_COLUMN in sheet_df.columns:
                df = sheet_df
                print(f"  -> Found required columns in tab: '{sheet_name}'")
                break
                
        if df is None:
            print(f"Error: Could not find the columns '{NAME_COLUMN}' and '{GOLD_COLUMN}' in any tab.")
            return

        gold_costs = {}
        for index, row in df.iterrows():
            card_name = str(row[NAME_COLUMN]).strip()
            try:
                # Convert the gold cost to an integer
                gold_cost = int(float(row[GOLD_COLUMN]))
                if gold_cost > 0 and card_name != "nan":
                    gold_costs[card_name] = gold_cost
            except (ValueError, TypeError):
                continue # Skip rows that are empty or have text instead of numbers

        os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
        with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
            json.dump(gold_costs, f, indent=2, sort_keys=True)
            
        print(f"Success! Extracted {len(gold_costs)} card gold costs.")
    except Exception as e:
        print(f"An error occurred while reading the Excel file: {e}")

if __name__ == "__main__":
    main()