import { clearAll, selectAll, toggleMember } from "./call-order.js";
import { renderMarkdown } from "./markdown.js";

const RECONNECT_DELAY_MS = 3_000;
const REQUEST_TIMEOUT_MS = 30_000;
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
  listBackButton: byId("list-back-button"),
  listTitle: byId("list-title"),
  selectButton: byId("select-button"),
  selectionHeading: byId("selection-heading"),
  cancelSelectionButton: byId("cancel-selection-button"),
  selectionCount: byId("selection-count"),
  selectAllButton: byId("select-all-button"),
  listStatus: byId("list-status"),
  trashViewButton: byId("trash-view-button"),
  bulkActions: byId("bulk-actions"),
  bulkRestoreButton: byId("bulk-restore-button"),
  bulkDeleteButton: byId("bulk-delete-button"),
  settingsButton: byId("settings-button"),
  settingsDialog: byId("settings-dialog"),
  settingsCloseButton: byId("settings-close-button"),
  usernameForm: byId("username-form"),
  usernameInput: byId("username-input"),
  usernameSaveButton: byId("username-save-button"),
  usernameStatus: byId("username-status"),
  defaultsList: byId("defaults-list"),
  defaultsStatus: byId("defaults-status"),
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
  backButton: byId("back-button"),
  groupTitle: byId("group-title"),
  groupMeta: byId("group-meta"),
  timeline: byId("timeline"),
  approvalList: byId("approval-list"),
  composer: byId("composer"),
  messageInput: byId("message-input"),
  callPicks: byId("call-picks"),
  plusButton: byId("plus-button"),
  plusMenu: byId("plus-menu"),
  agentPanel: byId("agent-panel"),
  interruptButton: byId("interrupt-button"),
  sendButton: byId("send-button"),
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

  agents: [],
  directories: [],
  /** 群摘要，按 id 存。 */
  groups: new Map(),
  /** 新建群时勾选的 AI。 */
  createMembers: new Set(),
  /** 后端的设置：{ username, defaults, createMembers } */
  settings: null,
  /** 设置页用的模型和权限列表，按 AI 存；值为 { catalog } 或 { error }。 */
  settingsCatalogs: new Map(),
  savingDefaults: new Set(),
  /** 当前群输入框里待发的附件：{ localId, name, status: uploading|done|failed, attachment, error } */
  drafts: [],
  createBusy: false,
  /** 侧栏显示哪一类：groups（群）或 trash（回收站）。 */
  listView: "groups",
  /** 选择模式。回收站里的群点不开，所以回收站一直处在选择模式。 */
  selecting: false,
  selected: new Set(),
  batchBusy: false,

  currentGroupId: null,
  /** 当前打开的群：{ group, transcript, round, compaction, approvals: Map } */
  current: null,
  /** 当前群的点名顺序（勾选的先后），以后端保存的为准。 */
  callOrder: [],
  /** 全选框是独立的开关，不跟着成员的勾选状态变。 */
  selectAllOn: false,
  /** 点名正在保存：多选框和发送按钮都锁住。 */
  savingOrder: false,
  sending: false,
  /** 成员面板用的模型和权限列表，按 “群 id:AI” 存；值为 { catalog } 或 { error }。 */
  catalogs: new Map(),
  /** 正在保存设置的 AI，它的下拉框锁住。 */
  savingSettings: new Set(),
  /** 点名那一排里点开了设置框的 AI。 */
  openAgent: null,
  /** + 菜单当前在哪一级：root 或 compact。 */
  plusLevel: "root",
};

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
      setConnectionStatus("disconnected", errorMessage(error));
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
    if (message.ok) entry.resolve(message.data);
    else entry.reject(new Error(message.error?.message ?? "请求失败。"));
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
      state.settings = event.settings;
      if (event.settings.createMembers) {
        state.createMembers = new Set(event.settings.createMembers);
        renderCreateForm();
      }
      renderSettingsDialog();
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
    case "approval.requested":
      current.approvals.set(event.approval.approvalId, event.approval);
      renderApprovals();
      return;
    case "approval.settled":
      current.approvals.delete(event.approval.approvalId);
      renderApprovals();
      return;
  }
}

