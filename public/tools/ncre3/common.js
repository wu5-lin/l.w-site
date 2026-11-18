(function () {
  "use strict";

  try {
    var saved = localStorage.getItem("lw-theme");
    if (saved === "light" || saved === "dark") {
      document.documentElement.dataset.theme = saved;
    }
  } catch (e) {}

  function isDark() {
    var t = document.documentElement.dataset.theme;
    if (t === "dark") return true;
    if (t === "light") return false;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function makeThemeBtn() {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ncre-theme-btn";
    function sync() {
      btn.textContent = isDark() ? "☀️ 日间" : "🌙 夜间";
    }
    sync();
    btn.addEventListener("click", function () {
      var next = isDark() ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem("lw-theme", next); } catch (e) {}
      sync();
    });
    return btn;
  }

  document.addEventListener("DOMContentLoaded", function () {
    var wrap = document.querySelector(".wrap") || document.body;
    var existingNav = document.querySelector(".topnav");
    if (existingNav) {
      var rightGroup = existingNav.querySelector(".nav-links");
      if (rightGroup) {
        rightGroup.appendChild(makeThemeBtn());
      } else {
        existingNav.appendChild(makeThemeBtn());
      }
      return;
    }

    if (document.querySelector(".ncre-bar")) return;

    var bar = document.createElement("nav");
    bar.className = "ncre-bar";
    bar.setAttribute("aria-label", "备考导航");

    var links = document.createElement("div");
    links.className = "ncre-bar-links";
    var isIndex = /(?:^|\/)(?:index\.html)?$/.test(location.pathname);

    if (!isIndex) {
      var backHub = document.createElement("a");
      backHub.href = "index.html";
      backHub.textContent = "← 备考总入口";
      links.appendChild(backHub);
    }

    var backTools = document.createElement("a");
    backTools.href = "/tools/";
    backTools.textContent = isIndex ? "← 返回工具箱" : "工具箱";
    links.appendChild(backTools);

    var backHome = document.createElement("a");
    backHome.href = "/";
    backHome.textContent = "首页";
    links.appendChild(backHome);

    bar.appendChild(links);
    bar.appendChild(makeThemeBtn());

    var header = wrap.querySelector("header");
    if (isIndex && header) {
      header.insertBefore(bar, header.firstChild);
    } else {
      wrap.insertBefore(bar, wrap.firstChild);
    }
  });
})();
