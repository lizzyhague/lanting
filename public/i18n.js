/*
 * Classic script, run synchronously in <head> after strings.js: decide the interface language and set <html lang>
 * before the page paints. Static text is marked in the markup with data-i18n attributes and filled in once the
 * document is parsed; scripts take text from lantingI18n.t.
 * The choice is stored only in the current browser; "follow browser" stores nothing, and browser language changes
 * apply immediately. Switching fires "lanting-languagechange" on window so scripts can redraw their own text.
 */
(function () {
  var KEY = "lanting.language";
  var LANGUAGES = ["zh", "en"];
  var HTML_LANG = { zh: "zh-CN", en: "en" };
  var ATTRIBUTES = {
    "data-i18n-aria-label": "aria-label",
    "data-i18n-title": "title",
    "data-i18n-placeholder": "placeholder",
  };
  var strings = window.lantingStrings || {};
  var root = document.documentElement;
  var choice = read();
  var language = resolve();

  function normalize(value) {
    return LANGUAGES.indexOf(value) >= 0 ? value : "system";
  }

  function read() {
    try {
      return normalize(localStorage.getItem(KEY));
    } catch (error) {
      return "system";
    }
  }

  // The first browser language lanting supports wins; anything else falls back to English.
  function browserLanguage() {
    var tags = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ""];
    for (var i = 0; i < tags.length; i += 1) {
      var tag = String(tags[i]).toLowerCase();
      for (var j = 0; j < LANGUAGES.length; j += 1) {
        if (tag === LANGUAGES[j] || tag.indexOf(LANGUAGES[j] + "-") === 0) return LANGUAGES[j];
      }
    }
    return "en";
  }

  function resolve() {
    return choice === "system" ? browserLanguage() : choice;
  }

  // A translation may be { one, other }; params.count picks the form.
  function t(key, params) {
    var entry = strings[key];
    var text = entry ? (entry[language] != null ? entry[language] : entry.zh) : key;
    if (text && typeof text === "object") text = params && params.count === 1 ? text.one : text.other;
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, function (match, name) {
      return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match;
    });
  }

  function apply(scope) {
    var target = scope || document;
    if (!target.querySelectorAll) return;
    var nodes = target.querySelectorAll("[data-i18n], [data-i18n-aria-label], [data-i18n-title], [data-i18n-placeholder]");
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      var key = node.getAttribute("data-i18n");
      if (key) node.textContent = t(key);
      for (var marker in ATTRIBUTES) {
        if (!Object.prototype.hasOwnProperty.call(ATTRIBUTES, marker)) continue;
        var attributeKey = node.getAttribute(marker);
        if (attributeKey) node.setAttribute(ATTRIBUTES[marker], t(attributeKey));
      }
    }
  }

  function announce() {
    var event;
    try {
      event = new Event("lanting-languagechange");
    } catch (error) {
      event = document.createEvent("Event");
      event.initEvent("lanting-languagechange", false, false);
    }
    window.dispatchEvent(event);
  }

  // Always announces, so a choice change that keeps the same language still updates the settings buttons.
  function update() {
    var next = resolve();
    if (next !== language) {
      language = next;
      root.setAttribute("lang", HTML_LANG[language]);
      apply(document);
    }
    announce();
  }

  root.setAttribute("lang", HTML_LANG[language]);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { apply(document); });
  } else {
    apply(document);
  }
  window.addEventListener("languagechange", update);
  // Follow changes made in other tabs of the same browser.
  window.addEventListener("storage", function (event) {
    if (event.key !== KEY && event.key !== null) return;
    choice = read();
    update();
  });

  window.lantingI18n = {
    get: function () {
      return choice;
    },
    language: function () {
      return language;
    },
    set: function (value) {
      choice = normalize(value);
      try {
        if (choice === "system") localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, choice);
      } catch (error) {
        // If the browser disables local storage, it applies to the current page only.
      }
      update();
    },
    t: t,
    apply: apply,
  };
}());
