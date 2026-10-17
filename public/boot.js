/* Classic script: app.js is a module script; when an old browser can't load it, this shows a clear message instead of leaving buttons unresponsive. */
(function () {
  var form = document.getElementById("token-form");
  var status = document.getElementById("login-status");
  var button = document.getElementById("connect-button");
  if (!form || !status || !button) return;

  button.disabled = true;
  status.dataset.tone = "progress";
  status.textContent = "页面正在启动……";

  var startupTimer = window.setTimeout(function () {
    if (window.lantingClientReady === true) return;
    status.dataset.tone = "error";
    status.textContent = "页面脚本未能启动，请刷新页面；如果仍然出现此提示，请更新浏览器。";
  }, 5000);

  window.lantingClientMarkReady = function () {
    window.clearTimeout(startupTimer);
    button.disabled = false;
    status.textContent = "";
    delete status.dataset.tone;
  };

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    if (window.lantingClientReady === true) return;
    status.dataset.tone = "progress";
    status.textContent = "页面仍在启动，请稍候……";
  });
}());

/*
 * Page updates happen through normal navigation. The SW only manages the offline copy and doesn't reload pages when it takes control.
 * Registration stays in the classic script so offline support is maintained even if app.js fails to start.
 */
(function () {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch(function () {
      // Failing to register doesn't affect online use.
    });
  });
}());

/* Inner scrolling lists don't rely on whether the browser provides native pull-to-refresh. */
(function () {
  if (!("ontouchstart" in window)) return;
  var start = null;
  var distance = 0;
  var threshold = 90;
  var indicator = document.createElement("div");
  indicator.className = "pull-refresh";
  indicator.setAttribute("role", "status");
  indicator.hidden = true;
  document.body.appendChild(indicator);
  document.documentElement.classList.add("pull-refresh-enabled");

  function reset() {
    start = null;
    distance = 0;
    indicator.hidden = true;
  }

  document.addEventListener("touchstart", function (event) {
    reset();
    if (event.touches.length !== 1 || !(event.target instanceof Element)) return;
    var target = event.target;
    if (target.closest("input, textarea, button, a, select, dialog, [contenteditable], pre")) return;
    var surface = target.closest(".timeline, .group-list, .group-header, .login-view");
    if (!surface || surface.scrollTop > 0 || window.scrollY > 0) return;
    // Nested scroll areas (e.g. long question cards) handle their own scrolling first.
    for (var node = target; node && node !== surface; node = node.parentElement) {
      if (node.scrollHeight > node.clientHeight && /auto|scroll/.test(getComputedStyle(node).overflowY)) return;
    }
    start = { x: event.touches[0].clientX, y: event.touches[0].clientY };
  }, { passive: true });

  document.addEventListener("touchmove", function (event) {
    if (!start) return;
    if (event.touches.length !== 1) { reset(); return; }
    var dx = event.touches[0].clientX - start.x;
    var dy = event.touches[0].clientY - start.y;
    if (dy < 0 || Math.abs(dx) > Math.max(12, dy)) { reset(); return; }
    distance = dy;
    if (dy < 12) { indicator.hidden = true; return; }
    if (!event.cancelable) { reset(); return; }
    event.preventDefault();
    indicator.hidden = false;
    indicator.textContent = distance >= threshold ? "松开刷新" : "下拉刷新";
  }, { passive: false });

  document.addEventListener("touchend", function () {
    var refresh = start && distance >= threshold;
    reset();
    if (refresh) window.location.reload();
  });
  document.addEventListener("touchcancel", reset);
}());
