const SVG_NS = "http://www.w3.org/2000/svg";

const ICONS = Object.freeze({
  back: [
    ["path", { d: "m15 18-6-6 6-6" }],
  ],
  cancel: [
    ["path", { d: "M18 6 6 18" }],
    ["path", { d: "m6 6 12 12" }],
  ],
  archive: [
    ["rect", { width: "20", height: "5", x: "2", y: "3", rx: "1" }],
    ["path", { d: "M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" }],
    ["path", { d: "M10 12h4" }],
  ],
  unarchive: [
    ["rect", { width: "20", height: "5", x: "2", y: "3", rx: "1" }],
    ["path", { d: "M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" }],
    ["path", { d: "m9 15 3-3 3 3" }],
    ["path", { d: "M12 12v6" }],
  ],
  restore: [
    ["path", { d: "M3 12a9 9 0 1 0 3-6.7L3 8" }],
    ["path", { d: "M3 3v5h5" }],
  ],
  delete: [
    ["path", { d: "M3 6h18" }],
    ["path", { d: "M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" }],
    ["path", { d: "M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" }],
    ["path", { d: "M10 11v6" }],
    ["path", { d: "M14 11v6" }],
  ],
  purge: [
    ["path", { d: "M3 6h18" }],
    ["path", { d: "M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" }],
    ["path", { d: "M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" }],
    ["path", { d: "m9.5 11.5 5 5" }],
    ["path", { d: "m14.5 11.5-5 5" }],
  ],
  "select-all": [
    ["path", { d: "m12 15 2 2 4-4" }],
    ["rect", { width: "14", height: "14", x: "8", y: "8", rx: "2" }],
    ["path", { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" }],
  ],
  "select-none": [
    ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2" }],
  ],
});

function icon(document, name) {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [attribute, value] of Object.entries({
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.8",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  })) svg.setAttribute(attribute, value);
  for (const [tag, attributes] of ICONS[name] ?? []) {
    const child = document.createElementNS(SVG_NS, tag);
    for (const [attribute, value] of Object.entries(attributes)) child.setAttribute(attribute, value);
    svg.append(child);
  }
  return svg;
}

function button(document, { id, label, iconName, danger = false }) {
  const element = document.createElement("button");
  element.id = id;
  element.type = "button";
  element.className = `quiet small icon-button${danger ? " danger" : ""}`;
  element.setAttribute("aria-label", label);
  element.title = label;
  element.append(icon(document, iconName));
  return element;
}

function normalizeResult(result) {
  const succeeded = Array.isArray(result?.succeeded) ? result.succeeded : [];
  const failed = Array.isArray(result?.failed) ? result.failed.map((failure) => ({
    id: failure?.id ?? failure?.sessionId ?? failure?.groupId,
    reason: failure?.reason ?? failure?.message ?? "操作失败。",
  })) : [];
  return { succeeded, failed };
}

export function createSelectionBar({
  container,
  views,
  initialView,
  noun,
  untitledLabel,
  backLabel = "返回最近会话",
  permanentDeleteDetail,
  getId,
  getTitle,
  isSelectable,
  isPinned,
  getActionUnavailableReason = () => "",
  executeAction,
  refreshItems,
  confirm,
  notify,
  errorMessage = (error) => error instanceof Error ? error.message : String(error),
  onSelectionChange = () => {},
  onBusyChange = () => {},
  onBack = () => {},
  document = globalThis.document,
}) {
  let view = initialView;
  let manualSelection = false;
  let items = new Map();
  let selected = new Map();
  let disabled = false;
  let disabledReason = "";
  let actionBusy = false;

  const backButton = button(document, {
    id: "selection-back-button",
    label: backLabel,
    iconName: "back",
  });
  const cancelButton = button(document, {
    id: "selection-cancel-button",
    label: "取消",
    iconName: "cancel",
  });
  const end = document.createElement("div");
  end.className = "selection-heading-end";
  const count = document.createElement("strong");
  count.id = "selection-count";
  end.append(count);

  const actions = new Map();
  const actionButtons = new Map();
  for (const config of Object.values(views)) {
    for (const action of config.actions) {
      if (actionButtons.has(action.id)) continue;
      actions.set(action.id, action);
      const actionButton = button(document, {
        id: `selection-action-${action.id}`,
        label: action.label,
        iconName: action.icon,
        danger: action.danger,
      });
      actionButton.addEventListener("click", () => void runAction(action.id));
      actionButtons.set(action.id, actionButton);
      end.append(actionButton);
    }
  }

  const selectAllButton = button(document, {
    id: "selection-select-all-button",
    label: "全选",
    iconName: "select-all",
  });
  const selectNoneButton = button(document, {
    id: "selection-select-none-button",
    label: "全部取消",
    iconName: "select-none",
  });
  selectAllButton.addEventListener("click", selectAll);
  selectNoneButton.addEventListener("click", clearSelection);
  end.append(selectAllButton, selectNoneButton);
  container.replaceChildren(backButton, cancelButton, end);

  backButton.addEventListener("click", onBack);
  cancelButton.addEventListener("click", () => setManualSelection(false));

  function selecting() {
    return view === "archived" || view === "trash" || manualSelection;
  }

  function unavailable() {
    return disabled || actionBusy;
  }

  function visibleSelectAllItems() {
    return [...items.values()].filter((item) => isSelectable(item) && !isPinned(item));
  }

  function unavailableReasonFor(action, targets = [...selected.values()]) {
    for (const item of targets) {
      const reason = getActionUnavailableReason(action, item);
      if (reason) return String(reason);
    }
    return "";
  }

  function update() {
    container.hidden = !selecting();
    const fixedSelection = view === "archived" || view === "trash";
    backButton.hidden = !fixedSelection;
    cancelButton.hidden = fixedSelection;
    count.textContent = `已选择 ${selected.size} 项`;

    const selectAllItems = visibleSelectAllItems();
    const allSelected = selectAllItems.length > 0 &&
      selectAllItems.every((item) => selected.has(getId(item)));
    selectAllButton.hidden = allSelected;
    selectNoneButton.hidden = !allSelected;
    selectAllButton.disabled = unavailable() || selectAllItems.length === 0;
    selectNoneButton.disabled = unavailable();

    const currentActions = new Set((views[view]?.actions ?? []).map((action) => action.id));
    for (const [id, actionButton] of actionButtons) {
      actionButton.hidden = !currentActions.has(id);
      const restriction = currentActions.has(id) && selected.size > 0
        ? unavailableReasonFor(actions.get(id))
        : "";
      actionButton.disabled = unavailable() || selected.size === 0 || Boolean(restriction);
      const label = actionButton.getAttribute("aria-label");
      actionButton.title = unavailable() && disabledReason
        ? disabledReason
        : restriction || label;
    }

    const reason = unavailable() && disabledReason ? disabledReason : "";
    for (const element of [selectAllButton, selectNoneButton]) {
      const label = element.getAttribute("aria-label");
      element.title = reason || label;
    }
    backButton.disabled = actionBusy;
    cancelButton.disabled = actionBusy;
  }

  function setView(nextView) {
    if (!views[nextView]) throw new Error(`Unknown selection view: ${nextView}`);
    view = nextView;
    manualSelection = false;
    selected.clear();
    update();
  }

  function setManualSelection(enabled) {
    manualSelection = Boolean(enabled);
    selected.clear();
    update();
    onSelectionChange();
  }

  function reconcile(nextItems) {
    items = new Map(nextItems.map((item) => [getId(item), item]));
    const nextSelected = new Map();
    for (const id of selected.keys()) {
      const item = items.get(id);
      if (item && isSelectable(item)) nextSelected.set(id, item);
    }
    selected = nextSelected;
    update();
  }

  function toggle(id) {
    const item = items.get(id);
    if (!selecting() || unavailable() || !item || !isSelectable(item)) return false;
    if (selected.has(id)) selected.delete(id);
    else selected.set(id, item);
    update();
    onSelectionChange();
    return true;
  }

  function selectAll() {
    if (unavailable()) return;
    for (const item of visibleSelectAllItems()) selected.set(getId(item), item);
    update();
    onSelectionChange();
  }

  function clearSelection() {
    if (unavailable()) return;
    selected.clear();
    update();
    onSelectionChange();
  }

  function setDisabled(nextDisabled, reason = "") {
    disabled = Boolean(nextDisabled);
    disabledReason = disabled ? reason : "";
    update();
  }

  async function runAction(actionId) {
    const action = views[view]?.actions.find((candidate) => candidate.id === actionId);
    const targets = [...selected.values()];
    if (!action || targets.length === 0 || unavailable()) return null;
    if (unavailableReasonFor(action, targets)) return null;

    if (action.permanent) {
      const message = targets.length === 1
        ? `立刻永久删除「${getTitle(targets[0]) || untitledLabel}」。这一步无法撤销，${permanentDeleteDetail}。继续吗？`
        : `立刻永久删除 ${targets.length} 个${noun}。这一步无法撤销，${permanentDeleteDetail}。继续吗？`;
      if (!await confirm(message, {
        title: `永久删除${noun}`,
        confirmLabel: "永久删除",
        danger: true,
      })) return null;
    }

    actionBusy = true;
    update();
    onBusyChange(true);
    try {
      const rawResult = await executeAction(action.id, targets.map(getId), targets);
      if (rawResult?.cancelled === true) return rawResult;
      const result = normalizeResult(rawResult);
      if (view === "archived" || view === "trash") {
        const failed = new Set(result.failed.map((failure) => failure.id));
        selected = new Map([...selected].filter(([id]) => failed.has(id)));
      } else {
        manualSelection = false;
        selected.clear();
      }
      update();
      onSelectionChange();
      await refreshItems();

      if (result.failed.length > 0) {
        notify(
          `已完成 ${result.succeeded.length} 项，${result.failed.length} 项失败：${result.failed[0].reason}`,
          "error",
        );
      } else if (result.succeeded.length > 0) {
        const retention = action.retention ? "，30 天后自动永久删除" : "";
        notify(`已${action.resultLabel} ${result.succeeded.length} 个${noun}${retention}。`, "info");
      }
      return result;
    } catch (error) {
      notify(errorMessage(error), "error");
      return null;
    } finally {
      actionBusy = false;
      onBusyChange(false);
      update();
    }
  }

  update();
  return {
    isSelecting: selecting,
    isSelected: (id) => selected.has(id),
    isSelectable,
    isDisabled: unavailable,
    selectedIds: () => [...selected.keys()],
    setView,
    setManualSelection,
    reconcile,
    toggle,
    setDisabled,
    runAction,
  };
}

export function trashRemainingText(purgeAt, now = Date.now()) {
  const timestamp = typeof purgeAt === "number"
    ? (purgeAt > 10_000_000_000 ? purgeAt : purgeAt * 1_000)
    : typeof purgeAt === "string"
    ? Date.parse(purgeAt)
    : Number.NaN;
  if (!Number.isFinite(timestamp)) return "30 天后自动删除";
  const milliseconds = timestamp - now;
  if (milliseconds <= 0) return "即将自动删除";
  const days = Math.max(1, Math.ceil(milliseconds / 86_400_000));
  return `${days} 天后自动删除`;
}
