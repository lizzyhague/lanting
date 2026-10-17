/** Interface text from i18n.js; looked up on each call so a language switch applies to the next render. */
const t = (key, params) => globalThis.lantingI18n ? globalThis.lantingI18n.t(key, params) : key;

export const DISPLAY_TIMEZONE_KEY = "lanting.display-timezone";
export const DEFAULT_DISPLAY_TIMEZONE = "Asia/Shanghai";
export const DISPLAY_TIMEZONES = Object.freeze([
  "device",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Europe/London",
  "Europe/Paris",
  "America/New_York",
  "America/Los_Angeles",
]);
let activeDisplayTimezone = null;

function timezoneStorage(storage) {
  if (storage) return storage;
  try { return globalThis.localStorage ?? null; }
  catch { return null; }
}

export function normalizeDisplayTimezone(value) {
  return DISPLAY_TIMEZONES.includes(value) ? value : DEFAULT_DISPLAY_TIMEZONE;
}

export function loadDisplayTimezone(storage) {
  if (!storage && activeDisplayTimezone !== null) return activeDisplayTimezone;
  const store = timezoneStorage(storage);
  let next = DEFAULT_DISPLAY_TIMEZONE;
  if (store) {
    try { next = normalizeDisplayTimezone(store.getItem(DISPLAY_TIMEZONE_KEY)); }
    catch { /* Use the default when storage is unavailable. */ }
  }
  if (!storage) activeDisplayTimezone = next;
  return next;
}

export function saveDisplayTimezone(value, storage) {
  const next = normalizeDisplayTimezone(value);
  if (!storage) activeDisplayTimezone = next;
  const store = timezoneStorage(storage);
  if (!store) return next;
  try { store.setItem(DISPLAY_TIMEZONE_KEY, next); }
  catch { /* The current page can still use the selected value. */ }
  return next;
}

export function reloadDisplayTimezone() {
  activeDisplayTimezone = null;
  return loadDisplayTimezone();
}

export function createCandidates(settings) {
  return settings.agents.filter((agent) => agent.complete);
}

export function effectiveCreateMembers(createMembers, settings) {
  const candidates = createCandidates(settings);
  if (createMembers === null) return candidates.map((agent) => agent.id);
  const selected = new Set(createMembers);
  return candidates.filter((agent) => selected.has(agent.id)).map((agent) => agent.id);
}

export function colorChoices(palette, agents, selfId) {
  const occupied = new Set(agents
    .filter((agent) => agent.id !== selfId && agent.color !== null)
    .map((agent) => agent.color));
  return palette.map((entry) => ({ ...entry, disabled: occupied.has(entry.id) }));
}

export function kindOptions(agentKinds, currentKind) {
  return [
    { value: "", label: "", disabled: false, selected: currentKind === null },
    ...agentKinds.map((entry) => ({
      value: entry.kind,
      label: entry.displayName,
      disabled: !entry.configured,
      selected: entry.kind === currentKind,
    })),
  ];
}

export function moveAgent(ids, id, delta) {
  const next = [...ids];
  const from = next.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= next.length) return next;
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

export function selectionAfterRemove(ids, removedId) {
  const index = ids.indexOf(removedId);
  if (index < 0) return null;
  const remaining = ids.filter((id) => id !== removedId);
  return remaining[index] ?? remaining[index - 1] ?? null;
}

export function settingsCatalogKey(id, kind) {
  return `${id}:${kind ?? ""}`;
}

export function paletteColor(palette, id) {
  return palette.find((entry) => entry.id === id)?.color ?? null;
}

export function memberSupports(group, agent, feature) {
  return group.features[agent].includes(feature);
}

export function kindSupports(agentKinds, kind, feature) {
  return agentKinds.find((entry) => entry.kind === kind)?.features.includes(feature) ?? false;
}

/** Members selectable for AI usage: the CLI is connected and supports usage. */
export function usageCandidates(group) {
  return group.members.filter((member) =>
    !group.unavailable.includes(member) && memberSupports(group, member, "usage")
  );
}

/** The member shown in the usage row; null when off, unsupported, or not connected. */
export function visibleUsageAgent(group) {
  const agent = group?.usageAgent ?? null;
  return agent && usageCandidates(group).includes(agent) ? agent : null;
}

/** Time of this member's last reply that completed normally or was interrupted; failed replies and compactions don't count. */
export function lastReplyAt(transcript, agent) {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const entry = transcript[index];
    if (entry.from.role === "agent" && entry.from.agent === agent &&
        (entry.status === "completed" || entry.status === "interrupted")) {
      return entry.at;
    }
  }
  return null;
}

/** Output format follows Relayu's formatTime (MM-DD HH:mm), in the selected display time zone. */
export function formatLocalTime(timestamp, timeZone = loadDisplayTimezone()) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const options = {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  };
  if (normalizeDisplayTimezone(timeZone) !== "device") options.timeZone = normalizeDisplayTimezone(timeZone);
  const parts = new Intl.DateTimeFormat("en-CA", options).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.month}-${values.day} ${values.hour}:${values.minute}`;
}

/**
 * Text segments of the usage row. With no native session yet the whole row is just "not started";
 * when the read fails or has no result yet it shows "usage unavailable"; otherwise it ends with the last reply time.
 */
export function usageTexts(usage, lastReply) {
  if (usage?.status === "not_started") return [t("usage.notStarted")];
  const texts = usage?.status === "ok" ? usage.parts.map(usagePartText) : [t("usage.unavailable")];
  texts.push(lastReply ? t("usage.lastReply", { time: formatLocalTime(lastReply) }) : t("usage.lastReplyUnavailable"));
  return texts;
}

/** Words one usage segment the backend sent as data. */
function usagePartText(part) {
  if (part.kind === "context") {
    if (part.percent === null) return t("usage.contextPending");
    return t(part.approximate ? "usage.contextApprox" : "usage.context", { percent: part.percent.toFixed(1) });
  }
  if (part.kind !== "quota") return t("usage.unavailable");
  const params = {
    window: usageWindowText(part.window),
    left: part.left === null ? t("usage.unknown") : `${part.left.toFixed(1)}%`,
  };
  return part.resetsAt
    ? t("usage.quotaReset", { ...params, time: formatLocalTime(part.resetsAt) })
    : t("usage.quota", params);
}

function usageWindowText(window) {
  const minutes = window.minutes;
  const duration = minutes === undefined ? "" : minutes % 1440 === 0
    ? t("usage.days", { count: minutes / 1440 })
    : minutes % 60 === 0 ? t("usage.hours", { count: minutes / 60 }) : t("usage.minutes", { count: minutes });
  if (!window.name) return duration;
  if (!duration) return window.name;
  return t(window.parenthesized ? "usage.windowParenthesized" : "usage.windowNamed", { name: window.name, duration });
}
