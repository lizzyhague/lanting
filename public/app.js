const RECONNECT_DELAY_MS = 3_000;
const REQUEST_TIMEOUT_MS = 30_000;

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
};

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
      await request("connection.ready");
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
  }
  // 事件（message.type === "event"）到第 2 步再处理。
}

function showLogin() {
  elements.appView.hidden = true;
  elements.loginView.hidden = false;
  elements.tokenInput.focus();
}

function showApp() {
  elements.loginView.hidden = true;
  elements.appView.hidden = false;
}

function setConnectionStatus(stateName, text) {
  elements.connectionStatus.dataset.state = stateName;
  elements.connectionStatus.textContent = text;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