/* ---------- 应用状态与新建群 ---------- */

async function loadAppState() {
  const data = await request("app.state");
  const firstLoad = state.agents.length === 0;
  state.agents = data.agents;
  state.directories = data.directories;
  state.groups = new Map(data.groups.map((group) => [group.id, group]));
  state.settings = data.settings;
  // 记住的是上次新建群时的勾选，存在后端；还没建过群时全部勾选。
  if (firstLoad) {
    state.createMembers = new Set(data.settings.createMembers ?? state.agents.map((agent) => agent.id));
  }
  renderCreateForm();
  renderGroupList();
}

function renderCreateForm() {
  const select = elements.directorySelect;
  const previous = select.value;
  select.replaceChildren(new Option("选择工作目录", ""));
  for (const name of state.directories) select.add(new Option(name, name));
  if (state.directories.includes(previous)) select.value = previous;

  elements.memberPicks.replaceChildren(...state.agents.map((agent) => {
    const label = document.createElement("label");
    label.className = "pick";
    label.dataset.agent = agent.id;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = state.createMembers.has(agent.id);
    input.addEventListener("change", () => {
      if (input.checked) state.createMembers.add(agent.id);
      else state.createMembers.delete(agent.id);
      updateCreateButton();
    });
    label.append(input, document.createTextNode(agent.displayName));
    return label;
  }));
  if (state.agents.length === 0) {
    const hint = document.createElement("span");
    hint.className = "empty-hint";
    hint.textContent = "还没有接入任何 AI";
    elements.memberPicks.append(hint);
  }
  updateCreateButton();
}

function updateCreateButton() {
  elements.createButton.disabled = state.createBusy || !state.authenticated ||
    !elements.directorySelect.value || state.createMembers.size === 0;
}

elements.directorySelect.addEventListener("change", updateCreateButton);

