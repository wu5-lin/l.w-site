document.getElementById("year").textContent = new Date().getFullYear();

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

const nav = document.getElementById("nav");
const navToggle = document.getElementById("navToggle");
const navLinks = document.getElementById("navLinks");

function setNavScrolled() {
  nav.classList.toggle("is-scrolled", window.scrollY > 12);
}
setNavScrolled();
window.addEventListener("scroll", setNavScrolled, { passive: true });

navToggle.addEventListener("click", () => {
  const open = nav.classList.toggle("is-open");
  navToggle.setAttribute("aria-expanded", String(open));
  navToggle.setAttribute("aria-label", open ? "关闭菜单" : "打开菜单");
  document.body.style.overflow = open ? "hidden" : "";
});

navLinks.querySelectorAll("a").forEach((a) => {
  a.addEventListener("click", () => {
    nav.classList.remove("is-open");
    navToggle.setAttribute("aria-expanded", "false");
    navToggle.setAttribute("aria-label", "打开菜单");
    document.body.style.overflow = "";
  });
});

const sections = [...document.querySelectorAll("main section[id]")];
const navAnchors = [...navLinks.querySelectorAll("a[href^='#']")];
function updateActiveNav() {
  const y = window.scrollY + 96;
  let current = sections[0]?.id;
  for (const s of sections) {
    if (s.offsetTop <= y) current = s.id;
  }
  navAnchors.forEach((a) => {
    a.classList.toggle("is-active", a.getAttribute("href") === "#" + current);
  });
}
window.addEventListener("scroll", updateActiveNav, { passive: true });
updateActiveNav();

/* =========================================================
   AI 资讯动态加载
   ========================================================= */
const NEWS_PREVIEW = 6;

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[c]));
}

function clip(s, n) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  return t.slice(0, n).replace(/[\s,，。；;：:]+$/, "") + "…";
}

function renderNews(items, updated) {
  const box = document.getElementById("news");
  const upd = document.getElementById("news-updated");
  const more = document.getElementById("newsMore");
  if (updated) upd.textContent = updated;
  if (!items || !items.length) return;

  const paint = (limit) => {
    box.innerHTML = items.slice(0, limit).map((it) => `
      <article class="news-item">
        <div class="news-meta">
          <time class="news-date">${esc(it.date)}</time>
          <span class="tag">${esc(it.tag || it.source || "AI")}</span>
        </div>
        <h3 class="news-title">
          <a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)}</a>
        </h3>
        <p class="news-sum">${esc(clip(it.summary, 110))}</p>
      </article>`).join("");
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

function loadNews() {
  fetch("news.json", { cache: "no-store" })
    .then((r) => {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then((data) => {
      const arr = Array.isArray(data) ? data : data.items || [];
      const updated = Array.isArray(data) ? "" : data.updated || "";
      renderNews(arr, updated);
    })
    .catch((err) => {
      console.warn("news.json 加载失败，显示兜底内容：", err);
      const upd = document.getElementById("news-updated");
      if (upd) upd.textContent = "离线";
    });
}
loadNews();
