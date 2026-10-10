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

/** AI usage 能选的成员：CLI 已接入并且支持 usage。 */
export function usageCandidates(group) {
  return group.members.filter((member) =>
    !group.unavailable.includes(member) && memberSupports(group, member, "usage")
  );
}

/** usage 行要显示的成员；关闭、成员不支持或未接入时为 null。 */
export function visibleUsageAgent(group) {
  const agent = group?.usageAgent ?? null;
  return agent && usageCandidates(group).includes(agent) ? agent : null;
}

/** 这个成员最后一条正常完成或被打断的发言时间；出错的发言和压缩都不算。 */
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

/** 输出格式照 Relayu 的 formatTime（MM-DD HH:mm），时区用浏览器本地时区。 */
export function formatLocalTime(timestamp) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * usage 行的各段文字。还没有原生会话时整行只有“未启动”；
 * 读取失败或还没有结果时显示“额度查询不可用”；其余情况最后接最后回复时间。
 */
export function usageTexts(usage, lastReply) {
  if (usage?.status === "not_started") return ["未启动"];
  const texts = usage?.status === "ok"
    ? usage.parts.map((part) => part.text.replaceAll("{time}", formatLocalTime(part.time)))
    : ["额度查询不可用"];
  texts.push(lastReply ? `最后回复时间 ${formatLocalTime(lastReply)}` : "最后回复时间不可用");
  return texts;
}