elements.createForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const directory = elements.directorySelect.value;
  if (!directory || state.createMembers.size === 0) return;
  state.createBusy = true;
  updateCreateButton();
  elements.createStatus.textContent = "";
  try {
    const members = state.agents.map((agent) => agent.id).filter((id) => state.createMembers.has(id));
    const { group } = await request("group.create", { directory, members, title: defaultTitle(directory) });
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

function defaultTitle(directory) {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${directory} ${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/* ---------- 群列表、选择与回收站 ---------- */

function inSelection() {
  return state.listView === "trash" || state.selecting;
}

function visibleGroups() {
  const trash = state.listView === "trash";
  return [...state.groups.values()]
    .filter((group) => Boolean(group.trashedAt) === trash)
    .sort((a, b) => trash
      ? b.trashedAt.localeCompare(a.trashedAt)
      : b.createdAt.localeCompare(a.createdAt));
}

function renderGroupList() {
  const trash = state.listView === "trash";
  const groups = visibleGroups();
  // 已经不在这一类里的群（被删、被恢复）从选择里去掉。
  const visibleIds = new Set(groups.map((group) => group.id));
  for (const id of state.selected) if (!visibleIds.has(id)) state.selected.delete(id);

  elements.listTitle.textContent = trash ? "回收站" : "群";
  elements.listBackButton.hidden = !trash;
  elements.trashViewButton.hidden = trash;
  elements.selectButton.hidden = trash || state.selecting;
  elements.selectionHeading.hidden = !inSelection();
  // 回收站一直在选择模式，返回用上面的“← 群”。
  elements.cancelSelectionButton.hidden = trash;
  elements.selectionCount.textContent = `已选择 ${state.selected.size} 项`;
  elements.selectAllButton.textContent =
    groups.length > 0 && state.selected.size === groups.length ? "全不选" : "全选";
  elements.bulkActions.hidden = !inSelection();
  elements.bulkRestoreButton.hidden = !trash;
  elements.bulkDeleteButton.textContent = trash ? "永久删除" : "删除";
  const noSelection = state.selected.size === 0 || state.batchBusy || !state.authenticated;
  elements.bulkRestoreButton.disabled = noSelection;
  elements.bulkDeleteButton.disabled = noSelection;

  if (groups.length === 0) {
    const hint = document.createElement("p");
    hint.className = "empty-hint";
    hint.textContent = trash ? "回收站是空的" : "还没有群";
    elements.groupList.replaceChildren(hint);
    return;
  }
  elements.groupList.replaceChildren(...groups.map((group) => groupItem(group, trash)));
}

function groupItem(group, trash) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "group-item";
  if (!inSelection() && group.id === state.currentGroupId) button.setAttribute("aria-current", "true");
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
  meta.append(...group.members.map((member) => agentDot(member)));
  meta.append(document.createTextNode(group.directory));
  const badge = document.createElement("span");
  badge.className = "busy-badge";
  if (trash) {
    badge.textContent = group.deleting ? "正在删除" : `${formatDate(group.purgeAt)} 到期`;
    badge.classList.add("purge-badge");
  } else if (group.busy) {
    badge.textContent = "发言中";
  }
  if (badge.textContent) meta.append(badge);
  button.append(title, meta);
  button.addEventListener("click", () => {
    if (inSelection()) toggleSelected(group.id);
    else void openGroup(group.id);
  });
  return button;
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

function agentDot(agent) {
  const dot = document.createElement("span");
  dot.className = "agent-dot";
  dot.dataset.agent = agent;
  dot.title = agentName(agent);
  return dot;
}

/* ---------- 打开群 ---------- */

async function openGroup(groupId, { keepPane = false } = {}) {
  const previous = state.currentGroupId;
  if (previous && previous !== groupId) {
    void request("group.unsubscribe", { groupId: previous }).catch(() => {});
  }
  const snapshot = await request("group.subscribe", { groupId });
  const switched = previous !== groupId;
  state.currentGroupId = groupId;
  state.current = {
    group: snapshot.group,
    transcript: [...snapshot.transcript],
    round: snapshot.round,
    compaction: snapshot.compaction,
    approvals: new Map(snapshot.approvals.map((approval) => [approval.approvalId, approval])),
  };
  state.groups.set(groupId, snapshot.group);
  state.callOrder = [...snapshot.group.callOrder];
  if (switched) {
    state.selectAllOn = false;
    elements.composerStatus.textContent = "";
    closePopovers();
    // 附件绑定在群上，换群就清掉没发出去的。
    state.drafts = [];
    renderDrafts();
  }

  elements.groupEmpty.hidden = true;
  elements.groupView.hidden = false;
  if (!keepPane) elements.appView.dataset.pane = "group";
  renderGroupList();
  renderHeader();
  renderTimeline();
  renderApprovals();
  renderCallPicks();
  renderComposer();
}

elements.backButton.addEventListener("click", () => {
  elements.appView.dataset.pane = "list";
});

/** 当前的群被删了：回到空白页。 */
function closeGroup() {
  if (!state.currentGroupId) return;
  void request("group.unsubscribe", { groupId: state.currentGroupId }).catch(() => {});
  state.currentGroupId = null;
  state.current = null;
  closePopovers();
  elements.groupView.hidden = true;
  elements.groupEmpty.hidden = false;
  elements.appView.dataset.pane = "list";
}

function renderHeader() {
  const group = state.current?.group;
  if (!group) return;
  elements.groupTitle.textContent = group.title;
  elements.groupMeta.replaceChildren(
    ...group.members.map((member) => agentDot(member)),
    document.createTextNode(group.directory),
  );
}

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
  label.append(agentDot(agent), document.createTextNode(agentName(agent)));
  const note = { interrupted: "已打断", failed: "出错", speaking: "正在发言" }[status];
  if (note) {
    const badge = document.createElement("span");
    badge.className = `status-badge ${status}`;
    badge.textContent = note;
    label.append(badge);
  }
  return label;
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
      waiting.textContent = compaction.current
        ? `正在压缩 ${agentName(compaction.current)} 的上下文……`
        : "准备压缩上下文……";
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
      waiting.textContent = "等待发言……";
      live.replaceChildren(waiting);
      return;
    }
    const article = document.createElement("article");
    article.className = "message agent live";
    article.dataset.agent = round.speaking;
    article.append(speakerLabel(round.speaking, "speaking"));
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

function keepBottom(change) {
  const timeline = elements.timeline;
  const atBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < STICK_TO_BOTTOM_PX;
  change();
  if (atBottom) timeline.scrollTop = timeline.scrollHeight;
}

/* ---------- 审批 ---------- */

function renderApprovals() {
  const approvals = [...(state.current?.approvals.values() ?? [])];
  elements.approvalList.replaceChildren(...approvals.map((approval) => {
    const card = document.createElement("div");
    card.className = "approval";
    card.dataset.agent = approval.agent;
    const title = document.createElement("div");
    title.className = "approval-title";
    title.append(agentDot(approval.agent), document.createTextNode(`${agentName(approval.agent)} 请求使用 ${approval.toolName}`));
    card.append(title);
    if (approval.detail) {
      const detail = document.createElement("pre");
      detail.className = "approval-detail";
      detail.textContent = approval.detail;
      card.append(detail);
    }
    const actions = document.createElement("div");
    actions.className = "approval-actions";
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
}

/* ---------- 输入区 ---------- */

function renderCallPicks() {
  const group = state.current?.group;
  if (!group) return;
  const all = document.createElement("label");
  all.className = "pick";
  const allInput = document.createElement("input");
  allInput.type = "checkbox";
  allInput.checked = state.selectAllOn;
  allInput.disabled = state.savingOrder;
  allInput.addEventListener("change", () => {
    const turningOn = !state.selectAllOn;
    void saveCallOrder(
      turningOn ? selectAll(state.callOrder, group.members) : clearAll(),
      turningOn,
    );
  });
  all.append(allInput, document.createTextNode("全选"));

  // 复选框管点名；名字是按钮，点开这个 AI 的设置框。
  elements.callPicks.replaceChildren(all, ...group.members.map((member) => {
    const pick = document.createElement("span");
    pick.className = "pick";
    pick.dataset.agent = member;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = state.callOrder.includes(member);
    input.disabled = state.savingOrder;
    input.setAttribute("aria-label", `点名 ${agentName(member)}`);
    input.addEventListener("change", () => {
      void saveCallOrder(toggleMember(state.callOrder, member, input.checked), state.selectAllOn);
    });
    const name = document.createElement("button");
    name.type = "button";
    name.className = "pick-name";
    name.textContent = agentName(member);
    name.setAttribute("aria-haspopup", "true");
    name.setAttribute("aria-expanded", String(state.openAgent === member));
    name.addEventListener("click", () => toggleAgentPanel(member));
    pick.append(input, name);
    return pick;
  }));
  positionAgentPanel();
}

/** 每次勾选变化都存到后端；保存期间锁住多选框和发送，失败时恢复成后端的状态。 */
async function saveCallOrder(order, selectAllOn) {
  const current = state.current;
  if (!current || state.savingOrder) return;
  const previousSelectAll = state.selectAllOn;
  state.savingOrder = true;
  state.callOrder = order;
  state.selectAllOn = selectAllOn;
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
      state.selectAllOn = previousSelectAll;
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
  elements.interruptButton.hidden = !busy || Boolean(current?.compaction && !current?.round);
  elements.sendButton.disabled = busy || state.sending || state.savingOrder || !state.authenticated ||
    state.callOrder.length === 0 || state.drafts.some((draft) => draft.status === "uploading");
}

elements.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  void send();
});

elements.messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    void send();
  }
});

