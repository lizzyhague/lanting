/* 经典脚本：app.js 是模块脚本，旧浏览器加载不了时，这里给出明确提示，而不是让按钮一直无反应。 */
(function () {
  var form = document.getElementById("token-form");
  var status = document.getElementById("login-status");
  var button = document.getElementById("connect-button");
  if (!form || !status || !button) return;

  button.disabled = true;
  status.textContent = "页面正在启动……";

  var startupTimer = window.setTimeout(function () {
    if (window.lantingClientReady === true) return;
    status.textContent = "页面脚本未能启动，请刷新页面；如果仍然出现此提示，请更新浏览器。";
  }, 5000);

  window.lantingClientMarkReady = function () {
    window.clearTimeout(startupTimer);
    button.disabled = false;
    status.textContent = "";
  };

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    if (window.lantingClientReady === true) return;
    status.textContent = "页面仍在启动，请稍候……";
  });
}());
