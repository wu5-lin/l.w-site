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
let lastResults = null; // { diameters:[], unit, rows:[], stats:{}, fit:{} }

/* ---------- 标尺画线状态 ---------- */
let scaleMode = false;     // 是否处于"画标尺线"模式
let drawing = false;       // 正在拖动画线
let scaleLine = null;      // {x1,y1,x2,y2} (canvas 像素坐标)
let drawEnd = null;        // 绘制中的临时终点

/* ---------- 实时预览状态 ---------- */
let previewTimer = null;
let previewRunning = false;
let previewPending = false;

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
  $("previewBadge").hidden = true;
  $("fitInfo").hidden = true;
  // 新图重置标尺线
  scaleLine = null; drawEnd = null;
  syncOverlay();
  schedulePreview();
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
  $("previewBadge").hidden = true;
  $("fitInfo").hidden = true;
  scaleLine = null; drawEnd = null;
  syncOverlay();
  schedulePreview();
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

/* ---------- 对数正态拟合 (微波介电陶瓷粒径分布标准) ---------- */
function lognormalFit(values) {
  const ln = values.map(Math.log);
  const mu = ln.reduce((a, b) => a + b, 0) / ln.length;
  const variance = ln.reduce((a, b) => a + (b - mu) ** 2, 0) / ln.length;
  let sigma = Math.sqrt(variance);
  if (sigma < 1e-3) sigma = 1e-3; // 退化情况(单值)，避免除零
  return { mu, sigma, dg: Math.exp(mu), sg: Math.exp(sigma), degenerate: variance < 1e-6 };
}
function lnpdf(d, mu, sigma) {
  if (d <= 0 || sigma <= 0) return 0;
  const z = (Math.log(d) - mu) / sigma;
  return Math.exp(-0.5 * z * z) / (d * sigma * Math.sqrt(2 * Math.PI));
}

/* ---------- 读取当前参数 ---------- */
function readParams() {
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
  const unitPerPx = calUnit === "px" ? 1 : (calPx > 0 ? calLen / calPx : 1);
  return { mode, thr, block, kern, minArea, minCirc, polar, calPx, calLen, calUnit, unitPerPx, unitLabel: calUnit };
}

/* ---------- 分割 + 提取轮廓 (供 分析 / 实时预览 复用) ---------- */
async function segment(p) {
  const src = cv.imread(srcCanvas);
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  const thresh = new cv.Mat();
  if (p.mode === "adaptive") {
    const flag = p.polar === "bright" ? cv.THRESH_BINARY_INV : cv.THRESH_BINARY;
    cv.adaptiveThreshold(gray, thresh, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, flag, p.block, 2);
  } else {
    const flag = p.polar === "bright" ? cv.THRESH_BINARY_INV : cv.THRESH_BINARY;
    cv.threshold(gray, thresh, p.thr, 255, flag);
  }
  let kernel = null;
  if (p.kern > 0) {
    kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(p.kern, p.kern));
    const tmp = new cv.Mat();
    cv.morphologyEx(thresh, tmp, cv.MORPH_OPEN, kernel);
    cv.morphologyEx(tmp, thresh, cv.MORPH_CLOSE, kernel);
    tmp.delete();
  }
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(thresh, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  const W = srcCanvas.width, H = srcCanvas.height;
  const keptIdx = [];
  const diametersPx = [];
  const rows = [];
  let dMin = Infinity, dMax = 0;
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    const area = cv.contourArea(c);
    if (area < p.minArea) { c.delete(); continue; }
    const peri = cv.arcLength(c, true);
    const circ = peri > 0 ? (4 * Math.PI * area) / (peri * peri) : 0;
    if (circ < p.minCirc) { c.delete(); continue; }
    const r = cv.boundingRect(c);
    if (r.x <= 0 || r.y <= 0 || r.x + r.width >= W - 1 || r.y + r.height >= H - 1) { c.delete(); continue; }
    const dPx = Math.sqrt((4 * area) / Math.PI);
    const mom = cv.moments(c);
    const cx = mom.m00 ? mom.m10 / mom.m00 : r.x + r.width / 2;
    const cy = mom.m00 ? mom.m01 / mom.m00 : r.y + r.height / 2;
    diametersPx.push(dPx);
    rows.push({ dPx, areaPx: area, circ, cx: Math.round(cx), cy: Math.round(cy) });
    keptIdx.push(i);
    if (dPx < dMin) dMin = dPx;
    if (dPx > dMax) dMax = dPx;
  }
  return { src, gray, thresh, kernel, contours, hierarchy, keptIdx, diametersPx, rows, dMin, dMax, W, H };
}

