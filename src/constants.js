export const INFLUENCES = [
  { id: "shaper",   label: "Shaper",   color: "#7bafdd" },
  { id: "elder",    label: "Elder",    color: "#c77be3" },
  { id: "crusader", label: "Crusader", color: "#e2c060" },
  { id: "hunter",   label: "Hunter",   color: "#7ec87e" },
  { id: "redeemer", label: "Redeemer", color: "#63c7b8" },
  { id: "warlord",  label: "Warlord",  color: "#e27b7b" },
];

export const ELEMENTAL_RESIST_GROUPS = new Set([
  "Fire Resistance",
  "Cold Resistance",
  "Lightning Resistance",
]);

export const SLOT_LABELS = {
  ring: "Ring",
  amulet: "Amulet",
  belt: "Belt",
  body_armour: "Body Armour",
  helmet: "Helmet",
  boots: "Boots",
  gloves: "Gloves",
};

export function freqColor(pct) {
  if (pct >= 70) return "#4CAF50";
  if (pct >= 40) return "#e2b659";
  if (pct >= 20) return "#6bbbe3";
  return "#888";
}
