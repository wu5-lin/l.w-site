/* 提前标记 JS 可用，避免 .reveal 在脚本失败时永久隐藏 */
(function () {
  var root = document.documentElement;
  root.classList.add("js");
  document.addEventListener("DOMContentLoaded", function () {
    setTimeout(function () {
      if (!window.__lwRevealReady) root.classList.remove("js");
    }, 2500);
  });
})();