async function send() {
  const current = state.current;
  const text = elements.messageInput.value;
  const attachmentIds = state.drafts.filter((draft) => draft.status === "done").map((draft) => draft.attachment.id);
  if (!current || (!text.trim() && attachmentIds.length === 0) || elements.sendButton.disabled) return;
  state.sending = true;
  renderComposer();
  elements.composerStatus.textContent = "";
  try {
    await request("round.start", { groupId: current.group.id, text, order: state.callOrder, attachmentIds });
    elements.messageInput.value = "";
    state.drafts = state.drafts.filter((draft) => draft.status !== "done");
    renderDrafts();
  } catch (error) {
    elements.composerStatus.textContent = errorMessage(error);
  } finally {
    state.sending = false;
    renderComposer();
  }
}

elements.interruptButton.addEventListener("click", async () => {
  const current = state.current;
  if (!current) return;
  elements.interruptButton.disabled = true;
  try {
    await request("round.interrupt", { groupId: current.group.id });
  } catch (error) {
    elements.composerStatus.textContent = errorMessage(error);
  } finally {
    elements.interruptButton.disabled = false;
  }
});

/* ---------- + 菜单与成员设置框 ---------- */

function closePopovers() {
  elements.plusMenu.hidden = true;
  elements.plusButton.setAttribute("aria-expanded", "false");
  state.plusLevel = "root";
  closeAgentPanel();
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
    node instanceof Element && node.matches(".menu-anchor, .agent-panel, .pick-name")
  );
  if (!inside) closePopovers();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closePopovers();
});

