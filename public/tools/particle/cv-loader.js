/* OpenCV.js 加载器：只在粒径分析页按需从 CDN 拉取，wasm 已打进这个脚本。 */
(function () {
  "use strict";

  var CDN = "https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.11.0-release.1/dist/opencv.js";

  function onReady() {
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
    b.textContent = "OpenCV 加载失败。请检查网络后刷新。";
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

  function whenReady() {
    var tries = 0;
    (function tick() {
      var cv = window.cv;
      if (!cv) {
        if (++tries > 1500) { onError(); return; }
        setTimeout(tick, 100);
        return;
      }
      if (typeof cv.then === "function") {
        cv.then(function (real) {
          window.cv = real;
          tries = 0;
          tick();
        }).catch(onError);
        return;
      }
      if (typeof cv.imread === "function") {
        onReady();
        return;
      }
      if (++tries > 1500) { onError(); return; }
      setTimeout(tick, 100);
    })();
  }

  var s = document.createElement("script");
  s.src = CDN;
  s.async = true;
  s.addEventListener("load", whenReady);
  s.addEventListener("error", onError);
  document.head.appendChild(s);
})();
