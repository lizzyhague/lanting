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
