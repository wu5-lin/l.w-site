/* ============================================================
 * AI 粒径分析 —— 浏览器端核心逻辑 (OpenCV.js / wasm)
 * 流程: 灰度 -> 阈值分割 -> 形态学去噪 -> 连通域 -> 粒径统计
 * 图像全程在本地处理，不上传服务器。
 * 借鉴思路: Microsphere Size Analyzer (传统CV), ParticleAnalyzer (统计指标)
 * ============================================================ */

const $ = (id) => document.getElementById(id);

let srcCanvas = $("src");
let dstCanvas = $("dst");
let imgLoaded = false;
let lastResults = null; // { diameters:[], unit, rows:[] }

/* ---------- 等待 OpenCV.js wasm 就绪 ----------
 * 注意: @techstark/opencv-js 的 module.exports 是一个 Promise,
 * 解析后才是真正的 cv 命名空间; 经典 opencv.js 则 window.cv 直接是命名空间。
 * 这里先解析 Promise, 再轮询 cv.imread 是否就绪。 */
async function waitCv(timeout = 150000) {
  if (window.cv && typeof window.cv.then === "function") {
    window.cv = await window.cv; // 解析出真正的 cv 命名空间
  }
  const t0 = Date.now();
  while (true) {
    if (window.cv && typeof window.cv.imread === "function") return;
    if (Date.now() - t0 > timeout) {
      throw new Error("OpenCV 加载超时，请强制刷新（Ctrl+F5）后重试");
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/* ---------- 把图片画到 src canvas (等比缩放, 最长边 1200) ---------- */
function drawToSrc(img) {
  const MAX = 1200;
  let w = img.naturalWidth || img.width;
  let h = img.naturalHeight || img.height;
  const r = Math.min(1, MAX / Math.max(w, h));
  w = Math.round(w * r);
  h = Math.round(h * r);
  srcCanvas.width = w;
  srcCanvas.height = h;
  dstCanvas.width = w;
  dstCanvas.height = h;
  const ctx = srcCanvas.getContext("2d");
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  imgLoaded = true;
  $("imgMeta").textContent = `分析分辨率: ${w} × ${h} px`;
  $("run").disabled = false;
  $("status").textContent = "";
  // 清空上次结果
  $("stats").hidden = true;
  $("chartBlock").hidden = true;
  $("tableBlock").hidden = true;
}

/* ---------- 载入本地图片 ---------- */
function loadFile(file) {
  if (!file || !file.type.startsWith("image/")) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => drawToSrc(img);
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

/* ---------- 生成示例颗粒图 (无需准备图片即可体验) ---------- */
function loadSample() {
  const w = 640, h = 420;
  srcCanvas.width = w; srcCanvas.height = h;
  dstCanvas.width = w; dstCanvas.height = h;
  const ctx = srcCanvas.getContext("2d");
  // 背景
  ctx.fillStyle = "#0a0d14";
  ctx.fillRect(0, 0, w, h);
  // 颗粒 (亮色圆, 随机半径)
  const n = 120;
  for (let i = 0; i < n; i++) {
    const x = 10 + Math.random() * (w - 20);
    const y = 10 + Math.random() * (h - 20);
    const rad = 4 + Math.pow(Math.random(), 2.2) * 34; // 偏小颗粒更多
    const g = 180 + Math.floor(Math.random() * 75);
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fillStyle = `rgb(${g},${g - 20},${g - 60})`;
    ctx.fill();
  }
  // 少量噪声点
  for (let i = 0; i < 400; i++) {
    ctx.fillStyle = `rgba(200,200,210,${Math.random() * 0.25})`;
    ctx.fillRect(Math.random() * w, Math.random() * h, 1, 1);
  }
  imgLoaded = true;
  $("imgMeta").textContent = `示例图像 ${w} × ${h} px（模拟粉末 SEM）`;
  $("run").disabled = false;
  $("status").textContent = "";
  $("stats").hidden = true;
  $("chartBlock").hidden = true;
  $("tableBlock").hidden = true;
}

/* ---------- 分位数 (线性插值) ---------- */
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/* ---------- 颜色: 按直径排名着色 (青->紫) ---------- */
function colorForRank(t) {
  // t in [0,1]; hue 180(cyan) -> 300(magenta)
  const hue = 180 + t * 120;
  return hslToScalar(hue, 0.85, 0.6);
}
function hslToScalar(h, s, l) {
  // h:0-360 -> opencv Scalar(b,g,r)
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return new cv.Scalar((b + m) * 255, (g + m) * 255, (r + m) * 255);
}

/* ---------- 主分析 ---------- */
async function analyze() {
  if (!imgLoaded) return;
  const status = $("status");
  status.style.color = "var(--warn)";
  status.textContent = "正在加载 OpenCV…";
  try {
    await waitCv();
  } catch (e) {
    status.style.color = "var(--bad)";
    status.textContent = e.message;
    return;
  }
  status.textContent = "分析中…";

  const mode = $("mode").value;
  const thr = +$("thr").value;
  const block = +$("blk").value;
  const kern = +$("kern").value;
  const minArea = +$("minarea").value;
  const minCirc = +$("circ").value;
  const polar = document.querySelector('input[name="polar"]:checked').value; // bright | dark
  const calPx = +$("calpx").value;
  const calLen = +$("calLen").value;
  const calUnit = $("calUnit").value;

  const unitPerPx = calUnit === "px" ? 1 : calLen / calPx;
  const unitLabel = calUnit;

  let src, gray, thresh, kernel;
  try {
    src = cv.imread(srcCanvas);
    gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    thresh = new cv.Mat();
    if (mode === "adaptive") {
      const flag = polar === "bright"
        ? cv.THRESH_BINARY_INV
        : cv.THRESH_BINARY;
      cv.adaptiveThreshold(gray, thresh, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, flag, block, 2);
    } else {
      const flag = polar === "bright"
        ? cv.THRESH_BINARY_INV
        : cv.THRESH_BINARY;
      cv.threshold(gray, thresh, thr, 255, flag);
    }

    if (kern > 0) {
      kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(kern, kern));
      const tmp = new cv.Mat();
      cv.morphologyEx(thresh, tmp, cv.MORPH_OPEN, kernel);
      cv.morphologyEx(tmp, thresh, cv.MORPH_CLOSE, kernel);
      tmp.delete();
    }

    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(thresh, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const W = srcCanvas.width, H = srcCanvas.height;
    const rows = [];
    const diametersPx = [];
    const keptIdx = [];
    let dMin = Infinity, dMax = 0;

    // 结果画布 = 原图副本
    const dst = src.clone();

    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const area = cv.contourArea(c);
      if (area < minArea) { c.delete(); continue; }

      const peri = cv.arcLength(c, true);
      const circ = peri > 0 ? (4 * Math.PI * area) / (peri * peri) : 0;
      if (circ < minCirc) { c.delete(); continue; }

      // 边界接触 -> 排除 (避免尺寸被截断)
      const r = cv.boundingRect(c);
      if (r.x <= 0 || r.y <= 0 || r.x + r.width >= W - 1 || r.y + r.height >= H - 1) {
        c.delete(); continue;
      }

      const dPx = Math.sqrt((4 * area) / Math.PI); // 等效圆直径(像素)
      diametersPx.push(dPx);

      // 质心
      const mom = cv.moments(c);
      const cx = mom.m00 ? mom.m10 / mom.m00 : r.x + r.width / 2;
      const cy = mom.m00 ? mom.m01 / mom.m00 : r.y + r.height / 2;

      rows.push({
        dPx,
        areaPx: area,
        circ,
        cx: Math.round(cx),
        cy: Math.round(cy),
      });
      keptIdx.push(i);
      if (dPx < dMin) dMin = dPx;
      if (dPx > dMax) dMax = dPx;
      // 轮廓暂存，统一着色阶段按粒径排名上色
    }

    // 按粒径排名着色：小颗粒偏青、大颗粒偏紫，演示更直观
    const dSpan = (dMax - dMin) || 1;
    for (let j = 0; j < keptIdx.length; j++) {
      const t = (diametersPx[j] - dMin) / dSpan;
      cv.drawContours(dst, contours, keptIdx[j], colorForRank(t), 2);
    }

    cv.imshow(dstCanvas, dst);

    // 按直径排序计算分位数
    const sorted = diametersPx.slice().sort((a, b) => a - b);
    const n = sorted.length;

    // 着色: 第二次按排名上色 (让大小层次更明显)
    // 已绘制轮廓(统一色)，这里仅更新统计；如需按大小着色可重画。保持简单。

    for (const idx of keptIdx) { try { contours.get(idx).delete(); } catch (_) {} }
    contours.delete();
    hierarchy.delete();

    if (n === 0) {
      status.style.color = "var(--bad)";
      status.textContent = "未检测到颗粒，请调低最小面积/圆度，或切换颗粒明暗。";
      return;
    }

    // 换算为真实单位
    const diameters = sorted.map((d) => d * unitPerPx);
    const rowsUnit = rows.map((row) => ({
      d: row.dPx * unitPerPx,
      area: row.areaPx * unitPerPx * unitPerPx,
      circ: row.circ,
      cx: row.cx,
      cy: row.cy,
    }));

    // 统计指标
    const mean = diameters.reduce((s, v) => s + v, 0) / n;
    const median = percentile(diameters, 0.5);
    const d10 = percentile(diameters, 0.1);
    const d30 = percentile(diameters, 0.3);
    const d50 = percentile(diameters, 0.5);
    const d60 = percentile(diameters, 0.6);
    const d90 = percentile(diameters, 0.9);
    const cu = d10 > 0 ? d60 / d10 : 0;
    const cc = (d10 > 0 && d60 > 0) ? (d30 * d30) / (d10 * d60) : 0;
    const span = d50 > 0 ? (d90 - d10) / d50 : 0;

    // 渲染统计卡片
    const fmt = (v) => (v >= 100 ? v.toFixed(0) : v.toFixed(2));
    $("sCount").textContent = n;
    $("sMean").textContent = `${fmt(mean)} ${unitLabel}`;
    $("sMedian").textContent = `${fmt(median)} ${unitLabel}`;
    $("sD10").textContent = `${fmt(d10)} ${unitLabel}`;
    $("sD50").textContent = `${fmt(d50)} ${unitLabel}`;
    $("sD90").textContent = `${fmt(d90)} ${unitLabel}`;
    $("sCu").textContent = cu ? cu.toFixed(2) : "–";
    $("sCc").textContent = cc ? cc.toFixed(2) : "–";
    $("stats").hidden = false;

    lastResults = { diameters, unit: unitLabel, rows: rowsUnit, stats: { n, mean, median, d10, d30, d50, d60, d90, cu, cc, span } };

    drawHist(diameters, unitLabel, { d10, d50, d90 });
    renderTable(rowsUnit, unitLabel);

    status.style.color = "var(--good)";
    status.textContent = `分析完成：共 ${n} 个颗粒（已排除边界接触颗粒）`;
  } catch (e) {
    status.style.color = "var(--bad)";
    status.textContent = "分析出错：" + (e && e.message ? e.message : e);
  } finally {
    // 释放 OpenCV 资源
    try { if (src) src.delete(); } catch (_) {}
    try { if (gray) gray.delete(); } catch (_) {}
    try { if (thresh) thresh.delete(); } catch (_) {}
    try { if (kernel) kernel.delete(); } catch (_) {}
  }
}

/* ---------- 绘制粒径分布直方图 ---------- */
function drawHist(values, unit, marks) {
  const cvs = $("hist");
  const cssW = cvs.clientWidth || 600;
  const cssH = 220;
  cvs.width = cssW;
  cvs.height = cssH;
  const ctx = cvs.getContext("2d");
  ctx.clearRect(0, 0, cssW, cssH);

  const padL = 44, padR = 12, padT = 12, padB = 34;
  const plotW = cssW - padL - padR;
  const plotH = cssH - padT - padB;

  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const bins = Math.min(25, Math.max(8, Math.round(Math.sqrt(values.length))));
  const binW = range / bins;
  const counts = new Array(bins).fill(0);
  for (const v of values) {
    let b = Math.floor((v - min) / binW);
    if (b >= bins) b = bins - 1;
    if (b < 0) b = 0;
    counts[b]++;
  }
  const maxCount = Math.max(...counts, 1);

  // 轴
  ctx.strokeStyle = "#243049";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, padT); ctx.lineTo(padL, padT + plotH); ctx.lineTo(padL + plotW, padT + plotH);
  ctx.stroke();

  // 柱
  const bw = plotW / bins;
  for (let i = 0; i < bins; i++) {
    const h = (counts[i] / maxCount) * plotH;
    const x = padL + i * bw;
    const y = padT + plotH - h;
    const grad = ctx.createLinearGradient(0, y, 0, padT + plotH);
    grad.addColorStop(0, "#38e1ff");
    grad.addColorStop(1, "#a78bfa");
    ctx.fillStyle = grad;
    ctx.fillRect(x + 1, y, bw - 2, h);
  }

  // 刻度
  ctx.fillStyle = "#8b97ad";
  ctx.font = "11px sans-serif";
  ctx.textAlign = "center";
  for (let i = 0; i <= 4; i++) {
    const val = min + (range * i) / 4;
    const x = padL + (plotW * i) / 4;
    ctx.fillText(val.toFixed(val >= 100 ? 0 : 1), x, padT + plotH + 16);
  }
  ctx.textAlign = "left";
  ctx.fillText("直径 (" + unit + ")", padL, cssH - 4);

  // 纵向刻度
  ctx.textAlign = "right";
  for (let i = 0; i <= 2; i++) {
    const c = (maxCount * i) / 2;
    const y = padT + plotH - (plotH * i) / 2;
    ctx.fillText(String(Math.round(c)), padL - 6, y + 3);
  }

  // D10/D50/D90 标记线
  const mark = (val, color, label) => {
    if (val < min || val > max) return;
    const x = padL + ((val - min) / range) * plotW;
    ctx.strokeStyle = color;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.fillText(label, x, padT + 10);
  };
  mark(marks.d10, "#4ade80", "D10");
  mark(marks.d50, "#fbbf24", "D50");
  mark(marks.d90, "#fb7185", "D90");

  $("chartBlock").hidden = false;
}

/* ---------- 渲染颗粒明细表 ---------- */
function renderTable(rowsUnit, unit) {
  const tbody = $("tbl").querySelector("tbody");
  tbody.innerHTML = "";
  const fmt = (v) => (v >= 100 ? v.toFixed(0) : v.toFixed(2));
  // 按直径降序展示
  const sorted = rowsUnit.slice().sort((a, b) => b.d - a.d);
  const limit = Math.min(sorted.length, 500); // 防止过多 DOM
  for (let i = 0; i < limit; i++) {
    const r = sorted[i];
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${i + 1}</td><td>${fmt(r.d)} ${unit}</td><td>${fmt(r.area)} ${unit}²</td><td>${r.circ.toFixed(2)}</td>`;
    tbody.appendChild(tr);
  }
  if (sorted.length > limit) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="4" style="color:var(--text-dim)">…仅显示前 ${limit} 条，完整数据见 CSV 导出</td>`;
    tbody.appendChild(tr);
  }
  $("tableBlock").hidden = false;
}

/* ---------- 导出 CSV ---------- */
function exportCsv() {
  if (!lastResults) return;
  const { diameters, unit, rows, stats } = lastResults;
  const fmt = (v) => (v >= 100 ? v.toFixed(1) : v.toFixed(3));
  let csv = "AI 粒径分析结果\n";
  csv += "指标,值\n";
  csv += `颗粒数,${stats.n}\n`;
  csv += `平均直径(${unit}),${fmt(stats.mean)}\n`;
  csv += `中位直径(${unit}),${fmt(stats.median)}\n`;
  csv += `D10(${unit}),${fmt(stats.d10)}\n`;
  csv += `D30(${unit}),${fmt(stats.d30)}\n`;
  csv += `D50(${unit}),${fmt(stats.d50)}\n`;
  csv += `D60(${unit}),${fmt(stats.d60)}\n`;
  csv += `D90(${unit}),${fmt(stats.d90)}\n`;
  csv += `不均匀度Cu,${stats.cu.toFixed(3)}\n`;
  csv += `曲率Cc,${stats.cc.toFixed(3)}\n`;
  csv += `跨度,${stats.span.toFixed(3)}\n\n`;
  csv += `颗粒明细\n序号,直径(${unit}),面积(${unit}^2),圆度,质心X,质心Y\n`;
  const sorted = rows.slice().sort((a, b) => b.d - a.d);
  sorted.forEach((r, i) => {
    csv += `${i + 1},${fmt(r.d)},${fmt(r.area)},${r.circ.toFixed(3)},${r.cx},${r.cy}\n`;
  });

  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "particle_size_result.csv";
  a.click();
  URL.revokeObjectURL(url);
}

/* ---------- 事件绑定 ---------- */
function bindUI() {
  $("pick").addEventListener("click", () => $("file").click());
  $("file").addEventListener("change", (e) => loadFile(e.target.files[0]));
  $("sample").addEventListener("click", loadSample);
  $("run").addEventListener("click", analyze);
  $("expCsv").addEventListener("click", exportCsv);

  // 拖拽
  const dz = $("drop");
  dz.addEventListener("click", (e) => {
    if (e.target === $("pick")) return;
    $("file").click();
  });
  ["dragover", "dragenter"].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); })
  );
  ["dragleave", "drop"].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); })
  );
  dz.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files[0];
    if (f) loadFile(f);
  });

  // 参数联动显示
  $("mode").addEventListener("change", () => {
    $("manualWrap").hidden = $("mode").value !== "manual";
    $("blockWrap").hidden = $("mode").value !== "adaptive";
  });
  $("thr").addEventListener("input", () => ($("thrVal").textContent = $("thr").value));
  $("blk").addEventListener("input", () => ($("blkVal").textContent = $("blk").value));
  $("kern").addEventListener("input", () => ($("kVal").textContent = $("kern").value));
  $("minarea").addEventListener("input", () => ($("minVal").textContent = $("minarea").value));
  $("circ").addEventListener("input", () => ($("cirVal").textContent = (+$("circ").value).toFixed(2)));
  $("calpx").addEventListener("input", () => ($("calPxVal").textContent = $("calpx").value));
  $("calpx").addEventListener("input", updateScaleInfo);
  $("calLen").addEventListener("input", updateScaleInfo);
  $("calUnit").addEventListener("change", updateScaleInfo);
}

function updateScaleInfo() {
  const calPx = +$("calpx").value;
  const calLen = +$("calLen").value;
  const unit = $("calUnit").value;
  if (calPx > 0 && calLen > 0) {
    const perPx = calLen / calPx;
    $("scaleInfo").textContent = `1 px ≈ ${perPx.toFixed(4)} ${unit}（或 1 ${unit} ≈ ${calPx / calLen} px）`;
  }
}

/* ---------- 启动 ---------- */
window.addEventListener("DOMContentLoaded", () => {
  bindUI();
  updateScaleInfo();
  waitCv().then(() => {
    $("status").style.color = "var(--good)";
    $("status").textContent = "OpenCV 已就绪，上传图像或载入示例即可分析。";
  }).catch((e) => {
    $("status").style.color = "var(--bad)";
    $("status").textContent = e.message;
  });
});
