/** AI 主色的唯一来源；顺序也是首次预填和新增 AI 时的取色顺序。 */
export const PALETTE = [
  { id: "orange", color: "#d97757" },
  { id: "mint", color: "#a7f3d0" },
  { id: "yellow", color: "#f3c56b" },
  { id: "blue", color: "#6f8cff" },
  { id: "pink", color: "#f4a6cd" },
  { id: "teal", color: "#3fbfae" },
  { id: "lime", color: "#d3e67c" },
  { id: "lavender", color: "#c4a6f7" },
  { id: "rose", color: "#e8799b" },
  { id: "sky", color: "#7fd4ee" },
  { id: "magenta", color: "#d77fd8" },
  { id: "ocean", color: "#4aa3df" },
] as const;

export type PaletteId = (typeof PALETTE)[number]["id"];

export function isPaletteId(value: unknown): value is PaletteId {
  return typeof value === "string" && PALETTE.some((entry) => entry.id === value);
}
