export const NOTICE_DURATION_MS = Object.freeze({
  info: 5_000,
  warning: 5_000,
  error: 8_000,
  undo: 10_000,
});

const LIFETIMES = new Set(["temporary", "state", "persistent"]);
const TONES = new Set(["info", "warning", "error"]);

export function createNoticeController({
  element,
  textElement,
  actionButton,
  closeButton,
  document: documentRef = globalThis.document,
  clock = defaultClock(),
  onActionError = () => {},
}) {
  let sequence = 0;
  let current = null;
  let timer = null;
  let timerStartedAt = 0;
  let pointerInside = false;
  let focusInside = false;
  const dismissedKeys = new Set();

  const pageVisible = () => documentRef?.visibilityState === "visible";
  const timerCanRun = () => pageVisible() && !pointerInside && !focusInside;

  function cancelTimer(updateRemaining = true) {
    if (timer === null) return;
    clock.clearTimeout(timer);
    timer = null;
    if (updateRemaining && current?.lifetime === "temporary") {
      current.remainingMs = Math.max(0, current.remainingMs - (clock.now() - timerStartedAt));
    }
  }

  function hideCurrent() {
    cancelTimer(false);
    current = null;
    textElement.textContent = "";
    actionButton.textContent = "";
    actionButton.hidden = true;
    actionButton.disabled = false;
    closeButton.hidden = true;
    element.hidden = true;
    delete element.dataset.tone;
    delete element.dataset.lifetime;
  }

  function hideIfCurrent(id) {
    if (current?.id !== id) return false;
    hideCurrent();
    return true;
  }

  function armTimer() {
    if (current?.lifetime !== "temporary" || timer !== null || !timerCanRun()) return;
    if (current.remainingMs <= 0) {
      hideIfCurrent(current.id);
      return;
    }
    const id = current.id;
    timerStartedAt = clock.now();
    timer = clock.setTimeout(() => {
      timer = null;
      if (current?.id !== id) return;
      current.remainingMs = 0;
      hideCurrent();
    }, current.remainingMs);
  }

  function pauseTimer() {
    cancelTimer(true);
  }

  function resumeTimer() {
    armTimer();
  }

  function show(text, options = {}) {
    if (!text) {
      hideCurrent();
      return null;
    }
    const lifetime = options.lifetime ?? "temporary";
    const tone = options.tone ?? "warning";
    if (!LIFETIMES.has(lifetime)) throw new TypeError(`无法识别的提示生命周期：${lifetime}`);
    if (!TONES.has(tone)) throw new TypeError(`无法识别的提示类型：${tone}`);
    const key = typeof options.key === "string" && options.key ? options.key : null;
    if (lifetime === "state" && !key) throw new TypeError("状态提示必须提供 key。");
    if (key && lifetime !== "temporary" && dismissedKeys.has(key) && options.force !== true) {
      return null;
    }

    cancelTimer(false);
    const action = options.action && typeof options.action.run === "function"
      ? { label: String(options.action.label ?? ""), run: options.action.run }
      : null;
    const defaultDuration = NOTICE_DURATION_MS[tone];
    const durationMs = Number.isFinite(options.durationMs) && options.durationMs > 0
      ? options.durationMs
      : defaultDuration;
    current = {
      id: ++sequence,
      key,
      lifetime,
      tone,
      action,
      remainingMs: lifetime === "temporary" ? durationMs : 0,
    };

    textElement.textContent = String(text);
    actionButton.textContent = action?.label ?? "";
    actionButton.hidden = !action;
    actionButton.disabled = false;
    closeButton.hidden = false;
    element.dataset.tone = tone;
    element.dataset.lifetime = lifetime;
    element.hidden = false;
    armTimer();
    return current.id;
  }

  function clear(key) {
    if (typeof key !== "string" || !key) return false;
    dismissedKeys.delete(key);
    if (current?.key !== key) return false;
    hideCurrent();
    return true;
  }

  function clearCurrent() {
    if (!current) return false;
    hideCurrent();
    return true;
  }

  function dismissCurrent() {
    if (!current) return false;
    if (current.key && current.lifetime !== "temporary") dismissedKeys.add(current.key);
    hideCurrent();
    return true;
  }

  function runCurrentAction() {
    const active = current;
    if (!active?.action) return;
    hideCurrent();
    let result;
    try {
      result = active.action.run();
    } catch (error) {
      onActionError(error);
      return;
    }
    Promise.resolve(result).catch(onActionError);
  }

  const onVisibilityChange = () => pageVisible() ? resumeTimer() : pauseTimer();
  const onPointerEnter = () => {
    pointerInside = true;
    pauseTimer();
  };
  const onPointerLeave = () => {
    pointerInside = false;
    resumeTimer();
  };
  const onFocusIn = () => {
    focusInside = true;
    pauseTimer();
  };
  const onFocusOut = (event) => {
    if (event?.relatedTarget && element.contains?.(event.relatedTarget)) return;
    focusInside = false;
    resumeTimer();
  };

  actionButton.addEventListener("click", runCurrentAction);
  closeButton.addEventListener("click", dismissCurrent);
  element.addEventListener("pointerenter", onPointerEnter);
  element.addEventListener("pointerleave", onPointerLeave);
  element.addEventListener("focusin", onFocusIn);
  element.addEventListener("focusout", onFocusOut);
  documentRef?.addEventListener?.("visibilitychange", onVisibilityChange);
  hideCurrent();

  return {
    show,
    clear,
    clearCurrent,
    dismissCurrent,
    get current() {
      return current ? { ...current } : null;
    },
    destroy() {
      hideCurrent();
      actionButton.removeEventListener("click", runCurrentAction);
      closeButton.removeEventListener("click", dismissCurrent);
      element.removeEventListener("pointerenter", onPointerEnter);
      element.removeEventListener("pointerleave", onPointerLeave);
      element.removeEventListener("focusin", onFocusIn);
      element.removeEventListener("focusout", onFocusOut);
      documentRef?.removeEventListener?.("visibilitychange", onVisibilityChange);
    },
  };
}

function defaultClock() {
  return {
    now: () => Date.now(),
    setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimeout: (timer) => globalThis.clearTimeout(timer),
  };
}
