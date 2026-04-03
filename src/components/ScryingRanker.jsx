import React, { useMemo, useState } from "react";
import mapData from "../data/map_cards.json";
import economyData from "../data/div_cards_economy.json";

export default function ScryingRanker() {
  const [expandedMap, setExpandedMap] = useState(null);

  const rankedMaps = useMemo(() => {
    if (!mapData?.maps || !economyData?.cards) return [];

    const maps = [];
    const cardPrices = economyData.cards;

    for (const [mapName, cards] of Object.entries(mapData.maps)) {
      let totalWeight = 0;
      let totalEV = 0;

      // First pass: calculate total map weight
      for (const card of cards) {
        totalWeight += card.weight;
      }

      // Second pass: calculate Expected Value (EV) per card drop
      const detailedCards = [];
      for (const card of cards) {
        const price = cardPrices[card.name]?.chaosValue || 0;
        const dropChance = totalWeight > 0 ? card.weight / totalWeight : 0;
        const cardEV = dropChance * price;
        
        totalEV += cardEV;

        detailedCards.push({
          name: card.name,
          weight: card.weight,
          dropChance: dropChance * 100, // percentage
          price,
          evContribution: cardEV,
        });
      }

      // Sort cards within the map by their EV contribution (most profitable first)
      detailedCards.sort((a, b) => b.evContribution - a.evContribution);

      maps.push({
        name: mapName,
        totalWeight,
        evPerDrop: totalEV,
        cards: detailedCards,
      });
    }

    // Sort all maps by highest EV
    return maps.sort((a, b) => b.evPerDrop - a.evPerDrop);
  }, []);

  const top10Maps = rankedMaps.slice(0, 10);

  return (
    <div className="p-6 max-w-4xl mx-auto text-slate-200">
      <h2 className="text-2xl font-bold mb-2 text-amber-500">Optimal Scrying Targets (Top 10)</h2>
      <p className="mb-6 text-slate-400">
        The most profitable maps to scry, based on the Expected Value (EV) in Chaos Orbs of a single divination card drop.
      </p>

      <div className="flex flex-col gap-3">
        {top10Maps.map((mapInfo, idx) => {
          const isExpanded = expandedMap === mapInfo.name;
          
          return (
            <div key={mapInfo.name} className="bg-slate-800 rounded-lg shadow-lg border border-slate-700 overflow-hidden flex flex-col">
              {/* Header / Clickable Area */}
              <div 
                className="flex justify-between items-center p-4 cursor-pointer hover:bg-slate-700 transition-colors"
                onClick={() => setExpandedMap(isExpanded ? null : mapInfo.name)}
              >
                <div className="flex items-center gap-4">
                  <span className="text-xl font-bold text-slate-500 w-8 text-right">#{idx + 1}</span>
                  <h3 className="text-lg font-semibold text-amber-400 leading-tight">{mapInfo.name}</h3>
                </div>
                <div className="flex items-center gap-4">
                  <span className="font-bold text-green-400 text-right shrink-0">
                    {mapInfo.evPerDrop.toFixed(2)}c <span className="text-xs text-slate-400 font-normal">EV</span>
                  </span>
                  <span className="text-slate-500 w-4 text-center">{isExpanded ? "▼" : "▶"}</span>
                </div>
              </div>
              
              {/* Expanded Content */}
              {isExpanded && (
                <div className="bg-slate-900 p-4 border-t border-slate-700 overflow-x-auto">
                  <table className="w-full text-sm text-left min-w-[500px]">
                    <thead>
                      <tr className="text-slate-400 border-b border-slate-700">
                        <th className="pb-2 font-medium">Divination Card</th>
                        <th className="pb-2 font-medium text-right">Market Value</th>
                        <th className="pb-2 font-medium text-right">Drop Chance</th>
                        <th className="pb-2 font-medium text-right">EV Contribution</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {mapInfo.cards.map((c) => (
                        <tr key={c.name} className="hover:bg-slate-800/50 transition-colors">
                          <td className="py-2 text-slate-300" title={`Weight: ${c.weight}`}>{c.name}</td>
                          <td className="py-2 text-right text-amber-200">{c.price.toFixed(1)}c</td>
                          <td className="py-2 text-right text-slate-400">{c.dropChance.toFixed(2)}%</td>
                          <td className="py-2 text-right text-green-400">+{c.evContribution.toFixed(2)}c</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}