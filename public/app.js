import { toggleMember } from "./call-order.js";
import {
  colorChoices,
  createCandidates,
  effectiveCreateMembers,
  kindSupports,
  kindOptions,
  lastReplyAt,
  memberSupports,
  moveAgent,
  paletteColor,
  selectionAfterRemove,
  settingsCatalogKey,
  usageCandidates,
  usageTexts,
  visibleUsageAgent,
} from "./agents.js";
import { renderMarkdown } from "./markdown.js";
import { createConfirmDialog } from "./confirm-dialog.js";
import { createNoticeController } from "./notice.js";
import { createSelectionBar, trashRemainingText } from "./selection-bar.js";

/**
 * Interface text from i18n.js, which loads in <head> before this module. Without it (e.g. a page served by a
 * backend that doesn't list i18n.js yet) the page still works and shows the keys.
 */
const t = window.lantingI18n ? window.lantingI18n.t : (key) => key;

/** Text the backend sent as { key, params }; fallback (its own message) when there is none or the key is unknown. */
function localText(text, fallback) {
  if (!text?.key) return fallback;
  const translated = t(text.key, text.params);
  return translated === text.key ? fallback : translated;
}

/** A new group has no title until its first message names it. */
function groupTitle(group) {
  return group.title || t("group.newTitle");
}

const RECONNECT_DELAY_MS = 3_000;
const REQUEST_TIMEOUT_MS = 30_000;
const DIRECTORY_KEY = "lanting.directory";
const SIDEBAR_COLLAPSED_KEY = "lanting.sidebar-collapsed";
/** Within this many pixels of the bottom, new content auto-scrolls to the bottom; scrolling up is left alone. */
const STICK_TO_BOTTOM_PX = 80;
/** Matches ai-remote-upload's limit. */
const MAX_UPLOAD_BYTES = 25 * 1_048_576;
const MAX_MESSAGE_ATTACHMENTS = 100;
const GROUP_SELECTION_VIEWS = Object.freeze({
  groups: { actions: [
    { id: "archive", labelKey: "selection.archive", doneKey: "selection.doneArchive", icon: "archive" },
    {
      id: "trash-active",
      labelKey: "common.delete",
      doneKey: "selection.doneTrash",
      icon: "delete",
      danger: true,
      retention: true,
    },
  ] },
  archived: { actions: [
    { id: "unarchive", labelKey: "selection.unarchive", doneKey: "selection.doneUnarchive", icon: "unarchive" },
    {
      id: "trash-archived",
      labelKey: "common.delete",
      doneKey: "selection.doneTrash",
      icon: "delete",
      danger: true,
      retention: true,
    },
  ] },
  trash: { actions: [
    { id: "restore-trash", labelKey: "selection.restore", doneKey: "selection.doneRestore", icon: "restore" },
    {
      id: "delete-trash",
      labelKey: "selection.purge",
      doneKey: "selection.donePurge",
      icon: "purge",
      danger: true,
      permanent: true,
    },
  ] },
});

function measureScrollbarWidth() {
  const probe = document.createElement("div");
  probe.className = "scrollbar-measure";
  probe.style.cssText = "position:absolute;width:100px;height:100px;overflow:scroll;visibility:hidden;";
  document.body.append(probe);
  const width = probe.offsetWidth - probe.clientWidth;
  probe.remove();
  return width;
}

document.documentElement.style.setProperty("--scrollbar-width", `${measureScrollbarWidth()}px`);

function byId(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Page element missing: ${id}`);
  return element;
}

const elements = {
  loginView: byId("login-view"),
  appView: byId("app-view"),
  tokenForm: byId("token-form"),
  tokenInput: byId("token-input"),
  connectButton: byId("connect-button"),
  loginStatus: byId("login-status"),
  connectionStatus: byId("connection-status"),
  createForm: byId("create-form"),
  directorySelect: byId("directory-select"),
  memberPicks: byId("member-picks"),
  createButton: byId("create-button"),
  createStatus: byId("create-status"),
  groupList: byId("group-list"),
  groupSearchInput: byId("group-search-input"),
  listHeading: byId("list-heading"),
  listViewBackButton: byId("list-view-back-button"),
  listTitle: byId("list-title"),
  selectButton: byId("select-button"),
  selectionHeading: byId("selection-heading"),
  listStatus: byId("list-status"),
  archivedViewButton: byId("archived-view-button"),
  trashViewButton: byId("trash-view-button"),
  notice: byId("notice"),
  noticeText: byId("notice-text"),
  noticeActionButton: byId("notice-action-button"),
  noticeCloseButton: byId("notice-close-button"),
  confirmDialog: byId("confirm-dialog"),
  confirmDialogTitle: byId("confirm-dialog-title"),
  confirmDialogMessage: byId("confirm-dialog-message"),
  confirmDialogAcceptButton: byId("confirm-dialog-accept-button"),
  confirmDialogCancelButton: byId("confirm-dialog-cancel-button"),
  settingsButton: byId("settings-button"),
  collapseSidebarButton: byId("collapse-sidebar-button"),
  settingsDialog: byId("settings-dialog"),
  settingsCloseButton: byId("settings-close-button"),
  themeSetting: byId("theme-setting"),
  themeOptions: byId("theme-options"),
  languageSetting: byId("language-setting"),
  languageOptions: byId("language-options"),
  usernameForm: byId("username-form"),
  usernameInput: byId("username-input"),
  usernameSaveButton: byId("username-save-button"),
  usernameStatus: byId("username-status"),
  collaborationForm: byId("collaboration-form"),
  collaborationInput: byId("collaboration-input"),
  collaborationSaveButton: byId("collaboration-save-button"),
  collaborationStatus: byId("collaboration-status"),
  settingsAgentList: byId("settings-agent-list"),
  settingsAddButton: byId("settings-add-button"),
  settingsRemoveButton: byId("settings-remove-button"),
  settingsUpButton: byId("settings-up-button"),
  settingsDownButton: byId("settings-down-button"),
  settingsStatus: byId("settings-status"),
  attachmentList: byId("attachment-list"),
  fileInput: byId("file-input"),
  renameDialog: byId("rename-dialog"),
  renameForm: byId("rename-form"),
  renameInput: byId("rename-input"),
  renameStatus: byId("rename-status"),
  renameCancelButton: byId("rename-cancel-button"),
  renameSaveButton: byId("rename-save-button"),
  groupEmpty: byId("group-empty"),
  groupView: byId("group-view"),
  groupSidebar: byId("group-sidebar"),
  openSidebarButton: byId("open-sidebar-button"),
  sidebarBackdrop: byId("sidebar-backdrop"),
  groupTitle: byId("group-title"),
  groupMembers: byId("group-members"),
  groupUsage: byId("group-usage"),
  timeline: byId("timeline"),
  approvalList: byId("approval-list"),
  composer: byId("composer"),
  messageInput: byId("message-input"),
  callPicks: byId("call-picks"),
  plusButton: byId("plus-button"),
  plusMenu: byId("plus-menu"),
  plusSubmenu: byId("plus-submenu"),
  agentPanel: byId("agent-panel"),
  taskButton: byId("task-button"),
  composerStatus: byId("composer-status"),
};

const state = {
  /** Incremented on every reconnect; callbacks from older connections are discarded by it. */
  generation: 0,
  socket: null,
  authenticated: false,
  reconnectAllowed: true,
  reconnectTimer: null,
  nextRequestId: 1,
  pending: new Map(),

  /** CLI kinds lanting supports and whether each is configured. */
  agentKinds: [],
  /** Primary color table sent by the backend. */
  palette: [],
  directories: [],
  /** Group summaries, keyed by id. */
  groups: new Map(),
  /** AIs checked when creating a group. */
  createMembers: new Set(),
  /** Backend settings: { username, agents, initialized, createMembers, collaboration } */
  settings: null,
  /** Model and permission lists for the settings page, keyed by "internal id:CLI kind". */
  settingsCatalogs: new Map(),
  savingDefaults: new Set(),
  /** One record may have several requests at once, e.g. a name blur and another control changing. */
  savingAgents: new Map(),
  settingsActionBusy: false,
  /** Per-item saves in flight; the top buttons wait for them, then act on the latest list. */
  settingsSaves: new Set(),
  /** A redraw was skipped while focus was in an input or select; it is done once focus leaves the list. */
  settingsRenderPending: false,
  selectedAgentId: null,
  openColorAgentId: null,
  /** The AI whose default model and permission are expanded in the settings dialog. */
  expandedSettingsAgents: new Set(),
  /** Keeps the user's input after a failed name request so the backend snapshot doesn't overwrite it. */
  settingsNameDrafts: new Map(),
  /** Current field errors per AI, keyed by internal id. */
  settingsErrors: new Map(),
  /** Attachments pending in the current group's input: { localId, name, status: uploading|done|failed, attachment, error } */
  drafts: [],
  createBusy: false,
  /** Which list the sidebar shows: groups (recent), archived, or trash. */
  listView: "groups",
  searchTimer: null,
  sidebarCollapsed: stateGet(SIDEBAR_COLLAPSED_KEY) === "1",

  currentGroupId: null,
  /** Group awaiting a subscribe response; when switching, the old group is unsubscribed first and the panel just hasn't swapped yet. */
  openingGroupId: null,
  /** The open group: { group, transcript, round, compaction, approvals: Map } */
  current: null,
  /** Call order for the current group (order the buttons were pressed); the backend's saved value wins. */
  callOrder: [],
  /** Call order is being saved: member buttons and the send button are locked. */
  savingOrder: false,
  /** Saving the automatic removal of disconnected members just failed; don't resend the same request right away on redraw after recovery. */
  skipUnavailableOrderSave: false,
  sending: false,
  interrupting: false,
  /** Model and permission lists for the member panel, keyed by "group id:AI"; values are { catalog } or { error }. */
  catalogs: new Map(),
  /** AI whose settings are being saved; its selects are locked. */
  savingSettings: new Set(),
  /** AI whose settings dialog is open. */
  openAgent: null,
  /** Current level of the + menu: root, compact, settings, or usage. */
  plusLevel: "root",
  /** Countdown timer for approval cards; null when no approvals are pending. */
  countdownTimer: null,
};

const confirmDialogController = createConfirmDialog({
  dialog: elements.confirmDialog,
  titleElement: elements.confirmDialogTitle,
  messageElement: elements.confirmDialogMessage,
  acceptButton: elements.confirmDialogAcceptButton,
  cancelButton: elements.confirmDialogCancelButton,
});
const noticeController = createNoticeController({
  element: elements.notice,
  textElement: elements.noticeText,
  actionButton: elements.noticeActionButton,
  closeButton: elements.noticeCloseButton,
});
const selectionBar = createSelectionBar({
  container: elements.selectionHeading,
  views: GROUP_SELECTION_VIEWS,
  initialView: state.listView,
  getId: (group) => group.id,
  getTitle: groupTitle,
  isSelectable: groupSelectable,
  isPinned: (group) => Boolean(group.pinned),
  getActionUnavailableReason: groupActionUnavailableReason,
  executeAction: executeGroupSelectionAction,
  refreshItems: () => renderGroupList(),
  confirm: (message, options) => confirmDialogController.show(message, options),
  notify: showNotice,
  errorMessage,
  onSelectionChange: renderGroupList,
  onBusyChange: renderGroupList,
  onBack: () => setListView("groups"),
});

elements.appView.dataset.sidebarCollapsed = String(state.sidebarCollapsed);

/* ---------- Login and connection ---------- */

elements.tokenForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const token = elements.tokenInput.value.trim();
  if (!token) {
    setLoginStatus(t("login.tokenMissing"), "error");
    return;
  }
  if (token.length < 32) {
    setLoginStatus(t("login.tokenInvalid"), "error");
    return;
  }
  state.reconnectAllowed = true;
  void connect(token);
});

window.lantingClientReady = true;
if (typeof window.lantingClientMarkReady === "function") {
  window.lantingClientMarkReady();
} else {
  elements.connectButton.disabled = false;
}

void connect();

async function connect(token) {
  const generation = ++state.generation;
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  rejectPending(new Error(t("connection.reestablished")));

  if (state.socket) {
    state.socket.onclose = null;
    state.socket.close();
    state.socket = null;
  }

  state.authenticated = false;
  elements.connectButton.disabled = true;
  setLoginStatus(t("login.connecting"), "progress");
  setConnectionStatus("connecting", "connection.connecting");

  try {
    let response;
    try {
      response = token
        ? await fetch("/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
          cache: "no-store",
        })
        : await fetch("/auth/session", { cache: "no-store" });
    } catch {
      throw new Error(t("login.noResponse"));
    }
    if (generation !== state.generation) return;
    if (response.status === 401) {
      state.reconnectAllowed = false;
      elements.connectButton.disabled = false;
      showLogin();
      setLoginStatus(token ? t("login.tokenInvalid") : t("login.required"), token ? "error" : null);
      return;
    }
    if (!response.ok) throw new Error(t("login.unavailable"));
    elements.tokenInput.value = "";
    const returnTo = new URLSearchParams(location.search).get("returnTo");
    if (returnTo?.startsWith("/view?")) {
      const target = new URL(returnTo, location.origin);
      if (target.origin === location.origin && target.pathname === "/view") {
        location.replace(target.href);
        return;
      }
    }
  } catch (error) {
    if (generation !== state.generation) return;
    setLoginStatus(errorMessage(error), "error");
    elements.connectButton.disabled = false;
    setConnectionStatus("disconnected", "connection.disconnected");
    scheduleReconnect();
    return;
  }

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/ws`);
  state.socket = socket;

  socket.addEventListener("message", (event) => {
    if (generation === state.generation) handleSocketMessage(event.data);
  });

  socket.addEventListener("open", async () => {
    if (generation !== state.generation) return;
    state.authenticated = true;
    setLoginStatus("");
    elements.connectButton.disabled = false;
    showApp();
    setConnectionStatus("connecting", "connection.restoring");
    try {
      await loadAppState();
      await request("connection.ready");
      // After reconnecting, return to the previous group and fill in from the snapshot.
      if (state.currentGroupId) {
        // The group may have been archived or deleted while disconnected.
        const group = state.groups.get(state.currentGroupId);
        if (!group || group.archived || group.trashedAt) closeGroup();
        else await openGroup(state.currentGroupId, { keepPane: true });
      }
      if (generation !== state.generation || socket.readyState !== WebSocket.OPEN) return;
      setConnectionStatus("connected", "connection.connected");
    } catch (error) {
      if (generation !== state.generation) return;
      setLoginStatus(errorMessage(error), "error");
      elements.connectButton.disabled = false;
    }
  });

  socket.addEventListener("error", () => {
    if (generation === state.generation && !state.authenticated) {
      setLoginStatus(t("login.hostUnreachable"), "error");
      elements.connectButton.disabled = false;
    }
  });

  socket.addEventListener("close", () => {
    if (generation !== state.generation) return;
    state.socket = null;
    state.authenticated = false;
    rejectPending(new Error(t("connection.lost")));
    setConnectionStatus("disconnected", "connection.disconnected");
    renderComposer();
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (!state.reconnectAllowed || state.reconnectTimer) return;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    void connect();
  }, RECONNECT_DELAY_MS);
}

