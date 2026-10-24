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

  // 仅允许 http(s) 协议，避免 javascript:/data: 等注入
  function safeUrl(u) {
    var s = String(u == null ? "" : u).trim();
    return /^https?:\/\//i.test(s) ? s : "#";
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

function pad(n) { return String(n).padStart(2, "0"); }

/* "2026-10-23 05:49 UTC" → "10 月 23 日 13:49 · 22 小时前"（北京时间） */
function formatUpdated(raw) {
  var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})\s*UTC$/i.exec(String(raw || "").trim());
  if (!m) return raw || "";
  var utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  var bj = new Date(utc + 8 * 3600 * 1000);
  var label = (bj.getUTCMonth() + 1) + " 月 " + bj.getUTCDate() + " 日 " +
    pad(bj.getUTCHours()) + ":" + pad(bj.getUTCMinutes());
  var diff = Date.now() - utc;
  var rel;
  if (diff < 3600 * 1000) rel = "刚刚";
  else if (diff < 24 * 3600 * 1000) rel = Math.floor(diff / 3600000) + " 小时前";
  else if (diff < 48 * 3600 * 1000) rel = "昨天";
  else rel = Math.floor(diff / 86400000) + " 天前";
  return label + " · " + rel;
}

function dateAttrs(d) {
  var s = String(d || "");
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? ' datetime="' + esc(s) + '"' : "";
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
      meta.textContent = "更新于 " + formatUpdated(DATA.updated) +
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
      var url = safeUrl(it.url);
      var rel = (url === "#") ? "" : ' target="_blank" rel="noopener"';
      html +=
        '<article class="dcard">' +
          '<div class="dcard-top">' +
            '<span class="tag ' + catClass + '">' + esc(it.source) + '</span>' +
            (rLabel ? '<span class="region-badge ' + rClass + '">' + rLabel + '</span>' : '') +
          '</div>' +
          '<h3><a href="' + esc(url) + '"' + rel + '>' + esc(it.title) + '</a></h3>' +
          (it.summary ? '<p class="sum">' + esc(it.summary) + '</p>' : '') +
          '<div class="date"><time' + dateAttrs(it.date) + '>' + esc(it.date) + '</time></div>' +
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
    fetch(DATA_URL, { cache: "default" })
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
