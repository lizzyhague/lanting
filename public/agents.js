/** Interface text from i18n.js; looked up on each call so a language switch applies to the next render. */
const t = (key, params) => globalThis.lantingI18n ? globalThis.lantingI18n.t(key, params) : key;

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

/** Output format follows Relayu's formatTime (MM-DD HH:mm), in the browser's local time zone. */
export function formatLocalTime(timestamp) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Text segments of the usage row. With no native session yet the whole row is just "not started";
 * when the read fails or has no result yet it shows "usage unavailable"; otherwise it ends with the last reply time.
 */
export function usageTexts(usage, lastReply) {
  if (usage?.status === "not_started") return [t("usage.notStarted")];
  const texts = usage?.status === "ok"
    ? usage.parts.map((part) => part.text.replaceAll("{time}", formatLocalTime(part.time)))
    : [t("usage.unavailable")];
  texts.push(lastReply ? t("usage.lastReply", { time: formatLocalTime(lastReply) }) : t("usage.lastReplyUnavailable"));
  return texts;
}
