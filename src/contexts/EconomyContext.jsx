import { createContext, useContext, useState, useEffect } from "react";
import bundledEconomy from "../data/active_economy.json";

const EconomyContext = createContext(bundledEconomy);

/**
 * Fetches /active_economy.json at runtime so the app always reflects the latest
 * prices written by update_data.py without needing a rebuild.
 * Falls back to the bundled static copy if the fetch fails.
 */
export function EconomyProvider({ children }) {
  const [economy, setEconomy] = useState(bundledEconomy);

  useEffect(() => {
    fetch("/active_economy.json")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setEconomy)
      .catch(() => {/* keep bundled fallback */});
  }, []);

  return (
    <EconomyContext.Provider value={economy}>
      {children}
    </EconomyContext.Provider>
  );
}

export function useEconomy() {
  return useContext(EconomyContext);
}
