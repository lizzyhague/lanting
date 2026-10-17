/** The single source of AI primary colors; the order is also the order colors are picked for initial prefill. label is the English name; the browser names colors by id for screen readers. */
export const PALETTE = [
  { id: "orange", label: "Orange", color: "#d97757" },
  { id: "mint", label: "Mint", color: "#a7f3d0" },
  { id: "yellow", label: "Yellow", color: "#f3c56b" },
  { id: "blue", label: "Blue", color: "#6f8cff" },
  { id: "pink", label: "Pink", color: "#f4a6cd" },
  { id: "teal", label: "Teal", color: "#3fbfae" },
  { id: "lime", label: "Lime", color: "#d3e67c" },
  { id: "lavender", label: "Lavender", color: "#c4a6f7" },
  { id: "rose", label: "Rose", color: "#e8799b" },
  { id: "sky", label: "Sky blue", color: "#7fd4ee" },
  { id: "magenta", label: "Magenta", color: "#d77fd8" },
  { id: "ocean", label: "Ocean blue", color: "#4aa3df" },
] as const;

export type PaletteId = (typeof PALETTE)[number]["id"];

export function isPaletteId(value: unknown): value is PaletteId {
  return typeof value === "string" && PALETTE.some((entry) => entry.id === value);
}