function request(type, fields = {}) {
  const socket = state.socket;
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error(t("request.notConnected")));
  }
  const requestId = `r${state.nextRequestId++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(requestId);
      reject(new Error(t("request.timeout")));
    }, REQUEST_TIMEOUT_MS);
    state.pending.set(requestId, { resolve, reject, timer });
    socket.send(JSON.stringify({ ...fields, type, requestId }));
  });
}

function rejectPending(error) {
  for (const { reject, timer } of state.pending.values()) {
    clearTimeout(timer);
    reject(error);
  }
  state.pending.clear();
}

function handleSocketMessage(data) {
  let message;
  try {
    message = JSON.parse(data);
  } catch {
    return;
  }
  if (message.type === "response" || (message.type === "error" && message.requestId)) {
    const entry = state.pending.get(message.requestId);
    if (!entry) return;
    state.pending.delete(message.requestId);
    clearTimeout(entry.timer);
    if (message.ok) {
      entry.resolve(message.data);
    } else {
      const error = new Error(localText(message.error?.text, message.error?.message ?? t("request.failed")));
      error.code = message.error?.code;
      error.details = message.error?.details;
      entry.reject(error);
    }
    return;
  }
  if (message.type === "error") {
    console.warn(message.error?.message);
    return;
  }
  if (message.type === "event") handleEvent(message.event);
}

/* ---------- Events ---------- */

function handleEvent(event) {
  switch (event.type) {
    case "settings.updated":
      applySettings(event.settings);
      return;
    case "group.removed":
      state.groups.delete(event.groupId);
      if (event.groupId === state.currentGroupId) closeGroup();
      renderGroupList();
      return;
    case "group.created":
    case "group.updated":
      state.groups.set(event.group.id, event.group);
      // The group was archived or moved to trash (possibly from another device); close it if it is open.
      if ((event.group.archived || event.group.trashedAt) && event.group.id === state.currentGroupId) closeGroup();
      renderGroupList();
      if (state.current && event.group.id === state.currentGroupId) {
        // The usage member changed; the old member's result can't be kept.
        if (state.current.group.usageAgent !== event.group.usageAgent) state.current.usage = null;
        state.current.group = event.group;
        // Another device changed the call order: follow the backend; while saving locally, the save result wins.
        if (!state.savingOrder) {
          state.callOrder = [...event.group.callOrder];
          renderCallPicks();
        }
        renderHeader();
        renderComposer();
        renderAgentPanel();
      }
      return;
  }

  const current = state.current;
  if (!current || event.groupId !== state.currentGroupId &&
      event.approval?.groupId !== state.currentGroupId) {
    return;
  }
  switch (event.type) {
    case "round.started":
      current.round = { roundId: event.roundId, order: event.order, speaking: null, text: "", activities: [] };
      renderLive();
      renderComposer();
      return;
    case "agent.started":
      if (!current.round) return;
      current.round.speaking = event.agent;
      current.round.text = "";
      current.round.activities = [];
      renderLive();
      return;
    case "agent.text":
      if (!current.round) return;
      current.round.text += event.delta;
      renderLive();
      return;
    case "agent.activity":
      if (!current.round) return;
      current.round.activities.push(event.activity);
      current.round.text = "";
      renderLive();
      return;
    case "entry.appended":
      current.transcript.push(event.entry);
      if (event.entry.from.role === "agent" && current.round) {
        current.round.speaking = null;
        current.round.text = "";
        current.round.activities = [];
      }
      appendEntry(event.entry);
      renderLive();
      renderUsage();
      return;
    case "round.ended":
      current.round = null;
      renderLive();
      renderComposer();
      if (event.outcome === "failed") elements.composerStatus.textContent = t("round.failedEarly");
      return;
    case "compact.started":
      current.compaction = { agents: event.agents, current: null };
      renderLive();
      renderComposer();
      return;
    case "compact.progress":
      if (!current.compaction) return;
      current.compaction.current = event.agent;
      renderLive();
      return;
    case "compact.ended":
      current.compaction = null;
      renderLive();
      renderComposer();
      return;
    case "usage.updated":
      if (event.agent !== current.group.usageAgent) return;
      current.usage = event.usage;
      renderUsage();
      return;
    case "approval.requested":
      current.approvals.set(event.approval.approvalId, withDeadline(event.approval));
      renderApprovals();
      renderLive();
      return;
    case "approval.settled":
      current.approvals.delete(event.approval.approvalId);
      renderApprovals();
      renderLive();
      return;
  }
}

/* ---------- App state and group creation ---------- */

async function loadAppState() {
  const data = await request("app.state");
  state.agentKinds = data.agentKinds;
  state.palette = data.palette;
  state.directories = data.directories;
  state.groups = new Map(data.groups.map((group) => [group.id, group]));
  applySettings(data.settings);
  renderGroupList();
}

function applySettings(settings) {
  state.settings = settings;
  state.createMembers = new Set(settings.createMembers === null
    ? effectiveCreateMembers(null, settings)
    : settings.createMembers);
  const ids = new Set(settings.agents.map((agent) => agent.id));
  if (!ids.has(state.selectedAgentId)) state.selectedAgentId = null;
  if (!ids.has(state.openColorAgentId)) state.openColorAgentId = null;
  for (const id of state.settingsNameDrafts.keys()) if (!ids.has(id)) state.settingsNameDrafts.delete(id);
  for (const id of state.settingsErrors.keys()) if (!ids.has(id)) state.settingsErrors.delete(id);
  for (const id of state.expandedSettingsAgents) if (!ids.has(id)) state.expandedSettingsAgents.delete(id);
  const catalogKeys = new Set(settings.agents
    .filter((agent) => agent.kind !== null)
    .map((agent) => settingsCatalogKey(agent.id, agent.kind)));
  for (const key of state.settingsCatalogs.keys()) if (!catalogKeys.has(key)) state.settingsCatalogs.delete(key);
  renderCreateForm();
  renderSettingsDialog();
  loadAvailableSettingsCatalogs();
}

function renderCreateForm() {
  const select = elements.directorySelect;
  const previous = select.value;
  select.replaceChildren(new Option(t("create.chooseDirectory"), ""));
  for (const name of state.directories) select.add(new Option(name, name));
  const saved = stateGet(DIRECTORY_KEY);
  const selected = state.directories.includes(previous)
    ? previous
    : state.directories.includes(saved)
    ? saved
    : "";
  select.value = selected;
  stateSet(DIRECTORY_KEY, selected);

  const candidates = state.settings ? createCandidates(state.settings) : [];
  elements.memberPicks.replaceChildren(...candidates.map((agent) => {
    const pick = agentPick(agent.id, agent.color, agent.name, state.createMembers.has(agent.id));
    pick.addEventListener("click", () => {
      const selected = !state.createMembers.has(agent.id);
      if (selected) state.createMembers.add(agent.id);
      else state.createMembers.delete(agent.id);
      pick.setAttribute("aria-pressed", String(selected));
      updateCreateButton();
    });
    return pick;
  }));
  if (candidates.length === 0) {
    const hint = document.createElement("span");
    hint.className = "empty-hint";
    hint.textContent = t("create.noAgents");
    elements.memberPicks.append(hint);
  }
  updateCreateButton();
}

function updateCreateButton() {
  const members = selectedCreateMemberIds();
  elements.createButton.disabled = state.createBusy || !state.authenticated ||
    !elements.directorySelect.value || members.length === 0;
}

function selectedCreateMemberIds() {
  if (!state.settings) return [];
  return effectiveCreateMembers([...state.createMembers], state.settings);
}

elements.directorySelect.addEventListener("change", () => {
  const directory = state.directories.includes(elements.directorySelect.value)
    ? elements.directorySelect.value
    : "";
  elements.directorySelect.value = directory;
  stateSet(DIRECTORY_KEY, directory);
  state.listView = "groups";
  selectionBar.setView("groups");
  elements.groupSearchInput.value = "";
  elements.listStatus.textContent = "";
  // The old group is already unsubscribed mid-switch; it can't be kept even if the directory matches.
  const switching = state.openingGroupId !== null && state.openingGroupId !== state.currentGroupId;
  if (switching || state.current?.group.directory !== directory) closeGroup();
  renderGroupList();
  updateCreateButton();
});

elements.groupSearchInput.addEventListener("input", () => {
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(renderGroupList, 250);
});

elements.createForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const directory = elements.directorySelect.value;
  const members = selectedCreateMemberIds();
  if (!directory || members.length === 0) return;
  if (state.listView !== "groups" || selectionBar.isSelecting()) setListView("groups");
  state.createBusy = true;
  updateCreateButton();
  elements.createStatus.textContent = "";
  try {
    const { group } = await request("group.create", { directory, members, title: "" });
    state.groups.set(group.id, group);
    renderGroupList();
    await openGroup(group.id);
  } catch (error) {
    elements.createStatus.textContent = errorMessage(error);
  } finally {
    state.createBusy = false;
    updateCreateButton();
  }
});

/* ---------- Group list, selection, archive and trash ---------- */

function visibleGroups() {
  const directory = elements.directorySelect.value;
  const query = elements.groupSearchInput.value.trim().toLowerCase();
  const matching = [...state.groups.values()]
    .filter((group) => {
      if (state.listView === "trash") return Boolean(group.trashedAt);
      if (group.trashedAt) return false;
      return state.listView === "archived" ? group.archived === true : group.archived !== true;
    })
    .filter((group) => !query || groupTitle(group).toLowerCase().includes(query))
    .sort(compareGroupSummaries);
  if (state.listView !== "groups") return matching.filter((group) => group.directory === directory);
  return [
    ...matching.filter((group) => group.pinned),
    ...matching.filter((group) => !group.pinned && group.directory === directory),
  ];
}

function compareGroupSummaries(left, right) {
  return (right.updatedAt || 0) - (left.updatedAt || 0) ||
    String(right.id).localeCompare(String(left.id));
}

function renderGroupList() {
  const trash = state.listView === "trash";
  const archived = state.listView === "archived";
  const groups = visibleGroups();
  const active = state.listView === "groups";
  const pinned = active ? groups.filter((group) => group.pinned) : [];
  const regular = active ? groups.filter((group) => !group.pinned) : groups;
  selectionBar.reconcile(groups);
  selectionBar.setDisabled(!state.authenticated);

  elements.listTitle.textContent = t(trash ? "list.trash" : archived ? "list.archived" : "list.recent");
  elements.listHeading.hidden = selectionBar.isSelecting();
  elements.listViewBackButton.hidden = active;
  elements.archivedViewButton.hidden = !active;
  elements.trashViewButton.hidden = !active;
  elements.selectButton.disabled = !state.authenticated || !groups.some(groupSelectable);

  if (groups.length === 0) {
    const hint = document.createElement("p");
    hint.className = "empty-hint";
    hint.textContent = elements.groupSearchInput.value.trim()
      ? t("list.noMatch")
      : trash
      ? t("list.trashEmpty")
      : archived
      ? t("list.archivedEmpty")
      : t("list.empty");
    elements.groupList.replaceChildren(hint);
    return;
  }
  const items = [];
  if (pinned.length > 0) {
    const section = document.createElement("div");
    section.className = "group-pin-section";
    section.append(...pinned.map((group) => groupItem(group, false)));
    const divider = document.createElement("hr");
    divider.className = "group-pin-divider";
    items.push(section, divider);
  }
  items.push(...regular.map((group) => groupItem(group, trash)));
  elements.groupList.replaceChildren(...items);
}

function groupItem(group, trash) {
  const item = document.createElement("article");
  item.className = "group-item";
  item.dataset.current = String(!selectionBar.isSelecting() && group.id === state.currentGroupId);
  item.setAttribute("role", "listitem");
  const open = document.createElement("button");
  open.type = "button";
  open.className = "group-open";
  if (!selectionBar.isSelecting() && group.id === state.currentGroupId) {
    open.setAttribute("aria-current", "true");
  }
  const title = document.createElement("span");
  title.className = "group-item-title";
  if (selectionBar.isSelecting()) {
    const check = document.createElement("input");
    check.type = "checkbox";
    check.tabIndex = -1;
    const selectable = selectionBar.isSelectable(group);
    check.checked = selectable && selectionBar.isSelected(group.id);
    check.disabled = !selectable || selectionBar.isDisabled();
    check.setAttribute("aria-hidden", "true");
    if (!selectable) open.title = t("list.busyNotSelectable");
    title.append(check);
  }
  title.append(document.createTextNode(groupTitle(group)));
  const meta = document.createElement("span");
  meta.className = "group-item-meta";
  meta.append(...group.members.map((member) => agentDot(member, group)));
  const directory = document.createElement("span");
  directory.className = "group-item-directory";
  directory.textContent = group.directory;
  meta.append(directory);
  const badge = document.createElement("span");
  badge.className = "busy-badge";
  if (trash) {
    badge.textContent = group.deleting ? t("list.deleting") : trashRemainingText(group.purgeAt);
    badge.classList.add("purge-badge");
  } else if (group.busy) {
    const status = group.busyStatus;
    const action = status?.kind === "compacting" ? "compacting" : "replying";
    badge.textContent = status?.agent
      ? t(`list.busyAgent.${action}`, { agent: status.agent })
      : t(`list.busy.${action}`);
    if (status?.agent) paintAgent(badge, memberColor(group, status.agent));
  }
  if (badge.textContent) meta.append(badge);
  open.append(title, meta);
  open.addEventListener("click", () => {
    if (selectionBar.isSelecting()) selectionBar.toggle(group.id);
    else void openListedGroup(group);
  });
  item.append(open);
  if (!selectionBar.isSelecting() && !trash) {
    const actions = document.createElement("div");
    actions.className = "group-item-actions";
    const rename = document.createElement("button");
    rename.className = "group-rename-trigger quiet small icon-button";
    rename.type = "button";
    rename.setAttribute("aria-label", t("list.renameGroup", { title: groupTitle(group) }));
    rename.title = t("rename.title");
    rename.append(groupRenameIcon());
    rename.addEventListener("click", (event) => {
      event.stopPropagation();
      openRenameDialog(group);
    });
    const pin = document.createElement("button");
    pin.className = "group-pin-trigger quiet small icon-button";
    pin.type = "button";
    pin.setAttribute("aria-pressed", String(Boolean(group.pinned)));
    pin.setAttribute("aria-label", t(group.pinned ? "list.unpinGroup" : "list.pinGroup", { title: groupTitle(group) }));
    pin.title = t(group.pinned ? "list.unpin" : "list.pinHint");
    pin.append(groupPinIcon(Boolean(group.pinned)));
    pin.addEventListener("click", (event) => {
      event.stopPropagation();
      void toggleGroupPin(group);
      if (!group.pinned) openRenameDialog(group);
    });
    actions.append(rename, pin);
    item.append(actions);
  }
  return item;
}

function groupRenameIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("group-rename-icon");
  const pencil = document.createElementNS("http://www.w3.org/2000/svg", "path");
  pencil.setAttribute("d", "M4 20h4l11-11a2.8 2.8 0 0 0-4-4L4 16v4zM13.5 6.5l4 4");
  svg.append(pencil);
  return svg;
}

function groupPinIcon(pinned) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("group-pin-icon");

  // Each state has its own glyph so the tilted pin isn't rotated and clipped by the viewBox; the pinned glyph has a filled body.
  const LOOSE = {
    body: "M15 4.5l-4 4l-4 1.5l-1.5 1.5l7 7l1.5-1.5l1.5-4l4-4",
    needle: "M9 15l-4.5 4.5",
    cap: "M14.5 4l5.5 5.5",
  };
  const DRIVEN = {
    body: "M9 4v6l-2 4v2h10v-2l-2-4v-6z",
    needle: "M12 16l0 5",
    cap: "M8 4l8 0",
  };
  const shape = pinned ? DRIVEN : LOOSE;
  const body = document.createElementNS("http://www.w3.org/2000/svg", "path");
  body.setAttribute("d", shape.body);
  if (pinned) body.setAttribute("fill", "currentColor");
  const needle = document.createElementNS("http://www.w3.org/2000/svg", "path");
  needle.setAttribute("d", shape.needle);
  const cap = document.createElementNS("http://www.w3.org/2000/svg", "path");
  cap.setAttribute("d", shape.cap);
  svg.append(body, needle, cap);
  return svg;
}

async function toggleGroupPin(group) {
  try {
    const data = await request("group.pin", { groupId: group.id, pinned: !group.pinned });
    if (data?.group) {
      state.groups.set(data.group.id, data.group);
      if (state.current && data.group.id === state.currentGroupId) state.current.group = data.group;
      renderGroupList();
    }
  } catch (error) {
    elements.listStatus.textContent = errorMessage(error);
  }
}

function setListView(view) {
  state.listView = view;
  selectionBar.setView(view);
  elements.listStatus.textContent = "";
  renderGroupList();
}

elements.selectButton.addEventListener("click", () => {
  elements.listStatus.textContent = "";
  selectionBar.setManualSelection(true);
});

elements.listViewBackButton.addEventListener("click", () => setListView("groups"));
elements.archivedViewButton.addEventListener("click", () => setListView("archived"));
elements.trashViewButton.addEventListener("click", () => setListView("trash"));

function groupSelectable(group) {
  return Boolean(group.trashedAt) || group.archived === true || group.busy !== true;
}

function groupActionUnavailableReason(action, group) {
  return action.id === "restore-trash" && group.deleting
    ? t("selection.restoreDeleting")
    : "";
}

async function executeGroupSelectionAction(action, groupIds) {
  const type = {
    archive: "groups.archive",
    unarchive: "groups.unarchive",
    "trash-active": "groups.trash",
    "trash-archived": "groups.trash",
    "restore-trash": "groups.restore",
    "delete-trash": "groups.purge",
  }[action];
  if (!type) throw new Error(`Unknown group selection action: ${action}`);
  const result = await request(type, { groupIds });
  return {
    succeeded: result.done,
    failed: result.failed.map((failure) => ({
      id: failure.groupId,
      reason: localText(failure.text, failure.message),
    })),
  };
}

function showNotice(message, tone = "warning") {
  noticeController.show(message, { lifetime: "temporary", tone });
}

function agentDot(agent, group = state.current?.group) {
  const dot = document.createElement("span");
  dot.className = "agent-dot";
  dot.dataset.agent = agent;
  dot.title = agent;
  paintAgent(dot, memberColor(group, agent));
  return dot;
}

/* ---------- Opening a group ---------- */

async function openGroup(groupId, { keepPane = false } = {}) {
  const previous = state.currentGroupId;
  if (previous && previous !== groupId) {
    void request("group.unsubscribe", { groupId: previous }).catch(() => {});
  }
  state.openingGroupId = groupId;
  let snapshot;
  try {
    snapshot = await request("group.subscribe", { groupId });
  } finally {
    if (state.openingGroupId === groupId) state.openingGroupId = null;
  }
  // Changing directory clears the current session; a late subscribe response must not reopen a group from the old directory.
  if (snapshot.group.directory !== elements.directorySelect.value) {
    void request("group.unsubscribe", { groupId }).catch(() => {});
    return;
  }
  const switched = previous !== groupId;
  state.currentGroupId = groupId;
  state.current = {
    group: snapshot.group,
    transcript: [...snapshot.transcript],
    round: snapshot.round,
    compaction: snapshot.compaction,
    approvals: new Map(snapshot.approvals.map((approval) => [approval.approvalId, withDeadline(approval)])),
    usage: snapshot.usage,
  };
  state.groups.set(groupId, snapshot.group);
  state.callOrder = [...snapshot.group.callOrder];
  if (switched) {
    elements.composerStatus.textContent = "";
    closePopovers();
    // Attachments belong to a group; unsent ones are cleared when switching groups.
    state.drafts = [];
    renderDrafts();
  }

  elements.groupEmpty.hidden = true;
  elements.groupView.hidden = false;
  if (!keepPane) closeMobileSidebar();
  renderGroupList();
  renderHeader();
  renderTimeline();
  renderApprovals();
  renderCallPicks();
  renderComposer();
  resizeComposer();
}

/** Opening a pinned group in another directory only syncs the directory box and list, without first closing the group being switched to. */
async function openListedGroup(group) {
  if (group.archived || group.trashedAt) return;
  if (!state.directories.includes(group.directory)) {
    elements.listStatus.textContent = t("group.directoryGone");
    return;
  }
  if (group.directory !== elements.directorySelect.value) {
    elements.directorySelect.value = group.directory;
    stateSet(DIRECTORY_KEY, group.directory);
    renderGroupList();
    updateCreateButton();
  }
  elements.listStatus.textContent = "";
  await openGroup(group.id);
}

/** The current group was deleted: go back to the blank page. */
function closeGroup() {
  if (!state.currentGroupId) return;
  void request("group.unsubscribe", { groupId: state.currentGroupId }).catch(() => {});
  state.currentGroupId = null;
  state.current = null;
  closePopovers();
  elements.groupView.hidden = true;
  elements.groupEmpty.hidden = false;
  elements.groupTitle.replaceChildren(brandWordmark());
  elements.groupMembers.replaceChildren();
  renderUsage();
  openMobileSidebar();
}

function renderHeader() {
  const group = state.current?.group;
  if (!group) return;
  updateGroupTitle();
  elements.groupMembers.replaceChildren(...group.members.map((member) => memberFlower(member, group)));
  renderUsage();
}

/** Orchids in the title bar: a click switches the member shown in the usage row; the current one gets an outline. */
function memberFlower(member, group) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "member-flower";
  button.dataset.agent = member;
  button.title = member;
  button.setAttribute("aria-label", member);
  button.setAttribute("aria-pressed", String(group.usageAgent === member));
  paintAgent(button, memberColor(group, member));
  button.append(agentDot(member, group));
  button.addEventListener("click", () => {
    if (group.unavailable.includes(member)) {
      elements.composerStatus.textContent = t("usage.memberNotConnected", { member });
      return;
    }
    if (!memberSupports(group, member, "usage")) {
      elements.composerStatus.textContent = t("usage.memberUnsupported", { member });
      return;
    }
    void setUsageAgent(group.usageAgent === member ? null : member);
  });
  return button;
}

/** Usage row: segments are separated by gray vertical bars; no orchid at the start of the row. */
function renderUsage() {
  const current = state.current;
  const agent = visibleUsageAgent(current?.group);
  if (!current || !agent) {
    elements.groupUsage.hidden = true;
    elements.groupUsage.replaceChildren();
    elements.groupUsage.title = "";
    return;
  }
  const texts = usageTexts(current.usage, lastReplyAt(current.transcript, agent));
  elements.groupUsage.replaceChildren();
  texts.forEach((text, index) => {
    if (index > 0) {
      const separator = document.createElement("span");
      separator.className = "group-usage-separator";
      separator.textContent = "|";
      separator.setAttribute("aria-hidden", "true");
      elements.groupUsage.append(separator);
    }
    elements.groupUsage.append(document.createTextNode(text));
  });
  elements.groupUsage.title = texts.join(" | ");
  elements.groupUsage.hidden = false;
}

async function setUsageAgent(agent) {
  const group = state.current?.group;
  if (!group) return;
  elements.composerStatus.textContent = "";
  try {
    const data = await request("group.usage", { groupId: group.id, agent });
    if (data?.group) handleEvent({ type: "group.updated", group: data.group });
  } catch (error) {
    elements.composerStatus.textContent = errorMessage(error);
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden || !state.authenticated || !state.current?.group.usageAgent) return;
  void request("group.usage.refresh", { groupId: state.current.group.id }).catch(() => {});
});

const mobileNavigationQuery = window.matchMedia("(max-width: 800px)");

function openSidebar() {
  if (mobileNavigationQuery.matches) {
    elements.appView.dataset.mobileSidebarOpen = "true";
    syncSidebarState();
    elements.collapseSidebarButton.focus();
    return;
  }
  state.sidebarCollapsed = false;
  elements.appView.dataset.sidebarCollapsed = "false";
  stateSet(SIDEBAR_COLLAPSED_KEY, "0");
  syncSidebarState();
}

function closeSidebar() {
  if (mobileNavigationQuery.matches) {
    closeMobileSidebar();
    return;
  }
  state.sidebarCollapsed = true;
  elements.appView.dataset.sidebarCollapsed = "true";
  stateSet(SIDEBAR_COLLAPSED_KEY, "1");
  syncSidebarState();
}

function openMobileSidebar() {
  if (!mobileNavigationQuery.matches) return;
  elements.appView.dataset.mobileSidebarOpen = "true";
  syncSidebarState();
}

function closeMobileSidebar() {
  elements.appView.dataset.mobileSidebarOpen = "false";
  syncSidebarState();
}

function syncSidebarState() {
  const sidebarVisible = mobileNavigationQuery.matches
    ? elements.appView.dataset.mobileSidebarOpen === "true"
    : !state.sidebarCollapsed;
  elements.groupSidebar.inert = !sidebarVisible;
  elements.groupSidebar.setAttribute("aria-hidden", String(!sidebarVisible));
  elements.openSidebarButton.setAttribute("aria-expanded", String(sidebarVisible));
  elements.sidebarBackdrop.setAttribute("aria-hidden", String(!(
    mobileNavigationQuery.matches && elements.appView.dataset.mobileSidebarOpen === "true"
  )));
  updateGroupTitle();
}

function brandWordmark() {
  const wordmark = document.createElement("span");
  wordmark.setAttribute("class", "brand-wordmark");
  wordmark.setAttribute("role", "img");
  wordmark.setAttribute("aria-label", t("common.wordmark"));
  wordmark.setAttribute("data-i18n-aria-label", "common.wordmark");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "brand-wordmark-zh");
  svg.setAttribute("viewBox", "0 0 1249 874");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#brand-wordmark");
  svg.append(use);
  const english = document.createElement("span");
  english.setAttribute("class", "brand-wordmark-en");
  english.setAttribute("aria-hidden", "true");
  english.textContent = "Lanting";
  wordmark.append(svg, english);
  return wordmark;
}

function updateGroupTitle() {
  const privateTitle = mobileNavigationQuery.matches || state.sidebarCollapsed;
  const title = privateTitle || !state.current ? null : groupTitle(state.current.group);
  if (title) elements.groupTitle.textContent = title;
  else elements.groupTitle.replaceChildren(brandWordmark());
}

elements.openSidebarButton.addEventListener("click", openSidebar);
elements.collapseSidebarButton.addEventListener("click", closeSidebar);
elements.sidebarBackdrop.addEventListener("click", closeSidebar);
mobileNavigationQuery.addEventListener("change", () => {
  elements.appView.dataset.mobileSidebarOpen = "false";
  syncSidebarState();
});
syncSidebarState();

/* ---------- Timeline ---------- */

function renderTimeline() {
  const current = state.current;
  if (!current) return;
  const entries = document.createElement("div");
  entries.id = "timeline-entries";
  for (const entry of current.transcript) entries.append(entryElement(entry));
  const live = document.createElement("div");
  live.id = "timeline-live";
  elements.timeline.replaceChildren(entries, live);
  renderLive();
  elements.timeline.scrollTop = elements.timeline.scrollHeight;
}

function appendEntry(entry) {
  const container = document.getElementById("timeline-entries");
  if (!container) return;
  keepBottom(() => container.append(entryElement(entry)));
}

function entryElement(entry) {
  const article = document.createElement("article");
  if (entry.from.role === "notice") {
    article.className = "timeline-notice";
    article.dataset.agent = entry.from.agent;
    paintAgent(article, memberColor(state.current?.group, entry.from.agent));
    article.append(agentDot(entry.from.agent), document.createTextNode(localText(entry.noticeText, entry.text)));
    return article;
  }
  if (entry.from.role === "host") {
    article.className = "message host";
    if (entry.text) article.append(renderMarkdown(entry.text));
    if (entry.attachments?.length) {
      const list = document.createElement("div");
      list.className = "entry-attachments";
      for (const attachment of entry.attachments) {
        const chip = document.createElement("span");
        chip.className = "attachment-chip";
        chip.textContent = `📎 ${attachment.originalName}`;
        list.append(chip);
      }
      article.append(list);
    }
    return article;
  }

  const agent = entry.from.agent;
  article.className = "message agent";
  article.dataset.agent = agent;
  paintAgent(article, memberColor(state.current?.group, agent));
  article.append(speakerLabel(agent, entry.status));
  if (entry.activities?.length) article.append(activityDetails(entry.activities));
  if (entry.text.trim()) article.append(renderMarkdown(entry.text));
  if (entry.status === "failed") {
    const error = document.createElement("p");
    error.className = "entry-error";
    error.textContent = localText(entry.errorText, entry.error) || t("entry.failed");
    article.append(error);
  }
  return article;
}

function speakerLabel(agent, status) {
  const label = document.createElement("div");
  label.className = "speaker";
  label.append(agentDot(agent), document.createTextNode(agent));
  const note = ["interrupted", "failed", "thinking", "tool", "replying", "approval", "stopping"].includes(status)
    ? t(`status.${status}`)
    : null;
  if (note) {
    const badge = document.createElement("span");
    badge.className = `status-badge status-${status}`;
    badge.append(document.createTextNode(note));
    if (!["interrupted", "failed"].includes(status)) {
      badge.classList.add("live-status");
      badge.append(thinkingDots());
    }
    label.append(badge);
  }
  return label;
}

function thinkingDots() {
  const dots = document.createElement("span");
  dots.className = "thinking-dots";
  dots.setAttribute("aria-hidden", "true");
  dots.append(document.createElement("i"), document.createElement("i"), document.createElement("i"));
  return dots;
}

function activityDetails(activities) {
  const details = document.createElement("details");
  details.className = "activities";
  const summary = document.createElement("summary");
  summary.textContent = t("activity.count", { count: activities.length });
  details.append(summary, activityList(activities));
  return details;
}

function activityList(activities) {
  const list = document.createElement("ul");
  list.className = "activity-list";
  for (const activity of activities) list.append(activityItem(activity));
  return list;
}

function activityItem(activity) {
  const item = document.createElement("li");
  item.dataset.kind = activity.kind;
  if (activity.kind === "tool") {
    const name = document.createElement("strong");
    name.textContent = String(activity.toolName === undefined ? t("activity.tool") : toolLabel(activity));
    item.append(name);
    if (activity.detail) item.append(document.createTextNode(` ${activity.detail}`));
  } else if (activity.kind === "denied") {
    item.textContent = t("activity.denied", {
      tool: activity.toolName === undefined ? "" : toolLabel(activity),
      message: localText(activity.messageText, activity.message ?? ""),
    });
  } else if (activity.kind === "note") {
    item.textContent = String(activity.text ?? "");
  } else {
    item.textContent = JSON.stringify(activity);
  }
  return item;
}

function renderLive() {
  const live = document.getElementById("timeline-live");
  if (!live) return;
  const round = state.current?.round;
  const compaction = state.current?.compaction;
  keepBottom(() => {
    if (!round && compaction) {
      const waiting = document.createElement("p");
      waiting.className = "live-waiting";
      waiting.append(document.createTextNode(compaction.current
        ? t("live.compacting", { agent: compaction.current })
        : t("live.preparingCompaction")), thinkingDots());
      if (compaction.current) {
        waiting.dataset.agent = compaction.current;
        paintAgent(waiting, memberColor(state.current?.group, compaction.current));
      }
      live.replaceChildren(waiting);
      return;
    }
    if (!round) {
      live.replaceChildren();
      return;
    }
    if (!round.speaking) {
      const waiting = document.createElement("p");
      waiting.className = "live-waiting";
      waiting.append(document.createTextNode(t("live.waiting")), thinkingDots());
      live.replaceChildren(waiting);
      return;
    }
    const article = document.createElement("article");
    article.className = "message agent live";
    article.dataset.agent = round.speaking;
    paintAgent(article, memberColor(state.current?.group, round.speaking));
    article.append(speakerLabel(round.speaking, liveStage(round)));
    if (round.activities.length > 0) article.append(activityList(round.activities));
    if (round.text) {
      const text = document.createElement("pre");
      text.className = "live-text";
      text.textContent = round.text;
      article.append(text);
    }
    live.replaceChildren(article);
  });
}

function liveStage(round) {
  if (state.interrupting) return "stopping";
  if ([...(state.current?.approvals.values() ?? [])].some((approval) => approval.agent === round.speaking)) {
    return "approval";
  }
  if (round.text) return "replying";
  if (round.activities.at(-1)?.kind === "tool") return "tool";
  return "thinking";
}

function keepBottom(change) {
  const timeline = elements.timeline;
  const atBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < STICK_TO_BOTTOM_PX;
  change();
  if (atBottom) timeline.scrollTop = timeline.scrollHeight;
}

/* ---------- Approvals ---------- */

/** The deadline is fixed by the local clock when an approval arrives; remaining time follows the server's remainingMs. */
function withDeadline(approval) {
  const remainingMs = typeof approval.remainingMs === "number"
    ? approval.remainingMs
    : Math.max(0, (approval.expiresAt ?? 0) - Date.now());
  return { ...approval, deadline: Date.now() + remainingMs };
}

function renderApprovals() {
  const approvals = [...(state.current?.approvals.values() ?? [])];
  elements.approvalList.replaceChildren(...approvals.map((approval) => {
    const card = document.createElement("div");
    card.className = "permission-card";
    card.dataset.agent = approval.agent;
    paintAgent(card, memberColor(state.current?.group, approval.agent));
    const title = document.createElement("p");
    title.className = "permission-card-title";
    title.append(agentDot(approval.agent), document.createTextNode(t("approval.title", { agent: approval.agent, tool: toolLabel(approval) })));
    card.append(title);
    const body = document.createElement("div");
    body.className = "permission-card-body";
    if (approval.detail) {
      const detail = document.createElement("pre");
      detail.className = "permission-card-detail";
      detail.textContent = approval.detail;
      body.append(detail);
    }
    const actions = document.createElement("div");
    actions.className = "permission-card-actions";
    const countdown = document.createElement("span");
    countdown.className = "permission-card-countdown";
    countdown.dataset.deadline = String(approval.deadline);
    actions.append(countdown);
    for (const [decision, label, className] of [["deny", t("approval.deny"), "danger"], ["allow", t("approval.allow"), "primary"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = className;
      button.textContent = label;
      button.addEventListener("click", async () => {
        for (const other of actions.querySelectorAll("button")) other.disabled = true;
        try {
          await request("approval.respond", { approvalId: approval.approvalId, decision });
        } catch (error) {
          elements.composerStatus.textContent = errorMessage(error);
          state.current?.approvals.delete(approval.approvalId);
          renderApprovals();
        }
      });
      actions.append(button);
    }
    card.append(body, actions);
    return card;
  }));
  if (approvals.length > 0) startCountdown();
  else stopCountdown();
}

function startCountdown() {
  const tick = () => {
    for (const countdown of elements.approvalList.querySelectorAll(".permission-card-countdown")) {
      const seconds = Math.max(0, Math.round((Number(countdown.dataset.deadline) - Date.now()) / 1_000));
      countdown.textContent = t("approval.countdown", { count: seconds });
    }
  };
  tick();
  if (state.countdownTimer === null) state.countdownTimer = setInterval(tick, 1_000);
}

function stopCountdown() {
  if (state.countdownTimer === null) return;
  clearInterval(state.countdownTimer);
  state.countdownTimer = null;
}

/* ---------- Composer ---------- */

function renderCallPicks() {
  const group = state.current?.group;
  if (!group) return;
  const availableOrder = state.callOrder.filter((member) => !group.unavailable.includes(member));
  if (availableOrder.length !== state.callOrder.length) {
    state.callOrder = availableOrder;
    if (state.skipUnavailableOrderSave) state.skipUnavailableOrderSave = false;
    else if (!state.savingOrder) void saveCallOrder(availableOrder, true);
  }
  elements.callPicks.replaceChildren(...group.members.map((member) => {
    const unavailable = group.unavailable.includes(member);
    const selected = state.callOrder.includes(member);
    const pick = agentPick(member, memberColor(group, member),
      unavailable ? t("member.notConnected", { member }) : member, selected);
    pick.disabled = state.savingOrder || unavailable;
    pick.addEventListener("click", () => {
      void saveCallOrder(toggleMember(state.callOrder, member, !selected));
    });
    return pick;
  }));
}

/** Member button shared by group creation and the call order: leaf plus name; when selected the leaf is filled and the name bold. */
function agentPick(agent, colorId, name, selected) {
  const pick = document.createElement("button");
  pick.type = "button";
  pick.className = "agent-pick";
  pick.dataset.agent = agent;
  paintAgent(pick, colorId);
  const leaf = document.createElement("span");
  leaf.className = "pick-leaf";
  leaf.setAttribute("aria-hidden", "true");
  pick.append(leaf, document.createTextNode(name));
  pick.setAttribute("aria-pressed", String(selected));
  return pick;
}

/** Every call order change is saved to the backend; member buttons and send are locked while saving, and the backend state is restored on failure. */
async function saveCallOrder(order, removingUnavailable = false) {
  const current = state.current;
  if (!current || state.savingOrder) return;
  state.savingOrder = true;
  state.callOrder = order;
  renderCallPicks();
  renderComposer();
  try {
    const { group } = await request("group.callOrder", { groupId: current.group.id, order });
    if (state.current === current) {
      current.group = group;
      state.callOrder = [...group.callOrder];
    }
    elements.composerStatus.textContent = "";
  } catch (error) {
    if (state.current === current) {
      state.callOrder = [...current.group.callOrder];
      if (removingUnavailable) state.skipUnavailableOrderSave = true;
    }
    elements.composerStatus.textContent = t("callOrder.saveFailed", { error: errorMessage(error) });
  } finally {
    state.savingOrder = false;
    renderCallPicks();
    renderComposer();
  }
}

function renderComposer() {
  renderPlusMenu();
  const current = state.current;
  const busy = Boolean(current?.group.busy || current?.round || current?.compaction);
  // Once compaction starts it isn't interrupted; only replies can be interrupted.
  const canInterrupt = busy && !Boolean(current?.compaction && !current?.round);
  const taskLabel = t(canInterrupt ? state.interrupting ? "composer.stopping" : "composer.stop" : "composer.send");
  elements.taskButton.dataset.action = canInterrupt ? "stop" : "send";
  elements.taskButton.setAttribute("aria-label", taskLabel);
  elements.taskButton.title = taskLabel;
  elements.taskButton.classList.toggle("primary", !canInterrupt);
  elements.taskButton.classList.toggle("danger", canInterrupt);
  elements.taskButton.disabled = canInterrupt
    ? !state.authenticated || state.interrupting
    : busy || state.sending || state.savingOrder || !state.authenticated ||
      state.callOrder.length === 0 || state.drafts.some((draft) => draft.status === "uploading");
}

elements.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  if (elements.taskButton.dataset.action === "stop") void interrupt();
  else void send();
});

elements.messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    void send();
  }
});

elements.messageInput.addEventListener("input", resizeComposer);

async function send() {
  const current = state.current;
  const text = elements.messageInput.value;
  const attachmentIds = state.drafts.filter((draft) => draft.status === "done").map((draft) => draft.attachment.id);
  if (!current || (!text.trim() && attachmentIds.length === 0) ||
      elements.taskButton.dataset.action !== "send" || elements.taskButton.disabled) return;
  state.sending = true;
  renderComposer();
  elements.composerStatus.textContent = "";
  try {
    await request("round.start", { groupId: current.group.id, text, order: state.callOrder, attachmentIds });
    elements.messageInput.value = "";
    resizeComposer();
    state.drafts = state.drafts.filter((draft) => draft.status !== "done");
    renderDrafts();
  } catch (error) {
    elements.composerStatus.textContent = errorMessage(error);
  } finally {
    state.sending = false;
    renderComposer();
  }
}

async function interrupt() {
  const current = state.current;
  if (!current || elements.taskButton.dataset.action !== "stop" || elements.taskButton.disabled) return;
  state.interrupting = true;
  renderComposer();
  renderLive();
  try {
    await request("round.interrupt", { groupId: current.group.id });
  } catch (error) {
    elements.composerStatus.textContent = errorMessage(error);
  } finally {
    state.interrupting = false;
    renderComposer();
    renderLive();
  }
}

/* ---------- + menu and member settings dialog ---------- */

function closePopovers() {
  elements.plusMenu.hidden = true;
  elements.plusSubmenu.hidden = true;
  elements.plusButton.setAttribute("aria-expanded", "false");
  state.plusLevel = "root";
  closeAgentPanel();
  closeSettingsColorPicker();
}

function closeSettingsColorPicker() {
  if (state.openColorAgentId === null) return;
  const row = elements.settingsAgentList.querySelector(`[data-agent-id="${state.openColorAgentId}"]`);
  row?.querySelector(".settings-color-panel")?.remove();
  row?.querySelector(".settings-color-button")?.setAttribute("aria-expanded", "false");
  state.openColorAgentId = null;
}

elements.plusButton.addEventListener("click", () => {
  const open = elements.plusMenu.hidden;
  closePopovers();
  if (!open) return;
  elements.plusMenu.hidden = false;
  elements.plusButton.setAttribute("aria-expanded", "true");
  renderPlusMenu();
});

document.addEventListener("click", (event) => {
  // Use the ancestor chain at click time: after the menu redraws in the click handler, the clicked button is no longer in the page,
  // so walking up from it would not find its menu and the click would be mistaken for an outside click.
  const inside = event.composedPath().some((node) =>
    node instanceof Element && node.matches(".menu-anchor, .agent-panel, .settings-color-wrap")
  );
  if (!inside) closePopovers();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closePopovers();
    closeMobileSidebar();
  }
});

function groupBusy() {
  const current = state.current;
  return Boolean(current?.group.busy || current?.round || current?.compaction);
}

/** + menu: group-level shared actions, in two levels. Compact context opens a choice of one AI or all. */
function renderPlusMenu() {
  const group = state.current?.group;
  if (!group || elements.plusMenu.hidden) return;
  const usageMembers = usageCandidates(group);
  if (state.plusLevel === "usage" && usageMembers.length === 0) state.plusLevel = "root";
  const submenuItem = (label, level) => {
    const item = menuItem(label, null, false, () => {
      state.plusLevel = state.plusLevel === level ? "root" : level;
      renderPlusMenu();
    });
    item.classList.add("has-submenu");
    item.classList.toggle("submenu-open", state.plusLevel === level);
    item.setAttribute("aria-expanded", String(state.plusLevel === level));
    return item;
  };
  const compactItem = submenuItem(t("plus.compact"), "compact");
  const settingsItem = submenuItem(t("plus.settings"), "settings");
  // Hidden, not grayed out, when no member can be chosen.
  const usageItem = usageMembers.length > 0 ? submenuItem(t("plus.usage"), "usage") : null;
  const attachItem = menuItem(t("plus.attach"), null, !state.authenticated, () => {
    closePopovers();
    elements.fileInput.click();
  });
  elements.plusMenu.replaceChildren(
    ...[attachItem, compactItem, settingsItem, usageItem].filter(Boolean),
  );

  if (state.plusLevel === "root") {
    elements.plusSubmenu.hidden = true;
    return;
  }
  elements.plusSubmenu.hidden = false;
  if (state.plusLevel === "usage") {
    const back = menuItem(`‹ ${t("plus.usage")}`, null, false, () => {
      state.plusLevel = "root";
      renderPlusMenu();
    });
    back.classList.add("menu-back");
    const choices = usageMembers.map((member) => {
      const selected = group.usageAgent === member;
      const item = menuItem(member, member, !state.authenticated, () => {
        // Clicking the currently selected member again turns it off.
        closePopovers();
        void setUsageAgent(selected ? null : member);
      });
      item.setAttribute("aria-checked", String(selected));
      return item;
    });
    const off = menuItem(t("plus.usageOff"), null, !state.authenticated, () => {
      closePopovers();
      if (group.usageAgent !== null) void setUsageAgent(null);
    });
    off.setAttribute("aria-checked", String(group.usageAgent === null));
    elements.plusSubmenu.replaceChildren(back, ...choices, off);
  } else if (state.plusLevel === "settings") {
    const back = menuItem(`‹ ${t("plus.settings")}`, null, false, () => {
      state.plusLevel = "root";
      renderPlusMenu();
    });
    back.classList.add("menu-back");
    const choices = group.members.map((member) => {
      const unavailable = group.unavailable.includes(member);
      return menuItem(unavailable ? t("member.notConnected", { member }) : member, member, unavailable, () => {
        toggleAgentPanel(member);
      });
    });
    elements.plusSubmenu.replaceChildren(back, ...choices);
  } else {
    const back = menuItem(`‹ ${t("plus.compact")}`, null, false, () => {
      state.plusLevel = "root";
      renderPlusMenu();
    });
    back.classList.add("menu-back");
    const disabled = groupBusy() || !state.authenticated;
    const choices = [
      ...group.members.map((member) => {
        const unavailable = group.unavailable.includes(member);
        const unsupported = !unavailable && !memberSupports(group, member, "compact");
        const label = unavailable
          ? t("member.notConnected", { member })
          : unsupported ? t("member.unsupported", { member }) : member;
        return menuItem(label, member, disabled || unavailable || unsupported, () => {
          closePopovers();
          void compact([member]);
        });
      }),
      menuItem(t("plus.all"), null, disabled, () => {
        closePopovers();
        void compact([...group.members]);
      }),
    ];
    elements.plusSubmenu.replaceChildren(back, ...choices);
  }
  positionPlusSubmenu();
}

function positionPlusSubmenu() {
  const gap = 6;
  const edge = 8;
  const anchorLeft = elements.plusMenu.parentElement.getBoundingClientRect().left;
  const preferredLeft = elements.plusMenu.offsetLeft + elements.plusMenu.offsetWidth + gap;
  const maxLeft = window.innerWidth - anchorLeft - elements.plusSubmenu.offsetWidth - edge;
  elements.plusSubmenu.style.left = `${Math.max(0, Math.min(preferredLeft, maxLeft))}px`;
}

function menuItem(label, agent, disabled, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "menu-item";
  if (agent) {
    button.dataset.agent = agent;
    paintAgent(button, memberColor(state.current?.group, agent));
    button.append(agentDot(agent));
  }
  button.append(document.createTextNode(label));
  button.disabled = disabled;
  button.addEventListener("click", onClick);
  return button;
}

async function compact(agents) {
  const current = state.current;
  if (!current) return;
  elements.composerStatus.textContent = "";
  try {
    await request("group.compact", { groupId: current.group.id, agents });
  } catch (error) {
    elements.composerStatus.textContent = t("compact.startFailed", { error: errorMessage(error) });
  }
}

function catalogKey(groupId, agent) {
  return `${groupId}:${agent}`;
}

/** Asks again on every open; the backend caches, so the CLI isn't started each time. */
async function loadCatalog(agent) {
  const current = state.current;
  if (!current) return;
  const groupId = current.group.id;
  const key = catalogKey(groupId, agent);
  try {
    const catalog = await request("agent.catalog", { groupId, agent });
    state.catalogs.set(key, { catalog });
  } catch (error) {
    state.catalogs.set(key, { error: errorMessage(error) });
  }
  if (state.current === current && state.openAgent === agent) renderAgentPanel();
}

function toggleAgentPanel(agent) {
  const opening = state.openAgent !== agent;
  closePopovers();
  if (!opening) return;
  state.openAgent = agent;
  elements.agentPanel.hidden = false;
  renderAgentPanel();
  void loadCatalog(agent);
}

function closeAgentPanel() {
  state.openAgent = null;
  elements.agentPanel.hidden = true;
}

/** Settings dialog for one AI: model, reasoning effort, permission, plus individual compaction. Affects this group only. */
function renderAgentPanel() {
  const group = state.current?.group;
  const agent = state.openAgent;
  if (!group || !agent || elements.agentPanel.hidden) return;
  if (!group.members.includes(agent)) {
    closeAgentPanel();
    return;
  }
  // Redrawing while a select is open would close it; wait until the user has chosen.
  if (elements.agentPanel.contains(document.activeElement) && document.activeElement?.tagName === "SELECT") return;
  elements.agentPanel.dataset.agent = agent;
  paintAgent(elements.agentPanel, memberColor(group, agent));
  elements.agentPanel.replaceChildren(memberRow(group, agent));
}

function resizeComposer() {
  elements.messageInput.style.height = "auto";
  elements.messageInput.style.height = `${Math.min(
    elements.messageInput.scrollHeight,
    window.innerHeight * 0.34,
  )}px`;
}

function memberRow(group, agent) {
  const row = document.createElement("div");
  row.className = "member-row";
  row.dataset.agent = agent;
  paintAgent(row, memberColor(group, agent));
  const name = document.createElement("div");
  name.className = "member-name";
  name.append(agentDot(agent), document.createTextNode(agent));
  const compactButton = document.createElement("button");
  const unavailable = group.unavailable.includes(agent);
  const supportsCompact = !unavailable && memberSupports(group, agent, "compact");
  compactButton.type = "button";
  compactButton.className = "small";
  compactButton.textContent = t(unavailable ? "member.compactNotConnected" : supportsCompact ? "member.compact" : "member.compactUnsupported");
  compactButton.disabled = groupBusy() || !state.authenticated || unavailable || !supportsCompact;
  compactButton.addEventListener("click", () => {
    closePopovers();
    void compact([agent]);
  });
  name.append(compactButton);
  row.append(name);

  const settings = group.settings?.[agent] ?? { model: null, effort: null, permission: null };
  if (unavailable) {
    row.append(...settingControls(
      { models: [], permissions: [] },
      settings,
      true,
      { model: true, permission: true },
      () => {},
      true,
    ));
    row.append(statusLine(t("member.cliNotConnected")));
    return row;
  }

  const entry = state.catalogs.get(catalogKey(group.id, agent));
  if (!entry) {
    row.append(statusLine(t("catalog.loading")));
    return row;
  }
  if (entry.error) {
    row.append(statusLine(t("catalog.failed", { error: entry.error }), true));
    return row;
  }
  const locked = state.savingSettings.has(agent) || !state.authenticated;
  row.append(...settingControls(
    entry.catalog,
    settings,
    locked,
    {
      model: memberSupports(group, agent, "models"),
      permission: memberSupports(group, agent, "permissions"),
    },
    (next) => void saveSettings(agent, next),
  ));
  row.append(statusLine(t("member.settingsScope")));
  return row;
}

/** Model, reasoning effort and permission selects, plus a description of the current permission. Shared by the member settings dialog and the settings page. */
function settingControls(catalog, settings, locked, supports, save, unavailable = false) {
  const model = catalog.models.find((item) => item.id === settings.model) ?? null;
  const modelUnavailable = unavailable ? t("setting.notConnected") : supports.model ? null : t("setting.unsupported");
  const permissionUnavailable = unavailable
    ? t("setting.notConnected")
    : supports.permission ? null : t("setting.unsupported");
  const modelSelect = settingSelect(t("setting.model"), settings.model, catalog.models.map((item) => ({
    value: item.id,
    label: item.label,
    title: [item.description, item.defaultEffort ? t("setting.defaultEffort", { effort: item.defaultEffort }) : ""]
      .filter(Boolean).join(" · "),
  })), locked || !supports.model, modelUnavailable);
  const effortSelect = settingSelect(t("setting.effort"), settings.effort, (model?.efforts ?? []).map((effort) => ({
    value: effort,
    label: effort,
  })), locked || !supports.model || !model || model.efforts.length === 0, modelUnavailable);
  const permissionSelect = settingSelect(t("setting.permission"), settings.permission, catalog.permissions.map((item) => ({
    value: item.id,
    label: item.danger ? `${permissionLabel(item)} ⚠` : permissionLabel(item),
    title: localText(item.descriptionText, item.description),
  })), locked || !supports.permission, permissionUnavailable);

  modelSelect.select.addEventListener("change", () => {
    const nextModel = modelSelect.select.value || null;
    const efforts = catalog.models.find((item) => item.id === nextModel)?.efforts ?? [];
    // When the new model doesn't support the previous reasoning effort, fall back to the default.
    const effort = nextModel && efforts.includes(settings.effort) ? settings.effort : null;
    save({ ...settings, model: nextModel, effort });
  });
  effortSelect.select.addEventListener("change", () => {
    save({ ...settings, effort: effortSelect.select.value || null });
  });
  permissionSelect.select.addEventListener("change", () => {
    save({ ...settings, permission: permissionSelect.select.value || null });
  });
  const controls = [modelSelect.label, effortSelect.label, permissionSelect.label];
  const permission = catalog.permissions.find((item) => item.id === settings.permission);
  const description = permission ? localText(permission.descriptionText, permission.description) : "";
  if (description) controls.push(statusLine(description));
  return controls;
}

function permissionLabel(item) {
  return localText(item.labelText, item.label);
}

/** A tool name the backend sent; toolKey marks lanting's own generic name for it. */
function toolLabel(source) {
  return source.toolKey ? localText({ key: source.toolKey }, source.toolName) : source.toolName;
}

/**
 * The first option shows "default", or unavailableLabel (the reason it can't be chosen) when given; when available,
 * the current value is shown even if it isn't in the list.
 */
function settingSelect(labelText, value, options, disabled, unavailableLabel = null) {
  const label = document.createElement("label");
  label.className = "setting";
  const caption = document.createElement("span");
  caption.textContent = labelText;
  const select = document.createElement("select");
  select.add(new Option(unavailableLabel ?? t("setting.default"), ""));
  for (const option of options) {
    const element = new Option(option.label, option.value);
    if (option.title) element.title = option.title;
    select.add(element);
  }
  if (unavailableLabel === null && value && !options.some((option) => option.value === value)) {
    select.add(new Option(t("setting.notInList", { value }), value));
  }
  select.value = unavailableLabel === null ? value ?? "" : "";
  select.disabled = disabled;
  label.append(caption, select);
  return { label, select };
}

function statusLine(text, error = false) {
  const line = document.createElement("p");
  line.className = error ? "member-note error" : "member-note";
  line.textContent = text;
  return line;
}

async function saveSettings(agent, settings) {
  const current = state.current;
  if (!current || state.savingSettings.has(agent)) return;
  state.savingSettings.add(agent);
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  renderAgentPanel();
  try {
    const { group } = await request("agent.settings", { groupId: current.group.id, agent, ...settings });
    if (state.current === current) current.group = group;
    elements.composerStatus.textContent = "";
  } catch (error) {
    elements.composerStatus.textContent = t("member.saveFailed", { agent, error: errorMessage(error) });
  } finally {
    state.savingSettings.delete(agent);
    renderAgentPanel();
  }
}

/* ---------- Settings ---------- */

elements.settingsButton.addEventListener("click", () => {
  if (!state.settings) return;
  state.settingsErrors.clear();
  state.settingsNameDrafts.clear();
  state.openColorAgentId = null;
  state.expandedSettingsAgents.clear();
  elements.usernameInput.value = state.settings.username;
  elements.usernameInput.removeAttribute("aria-invalid");
  elements.usernameStatus.textContent = "";
  elements.collaborationInput.value = state.settings.collaboration;
  elements.collaborationInput.removeAttribute("aria-invalid");
  elements.collaborationStatus.textContent = "";
  elements.settingsStatus.textContent = "";
  renderThemeChoice();
  renderLanguageChoice();
  elements.settingsDialog.showModal();
  renderSettingsDialog();
  loadAvailableSettingsCatalogs();
});

// Appearance is stored only in the current browser; theme.js reads, writes and applies it. This item is hidden when it isn't loaded.
function renderThemeChoice() {
  const theme = window.lantingTheme;
  elements.themeSetting.hidden = !theme;
  if (!theme) return;
  const current = theme.get();
  for (const button of elements.themeOptions.querySelectorAll("[data-theme-choice]")) {
    button.setAttribute("aria-pressed", String(button.dataset.themeChoice === current));
  }
}

elements.themeOptions.addEventListener("click", (event) => {
  const button = event.target.closest("[data-theme-choice]");
  if (!button || !window.lantingTheme) return;
  window.lantingTheme.set(button.dataset.themeChoice);
  renderThemeChoice();
});

// Language is stored only in the current browser; i18n.js reads, writes and applies it. This item is hidden when it isn't loaded.
function renderLanguageChoice() {
  const i18n = window.lantingI18n;
  elements.languageSetting.hidden = !i18n;
  if (!i18n) return;
  const current = i18n.get();
  for (const button of elements.languageOptions.querySelectorAll("[data-language-choice]")) {
    button.setAttribute("aria-pressed", String(button.dataset.languageChoice === current));
  }
}

elements.languageOptions.addEventListener("click", (event) => {
  const button = event.target.closest("[data-language-choice]");
  if (button && window.lantingI18n) window.lantingI18n.set(button.dataset.languageChoice);
});

// Redraw everything scripts wrote; markup marked with data-i18n is already refilled by i18n.js.
window.addEventListener("lanting-languagechange", () => {
  renderLanguageChoice();
  const statusKey = elements.connectionStatus.dataset.textKey;
  if (statusKey) elements.connectionStatus.textContent = t(statusKey);
  selectionBar.relabel();
  renderCreateForm();
  renderGroupList();
  if (state.current) {
    const scrollTop = elements.timeline.scrollTop;
    renderHeader();
    renderTimeline();
    elements.timeline.scrollTop = scrollTop;
    renderApprovals();
    renderCallPicks();
    renderComposer();
    renderDrafts();
    renderAgentPanel();
  }
  if (elements.settingsDialog.open) renderSettingsDialog();
});

elements.settingsCloseButton.addEventListener("click", () => {
  state.openColorAgentId = null;
  elements.settingsDialog.close();
});

elements.usernameInput.addEventListener("input", () => {
  elements.usernameInput.removeAttribute("aria-invalid");
  elements.usernameStatus.textContent = "";
});

// The save button is icon-only: after a successful save the check mark briefly changes color and the label changes to "saved".
function flashSaved(button) {
  button.dataset.saved = "true";
  button.setAttribute("aria-label", t("common.saved"));
  button.title = t("common.saved");
  setTimeout(() => {
    delete button.dataset.saved;
    button.setAttribute("aria-label", t("common.save"));
    button.title = t("common.save");
  }, 1_500);
}

elements.usernameForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.usernameSaveButton.disabled = true;
  elements.usernameInput.removeAttribute("aria-invalid");
  elements.usernameStatus.textContent = "";
  try {
    const { settings } = await request("settings.username", { username: elements.usernameInput.value });
    applySettings(settings);
    elements.usernameStatus.textContent = "";
    flashSaved(elements.usernameSaveButton);
  } catch (error) {
    if (error.details?.field === "username") elements.usernameInput.setAttribute("aria-invalid", "true");
    elements.usernameStatus.textContent = errorMessage(error);
  } finally {
    elements.usernameSaveButton.disabled = false;
  }
});

elements.collaborationInput.addEventListener("input", () => {
  elements.collaborationInput.removeAttribute("aria-invalid");
  elements.collaborationStatus.textContent = "";
});

elements.collaborationForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.collaborationSaveButton.disabled = true;
  elements.collaborationInput.removeAttribute("aria-invalid");
  elements.collaborationStatus.textContent = "";
  try {
    const { settings } = await request("settings.collaboration", {
      collaboration: elements.collaborationInput.value,
    });
    applySettings(settings);
    flashSaved(elements.collaborationSaveButton);
  } catch (error) {
    elements.collaborationInput.setAttribute("aria-invalid", "true");
    elements.collaborationStatus.textContent = errorMessage(error);
  } finally {
    elements.collaborationSaveButton.disabled = false;
  }
});

function settingsAgent(agentId) {
  return state.settings?.agents.find((agent) => agent.id === agentId) ?? null;
}

function configuredKind(kind) {
  return state.agentKinds.find((entry) => entry.kind === kind)?.configured === true;
}

function loadAvailableSettingsCatalogs() {
  if (!elements.settingsDialog.open || !state.settings) return;
  for (const agent of state.settings.agents) {
    if (agent.kind !== null && configuredKind(agent.kind)) void loadSettingsCatalog(agent);
  }
}

async function loadSettingsCatalog(agent) {
  if (agent.kind === null || !configuredKind(agent.kind)) return;
  const kind = agent.kind;
  const key = settingsCatalogKey(agent.id, kind);
  if (state.settingsCatalogs.has(key)) return;
  state.settingsCatalogs.set(key, { loading: true });
  renderSettingsDialog();
  try {
    const catalog = await request("settings.catalog", { agentId: agent.id });
    if (settingsAgent(agent.id)?.kind === kind) state.settingsCatalogs.set(key, { catalog });
  } catch (error) {
    if (settingsAgent(agent.id)?.kind === kind) {
      state.settingsCatalogs.set(key, { error: errorMessage(error) });
    }
  }
  renderSettingsDialog();
}

function renderSettingsDialog() {
  if (!elements.settingsDialog.open || !state.settings) return;
  const active = document.activeElement;
  const activeAgentId = active?.closest?.(".settings-agent-row")?.dataset.agentId;
  if (elements.settingsAgentList.contains(active) && settingsAgent(activeAgentId) &&
      (active?.tagName === "INPUT" || active?.tagName === "SELECT")) {
    state.settingsRenderPending = true;
    return;
  }
  state.settingsRenderPending = false;
  if (state.settings.agents.length === 0) {
    const hint = document.createElement("p");
    hint.className = "empty-hint settings-agents-empty";
    hint.textContent = t("settings.noAgents");
    elements.settingsAgentList.replaceChildren(hint);
  } else {
    elements.settingsAgentList.replaceChildren(...state.settings.agents.map(settingsAgentRow));
  }
  updateSettingsActions();
}

function settingsAgentRow(agent) {
  const row = document.createElement("div");
  row.className = "settings-agent-row";
  row.dataset.agent = agent.id;
  row.dataset.agentId = agent.id;
  row.classList.toggle("selected", state.selectedAgentId === agent.id);
  paintAgent(row, agent.color);
  row.addEventListener("click", () => selectSettingsAgent(agent.id));
  row.addEventListener("focusin", () => selectSettingsAgent(agent.id));

  const fields = document.createElement("div");
  fields.className = "settings-agent-fields";
  const locked = state.savingAgents.has(agent.id) || state.settingsActionBusy || !state.authenticated;
  const error = state.settingsErrors.get(agent.id);

  const name = document.createElement("input");
  name.className = "settings-agent-name";
  name.type = "text";
  name.maxLength = 200;
  name.autocomplete = "off";
  name.spellcheck = false;
  name.placeholder = t("settings.namePlaceholder");
  name.setAttribute("aria-label", t("settings.nameLabel"));
  name.value = state.settingsNameDrafts.has(agent.id)
    ? state.settingsNameDrafts.get(agent.id)
    : agent.name;
  name.disabled = locked;
  if (error?.field === "name") name.setAttribute("aria-invalid", "true");
  name.addEventListener("input", () => {
    state.settingsNameDrafts.set(agent.id, name.value);
    clearSettingsFieldError(agent.id, "name");
    name.removeAttribute("aria-invalid");
    row.querySelector(".settings-row-error")?.remove();
  });
  name.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      name.blur();
    }
  });
  name.addEventListener("blur", () => void saveAgentName(agent.id, name.value));

  const kind = document.createElement("select");
  kind.className = "settings-agent-kind";
  kind.setAttribute("aria-label", t("settings.kindLabel"));
  for (const option of kindOptions(state.agentKinds, agent.kind)) {
    const element = new Option(option.label || "CLI", option.value);
    element.disabled = option.disabled;
    element.selected = option.selected;
    kind.add(element);
  }
  kind.value = agent.kind ?? "";
  kind.disabled = locked;
  if (error?.field === "kind") kind.setAttribute("aria-invalid", "true");
  kind.addEventListener("change", () => {
    kind.blur();
    void saveAgentPatch(agent.id, "kind", kind.value || null);
  });

  const color = colorPicker(agent, locked, error?.field === "color");
  const expanded = state.expandedSettingsAgents.has(agent.id);
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "quiet settings-agent-toggle";
  toggle.setAttribute("aria-label", t(expanded ? "settings.collapseDefaults" : "settings.expandDefaults", { name: agent.name }));
  toggle.setAttribute("aria-expanded", String(expanded));
  toggle.addEventListener("click", () => {
    const nextExpanded = !state.expandedSettingsAgents.has(agent.id);
    if (nextExpanded) state.expandedSettingsAgents.add(agent.id);
    else state.expandedSettingsAgents.delete(agent.id);
    syncSettingsRowExpansion(agent.id, nextExpanded);
  });
  fields.append(name, kind, color, toggle);
  row.append(fields);

  const defaults = document.createElement("div");
  defaults.className = "settings-agent-defaults";
  defaults.classList.toggle("expanded", expanded);
  defaults.setAttribute("aria-hidden", String(!expanded));
  defaults.inert = !expanded;
  const defaultsContent = document.createElement("div");
  defaultsContent.className = "settings-agent-defaults-content";
  const defaultsLocked = locked || state.savingDefaults.has(agent.id);
  const kindAvailable = agent.kind !== null && configuredKind(agent.kind);
  const entry = kindAvailable ? state.settingsCatalogs.get(settingsCatalogKey(agent.id, agent.kind)) : null;
  if (!kindAvailable) {
    defaultsContent.append(...settingControls(
      { models: [], permissions: [] },
      agent.defaults,
      true,
      { model: true, permission: true },
      () => {},
    ));
    defaultsContent.append(statusLine(agent.kind === null
      ? t("settings.chooseKindFirst")
      : t("settings.kindNotConfigured")));
  } else if (!entry || entry.loading) {
    defaultsContent.append(statusLine(t("catalog.loading")));
  } else if (entry.error) {
    defaultsContent.append(statusLine(t("catalog.failed", { error: entry.error }), true));
  } else {
    defaultsContent.append(...settingControls(
      entry.catalog,
      agent.defaults,
      defaultsLocked,
      {
        model: kindSupports(state.agentKinds, agent.kind, "models"),
        permission: kindSupports(state.agentKinds, agent.kind, "permissions"),
      },
      (next) => void saveDefaults(agent.id, next),
    ));
  }
  if (error?.field === "defaults") {
    for (const select of defaultsContent.querySelectorAll("select")) select.setAttribute("aria-invalid", "true");
  }
  defaults.append(defaultsContent);
  row.append(defaults);
  if (error) {
    const line = statusLine(error.message, true);
    line.classList.add("settings-row-error");
    row.append(line);
  }
  return row;
}

function colorPicker(agent, locked, invalid) {
  const wrap = document.createElement("div");
  wrap.className = "settings-color-wrap";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "settings-color-button";
  button.setAttribute("aria-label", t("settings.chooseColor"));
  button.setAttribute("aria-haspopup", "true");
  button.setAttribute("aria-expanded", String(state.openColorAgentId === agent.id));
  button.disabled = locked;
  if (invalid) button.setAttribute("aria-invalid", "true");
  paintAgent(button, agent.color);
  button.classList.toggle("empty", agent.color === null);
  button.addEventListener("click", () => {
    state.openColorAgentId = state.openColorAgentId === agent.id ? null : agent.id;
    renderSettingsDialog();
  });
  wrap.append(button);

  if (state.openColorAgentId === agent.id) {
    const panel = document.createElement("div");
    panel.className = "settings-color-panel";
    panel.setAttribute("role", "group");
    panel.setAttribute("aria-label", t("settings.colors"));
    colorChoices(state.palette, state.settings.agents, agent.id).forEach((choice) => {
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "settings-color-choice";
      paintAgent(swatch, choice.id);
      swatch.setAttribute("aria-label", localText({ key: `color.${choice.id}` }, choice.label));
      swatch.setAttribute("aria-pressed", String(agent.color === choice.id));
      swatch.disabled = locked || choice.disabled;
      swatch.addEventListener("click", () => {
        closeSettingsColorPicker();
        void saveAgentPatch(agent.id, "color", choice.id);
      });
      panel.append(swatch);
    });
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "settings-color-clear";
    clear.setAttribute("aria-label", t("settings.noColor"));
    clear.setAttribute("aria-pressed", String(agent.color === null));
    clear.disabled = locked;
    clear.addEventListener("click", () => {
      closeSettingsColorPicker();
      void saveAgentPatch(agent.id, "color", null);
    });
    panel.append(clear);
    wrap.append(panel);
  }
  return wrap;
}

function selectSettingsAgent(agentId) {
  if (state.selectedAgentId === agentId) return;
  state.selectedAgentId = agentId;
  for (const row of elements.settingsAgentList.querySelectorAll(".settings-agent-row")) {
    row.classList.toggle("selected", row.dataset.agentId === agentId);
  }
  updateSettingsActions();
}

function updateSettingsActions() {
  const ids = state.settings?.agents.map((agent) => agent.id) ?? [];
  const index = ids.indexOf(state.selectedAgentId);
  // Not disabled while a per-item save is in flight: the save triggered by a name blur happens between pressing the button and the click.
  const busy = state.settingsActionBusy || !state.authenticated;
  elements.settingsAddButton.disabled = busy || ids.length >= 12;
  elements.settingsRemoveButton.disabled = busy || index < 0;
  elements.settingsUpButton.disabled = busy || index <= 0;
  elements.settingsDownButton.disabled = busy || index < 0 || index === ids.length - 1;
}

/** Top button actions first claim settingsActionBusy, then wait for per-item saves in flight to finish. */
async function beginSettingsAction() {
  if (!state.settings || state.settingsActionBusy) return false;
  state.settingsActionBusy = true;
  elements.settingsStatus.textContent = "";
  updateSettingsActions();
  await Promise.allSettled([...state.settingsSaves]);
  return true;
}

function endSettingsAction() {
  state.settingsActionBusy = false;
  renderSettingsDialog();
}

function trackSettingsSave(promise) {
  state.settingsSaves.add(promise);
  void promise.finally(() => state.settingsSaves.delete(promise));
  return promise;
}

elements.settingsAgentList.addEventListener("focusout", () => {
  // Wait for the new focus to settle; redraw only after focus leaves the list, so the target control isn't replaced mid-click.
  setTimeout(() => {
    if (state.settingsRenderPending && !elements.settingsAgentList.contains(document.activeElement)) {
      renderSettingsDialog();
    }
  }, 0);
});

elements.settingsAddButton.addEventListener("click", () => void addSettingsAgent());
elements.settingsRemoveButton.addEventListener("click", () => void removeSettingsAgent());
elements.settingsUpButton.addEventListener("click", () => void reorderSelectedAgent(-1));
elements.settingsDownButton.addEventListener("click", () => void reorderSelectedAgent(1));

async function addSettingsAgent() {
  if (!(await beginSettingsAction())) return;
  let addedId = null;
  try {
    if (state.settings.agents.length >= 12) return;
    const { settings, agentId } = await request("settings.agent.add");
    applySettings(settings);
    state.selectedAgentId = agentId;
    addedId = agentId;
  } catch (error) {
    elements.settingsStatus.textContent = errorMessage(error);
  } finally {
    endSettingsAction();
    if (addedId) elements.settingsAgentList.querySelector(`[data-agent-id="${addedId}"] input`)?.focus();
  }
}

async function removeSettingsAgent() {
  if (!(await beginSettingsAction())) return;
  try {
    const agentId = state.selectedAgentId;
    if (!agentId) return;
    const ids = state.settings.agents.map((agent) => agent.id);
    const nextSelection = selectionAfterRemove(ids, agentId);
    const { settings } = await request("settings.agent.remove", { agentId });
    applySettings(settings);
    state.selectedAgentId = nextSelection;
  } catch (error) {
    elements.settingsStatus.textContent = errorMessage(error);
  } finally {
    endSettingsAction();
  }
}

async function reorderSelectedAgent(delta) {
  if (!(await beginSettingsAction())) return;
  try {
    if (!state.selectedAgentId) return;
    const ids = state.settings.agents.map((agent) => agent.id);
    const order = moveAgent(ids, state.selectedAgentId, delta);
    if (order.every((id, index) => id === ids[index])) return;
    const { settings } = await request("settings.agent.reorder", { order });
    applySettings(settings);
  } catch (error) {
    elements.settingsStatus.textContent = errorMessage(error);
  } finally {
    endSettingsAction();
  }
}

async function saveAgentName(agentId, value) {
  const agent = settingsAgent(agentId);
  if (!agent) return;
  if (value === agent.name) {
    // This runs synchronously on blur before the new focus settles, so it can't redraw; update just this row in place.
    state.settingsNameDrafts.delete(agentId);
    clearSettingsFieldError(agentId, "name");
    syncSettingsRowError(agentId);
    return;
  }
  await saveAgentPatch(agentId, "name", value);
}

function saveAgentPatch(agentId, field, value) {
  return trackSettingsSave(sendAgentPatch(agentId, field, value));
}

async function sendAgentPatch(agentId, field, value) {
  beginAgentSave(agentId);
  clearSettingsFieldError(agentId, field);
  elements.settingsStatus.textContent = "";
  if (field === "kind") {
    for (const key of state.settingsCatalogs.keys()) {
      if (key.startsWith(`${agentId}:`)) state.settingsCatalogs.delete(key);
    }
  }
  updateSettingsActions();
  try {
    const { settings } = await request("settings.agent.update", { agentId, [field]: value });
    applySettings(settings);
    if (field === "name" && state.settingsNameDrafts.get(agentId) === value) {
      state.settingsNameDrafts.delete(agentId);
    }
  } catch (error) {
    setSettingsError(error, agentId, field);
  } finally {
    endAgentSave(agentId);
    renderSettingsDialog();
    syncSettingsRowError(agentId);
    loadAvailableSettingsCatalogs();
  }
}

function beginAgentSave(agentId) {
  state.savingAgents.set(agentId, (state.savingAgents.get(agentId) ?? 0) + 1);
}

function endAgentSave(agentId) {
  const remaining = (state.savingAgents.get(agentId) ?? 1) - 1;
  if (remaining > 0) state.savingAgents.set(agentId, remaining);
  else state.savingAgents.delete(agentId);
}

function saveDefaults(agentId, settings) {
  if (state.savingDefaults.has(agentId)) return Promise.resolve();
  return trackSettingsSave(sendDefaults(agentId, settings));
}

async function sendDefaults(agentId, settings) {
  state.savingDefaults.add(agentId);
  clearSettingsFieldError(agentId, "defaults");
  elements.settingsStatus.textContent = "";
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  renderSettingsDialog();
  try {
    const { settings: saved } = await request("settings.defaults", { agentId, ...settings });
    applySettings(saved);
  } catch (error) {
    setSettingsError(error, agentId, "defaults");
  } finally {
    state.savingDefaults.delete(agentId);
    renderSettingsDialog();
    syncSettingsRowError(agentId);
  }
}

/** When a redraw is skipped, this row's error state and text still have to be updated in place. */
function syncSettingsRowError(agentId) {
  const row = elements.settingsAgentList.querySelector(`[data-agent-id="${agentId}"]`);
  if (!row) return;
  for (const control of row.querySelectorAll("[aria-invalid]")) control.removeAttribute("aria-invalid");
  row.querySelector(".settings-row-error")?.remove();
  const error = state.settingsErrors.get(agentId);
  if (!error) return;
  const selector = {
    name: ".settings-agent-name",
    kind: ".settings-agent-kind",
    color: ".settings-color-button",
    defaults: ".settings-agent-defaults select",
  }[error.field];
  if (selector) for (const control of row.querySelectorAll(selector)) control.setAttribute("aria-invalid", "true");
  const line = statusLine(error.message, true);
  line.classList.add("settings-row-error");
  row.append(line);
}

function syncSettingsRowExpansion(agentId, expanded) {
  const row = elements.settingsAgentList.querySelector(`[data-agent-id="${agentId}"]`);
  const agent = settingsAgent(agentId);
  if (!row || !agent) return;
  const toggle = row.querySelector(".settings-agent-toggle");
  const defaults = row.querySelector(".settings-agent-defaults");
  toggle?.setAttribute("aria-label", t(expanded ? "settings.collapseDefaults" : "settings.expandDefaults", { name: agent.name }));
  toggle?.setAttribute("aria-expanded", String(expanded));
  defaults?.classList.toggle("expanded", expanded);
  defaults?.setAttribute("aria-hidden", String(!expanded));
  if (defaults) defaults.inert = !expanded;
}

function clearSettingsFieldError(agentId, field) {
  if (state.settingsErrors.get(agentId)?.field === field) state.settingsErrors.delete(agentId);
}

function setSettingsError(error, fallbackAgentId, fallbackField) {
  const field = error.details?.field ?? fallbackField;
  if (field === "username") {
    elements.usernameInput.setAttribute("aria-invalid", "true");
    elements.usernameStatus.textContent = errorMessage(error);
    return;
  }
  const agentId = error.details?.agentId ?? fallbackAgentId;
  if (field && agentId && settingsAgent(agentId)) {
    state.settingsErrors.set(agentId, { field, message: errorMessage(error) });
    if (field === "defaults") {
      state.expandedSettingsAgents.add(agentId);
      syncSettingsRowExpansion(agentId, true);
    }
  } else {
    elements.settingsStatus.textContent = errorMessage(error);
  }
}

/* ---------- Attachments ---------- */

let nextDraftId = 1;

elements.fileInput.addEventListener("change", () => {
  const files = [...(elements.fileInput.files ?? [])];
  elements.fileInput.value = "";
  const current = state.current;
  if (!current) return;
  for (const file of files) {
    if (state.drafts.length >= MAX_MESSAGE_ATTACHMENTS) {
      elements.composerStatus.textContent = t("attach.tooMany", { max: MAX_MESSAGE_ATTACHMENTS });
      break;
    }
    const draft = { localId: nextDraftId++, name: file.name, status: "uploading", attachment: null, error: "" };
    state.drafts.push(draft);
    void upload(current, draft, file);
  }
  renderDrafts();
  renderComposer();
});

/** First request a ticket over the WebSocket, then send the file as-is to the backend, which forwards it to ai-remote-upload. */
async function upload(current, draft, file) {
  try {
    if (file.size > MAX_UPLOAD_BYTES) throw new Error(t("attach.tooLarge"));
    const { ticket } = await request("attachment.ticket", {
      groupId: current.group.id,
      originalName: file.name,
      declaredMime: file.type,
      expectedSize: file.size,
    });
    const response = await fetch("/attachments/upload", {
      method: "POST",
      headers: { "x-upload-ticket": ticket, "content-type": "application/octet-stream" },
      body: file,
      cache: "no-store",
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(localText(result.error?.text, result.error?.message ?? t("attach.uploadFailed")));
    draft.status = "done";
    draft.attachment = result.attachment;
  } catch (error) {
    draft.status = "failed";
    draft.error = errorMessage(error);
  }
  if (state.current !== current) return;
  renderDrafts();
  renderComposer();
}

function renderDrafts() {
  elements.attachmentList.hidden = state.drafts.length === 0;
  elements.attachmentList.replaceChildren(...state.drafts.map((draft) => {
    const chip = document.createElement("span");
    chip.className = `attachment-chip draft ${draft.status}`;
    const labelKey = { uploading: "attach.chipUploading", failed: "attach.chipFailed" }[draft.status];
    chip.textContent = labelKey ? t(labelKey, { name: draft.name }) : draft.name;
    if (draft.error) chip.title = draft.error;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "chip-remove";
    remove.textContent = "×";
    remove.setAttribute("aria-label", t("attach.remove", { name: draft.name }));
    remove.addEventListener("click", () => {
      state.drafts = state.drafts.filter((item) => item !== draft);
      renderDrafts();
      renderComposer();
    });
    chip.append(remove);
    return chip;
  }));
  const failed = state.drafts.find((draft) => draft.status === "failed");
  if (failed) elements.composerStatus.textContent = t("attach.failedStatus", { name: failed.name, error: failed.error });
}

/* ---------- Rename ---------- */

/** The group may change after the dialog opens; submit always renames the group captured when the dialog opened. */
let renamingGroupId = null;

/** Only renames the group in lanting; each AI's native session name is left alone. */
function openRenameDialog(group) {
  if (!group || group.archived || group.trashedAt || group.deleting) return;
  renamingGroupId = group.id;
  elements.renameInput.value = group.title;
  elements.renameStatus.textContent = "";
  elements.renameSaveButton.disabled = false;
  if (!elements.renameDialog.open) elements.renameDialog.showModal();
  elements.renameInput.focus();
  elements.renameInput.select();
}

elements.renameCancelButton.addEventListener("click", () => elements.renameDialog.close());

elements.renameForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const group = state.groups.get(renamingGroupId);
  const title = elements.renameInput.value.trim();
  if (!group || group.archived || group.trashedAt || group.deleting) {
    elements.renameDialog.close();
    return;
  }
  if (!title) return;
  if (title === group.title) {
    elements.renameDialog.close();
    return;
  }
  elements.renameSaveButton.disabled = true;
  elements.renameStatus.textContent = "";
  try {
    const { group: renamed } = await request("group.rename", { groupId: group.id, title });
    state.groups.set(renamed.id, renamed);
    if (state.current && renamed.id === state.currentGroupId) state.current.group = renamed;
    renderGroupList();
    if (renamed.id === state.currentGroupId) renderHeader();
    elements.renameDialog.close();
  } catch (error) {
    elements.renameStatus.textContent = errorMessage(error);
  } finally {
    elements.renameSaveButton.disabled = false;
  }
});

/* ---------- Misc ---------- */

function memberColor(group, agent) {
  return group?.colors?.[agent] ?? null;
}

function paintAgent(element, colorId) {
  const color = paletteColor(state.palette, colorId);
  if (color) {
    element.style.setProperty("--agent-color", color);
    element.dataset.palette = colorId;
  } else {
    element.style.removeProperty("--agent-color");
    delete element.dataset.palette;
  }
}

function showLogin() {
  elements.appView.hidden = true;
  elements.loginView.hidden = false;
  elements.tokenInput.focus();
}

function showApp() {
  elements.loginView.hidden = true;
  elements.appView.hidden = false;
  syncSidebarState();
  updateCreateButton();
}

/** textKey is kept on the element so the text can be redrawn after a language switch. */
function setConnectionStatus(stateName, textKey) {
  elements.connectionStatus.dataset.state = stateName;
  elements.connectionStatus.dataset.textKey = textKey;
  elements.connectionStatus.textContent = t(textKey);
}

/** Status line of the login card: plain notices, progress and errors each use their own color. */
function setLoginStatus(text, tone = null) {
  elements.loginStatus.textContent = text;
  if (tone) elements.loginStatus.dataset.tone = tone;
  else delete elements.loginStatus.dataset.tone;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function stateGet(key) {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function stateSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // If the browser disables local storage, the current page keeps working.
  }
}
