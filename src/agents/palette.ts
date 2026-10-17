/** The single source of AI primary colors; the order is also the order colors are picked for initial prefill. label is for screen readers only and isn't shown. */
export const PALETTE = [
  { id: "orange", label: "橙", color: "#d97757" },
  { id: "mint", label: "薄荷绿", color: "#a7f3d0" },
  { id: "yellow", label: "黄", color: "#f3c56b" },
  { id: "blue", label: "蓝", color: "#6f8cff" },
  { id: "pink", label: "粉", color: "#f4a6cd" },
  { id: "teal", label: "青绿", color: "#3fbfae" },
  { id: "lime", label: "黄绿", color: "#d3e67c" },
  { id: "lavender", label: "薰衣草紫", color: "#c4a6f7" },
  { id: "rose", label: "玫红", color: "#e8799b" },
  { id: "sky", label: "天蓝", color: "#7fd4ee" },
  { id: "magenta", label: "品红", color: "#d77fd8" },
  { id: "ocean", label: "海蓝", color: "#4aa3df" },
] as const;

export type PaletteId = (typeof PALETTE)[number]["id"];

export function isPaletteId(value: unknown): value is PaletteId {
  return typeof value === "string" && PALETTE.some((entry) => entry.id === value);
}