/* ---------- 按粒径排名在 dst 上着色轮廓 ---------- */
function drawContoursColored(dst, contours, keptIdx, diametersPx, dMin, dMax) {
  const span = (dMax - dMin) || 1;
  for (let j = 0; j < keptIdx.length; j++) {
    const t = (diametersPx[j] - dMin) / span;
    cv.drawContours(dst, contours, keptIdx[j], colorForRank(t), 2);
  }
}

/* ---------- 主分析 ---------- */
async function analyze() {
  if (!imgLoaded) return;
  const status = $("status");
  status.style.color = "var(--warn)";
  status.textContent = "正在加载 OpenCV…";
  $("previewBadge").hidden = true;
  try {
    await waitCv();
  } catch (e) {
    status.style.color = "var(--bad)";
    status.textContent = e.message;
    return;
  }
  status.textContent = "分析中…";
  const p = readParams();
  let s = null, dst = null;
  try {
    s = await segment(p);
    if (s.diametersPx.length === 0) {
      status.style.color = "var(--bad)";
      status.textContent = "未检测到颗粒，请调低最小面积/圆度，或切换颗粒明暗。";
      return;
    }

    dst = s.src.clone();
    drawContoursColored(dst, s.contours, s.keptIdx, s.diametersPx, s.dMin, s.dMax);
    cv.imshow(dstCanvas, dst);

    // 按直径排序计算分位数
    const sorted = s.diametersPx.slice().sort((a, b) => a - b);
    const n = sorted.length;
    const diameters = sorted.map((d) => d * p.unitPerPx);
    const rowsUnit = s.rows.map((row) => ({
      d: row.dPx * p.unitPerPx,
      area: row.areaPx * p.unitPerPx * p.unitPerPx,
      circ: row.circ,
      cx: row.cx,
      cy: row.cy,
    }));

    // 统计指标
    const mean = diameters.reduce((sum, v) => sum + v, 0) / n;
    const median = percentile(diameters, 0.5);
    const d10 = percentile(diameters, 0.1);
    const d30 = percentile(diameters, 0.3);
    const d50 = percentile(diameters, 0.5);
    const d60 = percentile(diameters, 0.6);
    const d90 = percentile(diameters, 0.9);
    const cu = d10 > 0 ? d60 / d10 : 0;
    const cc = (d10 > 0 && d60 > 0) ? (d30 * d30) / (d10 * d60) : 0;
    const span = d50 > 0 ? (d90 - d10) / d50 : 0;

    const fmt = (v) => (v >= 100 ? v.toFixed(0) : v.toFixed(2));
    $("sCount").textContent = n;
    $("sMean").textContent = `${fmt(mean)} ${p.unitLabel}`;
    $("sMedian").textContent = `${fmt(median)} ${p.unitLabel}`;
    $("sD10").textContent = `${fmt(d10)} ${p.unitLabel}`;
    $("sD50").textContent = `${fmt(d50)} ${p.unitLabel}`;
    $("sD90").textContent = `${fmt(d90)} ${p.unitLabel}`;
    $("sCu").textContent = cu ? cu.toFixed(2) : "–";
    $("sCc").textContent = cc ? cc.toFixed(2) : "–";
    $("stats").hidden = false;

    const fit = lognormalFit(diameters);
    lastResults = { diameters, unit: p.unitLabel, rows: rowsUnit, stats: { n, mean, median, d10, d30, d50, d60, d90, cu, cc, span }, fit };

    $("chartBlock").hidden = false;
    renderHistogram($("hist"), { values: diameters, unit: p.unitLabel, marks: { d10, d50, d90 }, fit });
    renderHistogramFitInfo(fit, p.unitLabel);
    renderTable(rowsUnit, p.unitLabel);

    status.style.color = "var(--good)";
    status.textContent = `分析完成：共 ${n} 个颗粒（已排除边界接触颗粒）`;
  } catch (e) {
    status.style.color = "var(--bad)";
    status.textContent = "分析出错：" + (e && e.message ? e.message : e);
  } finally {
    if (s) {
      try { if (dst) dst.delete(); } catch (_) {}
      try { s.src.delete(); } catch (_) {}
      try { s.gray.delete(); } catch (_) {}
      try { s.thresh.delete(); } catch (_) {}
      try { if (s.kernel) s.kernel.delete(); } catch (_) {}
      try { for (const idx of s.keptIdx) { try { s.contours.get(idx).delete(); } catch (_) {} } } catch (_) {}
      try { s.contours.delete(); } catch (_) {}
      try { s.hierarchy.delete(); } catch (_) {}
    }
  }
}

