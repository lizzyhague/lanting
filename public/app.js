import { renderMarkdown } from "./markdown.js";

const RECONNECT_DELAY_MS = 3_000;
const REQUEST_TIMEOUT_MS = 30_000;
/** 离底部不到这么多像素时，新内容到来自动滚到底；用户往上翻时不打扰。 */
const STICK_TO_BOTTOM_PX = 80;

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
  createBusy: false,

  currentGroupId: null,
  /** 当前打开的群：{ group, transcript, round, approvals: Map } */
  current: null,
  /** 当前群的点名顺序（勾选的先后）。 */
  callOrder: [],
  sending: false,
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
      if (state.currentGroupId) await openGroup(state.currentGroupId, { keepPane: true });
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
    case "group.created":
    case "group.updated":
      state.groups.set(event.group.id, event.group);
      renderGroupList();
      if (state.current && event.group.id === state.currentGroupId) {
        state.current.group = event.group;
        renderHeader();
        renderComposer();
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
  // 第一次默认全部勾选。记住上次选择到第 7 步再做。
  if (firstLoad) state.createMembers = new Set(state.agents.map((agent) => agent.id));
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

/* ---------- 群列表 ---------- */

function renderGroupList() {
  const groups = [...state.groups.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (groups.length === 0) {
    const hint = document.createElement("p");
    hint.className = "empty-hint";
    hint.textContent = "还没有群";
    elements.groupList.replaceChildren(hint);
    return;
  }
  elements.groupList.replaceChildren(...groups.map((group) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "group-item";
    if (group.id === state.currentGroupId) button.setAttribute("aria-current", "true");
    const title = document.createElement("span");
    title.className = "group-item-title";
    title.textContent = group.title;
    const meta = document.createElement("span");
    meta.className = "group-item-meta";
    meta.append(...group.members.map((member) => agentDot(member)));
    meta.append(document.createTextNode(group.directory));
    if (group.busy) {
      const busy = document.createElement("span");
      busy.className = "busy-badge";
      busy.textContent = "发言中";
      meta.append(busy);
    }
    button.append(title, meta);
    button.addEventListener("click", () => void openGroup(group.id));
    return button;
  }));
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
    approvals: new Map(snapshot.approvals.map((approval) => [approval.approvalId, approval])),
  };
  state.groups.set(groupId, snapshot.group);
  if (switched || state.callOrder.length === 0) {
    const members = snapshot.group.members;
    const remembered = snapshot.group.callOrder.filter((agent) => members.includes(agent));
    state.callOrder = remembered.length > 0 ? remembered : [...members];
    elements.composerStatus.textContent = "";
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
  if (entry.from.role === "host") {
    article.className = "message host";
    const body = document.createElement("pre");
    body.textContent = entry.text;
    article.append(body);
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
  keepBottom(() => {
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
  elements.callPicks.replaceChildren(...group.members.map((member) => {
    const label = document.createElement("label");
    label.className = "pick";
    label.dataset.agent = member;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = state.callOrder.includes(member);
    // 发言顺序就是勾选的先后：去掉的移出，重新勾上的排到最后。
    input.addEventListener("change", () => {
      state.callOrder = state.callOrder.filter((agent) => agent !== member);
      if (input.checked) state.callOrder.push(member);
      renderComposer();
    });
    label.append(input, document.createTextNode(agentName(member)));
    return label;
  }));
}

function renderComposer() {
  const busy = Boolean(state.current?.group.busy || state.current?.round);
  elements.interruptButton.hidden = !busy;
  elements.sendButton.disabled = busy || state.sending || !state.authenticated || state.callOrder.length === 0;
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
  if (!current || !text.trim() || elements.sendButton.disabled) return;
  state.sending = true;
  renderComposer();
  elements.composerStatus.textContent = "";
  try {
    await request("round.start", { groupId: current.group.id, text, order: state.callOrder });
    elements.messageInput.value = "";
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
