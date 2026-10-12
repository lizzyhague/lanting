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

const RECONNECT_DELAY_MS = 3_000;
const REQUEST_TIMEOUT_MS = 30_000;
const DIRECTORY_KEY = "lanting.directory";
const SIDEBAR_COLLAPSED_KEY = "lanting.sidebar-collapsed";
/** 离底部不到这么多像素时，新内容到来自动滚到底；用户往上翻时不打扰。 */
const STICK_TO_BOTTOM_PX = 80;
/** 照 ai-remote-upload 的限制。 */
const MAX_UPLOAD_BYTES = 25 * 1_048_576;
const MAX_MESSAGE_ATTACHMENTS = 100;

function byId(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`页面缺少元素：${id}`);
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
  listBackButton: byId("list-back-button"),
  listTitle: byId("list-title"),
  selectButton: byId("select-button"),
  selectionHeading: byId("selection-heading"),
  cancelSelectionButton: byId("cancel-selection-button"),
  selectionCount: byId("selection-count"),
  selectAllButton: byId("select-all-button"),
  listStatus: byId("list-status"),
  listDestinations: byId("list-destinations"),
  trashViewButton: byId("trash-view-button"),
  bulkActions: byId("bulk-actions"),
  bulkRestoreButton: byId("bulk-restore-button"),
  bulkDeleteButton: byId("bulk-delete-button"),
  settingsButton: byId("settings-button"),
  collapseSidebarButton: byId("collapse-sidebar-button"),
  settingsDialog: byId("settings-dialog"),
  settingsCloseButton: byId("settings-close-button"),
  usernameForm: byId("username-form"),
  usernameInput: byId("username-input"),
  usernameSaveButton: byId("username-save-button"),
  usernameStatus: byId("username-status"),
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
  /** 每次重新连接加一，旧连接的回调据此作废。 */
  generation: 0,
  socket: null,
  authenticated: false,
  reconnectAllowed: true,
  reconnectTimer: null,
  nextRequestId: 1,
  pending: new Map(),

  /** lanting 支持的 CLI 种类及当前是否配置。 */
  agentKinds: [],
  /** 后端下发的主色表。 */
  palette: [],
  directories: [],
  /** 群摘要，按 id 存。 */
  groups: new Map(),
  /** 新建群时勾选的 AI。 */
  createMembers: new Set(),
  /** 后端的设置：{ username, agents, initialized, createMembers } */
  settings: null,
  /** 设置页用的模型和权限列表，按“内部 id:CLI 种类”存。 */
  settingsCatalogs: new Map(),
  savingDefaults: new Set(),
  /** 同一条记录可能因名字失焦和另一个控件变化而同时有多个请求。 */
  savingAgents: new Map(),
  settingsActionBusy: false,
  /** 进行中的单项保存；顶部按钮先等它们结束，再按最新列表操作。 */
  settingsSaves: new Set(),
  /** 焦点还在输入框或下拉框里时跳过了一次重绘，焦点离开列表后补上。 */
  settingsRenderPending: false,
  selectedAgentId: null,
  openColorAgentId: null,
  /** 当前设置弹窗里展开默认模型和权限的 AI。 */
  expandedSettingsAgents: new Set(),
  /** 名字请求失败后保留用户输入，不被后端快照冲掉。 */
  settingsNameDrafts: new Map(),
  /** 每条 AI 当前的字段错误，键是内部 id。 */
  settingsErrors: new Map(),
  /** 当前群输入框里待发的附件：{ localId, name, status: uploading|done|failed, attachment, error } */
  drafts: [],
  createBusy: false,
  /** 侧栏显示哪一类：groups（群）或 trash（回收站）。 */
  listView: "groups",
  /** 选择模式。回收站里的群点不开，所以回收站一直处在选择模式。 */
  selecting: false,
  selected: new Set(),
  batchBusy: false,
  searchTimer: null,
  sidebarCollapsed: stateGet(SIDEBAR_COLLAPSED_KEY) === "1",

  currentGroupId: null,
  /** 正在等订阅响应的群；换群时旧群已先退订，面板上的群只是还没换下来。 */
  openingGroupId: null,
  /** 当前打开的群：{ group, transcript, round, compaction, approvals: Map } */
  current: null,
  /** 当前群的点名顺序（按钮按下的先后），以后端保存的为准。 */
  callOrder: [],
  /** 点名正在保存：成员按钮和发送按钮都锁住。 */
  savingOrder: false,
  /** 自动移除未接入成员的保存刚失败；恢复后重画时不要立刻再发同一个请求。 */
  skipUnavailableOrderSave: false,
  sending: false,
  interrupting: false,
  /** 成员面板用的模型和权限列表，按 “群 id:AI” 存；值为 { catalog } 或 { error }。 */
  catalogs: new Map(),
  /** 正在保存设置的 AI，它的下拉框锁住。 */
  savingSettings: new Set(),
  /** 当前打开设置框的 AI。 */
  openAgent: null,
  /** + 菜单当前在哪一级：root、compact、settings 或 usage。 */
  plusLevel: "root",
  /** 审批卡片倒计时的定时器；没有待批的审批时为 null。 */
  countdownTimer: null,
};

