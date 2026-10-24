/* OpenCV.js 加载器：外置以便启用 CSP，并提供可见的加载/失败反馈 */
(function () {
  "use strict";

  function onLoaded() {
    window.__cvLoaded = true;
    var b = document.getElementById("cvBanner");
    if (b) {
      b.classList.add("ok");
      b.textContent = "OpenCV 引擎已就绪";
      setTimeout(function () { b.hidden = true; }, 1200);
    }
  }

  function onError() {
    var b = document.getElementById("cvBanner");
    if (!b) return;
    b.className = "cv-banner err";
    b.textContent = "OpenCV 加载失败，请检查网络后刷新重试。";
    var retry = document.createElement("a");
    retry.href = "#";
    retry.textContent = "刷新重试";
    retry.style.color = "inherit";
    retry.style.textDecoration = "underline";
    retry.style.marginLeft = "8px";
    retry.addEventListener("click", function (e) {
      e.preventDefault();
      location.reload();
    });
    b.appendChild(retry);
  }

  var s = document.createElement("script");
  s.src = "vendor/opencv.js";
  s.async = true;
  s.addEventListener("load", onLoaded);
  s.addEventListener("error", onError);
  document.head.appendChild(s);
})();
