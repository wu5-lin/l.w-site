/* =========================================================
   每日简报 前端逻辑
   读取 ../digest.json，按 类别 / 地区 / 关键词 筛选渲染
   ========================================================= */
(function () {
  "use strict";

  var DATA_URL = "../digest.json";
  var state = { cat: "全部", region: "全部", q: "" };
  var DATA = null;

  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function regionLabel(r) { return r === "cn" ? "国内" : (r === "en" ? "国际" : ""); }

  function allItems() {
    if (!DATA || !DATA.categories) return [];
    var out = [];
    var keys = Object.keys(DATA.categories);
    for (var i = 0; i < keys.length; i++) {
      var arr = DATA.categories[keys[i]] || [];
      for (var j = 0; j < arr.length; j++) out.push(arr[j]);
    }
    return out;
  }

  function filterItems() {
    var q = state.q.trim().toLowerCase();
    return allItems().filter(function (it) {
      if (state.cat !== "全部" && it.category !== state.cat) return false;
      if (state.region !== "全部" && it.region !== state.region) return false;
      if (q) {
        var hay = (it.title + " " + it.summary + " " + it.source).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  function render() {
    var grid = $("grid");
    var empty = $("empty");
    var meta = $("meta");
    var items = filterItems();

    if (!DATA) {
      meta.textContent = "加载中…";
      return;
    }

    if (DATA.updated) {
      meta.textContent = "更新于 " + DATA.updated +
        " · 共 " + allItems().length + " 条 · 当前筛选 " + items.length + " 条";
    }

    if (!items.length) {
      grid.innerHTML = "";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    var html = "";
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var catClass = "cat-" + it.category;
      var rLabel = regionLabel(it.region);
      var rClass = it.region === "cn" ? "cn" : (it.region === "en" ? "en" : "");
      var url = it.url || "#";
      var rel = (it.region === "en") ? ' target="_blank" rel="noopener"' : "";
      html +=
        '<article class="dcard">' +
          '<div class="dcard-top">' +
            '<span class="tag ' + catClass + '">' + esc(it.source) + '</span>' +
            (rLabel ? '<span class="region-badge ' + rClass + '">' + rLabel + '</span>' : '') +
          '</div>' +
          '<h3><a href="' + esc(url) + '"' + rel + '>' + esc(it.title) + '</a></h3>' +
          (it.summary ? '<p class="sum">' + esc(it.summary) + '</p>' : '') +
          '<div class="date">' + esc(it.date) + '</div>' +
        '</article>';
    }
    grid.innerHTML = html;
  }

  function bindSeg(segId, key, after) {
    var seg = $(segId);
    if (!seg) return;
    seg.addEventListener("click", function (e) {
      var btn = e.target.closest("button");
      if (!btn) return;
      var btns = seg.querySelectorAll("button");
      for (var i = 0; i < btns.length; i++) btns[i].classList.remove("active");
      btn.classList.add("active");
      state[key] = btn.getAttribute("data-" + key);
      if (after) after();
      render();
    });
  }

  function load() {
    fetch(DATA_URL, { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (json) {
        DATA = json;
        render();
      })
      .catch(function (err) {
        console.warn("digest.json 加载失败：", err);
        var meta = $("meta");
        if (meta) meta.textContent = "简报数据暂未生成（等待每日自动抓取）。";
        var empty = $("empty");
        if (empty) empty.hidden = false;
      });
  }

  // 导航高亮当前类别（URL ?cat= 支持深链）
  (function initFromQuery() {
    var p = new URLSearchParams(location.search);
    var c = p.get("cat");
    if (c) {
      var btn = document.querySelector('#catSeg button[data-cat="' + c + '"]');
      if (btn) {
        var btns = document.querySelectorAll("#catSeg button");
        for (var i = 0; i < btns.length; i++) btns[i].classList.remove("active");
        btn.classList.add("active");
        state.cat = c;
      }
    }
  })();

  bindSeg("catSeg", "cat");
  bindSeg("regionSeg", "region");
  var q = $("q");
  if (q) q.addEventListener("input", function () { state.q = q.value; render(); });

  var y = $("year"); if (y) y.textContent = new Date().getFullYear();

  load();
})();
