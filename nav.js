/* =========================================================
   LW · 全站公共脚本
   导航折叠（移动端）/ 焦点管理 / 当前区块 / 年份 / SW 注册
   ========================================================= */
(function () {
  "use strict";

  var yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  /* ---------- 导航 ---------- */
  var nav = document.querySelector(".nav, .topbar");
  var toggle = document.getElementById("navToggle");
  var links = (nav && nav.querySelector(".nav-links, .topnav")) ||
    document.getElementById("navLinks") || document.getElementById("topnav");
  var mobile = window.matchMedia("(max-width: 720px)");

  function isOpen() { return !!(nav && nav.classList.contains("is-open")); }

  function setOpen(open, restoreFocus) {
    if (!nav || !toggle || !links) return;
    nav.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "关闭菜单" : "打开菜单");
    document.body.style.overflow = open ? "hidden" : "";
    if (mobile.matches) links.inert = !open;
    if (open) {
      var first = links.querySelector("a[href], button");
      if (first) setTimeout(function () { first.focus(); }, 30);
    } else if (restoreFocus) {
      toggle.focus();
    }
  }

  function syncInert() {
    if (!links) return;
    if (mobile.matches && !isOpen()) links.inert = true;
    else links.inert = false;
  }

  if (nav && toggle && links) {
    syncInert();

    toggle.addEventListener("click", function () { setOpen(!isOpen()); });

    links.querySelectorAll("a").forEach(function (a) {
      a.addEventListener("click", function () { setOpen(false); });
    });

    document.addEventListener("keydown", function (e) {
      if (!isOpen()) return;
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false, true);
        return;
      }
      if (e.key !== "Tab") return;
      var focusables = Array.prototype.slice.call(
        links.querySelectorAll("a[href], button:not([disabled])")
      );
      if (!focusables.length) return;
      var first = focusables[0];
      var last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      }
    });

    mobile.addEventListener("change", function () {
      if (!mobile.matches) setOpen(false);
      syncInert();
    });

    function onScroll() {
      if (nav.matches(".nav")) nav.classList.toggle("is-scrolled", window.scrollY > 12);
    }
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  /* ---------- 当前页 / 当前区块 ---------- */
  var pageLinks = links ? Array.prototype.slice.call(links.querySelectorAll("a[href]")) : [];
  var here = location.pathname.replace(/\/index\.html$/, "/");
  pageLinks.forEach(function (a) {
    var href = a.getAttribute("href") || "";
    if (href.charAt(0) === "#") return;
    var url;
    try { url = new URL(href, location.href); } catch (err) { return; }
    if (url.origin !== location.origin) return;
    var path = url.pathname.replace(/\/index\.html$/, "/");
    if (path === here) a.setAttribute("aria-current", "page");
  });

  var sections = Array.prototype.slice.call(
    document.querySelectorAll("main section[id], section.info[id]")
  );
  var anchors = pageLinks.filter(function (a) {
    var href = a.getAttribute("href") || "";
    return href.charAt(0) === "#" && href.length > 1;
  });

  if (sections.length && anchors.length) {
    var ticking = false;
    function updateActive() {
      ticking = false;
      var current = sections[0].id;
      for (var i = 0; i < sections.length; i++) {
        if (sections[i].getBoundingClientRect().top <= 140) current = sections[i].id;
      }
      anchors.forEach(function (a) {
        if (a.getAttribute("href") === "#" + current) a.setAttribute("aria-current", "true");
        else if (a.getAttribute("aria-current") === "true") a.removeAttribute("aria-current");
      });
    }
    window.addEventListener("scroll", function () {
      if (!ticking) { ticking = true; requestAnimationFrame(updateActive); }
    }, { passive: true });
    updateActive();
  }

  /* ---------- Service Worker（长缓存 / 离线） ---------- */
  if ("serviceWorker" in navigator &&
      (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("/sw.js").catch(function () {});
    });
  }
})();
