import fetch_economy
import parse_economy

def run_pipeline():
    print("=== Starting PoE Economy ETL Pipeline ===")
    
    # Step 1: Extract (Safely fetch from poe.ninja)
    fetch_economy.fetch_poe_ninja_data()
    
    # Step 2: Transform & Load (Merge with our mockData structure)
    parse_economy.update_prices()
    
    print("=== Pipeline Complete! App is ready with live data. ===")

if __name__ == "__main__":
    run_pipeline()