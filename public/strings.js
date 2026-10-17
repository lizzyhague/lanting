/*
 * Interface text in every supported language, keyed by a stable id. Each entry lists all languages side by side
 * so a missing translation is easy to spot. {name} placeholders are filled in by lantingI18n.t.
 */
window.lantingStrings = {
  "login.tokenLabel": { zh: "访问令牌", en: "Access token" },
  "login.tokenHint": { zh: "（登录状态存于浏览器）", en: " (sign-in is kept in this browser)" },
  "login.connect": { zh: "连接", en: "Connect" },
  "login.tokenMissing": { zh: "请输入访问令牌。", en: "Enter the access token." },
  "login.tokenInvalid": { zh: "访问令牌有误，请重新输入。", en: "The access token is incorrect. Try again." },
  "login.connecting": { zh: "正在连接主机……", en: "Connecting to the host…" },
  "login.noResponse": {
    zh: "没有收到服务器响应。请求可能未到达服务器，或者连接在服务器响应前中断。请检查网络或代理设置后重试。",
    en: "No response from the server. The request may not have reached it, or the connection dropped before it replied. Check your network or proxy settings and try again.",
  },
  "login.required": { zh: "请登录。", en: "Please sign in." },
  "login.unavailable": { zh: "登录服务暂时不可用。", en: "The sign-in service is temporarily unavailable." },

  "boot.starting": { zh: "页面正在启动……", en: "Starting…" },
  "boot.failed": {
    zh: "页面脚本未能启动，请刷新页面；如果仍然出现此提示，请更新浏览器。",
    en: "The page script failed to start. Refresh the page; if this message persists, update your browser.",
  },
  "boot.stillStarting": { zh: "页面仍在启动，请稍候……", en: "The page is still starting, please wait…" },

  "settings.browserOnly": { zh: "只影响当前浏览器。", en: "Only affects this browser." },
  "settings.language": { zh: "语言", en: "Language" },
  "settings.languageSystem": { zh: "跟随浏览器", en: "Follow browser" },
};
