/* OpenCV.js 加载器：只在粒径分析页按需从 CDN 拉取，wasm 已打进这个脚本。 */
(function () {
  "use strict";

  var CDNS = [
    "https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.11.0-release.1/dist/opencv.js",
    "https://unpkg.com/@techstark/opencv-js@4.11.0-release.1/dist/opencv.js"
  ];
  var cdnIndex = 0;
  var loadTimer = 0;

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

  function loadScript(index) {
    if (index >= CDNS.length) { onError(); return; }
    cdnIndex = index;
    var s = document.createElement("script");
    s.src = CDNS[index];
    s.async = true;
    var done = false;
    function nextFallback() {
      if (done || window.__cvLoaded) return;
      done = true;
      clearTimeout(loadTimer);
      s.remove();
      var b = document.getElementById("cvBanner");
      if (b && index + 1 < CDNS.length) {
        b.textContent = "主 CDN 较慢，正在切换备用源加载 OpenCV…";
      }
      loadScript(index + 1);
    }
    loadTimer = setTimeout(nextFallback, 25000);
    s.addEventListener("load", function () {
      if (done) return;
      done = true;
      clearTimeout(loadTimer);
      whenReady();
    });
    s.addEventListener("error", nextFallback);
    document.head.appendChild(s);
  }

  loadScript(0);
})();
