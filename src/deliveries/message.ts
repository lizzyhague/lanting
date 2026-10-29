import type { DeliveryFailure, DeliveryResult } from "./prepare.ts";

const FAILURE_REASONS: Record<DeliveryFailure, string> = {
  interrupted: "Reply interrupted; not delivered",
  too_many: "More than 100 files in one reply",
  invalid_path: "An absolute file path is required",
  outside_root: "File is outside the group's working directory",
  not_file: "Only individual regular files can be delivered",
  sensitive_file: "Sensitive file name",
  too_large: "File exceeds 25 MiB",
  file_changed: "File changed while being saved",
  unavailable: "File is missing or cannot be read",
  upload_failed: "Could not save the delivery copy",
};

/** Escape filenames as data, keeping platform tags flat even with unusual filenames. */
function quoted(value: string): string {
  return JSON.stringify(value).replace(/</gu, "\\u003c").replace(/>/gu, "\\u003e");
}

export function deliveryMessage(agent: string, deliveries: readonly DeliveryResult[]): string {
  const results = deliveries.map((delivery) => delivery.status === "available"
    ? `${quoted(delivery.name)}: delivered`
    : `${quoted(delivery.name)}: failed (${FAILURE_REASONS[delivery.reason]})`);
  return `<lanting>\nDelivery results for ${quoted(agent)}: ${results.join("; ")}\n</lanting>`;
}