window.addEventListener("resize", () => positionAgentPanel());

function groupBusy() {
  const current = state.current;
  return Boolean(current?.group.busy || current?.round || current?.compaction);
}

/** + 菜单：群级的共用操作，分两级。压缩上下文点开后再选某个 AI 或全部。 */
function renderPlusMenu() {
  const group = state.current?.group;
  if (!group || elements.plusMenu.hidden) return;
  if (state.plusLevel === "root") {
    const compactItem = menuItem("压缩上下文", null, false, () => {
      state.plusLevel = "compact";
      renderPlusMenu();
    });
    compactItem.classList.add("has-submenu");
    const renameItem = menuItem("重命名", null, !state.authenticated, () => {
      closePopovers();
      openRenameDialog();
    });
    const attachItem = menuItem("添加附件", null, !state.authenticated, () => {
      closePopovers();
      elements.fileInput.click();
    });
    elements.plusMenu.replaceChildren(attachItem, compactItem, renameItem);
    return;
  }
  const back = menuItem("‹ 压缩上下文", null, false, () => {
    state.plusLevel = "root";
    renderPlusMenu();
  });
  back.classList.add("menu-back");
  const disabled = groupBusy() || !state.authenticated;
  const choices = [
    ...group.members.map((member) => menuItem(agentName(member), member, disabled, () => {
      closePopovers();
      void compact([member]);
    })),
    menuItem("全部", null, disabled, () => {
      closePopovers();
      void compact([...group.members]);
    }),
  ];
  elements.plusMenu.replaceChildren(back, ...choices);
}

