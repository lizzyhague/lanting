/*
 * 经典脚本，在 <head> 里先于样式同步执行：页面画出来之前定好深色还是浅色，避免先闪一下深色。
 * 选择只存在当前浏览器；“跟随系统”时不存值，系统外观变化会立即切换。
 */
(function () {
  var KEY = "lanting.theme";
  var root = document.documentElement;
  var media = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: light)") : null;
  var choice = read();

  function normalize(value) {
    return value === "light" || value === "dark" ? value : "system";
  }

  function read() {
    try {
      return normalize(localStorage.getItem(KEY));
    } catch (error) {
      return "system";
    }
  }

  function apply() {
    var theme = choice === "system" ? (media && media.matches ? "light" : "dark") : choice;
    root.setAttribute("data-theme", theme);
  }

  apply();
  if (media) {
    if (typeof media.addEventListener === "function") media.addEventListener("change", apply);
    else if (typeof media.addListener === "function") media.addListener(apply);
  }
  // 同一浏览器的其他标签页改了选择时跟着变。
  window.addEventListener("storage", function (event) {
    if (event.key !== KEY && event.key !== null) return;
    choice = read();
    apply();
  });

  window.lantingTheme = {
    get: function () {
      return choice;
    },
    set: function (value) {
      choice = normalize(value);
      try {
        if (choice === "system") localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, choice);
      } catch (error) {
        // 浏览器禁用本地存储时，只对当前页面生效。
      }
      apply();
    },
  };
}());