elements.appView.dataset.sidebarCollapsed = String(state.sidebarCollapsed);

/* ---------- 登录与连接 ---------- */

elements.tokenForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const token = elements.tokenInput.value.trim();
  if (token.length < 32) {
    elements.loginStatus.textContent = "访问令牌至少需要 32 个字符。";
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
  rejectPending(new Error("连接已重新建立。"));

  if (state.socket) {
    state.socket.onclose = null;
    state.socket.close();
    state.socket = null;
  }

  state.authenticated = false;
  elements.connectButton.disabled = true;
  elements.loginStatus.textContent = "正在连接主机……";
  setConnectionStatus("connecting", "正在连接");

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
      throw new Error(
        "没有收到服务器响应。请求可能未到达服务器，或者连接在服务器响应前中断。请检查网络或代理设置后重试。",
      );
    }
    if (generation !== state.generation) return;
    if (response.status === 401) {
      state.reconnectAllowed = false;
      elements.connectButton.disabled = false;
      showLogin();
      elements.loginStatus.textContent = token ? "访问令牌不正确。" : "请登录。";
      return;
    }
    if (!response.ok) throw new Error("登录服务暂时不可用。");
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
    elements.loginStatus.textContent = errorMessage(error);
    elements.connectButton.disabled = false;
    setConnectionStatus("disconnected", "连接已断开");
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
    elements.loginStatus.textContent = "";
    elements.connectButton.disabled = false;
    showApp();
    setConnectionStatus("connecting", "正在恢复连接");
    try {
      await loadAppState();
      await request("connection.ready");
      // 断线重连后回到原来的群，按快照补齐。
      if (state.currentGroupId) {
        // 断线期间这个群可能被删了（进了回收站或已永久删除）。
        const group = state.groups.get(state.currentGroupId);
        if (!group || group.trashedAt) closeGroup();
        else await openGroup(state.currentGroupId, { keepPane: true });
      }
      if (generation !== state.generation || socket.readyState !== WebSocket.OPEN) return;
      setConnectionStatus("connected", "已连接");
    } catch (error) {
      if (generation !== state.generation) return;
      elements.loginStatus.textContent = errorMessage(error);
      elements.connectButton.disabled = false;
    }
  });

  socket.addEventListener("error", () => {
    if (generation === state.generation && !state.authenticated) {
      elements.loginStatus.textContent = "现在无法连接主机。";
      elements.connectButton.disabled = false;
    }
  });

  socket.addEventListener("close", () => {
    if (generation !== state.generation) return;
    state.socket = null;
    state.authenticated = false;
    rejectPending(new Error("连接已断开。"));
    setConnectionStatus("disconnected", "连接已断开");
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
    return Promise.reject(new Error("还没有连接到主机。"));
  }
  const requestId = `r${state.nextRequestId++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(requestId);
      reject(new Error("请求超时。"));
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
      const error = new Error(message.error?.message ?? "请求失败。");
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

/* ---------- 事件 ---------- */

function handleEvent(event) {
  switch (event.type) {
    case "settings.updated":
      applySettings(event.settings);
      return;
    case "group.removed":
      state.groups.delete(event.groupId);
      state.selected.delete(event.groupId);
      if (event.groupId === state.currentGroupId) closeGroup();
      renderGroupList();
      return;
    case "group.created":
    case "group.updated":
      state.groups.set(event.group.id, event.group);
      // 群被移进回收站（可能是别的设备删的），正开着的这个群就关掉。
      if (event.group.trashedAt && event.group.id === state.currentGroupId) closeGroup();
      renderGroupList();
      if (state.current && event.group.id === state.currentGroupId) {
        // 换了 usage 成员，旧成员的结果不能留着。
        if (state.current.group.usageAgent !== event.group.usageAgent) state.current.usage = null;
        state.current.group = event.group;
        // 别的设备改了点名，跟着后端走；自己正在保存时以保存结果为准。
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
      if (event.outcome === "failed") elements.composerStatus.textContent = "这一轮因为出错提前结束了。";
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

/* ---------- 应用状态与新建群 ---------- */

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
  select.replaceChildren(new Option("选择工作目录", ""));
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
    const label = document.createElement("label");
    label.className = "pick";
    label.dataset.agent = agent.id;
    paintAgent(label, agent.color);
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = state.createMembers.has(agent.id);
    input.addEventListener("change", () => {
      if (input.checked) state.createMembers.add(agent.id);
      else state.createMembers.delete(agent.id);
      updateCreateButton();
    });
    const leaf = document.createElement("span");
    leaf.className = "pick-leaf";
    leaf.setAttribute("aria-hidden", "true");
    label.append(input, leaf, document.createTextNode(agent.name));
    return label;
  }));
  if (candidates.length === 0) {
    const hint = document.createElement("span");
    hint.className = "empty-hint";
    hint.textContent = "还没有设置完整的 AI";
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
  state.selecting = false;
  state.selected.clear();
  elements.groupSearchInput.value = "";
  elements.listStatus.textContent = "";
  // 换群途中旧群已经退订，即使目录对得上也不能留着它。
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

/* ---------- 群列表、选择与回收站 ---------- */

function inSelection() {
  return state.listView === "trash" || state.selecting;
}

function visibleGroups() {
  const trash = state.listView === "trash";
  const directory = elements.directorySelect.value;
  const query = elements.groupSearchInput.value.trim().toLowerCase();
  const matching = [...state.groups.values()]
    .filter((group) => Boolean(group.trashedAt) === trash &&
      (!query || group.title.toLowerCase().includes(query)))
    .sort(compareGroupSummaries);
  if (trash) return matching.filter((group) => group.directory === directory);
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
  const groups = visibleGroups();
  const pinned = trash ? [] : groups.filter((group) => group.pinned);
  const regular = trash ? groups : groups.filter((group) => !group.pinned);
  // 已经不在这一类里的群（被删、被恢复）从选择里去掉。
  const visibleIds = new Set(groups.map((group) => group.id));
  for (const id of state.selected) if (!visibleIds.has(id)) state.selected.delete(id);

  elements.listTitle.textContent = trash ? "回收站" : "最近群会话";
  elements.listHeading.hidden = inSelection();
  elements.listBackButton.hidden = !trash;
  elements.trashViewButton.hidden = trash;
  elements.selectButton.hidden = trash || state.selecting;
  elements.selectionHeading.hidden = !inSelection();
  // 回收站一直在选择模式，返回按钮占用选择标题的左侧位置。
  elements.cancelSelectionButton.hidden = trash;
  elements.selectionCount.textContent = `已选择 ${state.selected.size} 项`;
  elements.selectAllButton.textContent =
    groups.length > 0 && state.selected.size === groups.length ? "全不选" : "全选";
  elements.bulkActions.hidden = !inSelection();
  elements.listDestinations.hidden = inSelection();
  elements.bulkActions.dataset.single = String(!trash);
  elements.bulkRestoreButton.hidden = !trash;
  elements.bulkDeleteButton.textContent = trash ? "永久删除" : "删除";
  const noSelection = state.selected.size === 0 || state.batchBusy || !state.authenticated;
  elements.bulkRestoreButton.disabled = noSelection;
  elements.bulkDeleteButton.disabled = noSelection;

  if (groups.length === 0) {
    const hint = document.createElement("p");
    hint.className = "empty-hint";
    hint.textContent = elements.groupSearchInput.value.trim()
      ? "没有找到匹配的群会话。"
      : trash
      ? "回收站是空的"
      : "还没有群";
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
  item.dataset.current = String(!inSelection() && group.id === state.currentGroupId);
  item.setAttribute("role", "listitem");
  const open = document.createElement("button");
  open.type = "button";
  open.className = "group-open";
  if (!inSelection() && group.id === state.currentGroupId) open.setAttribute("aria-current", "true");
  const title = document.createElement("span");
  title.className = "group-item-title";
  if (inSelection()) {
    const check = document.createElement("input");
    check.type = "checkbox";
    check.tabIndex = -1;
    check.checked = state.selected.has(group.id);
    check.setAttribute("aria-hidden", "true");
    title.append(check);
  }
  title.append(document.createTextNode(group.title));
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
    badge.textContent = group.deleting ? "正在删除" : `${formatDate(group.purgeAt)} 到期`;
    badge.classList.add("purge-badge");
  } else if (group.busy) {
    const status = group.busyStatus;
    const action = status?.kind === "compacting" ? "压缩中" : "发言中";
    badge.textContent = status?.agent ? `${status.agent} ${action}` : action;
    if (status?.agent) paintAgent(badge, memberColor(group, status.agent));
  }
  if (badge.textContent) meta.append(badge);
  open.append(title, meta);
  open.addEventListener("click", () => {
    if (inSelection()) toggleSelected(group.id);
    else void openListedGroup(group);
  });
  item.append(open);
  if (!inSelection() && !trash) {
    const actions = document.createElement("div");
    actions.className = "group-item-actions";
    const rename = document.createElement("button");
    rename.className = "group-rename-trigger quiet";
    rename.type = "button";
    rename.setAttribute("aria-label", `重命名 ${group.title}`);
    rename.title = "重命名";
    rename.append(groupRenameIcon());
    rename.addEventListener("click", (event) => {
      event.stopPropagation();
      openRenameDialog(group);
    });
    const pin = document.createElement("button");
    pin.className = "group-pin-trigger quiet";
    pin.type = "button";
    pin.setAttribute("aria-pressed", String(Boolean(group.pinned)));
    pin.setAttribute("aria-label", group.pinned ? `取消钉住 ${group.title}` : `钉住 ${group.title}`);
    pin.title = group.pinned ? "取消钉住" : "钉住后会一直显示在最近群会话顶部";
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

  // 两个状态各用一副图形，避免把斜图钉旋转后裁出 viewBox；钉住时填实钉身。
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

function toggleSelected(groupId) {
  if (state.selected.has(groupId)) state.selected.delete(groupId);
  else state.selected.add(groupId);
  renderGroupList();
}

function formatDate(iso) {
  const date = new Date(iso);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function setListView(view) {
  state.listView = view;
  state.selecting = false;
  state.selected.clear();
  elements.listStatus.textContent = "";
  renderGroupList();
}

elements.selectButton.addEventListener("click", () => {
  state.selecting = true;
  state.selected.clear();
  elements.listStatus.textContent = "";
  renderGroupList();
});

elements.cancelSelectionButton.addEventListener("click", () => setListView("groups"));

elements.selectAllButton.addEventListener("click", () => {
  const groups = visibleGroups();
  if (state.selected.size === groups.length) state.selected.clear();
  else for (const group of groups) state.selected.add(group.id);
  renderGroupList();
});

elements.trashViewButton.addEventListener("click", () => setListView("trash"));
elements.listBackButton.addEventListener("click", () => setListView("groups"));

elements.bulkDeleteButton.addEventListener("click", () => {
  void runBatch(state.listView === "trash" ? "groups.purge" : "groups.trash");
});
elements.bulkRestoreButton.addEventListener("click", () => void runBatch("groups.restore"));

/** 多选操作：后端逐个处理，失败的留在原处并列出原因。永久删除不再另弹确认。 */
async function runBatch(type) {
  const groupIds = [...state.selected];
  if (groupIds.length === 0 || state.batchBusy) return;
  state.batchBusy = true;
  elements.listStatus.textContent = "";
  renderGroupList();
  try {
    const result = await request(type, { groupIds });
    for (const id of result.done) state.selected.delete(id);
    if (result.failed.length > 0) {
      elements.listStatus.textContent = result.failed
        .map((item) => `${state.groups.get(item.groupId)?.title ?? item.groupId}：${item.message}`)
        .join("\n");
    } else if (state.listView === "groups") {
      state.selecting = false;
    }
  } catch (error) {
    elements.listStatus.textContent = errorMessage(error);
  } finally {
    state.batchBusy = false;
    renderGroupList();
  }
}

function agentDot(agent, group = state.current?.group) {
  const dot = document.createElement("span");
  dot.className = "agent-dot";
  dot.dataset.agent = agent;
  dot.title = agent;
  paintAgent(dot, memberColor(group, agent));
  return dot;
}

/* ---------- 打开群 ---------- */

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
  // 换目录会清空当前会话；订阅响应迟到时也不能把旧目录的群重新打开。
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
    // 附件绑定在群上，换群就清掉没发出去的。
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

/** 点开跨目录的钉住群时，只同步目录框和列表，不先关掉正在切换的群。 */
async function openListedGroup(group) {
  if (!state.directories.includes(group.directory)) {
    elements.listStatus.textContent = "这个群的工作目录已经不在了。";
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

/** 当前的群被删了：回到空白页。 */
function closeGroup() {
  if (!state.currentGroupId) return;
  void request("group.unsubscribe", { groupId: state.currentGroupId }).catch(() => {});
  state.currentGroupId = null;
  state.current = null;
  closePopovers();
  elements.groupView.hidden = true;
  elements.groupEmpty.hidden = false;
  elements.groupTitle.textContent = "lanting";
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

/** 标题栏的兰花：点一下切换 usage 行显示的成员，当前那一朵画一圈描边。 */
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
      elements.composerStatus.textContent = `${member} 未接入`;
      return;
    }
    if (!memberSupports(group, member, "usage")) {
      elements.composerStatus.textContent = `${member} 不支持 usage`;
      return;
    }
    void setUsageAgent(group.usageAgent === member ? null : member);
  });
  return button;
}

/** usage 行：各段之间用灰色竖线分开，行首不放兰花。 */
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

function updateGroupTitle() {
  const privateTitle = mobileNavigationQuery.matches || state.sidebarCollapsed;
  elements.groupTitle.textContent = privateTitle
    ? "lanting"
    : (state.current?.group.title ?? "lanting");
}

elements.openSidebarButton.addEventListener("click", openSidebar);
elements.collapseSidebarButton.addEventListener("click", closeSidebar);
elements.sidebarBackdrop.addEventListener("click", closeSidebar);
mobileNavigationQuery.addEventListener("change", () => {
  elements.appView.dataset.mobileSidebarOpen = "false";
  syncSidebarState();
});
syncSidebarState();

/* ---------- 时间线 ---------- */

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
    article.className = "notice";
    article.dataset.agent = entry.from.agent;
    paintAgent(article, memberColor(state.current?.group, entry.from.agent));
    article.append(agentDot(entry.from.agent), document.createTextNode(entry.text));
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
    error.textContent = entry.error || "发言出错。";
    article.append(error);
  }
  return article;
}

function speakerLabel(agent, status) {
  const label = document.createElement("div");
  label.className = "speaker";
  label.append(agentDot(agent), document.createTextNode(agent));
  const note = {
    interrupted: "已打断",
    failed: "出错",
    thinking: "正在思考",
    tool: "正在执行工具",
    replying: "正在回复",
    approval: "等待批准",
    stopping: "正在停止",
  }[status];
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
  summary.textContent = `过程 ${activities.length} 条`;
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
    name.textContent = String(activity.toolName ?? "工具");
    item.append(name);
    if (activity.detail) item.append(document.createTextNode(` ${activity.detail}`));
  } else if (activity.kind === "denied") {
    item.textContent = `已拒绝 ${activity.toolName ?? ""}：${activity.message ?? ""}`;
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
        ? `正在压缩 ${compaction.current} 的上下文`
        : "准备压缩上下文"), thinkingDots());
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
      waiting.append(document.createTextNode("等待发言"), thinkingDots());
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

/* ---------- 审批 ---------- */

/** 收到审批时按本机时钟定下截止时刻；剩余时间以服务端发来的 remainingMs 为准。 */
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
    card.className = "approval";
    card.dataset.agent = approval.agent;
    paintAgent(card, memberColor(state.current?.group, approval.agent));
    const title = document.createElement("div");
    title.className = "approval-title";
    title.append(agentDot(approval.agent), document.createTextNode(`${approval.agent} 请求使用 ${approval.toolName}`));
    card.append(title);
    if (approval.detail) {
      const detail = document.createElement("pre");
      detail.className = "approval-detail";
      detail.textContent = approval.detail;
      card.append(detail);
    }
    const actions = document.createElement("div");
    actions.className = "approval-actions";
    const countdown = document.createElement("span");
    countdown.className = "approval-countdown";
    countdown.dataset.deadline = String(approval.deadline);
    actions.append(countdown);
    for (const [decision, label, className] of [["deny", "拒绝", "danger"], ["allow", "允许", "primary"]]) {
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
    card.append(actions);
    return card;
  }));
  if (approvals.length > 0) startCountdown();
  else stopCountdown();
}

function startCountdown() {
  const tick = () => {
    for (const countdown of elements.approvalList.querySelectorAll(".approval-countdown")) {
      const seconds = Math.max(0, Math.round((Number(countdown.dataset.deadline) - Date.now()) / 1_000));
      countdown.textContent = `${seconds} 秒后自动拒绝`;
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

/* ---------- 输入区 ---------- */

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
    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "call-pick";
    pick.dataset.agent = member;
    paintAgent(pick, memberColor(group, member));
    const leaf = document.createElement("span");
    leaf.className = "pick-leaf";
    leaf.setAttribute("aria-hidden", "true");
    pick.append(leaf, document.createTextNode(unavailable ? `${member}（未接入）` : member));
    pick.disabled = state.savingOrder || unavailable;
    pick.setAttribute("aria-pressed", String(selected));
    pick.addEventListener("click", () => {
      void saveCallOrder(toggleMember(state.callOrder, member, !selected));
    });
    return pick;
  }));
}

/** 每次点名变化都存到后端；保存期间锁住成员按钮和发送，失败时恢复成后端的状态。 */
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
    elements.composerStatus.textContent = `点名没有保存：${errorMessage(error)}`;
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
  // 压缩一旦开始不打断，只有发言能打断。
  const canInterrupt = busy && !Boolean(current?.compaction && !current?.round);
  const taskLabel = canInterrupt ? state.interrupting ? "正在停止" : "停止" : "发送";
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

/* ---------- + 菜单与成员设置框 ---------- */

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
  // 用点击那一刻的祖先链判断：菜单在点击处理里重画后，被点的按钮已经不在页面上，
  // 再从它往上找就找不到所属的菜单，会被误当成点在外面。
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

/** + 菜单：群级的共用操作，分两级。压缩上下文点开后再选某个 AI 或全部。 */
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
  const compactItem = submenuItem("压缩上下文", "compact");
  const settingsItem = submenuItem("AI 设置", "settings");
  // 没有能选的成员时不出现，不置灰。
  const usageItem = usageMembers.length > 0 ? submenuItem("AI usage", "usage") : null;
  const attachItem = menuItem("添加附件", null, !state.authenticated, () => {
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
    const back = menuItem("‹ AI usage", null, false, () => {
      state.plusLevel = "root";
      renderPlusMenu();
    });
    back.classList.add("menu-back");
    const choices = usageMembers.map((member) => {
      const selected = group.usageAgent === member;
      const item = menuItem(member, member, !state.authenticated, () => {
        // 再点当前已选的成员等于关闭。
        closePopovers();
        void setUsageAgent(selected ? null : member);
      });
      item.setAttribute("aria-checked", String(selected));
      return item;
    });
    const off = menuItem("关闭", null, !state.authenticated, () => {
      closePopovers();
      if (group.usageAgent !== null) void setUsageAgent(null);
    });
    off.setAttribute("aria-checked", String(group.usageAgent === null));
    elements.plusSubmenu.replaceChildren(back, ...choices, off);
  } else if (state.plusLevel === "settings") {
    const back = menuItem("‹ AI 设置", null, false, () => {
      state.plusLevel = "root";
      renderPlusMenu();
    });
    back.classList.add("menu-back");
    const choices = group.members.map((member) => {
      const unavailable = group.unavailable.includes(member);
      return menuItem(unavailable ? `${member}（未接入）` : member, member, unavailable, () => {
        toggleAgentPanel(member);
      });
    });
    elements.plusSubmenu.replaceChildren(back, ...choices);
  } else {
    const back = menuItem("‹ 压缩上下文", null, false, () => {
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
          ? `${member}（未接入）`
          : unsupported ? `${member}（不支持）` : member;
        return menuItem(label, member, disabled || unavailable || unsupported, () => {
          closePopovers();
          void compact([member]);
        });
      }),
      menuItem("全部", null, disabled, () => {
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
    elements.composerStatus.textContent = `没有开始压缩：${errorMessage(error)}`;
  }
}

function catalogKey(groupId, agent) {
  return `${groupId}:${agent}`;
}

/** 每次点开都重新问一次；后端有缓存，不会每次都启动 CLI。 */
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

/** 一个 AI 的设置框：模型、思考强度、权限，加单独压缩。只影响这个群。 */
function renderAgentPanel() {
  const group = state.current?.group;
  const agent = state.openAgent;
  if (!group || !agent || elements.agentPanel.hidden) return;
  if (!group.members.includes(agent)) {
    closeAgentPanel();
    return;
  }
  // 下拉框正打开时重画会把它收起来，等用户选完再画。
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
  compactButton.textContent = unavailable ? "压缩（未接入）" : supportsCompact ? "压缩" : "压缩（不支持）";
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
    row.append(statusLine("这个 CLI 未接入。"));
    return row;
  }

  const entry = state.catalogs.get(catalogKey(group.id, agent));
  if (!entry) {
    row.append(statusLine("正在读取可选的模型和权限……"));
    return row;
  }
  if (entry.error) {
    row.append(statusLine(`读取失败：${entry.error}`, true));
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
  row.append(statusLine("只影响这个群，下次发言时生效。"));
  return row;
}

/** 模型、思考强度、权限三个下拉框，加当前权限的说明。成员设置框和设置页共用。 */
function settingControls(catalog, settings, locked, supports, save, unavailable = false) {
  const model = catalog.models.find((item) => item.id === settings.model) ?? null;
  const modelSelect = settingSelect("模型", settings.model, catalog.models.map((item) => ({
    value: item.id,
    label: item.label,
    title: item.description,
  })), locked || !supports.model, unavailable ? "（未接入）" : supports.model ? "默认" : "（不支持）");
  const effortSelect = settingSelect("思考强度", settings.effort, (model?.efforts ?? []).map((effort) => ({
    value: effort,
    label: effort,
  })), locked || !supports.model || !model || model.efforts.length === 0,
  unavailable ? "（未接入）" : supports.model ? "默认" : "（不支持）");
  const permissionSelect = settingSelect("权限", settings.permission, catalog.permissions.map((item) => ({
    value: item.id,
    label: item.danger ? `${item.label} ⚠` : item.label,
    title: item.description,
  })), locked || !supports.permission,
  unavailable ? "（未接入）" : supports.permission ? "默认" : "（不支持）");

  modelSelect.select.addEventListener("change", () => {
    const nextModel = modelSelect.select.value || null;
    const efforts = catalog.models.find((item) => item.id === nextModel)?.efforts ?? [];
    // 新模型不支持原来的思考强度时，回到默认。
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
  const description = catalog.permissions.find((item) => item.id === settings.permission)?.description;
  if (description) controls.push(statusLine(description));
  return controls;
}

/** 第一项显示“默认”或不可用原因；可用时，当前值不在列表里也照样显示出来。 */
function settingSelect(labelText, value, options, disabled, defaultLabel = "默认") {
  const label = document.createElement("label");
  label.className = "setting";
  const caption = document.createElement("span");
  caption.textContent = labelText;
  const select = document.createElement("select");
  select.add(new Option(defaultLabel, ""));
  for (const option of options) {
    const element = new Option(option.label, option.value);
    if (option.title) element.title = option.title;
    select.add(element);
  }
  if (defaultLabel === "默认" && value && !options.some((option) => option.value === value)) {
    select.add(new Option(`${value}（不在列表里）`, value));
  }
  select.value = defaultLabel === "默认" ? value ?? "" : "";
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
    elements.composerStatus.textContent = `${agent} 的设置没有保存：${errorMessage(error)}`;
  } finally {
    state.savingSettings.delete(agent);
    renderAgentPanel();
  }
}

/* ---------- 设置 ---------- */

elements.settingsButton.addEventListener("click", () => {
  if (!state.settings) return;
  state.settingsErrors.clear();
  state.settingsNameDrafts.clear();
  state.openColorAgentId = null;
  state.expandedSettingsAgents.clear();
  elements.usernameInput.value = state.settings.username;
  elements.usernameInput.removeAttribute("aria-invalid");
  elements.usernameStatus.textContent = "";
  elements.settingsStatus.textContent = "";
  elements.settingsDialog.showModal();
  renderSettingsDialog();
  loadAvailableSettingsCatalogs();
});

elements.settingsCloseButton.addEventListener("click", () => {
  state.openColorAgentId = null;
  elements.settingsDialog.close();
});

elements.usernameInput.addEventListener("input", () => {
  elements.usernameInput.removeAttribute("aria-invalid");
  elements.usernameStatus.textContent = "";
});

elements.usernameForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.usernameSaveButton.disabled = true;
  elements.usernameInput.removeAttribute("aria-invalid");
  elements.usernameStatus.textContent = "";
  try {
    const { settings } = await request("settings.username", { username: elements.usernameInput.value });
    applySettings(settings);
    elements.usernameStatus.textContent = "";
    elements.usernameSaveButton.textContent = "已保存";
    setTimeout(() => { elements.usernameSaveButton.textContent = "保存"; }, 1_500);
  } catch (error) {
    if (error.details?.field === "username") elements.usernameInput.setAttribute("aria-invalid", "true");
    elements.usernameStatus.textContent = errorMessage(error);
  } finally {
    elements.usernameSaveButton.disabled = false;
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
    hint.textContent = "还没有 AI";
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
  name.placeholder = "名字";
  name.setAttribute("aria-label", "AI 名字");
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
  kind.setAttribute("aria-label", "CLI 种类");
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
  toggle.setAttribute("aria-label", `${expanded ? "收起" : "展开"}${agent.name}的模型和权限设置`);
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
      ? "选择 CLI 后可以设置默认值。"
      : "这个 CLI 没有在 config.json 中配置。"));
  } else if (!entry || entry.loading) {
    defaultsContent.append(statusLine("正在读取可选的模型和权限……"));
  } else if (entry.error) {
    defaultsContent.append(statusLine(`读取失败：${entry.error}`, true));
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
  button.setAttribute("aria-label", "选择主色");
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
    panel.setAttribute("aria-label", "主色");
    colorChoices(state.palette, state.settings.agents, agent.id).forEach((choice) => {
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "settings-color-choice";
      swatch.style.setProperty("--choice-color", choice.color);
      swatch.setAttribute("aria-label", choice.label);
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
    clear.setAttribute("aria-label", "不选择主色");
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
  // 单项保存进行中时不禁用：名字失焦发出的保存就发生在按下按钮和 click 之间。
  const busy = state.settingsActionBusy || !state.authenticated;
  elements.settingsAddButton.disabled = busy || ids.length >= 12;
  elements.settingsRemoveButton.disabled = busy || index < 0;
  elements.settingsUpButton.disabled = busy || index <= 0;
  elements.settingsDownButton.disabled = busy || index < 0 || index === ids.length - 1;
}

/** 顶部按钮的操作先占住 settingsActionBusy，再等进行中的单项保存结束。 */
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
  // 等新焦点落定；焦点离开列表后才补重绘，不在点击途中换掉目标控件。
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
    // 这里在失焦时同步执行，新焦点还没落定，不能重绘，只就地更新这一行。
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

/** 重绘被跳过时，也要把这一行的错误标记和文字就地更新。 */
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
  toggle?.setAttribute("aria-label", `${expanded ? "收起" : "展开"}${agent.name}的模型和权限设置`);
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

/* ---------- 附件 ---------- */

let nextDraftId = 1;

elements.fileInput.addEventListener("change", () => {
  const files = [...(elements.fileInput.files ?? [])];
  elements.fileInput.value = "";
  const current = state.current;
  if (!current) return;
  for (const file of files) {
    if (state.drafts.length >= MAX_MESSAGE_ATTACHMENTS) {
      elements.composerStatus.textContent = `一条消息最多 ${MAX_MESSAGE_ATTACHMENTS} 个附件。`;
      break;
    }
    const draft = { localId: nextDraftId++, name: file.name, status: "uploading", attachment: null, error: "" };
    state.drafts.push(draft);
    void upload(current, draft, file);
  }
  renderDrafts();
  renderComposer();
});

/** 先在 WebSocket 上要一张票据，再把文件原样传给后端，由后端转交 ai-remote-upload。 */
async function upload(current, draft, file) {
  try {
    if (file.size > MAX_UPLOAD_BYTES) throw new Error("单个文件不能超过 25 MiB。");
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
    if (!response.ok) throw new Error(result.error?.message ?? "上传失败。");
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
    const label = { uploading: "上传中", done: "", failed: "失败" }[draft.status];
    chip.textContent = label ? `${draft.name}（${label}）` : draft.name;
    if (draft.error) chip.title = draft.error;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "chip-remove";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `移除 ${draft.name}`);
    remove.addEventListener("click", () => {
      state.drafts = state.drafts.filter((item) => item !== draft);
      renderDrafts();
      renderComposer();
    });
    chip.append(remove);
    return chip;
  }));
  const failed = state.drafts.find((draft) => draft.status === "failed");
  if (failed) elements.composerStatus.textContent = `${failed.name} 上传失败：${failed.error}`;
}

/* ---------- 重命名 ---------- */

/** 弹窗打开后群可能切换；提交始终改打开弹窗时认下的群。 */
let renamingGroupId = null;

/** 只改 lanting 里的群名，各 AI 的原生会话名不动。 */
function openRenameDialog(group) {
  if (!group || group.trashedAt || group.deleting) return;
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
  if (!group || group.trashedAt || group.deleting) {
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

/* ---------- 杂项 ---------- */

function memberColor(group, agent) {
  return group?.colors?.[agent] ?? null;
}

function paintAgent(element, colorId) {
  const color = paletteColor(state.palette, colorId);
  if (color) element.style.setProperty("--agent", color);
  else element.style.removeProperty("--agent");
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

function setConnectionStatus(stateName, text) {
  elements.connectionStatus.dataset.state = stateName;
  elements.connectionStatus.textContent = text;
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
    // 浏览器禁用本地存储时，当前页面仍可继续使用。
  }
}