function menuItem(label, agent, disabled, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "menu-item";
  if (agent) {
    button.dataset.agent = agent;
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
  setNameExpanded(agent, true);
  renderAgentPanel();
  void loadCatalog(agent);
}

function closeAgentPanel() {
  if (state.openAgent) setNameExpanded(state.openAgent, false);
  state.openAgent = null;
  elements.agentPanel.hidden = true;
}

function setNameExpanded(agent, expanded) {
  const name = elements.callPicks.querySelector(`.pick[data-agent="${agent}"] .pick-name`);
  name?.setAttribute("aria-expanded", String(expanded));
}

/** 设置框从被点的名字那里往上弹出，靠窗口边时往里收。 */
function positionAgentPanel() {
  const agent = state.openAgent;
  if (!agent || elements.agentPanel.hidden) return;
  const pick = elements.callPicks.querySelector(`.pick[data-agent="${agent}"]`);
  const row = elements.agentPanel.offsetParent;
  if (!pick || !(row instanceof HTMLElement)) return;
  const rowBox = row.getBoundingClientRect();
  const pickBox = pick.getBoundingClientRect();
  const width = elements.agentPanel.offsetWidth;
  const left = Math.max(0, Math.min(pickBox.left - rowBox.left, rowBox.width - width));
  elements.agentPanel.style.left = `${left}px`;
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
  elements.agentPanel.replaceChildren(memberRow(group, agent));
  positionAgentPanel();
}

function memberRow(group, agent) {
  const row = document.createElement("div");
  row.className = "member-row";
  row.dataset.agent = agent;
  const name = document.createElement("div");
  name.className = "member-name";
  name.append(agentDot(agent), document.createTextNode(agentName(agent)));
  const compactButton = document.createElement("button");
  compactButton.type = "button";
  compactButton.className = "small";
  compactButton.textContent = "压缩";
  compactButton.disabled = groupBusy() || !state.authenticated;
  compactButton.addEventListener("click", () => {
    closePopovers();
    void compact([agent]);
  });
  name.append(compactButton);
  row.append(name);

  const entry = state.catalogs.get(catalogKey(group.id, agent));
  if (!entry) {
    row.append(statusLine("正在读取可选的模型和权限……"));
    return row;
  }
  if (entry.error) {
    row.append(statusLine(`读取失败：${entry.error}`, true));
    return row;
  }
  const settings = group.settings?.[agent] ?? { model: null, effort: null, permission: null };
  const locked = state.savingSettings.has(agent) || !state.authenticated;
  row.append(...settingControls(entry.catalog, settings, locked, (next) => void saveSettings(agent, next)));
  row.append(statusLine("只影响这个群，下次发言时生效。"));
  return row;
}

/** 模型、思考强度、权限三个下拉框，加当前权限的说明。成员设置框和设置页共用。 */
function settingControls(catalog, settings, locked, save) {
  const model = catalog.models.find((item) => item.id === settings.model) ?? null;
  const modelSelect = settingSelect("模型", settings.model, catalog.models.map((item) => ({
    value: item.id,
    label: item.label,
    title: item.description,
  })), locked);
  const effortSelect = settingSelect("思考强度", settings.effort, (model?.efforts ?? []).map((effort) => ({
    value: effort,
    label: effort,
  })), locked || !model || model.efforts.length === 0);
  const permissionSelect = settingSelect("权限", settings.permission, catalog.permissions.map((item) => ({
    value: item.id,
    label: item.danger ? `${item.label} ⚠` : item.label,
    title: item.description,
  })), locked);

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

/** 第一项是“默认”（不指定，跟随 CLI）；当前值不在列表里时也照样显示出来。 */
function settingSelect(labelText, value, options, disabled) {
  const label = document.createElement("label");
  label.className = "setting";
  const caption = document.createElement("span");
  caption.textContent = labelText;
  const select = document.createElement("select");
  select.add(new Option("默认", ""));
  for (const option of options) {
    const element = new Option(option.label, option.value);
    if (option.title) element.title = option.title;
    select.add(element);
  }
  if (value && !options.some((option) => option.value === value)) select.add(new Option(`${value}（不在列表里）`, value));
  select.value = value ?? "";
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
    elements.composerStatus.textContent = `${agentName(agent)} 的设置没有保存：${errorMessage(error)}`;
  } finally {
    state.savingSettings.delete(agent);
    renderAgentPanel();
  }
}

/* ---------- 设置 ---------- */

elements.settingsButton.addEventListener("click", () => {
  if (!state.settings) return;
  elements.usernameInput.value = state.settings.username;
  elements.usernameStatus.textContent = "";
  elements.defaultsStatus.textContent = "";
  elements.settingsDialog.showModal();
  renderSettingsDialog();
  for (const agent of state.agents) void loadSettingsCatalog(agent.id);
});

elements.settingsCloseButton.addEventListener("click", () => elements.settingsDialog.close());

elements.usernameForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.usernameSaveButton.disabled = true;
  elements.usernameStatus.textContent = "";
  try {
    const { settings } = await request("settings.username", { username: elements.usernameInput.value });
    state.settings = settings;
    elements.usernameStatus.textContent = "";
    elements.usernameSaveButton.textContent = "已保存";
    setTimeout(() => { elements.usernameSaveButton.textContent = "保存"; }, 1_500);
  } catch (error) {
    elements.usernameStatus.textContent = errorMessage(error);
  } finally {
    elements.usernameSaveButton.disabled = false;
  }
});