/* ---------- 绘制粒径分布直方图 (对数正态拟合 + SCI 规范) ----------
 * opts: { values, unit, marks:{d10,d50,d90}, fit:{mu,sigma,dg,sg,degenerate}, width, height, fontScale } */
function renderHistogram(canvas, o) {
  const { values, unit, marks, fit } = o;
  const fontScale = o.fontScale || 1;
  const cssW = o.width || canvas.clientWidth || 600;
  const cssH = o.height || 220;
  canvas.width = cssW;
  canvas.height = cssH;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, cssW, cssH);

  const padL = 52 * fontScale, padR = 16 * fontScale, padT = 16 * fontScale, padB = 42 * fontScale;
  const plotW = cssW - padL - padR;
  const plotH = cssH - padT - padB;

  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = (max - min) || 1;
  const bins = Math.min(28, Math.max(8, Math.round(Math.sqrt(values.length))));
  const binW = range / bins;
  const counts = new Array(bins).fill(0);
  const centers = [];
  for (let i = 0; i < bins; i++) centers.push(min + (i + 0.5) * binW);
  for (const v of values) {
    let b = Math.floor((v - min) / binW);
    if (b >= bins) b = bins - 1;
    if (b < 0) b = 0;
    counts[b]++;
  }
  const n = values.length;
  const freq = counts.map((c) => (c / n) * 100); // 频率 %
  const maxFreq = Math.max(...freq, 1e-6);

  // 对数正态拟合曲线 (预期每 bin 频率 %)
  let curve = null;
  if (fit && fit.sigma > 0 && !fit.degenerate) {
    curve = centers.map((d) => lnpdf(d, fit.mu, fit.sigma) * binW * 100);
  }
  const maxCurve = curve ? Math.max(...curve, 1e-6) : 0;
  const yMax = Math.max(maxFreq, curve ? maxCurve : 0) * 1.12;

  // 坐标轴线 (L 形)
  ctx.strokeStyle = "#243049";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, padT); ctx.lineTo(padL, padT + plotH); ctx.lineTo(padL + plotW, padT + plotH);
  ctx.stroke();

  // 柱 (频率 %)
  const bw = plotW / bins;
  for (let i = 0; i < bins; i++) {
    const h = (freq[i] / yMax) * plotH;
    const x = padL + i * bw;
    const y = padT + plotH - h;
    const grad = ctx.createLinearGradient(0, y, 0, padT + plotH);
    grad.addColorStop(0, "#38e1ff");
    grad.addColorStop(1, "#a78bfa");
    ctx.fillStyle = grad;
    ctx.fillRect(x + 1, y, bw - 2, h);
  }

  // 拟合曲线
  if (curve) {
    ctx.strokeStyle = "#ff7847";
    ctx.lineWidth = 2 * fontScale;
    ctx.beginPath();
    for (let i = 0; i < bins; i++) {
      const x = padL + (i + 0.5) * bw;
      const y = padT + plotH - (curve[i] / yMax) * plotH;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // 刻度 + 标签 (Arial, 内向刻度)
  ctx.fillStyle = "#8b97ad";
  ctx.font = `${11 * fontScale}px Arial, sans-serif`;
  ctx.strokeStyle = "#3a4760";
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  for (let i = 0; i <= 4; i++) {
    const val = min + (range * i) / 4;
    const x = padL + (plotW * i) / 4;
    ctx.beginPath(); ctx.moveTo(x, padT + plotH); ctx.lineTo(x, padT + plotH - 4 * fontScale); ctx.stroke(); // 内向
    ctx.fillText(val.toFixed(val >= 100 ? 0 : 1), x, padT + plotH + 7 * fontScale);
  }
  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (let i = 0; i <= 4; i++) {
    const val = (yMax * i) / 4;
    const y = padT + plotH - (plotH * i) / 4;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + 4 * fontScale, y); ctx.stroke(); // 内向
    ctx.fillText(val.toFixed(0) + "%", padL - 7 * fontScale, y);
  }

  // 轴标题
  ctx.fillStyle = "#c7d0e0";
  ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
  ctx.font = `${12 * fontScale}px Arial, sans-serif`;
  ctx.fillText(`Diameter (${unit})`, padL + plotW / 2, cssH - 3 * fontScale);
  ctx.save();
  ctx.translate(13 * fontScale, padT + plotH / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillText("Frequency (%)", 0, 0);
  ctx.restore();

  // D10/D50/D90 标记线
  const mark = (val, color, label) => {
    if (val < min || val > max) return;
    const x = padL + ((val - min) / range) * plotW;
    ctx.strokeStyle = color;
    ctx.setLineDash([4 * fontScale, 3 * fontScale]);
    ctx.lineWidth = 1 * fontScale;
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.font = `${10 * fontScale}px Arial`;
    ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    ctx.fillText(label, x, padT + 10 * fontScale);
  };
  mark(marks.d10, "#4ade80", "D10");
  mark(marks.d50, "#fbbf24", "D50");
  mark(marks.d90, "#fb7185", "D90");

  // 图例
  if (curve) {
    ctx.fillStyle = "#ff7847";
    ctx.font = `${11 * fontScale}px Arial`;
    ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    ctx.fillText("— Log-normal fit", padL + 8 * fontScale, padT + plotH - 8 * fontScale);
  }

  canvas.hidden = false;
}

function renderHistogramFitInfo(fit, unit) {
  const el = $("fitInfo");
  if (!fit || fit.degenerate) { el.hidden = true; return; }
  const fmt = (v) => (v >= 100 ? v.toFixed(0) : v.toFixed(2));
  el.textContent = `Log-normal fit: d_g (几何平均) = ${fmt(fit.dg)} ${unit}, σ_g (几何标准差) = ${fit.sg.toFixed(2)}`;
  el.hidden = false;
}

/* ---------- 渲染颗粒明细表 ---------- */
function renderTable(rowsUnit, unit) {
  const tbody = $("tbl").querySelector("tbody");
  tbody.innerHTML = "";
  const fmt = (v) => (v >= 100 ? v.toFixed(0) : v.toFixed(2));
  const sorted = rowsUnit.slice().sort((a, b) => b.d - a.d);
  const limit = Math.min(sorted.length, 500);
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
  const { diameters, unit, rows, stats, fit } = lastResults;
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
  csv += `跨度,${stats.span.toFixed(3)}\n`;
  if (fit && !fit.degenerate) {
    csv += `几何平均dg(${unit}),${fmt(fit.dg)}\n`;
    csv += `几何标准差sg,${fit.sg.toFixed(3)}\n`;
  }
  csv += `\n颗粒明细\n序号,直径(${unit}),面积(${unit}^2),圆度,质心X,质心Y\n`;
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

/* ---------- 导出 300 DPI 出版级直方图 PNG ---------- */
function exportHistPng() {
  if (!lastResults || !lastResults.fit) return;
  const off = document.createElement("canvas");
  renderHistogram(off, {
    values: lastResults.diameters,
    unit: lastResults.unit,
    marks: { d10: lastResults.stats.d10, d50: lastResults.stats.d50, d90: lastResults.stats.d90 },
    fit: lastResults.fit,
    width: 2100,   // 7 inch @ 300 DPI
    height: 900,   // 3 inch @ 300 DPI
    fontScale: 2.6,
  });
  const url = off.toDataURL("image/png");
  const a = document.createElement("a");
  a.href = url;
  a.download = "particle_size_distribution.png";
  a.click();
}

/* ---------- 实时预览 (拖动参数时彩色高亮被选中晶粒) ---------- */
function schedulePreview() {
  if (!imgLoaded) return;
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(runPreview, 150);
}
async function runPreview() {
  if (previewRunning) { previewPending = true; return; }
  previewRunning = true;
  let s = null, dst = null;
  try {
    await waitCv();
    const p = readParams();
    s = await segment(p);
    if (s.diametersPx.length > 0) {
      dst = s.src.clone();
      drawContoursColored(dst, s.contours, s.keptIdx, s.diametersPx, s.dMin, s.dMax);
      cv.imshow(dstCanvas, dst);
      $("previewBadge").textContent = `预览 ${s.diametersPx.length} 颗`;
      $("previewBadge").hidden = false;
    } else {
      $("previewBadge").hidden = true;
    }
  } catch (e) {
    // 预览失败不影响主流程
  } finally {
    if (s) {
      try { if (dst) dst.delete(); } catch (_) {}
      try { s.src.delete(); } catch (_) {}
      try { s.gray.delete(); } catch (_) {}
      try { s.thresh.delete(); } catch (_) {}
      try { if (s.kernel) s.kernel.delete(); } catch (_) {}
      try { for (const idx of s.keptIdx) { try { s.contours.get(idx).delete(); } catch (_) {} } } catch (_) {}
      try { s.contours.delete(); } catch (_) {}
      try { s.hierarchy.delete(); } catch (_) {}
    }
    previewRunning = false;
    if (previewPending) { previewPending = false; runPreview(); }
  }
}

/* ---------- 标尺线 overlay ---------- */
function syncOverlay() {
  const ov = $("srcOverlay");
  if (!srcCanvas.width) { ov.width = 300; ov.height = 200; }
  else { ov.width = srcCanvas.width; ov.height = srcCanvas.height; }
  drawScaleOverlay();
}
function drawScaleOverlay() {
  const ov = $("srcOverlay");
  const ctx = ov.getContext("2d");
  ctx.clearRect(0, 0, ov.width, ov.height);
  const line = drawEnd ? { x1: scaleLine.x1, y1: scaleLine.y1, x2: drawEnd.x, y2: drawEnd.y } : scaleLine;
  if (!line) return;
  const lw = Math.max(2, ov.width / 300);
  ctx.strokeStyle = "#ffd23f";
  ctx.lineWidth = lw;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(line.x1, line.y1);
  ctx.lineTo(line.x2, line.y2);
  ctx.stroke();
  // 端点短刻线 (标尺样式)
  const ang = Math.atan2(line.y2 - line.y1, line.x2 - line.x1);
  const tk = 8 * (ov.width / 640);
  for (const [px, py] of [[line.x1, line.y1], [line.x2, line.y2]]) {
    ctx.beginPath();
    ctx.moveTo(px - Math.sin(ang) * tk, py + Math.cos(ang) * tk);
    ctx.lineTo(px + Math.sin(ang) * tk, py - Math.cos(ang) * tk);
    ctx.stroke();
  }
  const len = Math.hypot(line.x2 - line.x1, line.y2 - line.y1);
  const mx = (line.x1 + line.x2) / 2, my = (line.y1 + line.y2) / 2;
  ctx.fillStyle = "#ffd23f";
  ctx.font = `${Math.max(11, ov.width / 38)}px Arial`;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillText(`${len.toFixed(0)} px`, mx, my - tk - 2);
}
function ovPos(e) {
  const ov = $("srcOverlay");
  const rect = ov.getBoundingClientRect();
  const sx = ov.width / rect.width, sy = ov.height / rect.height;
  return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
}
function toggleScale() {
  scaleMode = !scaleMode;
  const btn = $("drawScale");
  btn.classList.toggle("active", scaleMode);
  $("srcOverlay").style.pointerEvents = scaleMode ? "auto" : "none";
  $("srcOverlay").style.cursor = scaleMode ? "crosshair" : "default";
  $("calHintLine").textContent = scaleMode
    ? "在原图上按住并拖出一条已知长度的线段，松开即自动填入像素数。"
    : "点击「画标尺线」后，可在原图上拖线标出已知长度来设定比例尺。";
}
function bindScale() {
  const ov = $("srcOverlay");
  ov.addEventListener("mousedown", (e) => {
    if (!scaleMode) return;
    e.preventDefault();
    drawing = true;
    const p = ovPos(e);
    scaleLine = { x1: p.x, y1: p.y, x2: p.x, y2: p.y };
    drawEnd = p;
  });
  ov.addEventListener("mousemove", (e) => {
    if (!scaleMode || !drawing) return;
    drawEnd = ovPos(e);
    drawScaleOverlay();
  });
  window.addEventListener("mouseup", (e) => {
    if (!scaleMode || !drawing) return;
    drawing = false;
    const p = ovPos(e);
    scaleLine = { x1: scaleLine.x1, y1: scaleLine.y1, x2: p.x, y2: p.y };
    drawEnd = null;
    const len = Math.hypot(scaleLine.x2 - scaleLine.x1, scaleLine.y2 - scaleLine.y1);
    $("calpx").value = Math.max(1, Math.round(len));
    $("calPxVal").textContent = $("calpx").value;
    updateScaleInfo();
    drawScaleOverlay();
  });
  // 触摸支持
  ov.addEventListener("touchstart", (e) => {
    if (!scaleMode) return;
    e.preventDefault();
    const t = e.touches[0];
    drawing = true;
    const p = ovPos(t);
    scaleLine = { x1: p.x, y1: p.y, x2: p.x, y2: p.y };
    drawEnd = p;
  }, { passive: false });
  ov.addEventListener("touchmove", (e) => {
    if (!scaleMode || !drawing) return;
    e.preventDefault();
    drawEnd = ovPos(e.touches[0]);
    drawScaleOverlay();
  }, { passive: false });
  ov.addEventListener("touchend", (e) => {
    if (!scaleMode || !drawing) return;
    drawing = false;
    const t = e.changedTouches[0];
    const p = ovPos(t);
    scaleLine = { x1: scaleLine.x1, y1: scaleLine.y1, x2: p.x, y2: p.y };
    drawEnd = null;
    const len = Math.hypot(scaleLine.x2 - scaleLine.x1, scaleLine.y2 - scaleLine.y1);
    $("calpx").value = Math.max(1, Math.round(len));
    $("calPxVal").textContent = $("calpx").value;
    updateScaleInfo();
    drawScaleOverlay();
  });
}

/* ---------- 事件绑定 ---------- */
function bindUI() {
  $("pick").addEventListener("click", () => $("file").click());
  $("file").addEventListener("change", (e) => loadFile(e.target.files[0]));
  $("sample").addEventListener("click", loadSample);
  $("run").addEventListener("click", analyze);
  $("expCsv").addEventListener("click", exportCsv);
  $("expPng").addEventListener("click", exportHistPng);
  $("drawScale").addEventListener("click", toggleScale);
  $("clearScale").addEventListener("click", () => { scaleLine = null; drawEnd = null; drawScaleOverlay(); });

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

  // 参数联动显示 + 实时预览
  $("mode").addEventListener("change", () => {
    $("manualWrap").hidden = $("mode").value !== "manual";
    $("blockWrap").hidden = $("mode").value !== "adaptive";
    schedulePreview();
  });
  $("thr").addEventListener("input", () => { $("thrVal").textContent = $("thr").value; schedulePreview(); });
  $("blk").addEventListener("input", () => { $("blkVal").textContent = $("blk").value; schedulePreview(); });
  $("kern").addEventListener("input", () => { $("kVal").textContent = $("kern").value; schedulePreview(); });
  $("minarea").addEventListener("input", () => { $("minVal").textContent = $("minarea").value; schedulePreview(); });
  $("circ").addEventListener("input", () => { $("cirVal").textContent = (+$("circ").value).toFixed(2); schedulePreview(); });
  document.querySelectorAll('input[name="polar"]').forEach((r) =>
    r.addEventListener("change", schedulePreview)
  );

  // 标尺校准
  $("calpx").addEventListener("input", () => { $("calPxVal").textContent = $("calpx").value; updateScaleInfo(); });
  $("calLen").addEventListener("input", updateScaleInfo);
  $("calUnit").addEventListener("change", updateScaleInfo);

  bindScale();
}

function updateScaleInfo() {
  const calPx = +$("calpx").value;
  const calLen = +$("calLen").value;
  const unit = $("calUnit").value;
  if (calPx > 0 && calLen > 0) {
    const perPx = calLen / calPx;
    $("scaleInfo").textContent = `1 px ≈ ${perPx.toFixed(4)} ${unit}（或 1 ${unit} ≈ ${(calPx / calLen).toFixed(2)} px）`;
  }
}

/* ---------- 启动 ---------- */
window.addEventListener("DOMContentLoaded", () => {
  bindUI();
  updateScaleInfo();
  syncOverlay();
  waitCv().then(() => {
    $("status").style.color = "var(--good)";
    $("status").textContent = "OpenCV 已就绪，上传图像或载入示例即可分析。";
  }).catch((e) => {
    $("status").style.color = "var(--bad)";
    $("status").textContent = e.message;
  });
});
