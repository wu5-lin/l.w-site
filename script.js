/* ---------- reveal ---------- */
const reveals = document.querySelectorAll(".reveal");
if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  reveals.forEach((el) => el.classList.add("visible"));
} else {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("visible");
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.12, rootMargin: "0px 0px -8% 0px" }
  );
  reveals.forEach((el) => observer.observe(el));
}
window.__lwRevealReady = true;

/* =========================================================
   AI 资讯动态加载
   ========================================================= */
const NEWS_PREVIEW = 6;

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[c]));
}

/* 仅允许 http(s) 协议，避免 javascript:/data: 等注入；非法链接退化为不可跳转 */
function safeUrl(u) {
  const s = String(u == null ? "" : u).trim();
  return /^https?:\/\//i.test(s) ? s : "#";
}

function clip(s, n) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  return t.slice(0, n).replace(/[\s,，。；;：:]+$/, "") + "…";
}

function pad(n) { return String(n).padStart(2, "0"); }

/* "2026-10-23 05:49 UTC" → "10 月 23 日 13:49 · 22 小时前"（北京时间） */
function formatUpdated(raw) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})\s*UTC$/i.exec(String(raw || "").trim());
  if (!m) return raw || "";
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const bj = new Date(utc + 8 * 3600 * 1000);
  const label = `${bj.getUTCMonth() + 1} 月 ${bj.getUTCDate()} 日 ${pad(bj.getUTCHours())}:${pad(bj.getUTCMinutes())}`;
  const diff = Date.now() - utc;
  let rel = "";
  if (diff < 0) rel = "刚刚";
  else if (diff < 3600 * 1000) rel = "刚刚";
  else if (diff < 24 * 3600 * 1000) rel = Math.floor(diff / 3600000) + " 小时前";
  else if (diff < 48 * 3600 * 1000) rel = "昨天";
  else rel = Math.floor(diff / 86400000) + " 天前";
  return `${label} · ${rel}`;
}

/* "2026-10-23" → "10-23"；跨年时保留年份 */
function formatDate(d) {
  const s = String(d || "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return { text: s, iso: "" };
  const sameYear = +m[1] === new Date().getFullYear();
  return { text: sameYear ? `${m[2]}-${m[3]}` : s, iso: s };
}

function renderNews(items, updated) {
  const box = document.getElementById("newsList");
  const upd = document.getElementById("news-updated");
  const more = document.getElementById("newsMore");
  if (updated && upd) upd.textContent = formatUpdated(updated);
  if (!items || !items.length) return;

  const paint = (limit) => {
    box.innerHTML = items.slice(0, limit).map((it) => {
      const href = safeUrl(it.url);
      const attrs = href === "#" ? "" : ' target="_blank" rel="noopener"';
      const dt = formatDate(it.date);
      return `
      <article class="news-item">
        <div class="news-meta">
          <time class="news-date"${dt.iso ? ` datetime="${esc(dt.iso)}"` : ""}>${esc(dt.text)}</time>
          <span class="tag">${esc(it.tag || it.source || "AI")}</span>
        </div>
        <h3 class="news-title">
          <a href="${esc(href)}"${attrs}>${esc(it.title)}</a>
        </h3>
        <p class="news-sum">${esc(clip(it.summary, 110))}</p>
      </article>`;
    }).join("");
  };

  paint(NEWS_PREVIEW);
  if (items.length > NEWS_PREVIEW) {
    more.hidden = false;
    more.textContent = `显示全部 ${items.length} 条`;
    more.onclick = () => {
      paint(items.length);
      more.hidden = true;
    };
  } else {
    more.hidden = true;
  }
}

function getJSON(url) {
  return fetch(url, { cache: "default" }).then((r) => {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  });
}

function loadNews() {
  // 首页只需要「科技」类别：优先读取轻量文件，缺失时回退完整 digest.json
  getJSON("news-home.json")
    .then((data) => {
      const items = (data && data.items) || [];
      if (!items.length) throw new Error("empty news-home.json");
      renderNews(items, (data && data.updated) || "");
    })
    .catch(() => {
      getJSON("digest.json")
        .then((data) => {
          const cats = (data && data.categories) || {};
          let arr = cats["科技"] || [];
          if (!arr.length) {
            arr = Object.keys(cats).reduce((acc, k) => acc.concat(cats[k] || []), []);
            arr.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
          }
          renderNews(arr, (data && data.updated) || "");
        })
        .catch((err) => {
          console.warn("资讯数据加载失败，保留兜底内容：", err);
          const upd = document.getElementById("news-updated");
          if (upd) upd.textContent = "离线";
        });
    });
}
loadNews();