async function loadSettingsCatalog(agent) {
  try {
    state.settingsCatalogs.set(agent, { catalog: await request("settings.catalog", { agent }) });
  } catch (error) {
    state.settingsCatalogs.set(agent, { error: errorMessage(error) });
  }
  renderSettingsDialog();
}

/** 设置页里每个 AI 一行默认设置。 */
function renderSettingsDialog() {
  if (!elements.settingsDialog.open || !state.settings) return;
  if (elements.defaultsList.contains(document.activeElement) && document.activeElement?.tagName === "SELECT") return;
  elements.defaultsList.replaceChildren(...state.agents.map(({ id: agent }) => {
    const row = document.createElement("div");
    row.className = "member-row defaults-row";
    row.dataset.agent = agent;
    const name = document.createElement("div");
    name.className = "member-name";
    name.append(agentDot(agent), document.createTextNode(agentName(agent)));
    row.append(name);
    const entry = state.settingsCatalogs.get(agent);
    if (!entry) row.append(statusLine("正在读取可选的模型和权限……"));
    else if (entry.error) row.append(statusLine(`读取失败：${entry.error}`, true));
    else {
      const settings = state.settings.defaults[agent] ?? { model: null, effort: null, permission: null };
      const locked = state.savingDefaults.has(agent) || !state.authenticated;
      row.append(...settingControls(entry.catalog, settings, locked, (next) => void saveDefaults(agent, next)));
    }
    return row;
  }));
}

async function saveDefaults(agent, settings) {
  if (state.savingDefaults.has(agent)) return;
  state.savingDefaults.add(agent);
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  elements.defaultsStatus.textContent = "";
  renderSettingsDialog();
  try {
    const { settings: saved } = await request("settings.defaults", { agent, ...settings });
    state.settings = saved;
  } catch (error) {
    elements.defaultsStatus.textContent = `${agentName(agent)} 的默认设置没有保存：${errorMessage(error)}`;
  } finally {
    state.savingDefaults.delete(agent);
    renderSettingsDialog();
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

/** 只改 lanting 里的群名，各 AI 的原生会话名不动。 */
function openRenameDialog() {
  const group = state.current?.group;
  if (!group) return;
  elements.renameInput.value = group.title;
  elements.renameStatus.textContent = "";
  elements.renameSaveButton.disabled = false;
  elements.renameDialog.showModal();
  elements.renameInput.select();
}

elements.renameCancelButton.addEventListener("click", () => elements.renameDialog.close());

elements.renameForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const current = state.current;
  const title = elements.renameInput.value.trim();
  if (!current || !title) return;
  elements.renameSaveButton.disabled = true;
  elements.renameStatus.textContent = "";
  try {
    const { group } = await request("group.rename", { groupId: current.group.id, title });
    state.groups.set(group.id, group);
    if (state.current === current) current.group = group;
    renderGroupList();
    renderHeader();
    elements.renameDialog.close();
  } catch (error) {
    elements.renameStatus.textContent = errorMessage(error);
  } finally {
    elements.renameSaveButton.disabled = false;
  }
});

/* ---------- 杂项 ---------- */

function agentName(id) {
  return state.agents.find((agent) => agent.id === id)?.displayName ?? id;
}

function showLogin() {
  elements.appView.hidden = true;
  elements.loginView.hidden = false;
  elements.tokenInput.focus();
}

function showApp() {
  elements.loginView.hidden = true;
  elements.appView.hidden = false;
  updateCreateButton();
}

function setConnectionStatus(stateName, text) {
  elements.connectionStatus.dataset.state = stateName;
  elements.connectionStatus.textContent = text;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
