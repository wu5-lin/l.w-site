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
  const t0 = Date.now();
  const sleep = () => new Promise((r) => setTimeout(r, 100));
  // 1) 先等 opencv.js 脚本执行完, window.cv 出现 (可能还在下载 13MB wasm)
  while (!window.cv) {
    if (Date.now() - t0 > timeout) {
      throw new Error("OpenCV 加载超时，请检查网络后强制刷新（Ctrl+F5）重试");
    }
    await sleep();
  }
  // 2) @techstark 构建 module.exports 是 Promise, 解析出真正的 cv 命名空间
  if (typeof window.cv.then === "function") {
    window.cv = await window.cv;
  }
  // 3) 再等 wasm 运行时就绪 (imread 挂载)
  while (typeof window.cv.imread !== "function") {
    if (Date.now() - t0 > timeout) {
      throw new Error("OpenCV 加载超时，请强制刷新（Ctrl+F5）后重试");
    }
    await sleep();
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

/* 多色区分: 黄金角色相, 同一图中每颗颗粒颜色各不相同 (五彩标注) */
function colorForIndex(i) {
  const hue = (i * 137.508) % 360;
  return hslToScalar(hue, 0.72, 0.62);
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
  const calOkay = calPx > 0 && calLen > 0 && !Number.isNaN(calLen);
  const calibrated = calUnit !== "px" && calOkay;
  const unitPerPx = calibrated ? (calLen / calPx) : 1;
  const unitLabel = calibrated ? calUnit : "px";
  const ws = $("ws") ? $("ws").checked : false;
  const colorMode = $("colorMode") ? $("colorMode").value : "gradient";
  const blur = $("blur") ? $("blur").checked : false;
  const fill = $("fill") ? $("fill").checked : false;
  const keepEdge = $("keepEdge") ? $("keepEdge").checked : false;

  // 晶粒模式参数
  const isGrain = mode === "grain";
  const grainBlur = $("grainBlur") ? +$("grainBlur").value : 1.0;
  const edgePct = $("edgePct") ? +$("edgePct").value : 80;
  const dilateW = $("dilateW") ? +$("dilateW").value : 5;
  const gradK = $("gradK") ? +$("gradK").value : 3;
  const closeW = $("closeW") ? +$("closeW").value : 5;
  const grainMinSeed = $("grainMinSeed") ? +$("grainMinSeed").value : 200;
  const wsPeakK = $("wsPeakK") ? +$("wsPeakK").value : 7;

  // 晶粒模式不启用圆度过滤: 晶粒是多边形, 且分水岭边界沿像素网格走,
  // cv.arcLength 会系统性低估圆度(实测中位仅 0.64, 17% 的真实晶粒低于 0.25)。
  // 若照搬阈值模式的圆度门槛, 会误杀约 17% 的真晶粒。碎片已由
  // 最小面积 + 种子最小面积( grainMinSeed )过滤, 形状质量请看「实心度」列。
  const effMinCirc = isGrain ? 0 : minCirc;

  return {
    mode, thr, block, kern, minArea, minCirc, effMinCirc, polar,
    calPx, calLen, calUnit, calibrated, unitPerPx, unitLabel,
    ws, colorMode, blur, fill, keepEdge, isGrain,
    grainBlur, edgePct, dilateW, gradK, closeW, grainMinSeed, wsPeakK,
  };
}

/* ---------- 分水岭分离重叠/团聚颗粒 (提升准确度) ----------
 * 用距离变换找种子, 再 watershed 把相互接触的颗粒切开, 返回分离后的二值掩膜。 */
async function watershedSplit(gray, thresh, src, peakK = 7, minPeak = 1.5) {
  // 距离变换: 每个前景像素到最近背景的距离 (输出 32F)
  const dist = new cv.Mat();
  cv.distanceTransform(thresh, dist, cv.DIST_L2, 3);

  // 种子 = 距离变换的形态学局部极大 (等价于 peak_local_max)。
  // 旧实现用 maxD * 0.4 的全局阈值取种子, 这在大小颗粒共存时是不公平的:
  // 小颗粒的峰本来就低, 永远够不到全局最大值的 40%, 于是拿不到种子、
  // 被并进邻近的大颗粒。合成基准实测欠分割 41%。局部极大是逐点判定的,
  // 与整体尺度无关, 同一张图里任何尺寸的颗粒都能拿到自己的种子。
  const pkKernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(peakK, peakK));
  const distDil = new cv.Mat();
  cv.dilate(dist, distDil, pkKernel);                           // 32F 可用形态学
  const isPeak = new cv.Mat();
  cv.compare(dist, distDil, isPeak, cv.CMP_GE);                 // 8U: 不小于邻域者=255
  const aboveMin = new cv.Mat();
  cv.threshold(dist, aboveMin, minPeak, 255, cv.THRESH_BINARY); // 32F: 0/255
  const sureFg8 = new cv.Mat();
  aboveMin.convertTo(sureFg8, cv.CV_8U);                        // 32F -> 8U
  cv.bitwise_and(isPeak, sureFg8, sureFg8);                     // 峰点掩膜

  // 标记前景种子 (1..K)
  const markers = new cv.Mat(thresh.rows, thresh.cols, cv.CV_32SC1, new cv.Scalar(0));
  const nSeeds = cv.connectedComponents(sureFg8, markers);

  // 原图背景区域标记为单独标签, 防止分水岭把背景淹没成颗粒
  const bgLabel = nSeeds + 1;
  const bgMask = new cv.Mat();
  cv.threshold(thresh, bgMask, 1, 255, cv.THRESH_BINARY_INV); // 原背景=255 (8U)
  markers.setTo(new cv.Scalar(bgLabel), bgMask);

  // watershed 需要 3 通道
  const src3 = new cv.Mat();
  cv.cvtColor(src, src3, cv.COLOR_RGBA2BGR);
  cv.watershed(src3, markers);

  // 仅保留颗粒区域(标签 1..K), 排除背景(bgLabel)与边界(-1)
  // 注意: markers 为 CV_32S, cv.threshold 不支持 32S; 先转 32F 再 threshold
  const markersF = new cv.Mat();
  markers.convertTo(markersF, cv.CV_32F);
  const mask1 = new cv.Mat();
  cv.threshold(markersF, mask1, 0, 255, cv.THRESH_BINARY);              // 32F: >0 -> 255
  const mask1u = new cv.Mat();
  mask1.convertTo(mask1u, cv.CV_8U);
  const mask2 = new cv.Mat();
  cv.threshold(markersF, mask2, bgLabel - 1, 255, cv.THRESH_BINARY_INV); // 32F: <=K -> 255
  const mask2u = new cv.Mat();
  mask2.convertTo(mask2u, cv.CV_8U);
  const regionMask = new cv.Mat();
  cv.bitwise_and(mask1u, mask2u, regionMask);

  dist.delete();
  distDil.delete(); pkKernel.delete(); isPeak.delete(); aboveMin.delete();
  sureFg8.delete(); bgMask.delete(); src3.delete();
  markersF.delete(); mask1.delete(); mask1u.delete(); mask2.delete(); mask2u.delete();
  return { markers, regionMask, bgLabel };
}

/* ---------- 工具: 单通道 8U Mat 的百分位阈值 ----------
 * 梯度直方图是单峰偏态的, Otsu 在上面表现不稳; 用百分位更可控也更直观。 */
function matPercentile(mat, pct) {
  const d = mat.data;
  const n = mat.rows * mat.cols;
  const hist = new Int32Array(256);
  for (let i = 0; i < n; i++) hist[d[i]]++;
  const target = (n * pct) / 100;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= target) return v;
  }
  return 255;
}

/* ---------- 工具: 凸包法 Feret 直径 ----------
 * maxFeret = 凸包上最远两点距离; minFeret = 最小宽度(各边法向最大垂距的最小值)。
 * 刻意不用 cv.minAreaRect: 其返回结构随 opencv.js 版本而异, 且外接矩形的长边
 * 并不严格等于最远点距。凸包法无 API 依赖, 也是粒径分析的标准定义。
 * 一并返回凸包面积, 供 solidity(实心度) 复用, 避免重复算凸包。 */
function feretMetrics(contour) {
  const hull = new cv.Mat();
  cv.convexHull(contour, hull);
  const n = hull.rows;
  const hd = hull.data32S;
  const hullArea = n >= 3 ? cv.contourArea(hull) : 0;
  if (n < 3) { hull.delete(); return { minFeret: 0, maxFeret: 0, hullArea: 0 }; }
  const px = new Float64Array(n), py = new Float64Array(n);
  for (let i = 0; i < n; i++) { px[i] = hd[i * 2]; py[i] = hd[i * 2 + 1]; }
  let maxD2 = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = px[j] - px[i], dy = py[j] - py[i];
      const d2 = dx * dx + dy * dy;
      if (d2 > maxD2) maxD2 = d2;
    }
  }
  let minW = Infinity;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    let ex = px[j] - px[i], ey = py[j] - py[i];
    const len = Math.hypot(ex, ey);
    if (len < 1e-9) continue;
    ex /= len; ey /= len;
    let far = 0;
    for (let k = 0; k < n; k++) {
      const perp = Math.abs((px[k] - px[i]) * (-ey) + (py[k] - py[i]) * ex);
      if (perp > far) far = perp;
    }
    if (far < minW) minW = far;
  }
  hull.delete();
  return {
    minFeret: minW === Infinity ? 0 : minW,
    maxFeret: Math.sqrt(maxD2),
    hullArea,
  };
}

/* ---------- 工具: 把标签图中的 0 / -1 像素并入邻域标签 ----------
 * OpenCV 的形态学操作不支持 CV_32S 标签图(报 Unsupported data type = 4),
 * 与 cv.threshold 不接受 CV_32S 同源。所以这里只能用纯 JS 邻域填充, 不能改成 cv.dilate。 */
function fillLabelZeros(mat, iters) {
  const rows = mat.rows, cols = mat.cols;
  const d = mat.data32S;
  const copy = new Int32Array(d.length);
  for (let it = 0; it < iters; it++) {
    copy.set(d);
    let changed = false;
    for (let y = 0; y < rows; y++) {
      const y0 = y > 0 ? y - 1 : 0, y1 = y < rows - 1 ? y + 1 : rows - 1;
      const row = y * cols;
      for (let x = 0; x < cols; x++) {
        const i = row + x;
        if (copy[i] > 0) continue;
        const x0 = x > 0 ? x - 1 : 0, x1 = x < cols - 1 ? x + 1 : cols - 1;
        let best = 0;
        for (let yy = y0; yy <= y1; yy++) {
          const r2 = yy * cols;
          for (let xx = x0; xx <= x1; xx++) {
            const v = copy[r2 + xx];
            if (v > best) best = v;
          }
        }
        if (best > 0) { d[i] = best; changed = true; }
      }
    }
    if (!changed) break;
  }
}

/* ---------- 晶粒模式: 面向致密烧结组织 ----------
 * 致密烧结陶瓷里晶粒彼此紧贴、整幅图没有"背景", 所以靠前景/背景灰度阈值
 * 从原理上就切不开它。但晶界是一圈高梯度线, 于是换一条路:
 *   形态学梯度 → 百分位阈值取晶界 → 闭运算连接断续晶界 → 膨胀加宽
 *   → 余下区域即晶粒核心 → 连通域作种子 → 分水岭把晶界像素按中线平分给相邻晶粒
 *
 * 最后一步是关键: 若把晶界像素直接丢掉, 测得的直径会系统性偏小(实测 -17%);
 * 用分水岭平分后面积守恒, 系统偏差降到 -0.6%。这一步也让算法不再关心
 * 晶界是亮是暗 —— 阈值法在亮晶界图上会 100% 失效, 梯度法不受影响。 */
function grainSegment(p, gray, W, H) {
  const smooth = new cv.Mat();
  cv.GaussianBlur(gray, smooth, new cv.Size(0, 0), p.grainBlur);

  const gk = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(p.gradK, p.gradK));
  const grad = new cv.Mat();
  cv.morphologyEx(smooth, grad, cv.MORPH_GRADIENT, gk);

  const t = matPercentile(grad, p.edgePct);
  const edge = new cv.Mat();
  cv.threshold(grad, edge, t, 255, cv.THRESH_BINARY);

  const ck = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(p.closeW, p.closeW));
  cv.morphologyEx(edge, edge, cv.MORPH_CLOSE, ck);

  const dk = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(p.dilateW, p.dilateW));
  cv.dilate(edge, edge, dk);

  const core = new cv.Mat();
  cv.bitwise_not(edge, core);

  const labels = new cv.Mat();
  const nComp = cv.connectedComponents(core, labels, 4, cv.CV_32S);

  // 过小的连通域不作为种子, 否则会污染分水岭
  const markers = new cv.Mat(H, W, cv.CV_32SC1, new cv.Scalar(0));
  const lb = labels.data32S, mk = markers.data32S;
  const area = new Int32Array(nComp);
  for (let i = 0, n = W * H; i < n; i++) { const v = lb[i]; if (v > 0) area[v]++; }
  const keep = new Uint8Array(nComp);
  for (let i = 1; i < nComp; i++) if (area[i] >= p.grainMinSeed) keep[i] = 1;
  for (let i = 0, n = W * H; i < n; i++) {
    const v = lb[i];
    if (v > 0 && keep[v]) mk[i] = v;
  }

  const topo = new cv.Mat();
  cv.cvtColor(grad, topo, cv.COLOR_GRAY2BGR);
  cv.watershed(topo, markers);        // 晶界像素按中线分给相邻晶粒
  fillLabelZeros(markers, 3);         // 收编 watershed 留下的 -1 分界线

  smooth.delete(); gk.delete(); grad.delete();
  ck.delete(); dk.delete(); labels.delete(); topo.delete();
  return { edge, core, markers };
}

/* ---------- 轮廓测量与筛选(两条路径共用) ----------
 * 返回 null 表示该轮廓被筛掉。 */
function measureContour(c, p, W, H) {
  const area = cv.contourArea(c);
  if (area < p.minArea) return null;
  const peri = cv.arcLength(c, true);
  const circ = peri > 0 ? (4 * Math.PI * area) / (peri * peri) : 0;
  if (circ < p.effMinCirc) return null;
  const r = cv.boundingRect(c);
  const touchesEdge = (r.x <= 0 || r.y <= 0
    || r.x + r.width >= W - 1 || r.y + r.height >= H - 1);
  if (touchesEdge && !p.keepEdge) return null;
  const fer = feretMetrics(c);
  const solidity = fer.hullArea > 0 ? area / fer.hullArea : 1;
  const mom = cv.moments(c);
  const cx = mom.m00 ? mom.m10 / mom.m00 : r.x + r.width / 2;
  const cy = mom.m00 ? mom.m01 / mom.m00 : r.y + r.height / 2;
  return {
    area, circ, touchesEdge, solidity, cx, cy,
    dPx: Math.sqrt((4 * area) / Math.PI),
    minFeretPx: fer.minFeret, maxFeretPx: fer.maxFeret,
  };
}

/* ---------- 从晶粒标签图逐个提取轮廓 ----------
 * 逐个在各自 bbox 内二值化再 findContours: 分水岭后的区域彼此紧邻,
 * 若整图一次性求外轮廓, 相邻晶粒会被连成一整片。 */
function extractByLabel(labelMat, p, W, H, out) {
  const mk = labelMat.data32S;
  const n = W * H;
  let maxLab = 0;
  for (let i = 0; i < n; i++) { const v = mk[i]; if (v > maxLab) maxLab = v; }
  const area = new Int32Array(maxLab + 1);
  const minX = new Int32Array(maxLab + 1).fill(W);
  const maxX = new Int32Array(maxLab + 1).fill(-1);
  const minY = new Int32Array(maxLab + 1).fill(H);
  const maxY = new Int32Array(maxLab + 1).fill(-1);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const v = mk[row + x];
      if (v <= 0) continue;
      area[v]++;
      if (x < minX[v]) minX[v] = x;
      if (x > maxX[v]) maxX[v] = x;
      if (y < minY[v]) minY[v] = y;
      if (y > maxY[v]) maxY[v] = y;
    }
  }
  for (let v = 1; v <= maxLab; v++) {
    if (area[v] < p.minArea || maxX[v] < 0) continue;
    const bw = maxX[v] - minX[v] + 1, bh = maxY[v] - minY[v] + 1;
    const mask = new cv.Mat(bh, bw, cv.CV_8UC1, new cv.Scalar(0));
    const md = mask.data;
    for (let y = 0; y < bh; y++) {
      const srow = (minY[v] + y) * W + minX[v];
      const drow = y * bw;
      for (let x = 0; x < bw; x++) if (mk[srow + x] === v) md[drow + x] = 255;
    }
    const sub = new cv.MatVector();
    const subH = new cv.Mat();
    cv.findContours(mask, sub, subH, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    const cnts = [];
    for (let k = 0; k < sub.size(); k++) cnts.push(sub.get(k));
    let best = -1, bestA = -1;
    for (let k = 0; k < cnts.length; k++) {
      const a = cv.contourArea(cnts[k]);
      if (a > bestA) { bestA = a; best = k; }
    }
    if (best >= 0) {
      const c = cnts[best];
      const cd = c.data32S;
      for (let k = 0; k < c.rows; k++) { cd[k * 2] += minX[v]; cd[k * 2 + 1] += minY[v]; }
      const m = measureContour(c, p, W, H);
      if (m) {
        out.contours.push_back(c);
        out.keptIdx.push(out.contours.size() - 1);
        out.diametersPx.push(m.dPx);
        out.rows.push({
          dPx: m.dPx, areaPx: m.area, circ: m.circ,
          cx: Math.round(m.cx), cy: Math.round(m.cy),
          minFeretPx: m.minFeretPx, maxFeretPx: m.maxFeretPx,
          solidity: m.solidity, edgeGrain: m.touchesEdge,
        });
        out.labels.push(v);
        if (m.dPx < out.dMin) out.dMin = m.dPx;
        if (m.dPx > out.dMax) out.dMax = m.dPx;
      }
    }
    for (const cc of cnts) { try { cc.delete(); } catch (_) {} }
    sub.delete(); subH.delete(); mask.delete();
  }
}

/* ---------- 分割 + 提取轮廓 (供 分析 / 实时预览 复用) ---------- */
async function segment(p) {
  const src = cv.imread(srcCanvas);
  let gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  if (p.blur) {
    const tmp = new cv.Mat();
    cv.GaussianBlur(gray, tmp, new cv.Size(3, 3), 0);
    gray.delete();
    gray = tmp;
  }
  const W = srcCanvas.width, H = srcCanvas.height;
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  const keptIdx = [];
  const diametersPx = [];
  const rows = [];
  const labels = [];
  const out = { contours, keptIdx, diametersPx, rows, labels, dMin: Infinity, dMax: 0 };
  let thresh = null, kernel = null, regionMask = null, markers = null;

  if (p.mode === "grain") {
    // 致密烧结组织: 梯度晶界 + 分水岭, 与阈值无关
    const g = grainSegment(p, gray, W, H);
    thresh = g.edge;
    regionMask = g.core;
    markers = g.markers;
    extractByLabel(markers, p, W, H, out);
  } else {
    // polar 语义: "颗粒亮"= 颗粒比背景亮 -> 亮像素即前景 -> THRESH_BINARY。
    // 之前写成 BINARY_INV, 等于把"暗的那一半"当颗粒: 在暗晶界图上前景只剩
    // 18.3%(那是晶界网络本身), 实测只能检出 2 个颗粒, 而正确映射检出 111 个。
    thresh = new cv.Mat();
    if (p.mode === "adaptive") {
      const flag = p.polar === "bright" ? cv.THRESH_BINARY : cv.THRESH_BINARY_INV;
      cv.adaptiveThreshold(gray, thresh, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, flag, p.block, 2);
    } else if (p.mode === "otsu") {
      const flag = (p.polar === "bright" ? cv.THRESH_BINARY : cv.THRESH_BINARY_INV) | cv.THRESH_OTSU;
      cv.threshold(gray, thresh, 0, 255, flag);
    } else {
      const flag = p.polar === "bright" ? cv.THRESH_BINARY : cv.THRESH_BINARY_INV;
      cv.threshold(gray, thresh, p.thr, 255, flag);
    }
    if (p.kern > 0) {
      kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(p.kern, p.kern));
      const tmp = new cv.Mat();
      cv.morphologyEx(thresh, tmp, cv.MORPH_OPEN, kernel);
      cv.morphologyEx(tmp, thresh, cv.MORPH_CLOSE, kernel);
      tmp.delete();
    }

    // 是否用分水岭拆分重叠颗粒
    if (p.ws) {
      const wsRes = await watershedSplit(gray, thresh, src, p.wsPeakK);
      // 若没有有效种子(颗粒过小), 退回直接阈值掩膜, 避免漏检
      if (wsRes && wsRes.bgLabel > 1) {
        markers = wsRes.markers;
        regionMask = wsRes.regionMask;
      } else {
        if (wsRes) { wsRes.markers.delete(); wsRes.regionMask.delete(); }
        regionMask = thresh;
      }
    } else {
      regionMask = thresh;
    }

    cv.findContours(regionMask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const m = measureContour(c, p, W, H);
      if (!m) { c.delete(); continue; }
      let lab = keptIdx.length + 1;
      if (markers) {
        const v = markers.intAt(Math.round(m.cy), Math.round(m.cx));
        if (v > 0) lab = v;
      }
      diametersPx.push(m.dPx);
      rows.push({
        dPx: m.dPx, areaPx: m.area, circ: m.circ,
        cx: Math.round(m.cx), cy: Math.round(m.cy),
        minFeretPx: m.minFeretPx, maxFeretPx: m.maxFeretPx,
        solidity: m.solidity, edgeGrain: m.touchesEdge,
      });
      labels.push(lab);
      keptIdx.push(i);
      if (m.dPx < out.dMin) out.dMin = m.dPx;
      if (m.dPx > out.dMax) out.dMax = m.dPx;
    }
  }

  return {
    src, gray, thresh, kernel, regionMask, markers, contours, hierarchy,
    keptIdx, diametersPx, rows, labels,
    dMin: out.dMin, dMax: out.dMax, W, H,
  };
}

/* ---------- 按模式在 dst 上着色轮廓 / 填充 ----------
 * src: 原始图像（dst 通常是其克隆），fill 模式用它做 alpha 混合底图 */
function drawContoursColored(dst, contours, keptIdx, diametersPx, dMin, dMax, colorMode, labels, fill, src) {
  const span = (dMax - dMin) || 1;
  if (fill && src) {
    // 在独立 overlay 上填充颜色，再半透明叠回原始图
    const overlay = src.clone();
    for (let j = 0; j < keptIdx.length; j++) {
      const col = (colorMode === "multi")
        ? colorForIndex(labels ? labels[j] : (j + 1))
        : colorForRank((diametersPx[j] - dMin) / span);
      cv.drawContours(overlay, contours, keptIdx[j], col, -1);
    }
    cv.addWeighted(src, 0.40, overlay, 0.60, 0, dst);
    overlay.delete();
    // 再描边让边界更清晰
    for (let j = 0; j < keptIdx.length; j++) {
      const col = (colorMode === "multi")
        ? colorForIndex(labels ? labels[j] : (j + 1))
        : colorForRank((diametersPx[j] - dMin) / span);
      cv.drawContours(dst, contours, keptIdx[j], col, 1);
    }
  } else {
    for (let j = 0; j < keptIdx.length; j++) {
      const col = (colorMode === "multi")
        ? colorForIndex(labels ? labels[j] : (j + 1))
        : colorForRank((diametersPx[j] - dMin) / span);
      cv.drawContours(dst, contours, keptIdx[j], col, 2);
    }
  }
}

/* ---------- 统计指标计算 (纯函数, 供分析与实时重算复用) ---------- */
function computeStats(diameters) {
  const n = diameters.length;
  if (n === 0) return null;
  const sorted = diameters.slice().sort((a, b) => a - b);
  const mean = diameters.reduce((s, v) => s + v, 0) / n;
  const d10 = percentile(sorted, 0.1);
  const d30 = percentile(sorted, 0.3);
  const d50 = percentile(sorted, 0.5);
  const d60 = percentile(sorted, 0.6);
  const d90 = percentile(sorted, 0.9);
  const cu = d10 > 0 ? d60 / d10 : 0;
  const cc = (d10 > 0 && d60 > 0) ? (d30 * d30) / (d10 * d60) : 0;
  const span = d50 > 0 ? (d90 - d10) / d50 : 0;
  return { n, mean, median: d50, d10, d30, d50, d60, d90, cu, cc, span };
}
function renderStats(stats, unit) {
  const fmt = (v) => (v >= 100 ? v.toFixed(0) : v.toFixed(2));
  $("sCount").textContent = stats.n;
  $("sMean").textContent = `${fmt(stats.mean)} ${unit}`;
  $("sMedian").textContent = `${fmt(stats.median)} ${unit}`;
  $("sD10").textContent = `${fmt(stats.d10)} ${unit}`;
  $("sD50").textContent = `${fmt(stats.d50)} ${unit}`;
  $("sD90").textContent = `${fmt(stats.d90)} ${unit}`;
  $("sCu").textContent = stats.cu ? stats.cu.toFixed(2) : "–";
  $("sCc").textContent = stats.cc ? stats.cc.toFixed(2) : "–";
  $("sSpan").textContent = stats.span ? stats.span.toFixed(2) : "–";
  $("stats").hidden = false;
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
    const noun = p.isGrain ? "晶粒" : "颗粒";
    if (s.diametersPx.length === 0) {
      status.style.color = "var(--bad)";
      status.textContent = p.isGrain
        ? "未检测到晶粒，请调低晶界灵敏度或最小晶粒面积；若图中确无晶界衬度，请改回阈值模式。"
        : "未检测到颗粒，请调低最小面积/圆度，或切换颗粒明暗。";
      return;
    }

    dst = s.src.clone();
    drawContoursColored(dst, s.contours, s.keptIdx, s.diametersPx, s.dMin, s.dMax, p.colorMode, s.labels, p.fill, s.src);
    cv.imshow(dstCanvas, dst);

    const diameters = s.diametersPx.map((d) => d * p.unitPerPx);
    const rowsUnit = s.rows.map((row) => ({
      d: row.dPx * p.unitPerPx,
      area: row.areaPx * p.unitPerPx * p.unitPerPx,
      circ: row.circ,
      cx: row.cx,
      cy: row.cy,
      minFeret: (row.minFeretPx || 0) * p.unitPerPx,
      maxFeret: (row.maxFeretPx || 0) * p.unitPerPx,
      solidity: (typeof row.solidity === "number") ? row.solidity : null,
      edgeGrain: !!row.edgeGrain,
    }));

    // 统计指标
    const stats = computeStats(diameters);
    if (!stats) {
      status.style.color = "var(--bad)";
      status.textContent = `未检测到${noun}，请调整分割参数后重试。`;
      return;
    }
    renderStats(stats, p.unitLabel);
    // 文案随分割方式走: 晶粒模式下说"晶粒"而非"颗粒", 避免语义混乱
    if ($("sCountLabel")) $("sCountLabel").textContent = p.isGrain ? "晶粒数" : "颗粒数";
    if ($("histTitle")) $("histTitle").textContent = p.isGrain ? "晶粒尺寸分布直方图" : "粒径分布直方图";
    if ($("tableTitle")) $("tableTitle").textContent = p.isGrain ? "晶粒明细" : "颗粒明细";

    const fit = lognormalFit(diameters);
    lastResults = {
      px: s.diametersPx.slice(),
      rowsPx: s.rows.map((r) => ({ ...r })),
      diameters, unit: p.unitLabel, rows: rowsUnit, stats, fit,
      isGrain: p.isGrain, keepEdge: p.keepEdge,
    };

    $("chartBlock").hidden = false;
    renderHistogram($("hist"), { values: diameters, unit: p.unitLabel, marks: { d10: stats.d10, d50: stats.d50, d90: stats.d90 }, fit });
    renderHistogramFitInfo(fit, p.unitLabel);
    renderTable(rowsUnit, p.unitLabel);

    status.style.color = "var(--good)";
    const edgeN = s.rows.filter((r) => r.edgeGrain).length;
    status.textContent = p.keepEdge
      ? `分析完成：共 ${stats.n} 个${noun}（含 ${edgeN} 个接触边界，其尺寸不完整）`
      : `分析完成：共 ${stats.n} 个${noun}（已排除 ${edgeN} 个接触边界的）`;
  } catch (e) {
    status.style.color = "var(--bad)";
    const msg = (e && e.message) ? e.message : String(e);
    status.textContent = "分析出错：" + msg;
  } finally {
    if (s) {
      try { if (dst) dst.delete(); } catch (_) {}
      try { s.src.delete(); } catch (_) {}
      try { s.gray.delete(); } catch (_) {}
      try { s.thresh.delete(); } catch (_) {}
      try { if (s.kernel) s.kernel.delete(); } catch (_) {}
      try { if (s.regionMask && s.regionMask !== s.thresh) s.regionMask.delete(); } catch (_) {}
      try { if (s.markers) s.markers.delete(); } catch (_) {}
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
    const fer = (r.minFeret && r.maxFeret)
      ? `${fmt(r.minFeret)}–${fmt(r.maxFeret)}` : "–";
    const sol = (typeof r.solidity === "number") ? r.solidity.toFixed(2) : "–";
    tr.innerHTML = `<td>${i + 1}</td><td>${fmt(r.d)} ${unit}</td>`
      + `<td>${fmt(r.area)} ${unit}²</td><td>${r.circ.toFixed(2)}</td>`
      + `<td>${fer}</td><td>${sol}</td>`;
    tbody.appendChild(tr);
  }
  if (sorted.length > limit) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="6" style="color:var(--text-dim)">…仅显示前 ${limit} 条，完整数据见 CSV 导出</td>`;
    tbody.appendChild(tr);
  }
  $("tableBlock").hidden = false;
}

/* ---------- 导出 CSV ---------- */
function exportCsv() {
  if (!lastResults) return;
  const { diameters, unit, rows, stats, fit, isGrain } = lastResults;
  const noun = isGrain ? "晶粒" : "颗粒";
  const fmt = (v) => (v >= 100 ? v.toFixed(1) : v.toFixed(3));
  let csv = "AI 粒径分析结果\n";
  csv += "指标,值\n";
  csv += `${noun}数,${stats.n}\n`;
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
  csv += `\n${noun}明细\n序号,直径(${unit}),面积(${unit}^2),圆度,`
    + `最小Feret(${unit}),最大Feret(${unit}),实心度,质心X,质心Y,接触边界\n`;
  const sorted = rows.slice().sort((a, b) => b.d - a.d);
  sorted.forEach((r, i) => {
    const mn = (typeof r.minFeret === "number") ? fmt(r.minFeret) : "";
    const mx = (typeof r.maxFeret === "number") ? fmt(r.maxFeret) : "";
    const sol = (typeof r.solidity === "number") ? r.solidity.toFixed(3) : "";
    csv += `${i + 1},${fmt(r.d)},${fmt(r.area)},${r.circ.toFixed(3)},`
      + `${mn},${mx},${sol},${r.cx},${r.cy},${r.edgeGrain ? "是" : ""}\n`;
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

/* ---------- 打印 / 导出 PDF 报告 ---------- */
function exportReport() {
  if (!lastResults || !lastResults.fit) return;
  const { diameters, unit, rows, stats, fit, isGrain } = lastResults;
  const noun = isGrain ? "晶粒" : "颗粒";
  const fmt = (v) => (v >= 100 ? v.toFixed(1) : v.toFixed(3));
  const histData = $("hist").toDataURL("image/png");
  const p = readParams();
  const now = new Date().toLocaleString();
  const rowsSorted = rows.slice().sort((a, b) => b.d - a.d).slice(0, 50);
  const tblRows = rowsSorted.map((r, i) =>
    `<tr><td>${i + 1}</td><td>${fmt(r.d)} ${unit}</td><td>${fmt(r.area)} ${unit}²</td>`
    + `<td>${r.circ.toFixed(3)}</td>`
    + `<td>${(typeof r.minFeret === "number") ? fmt(r.minFeret) : "–"}</td>`
    + `<td>${(typeof r.maxFeret === "number") ? fmt(r.maxFeret) : "–"}</td>`
    + `<td>${(typeof r.solidity === "number") ? r.solidity.toFixed(3) : "–"}</td></tr>`
  ).join("");
  const w = window.open("", "_blank");
  if (!w) { alert("请允许弹出窗口以生成报告。"); return; }
  w.document.write(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"/>
<title>粒径分析报告</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: Arial, "Microsoft YaHei", sans-serif; color:#111; margin:32px; }
  h1 { font-size:20px; margin:0 0 4px; }
  .sub { color:#666; font-size:12px; margin-bottom:18px; }
  .card { border:1px solid #ddd; border-radius:10px; padding:16px 18px; margin-bottom:18px; }
  .kv { display:grid; grid-template-columns:repeat(4,1fr); gap:10px 18px; }
  .kv div { font-size:13px; }
  .kv b { display:block; color:#0a7; font-size:15px; font-weight:600; }
  .sec-title { font-size:14px; font-weight:600; margin:0 0 10px; }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  th,td { border:1px solid #e2e2e2; padding:5px 8px; text-align:right; }
  th { background:#f5f5f5; }
  img.hist { width:100%; max-width:560px; border:1px solid #e2e2e2; border-radius:8px; }
  @media print { body { margin:12mm; } .noprint { display:none; } }
  .btn { margin-top:10px; padding:8px 16px; border:1px solid #0a7; background:#0a7; color:#fff; border-radius:8px; cursor:pointer; }
</style></head>
<body>
  <h1>${isGrain ? "AI 晶粒尺寸分析报告" : "AI 粒径分析报告"}</h1>
  <div class="sub">生成时间：${now} ｜ ${noun}数：${stats.n} ｜ 单位：${unit} ｜ 分割方式：${isGrain ? "晶粒模式(梯度晶界+分水岭)" : "阈值分割"} ｜ 标尺校准：${p.calibrated ? "已标定" : "未标定(像素)"}</div>
  <div class="card">
    <p class="sec-title">统计汇总</p>
    <div class="kv">
      <div>平均直径<b>${fmt(stats.mean)} ${unit}</b></div>
      <div>中位 D50<b>${fmt(stats.median)} ${unit}</b></div>
      <div>D10<b>${fmt(stats.d10)} ${unit}</b></div>
      <div>D90<b>${fmt(stats.d90)} ${unit}</b></div>
      <div>不均匀度 Cu<b>${stats.cu.toFixed(3)}</b></div>
      <div>曲率 Cc<b>${stats.cc.toFixed(3)}</b></div>
      <div>跨度 Span<b>${stats.span.toFixed(3)}</b></div>
      <div>几何均值 dg<b>${fmt(fit.dg)} ${unit}</b></div>
    </div>
  </div>
  <div class="card">
    <p class="sec-title">粒径分布（对数正态拟合）</p>
    <img class="hist" src="${histData}" />
    <p style="font-size:12px;color:#555">${fit.degenerate ? "（单值分布，拟合不适用）" : `Log-normal fit: d_g=${fmt(fit.dg)} ${unit}, σ_g=${fit.sg.toFixed(2)}`}</p>
  </div>
  <div class="card">
    <p class="sec-title">${noun}明细（前 50 条，完整见 CSV）</p>
    <table><thead><tr><th>#</th><th>直径</th><th>面积</th><th>圆度</th><th>最小Feret</th><th>最大Feret</th><th>实心度</th></tr></thead><tbody>${tblRows}</tbody></table>
  </div>
  <button class="btn noprint" onclick="window.print()">打印 / 另存为 PDF</button>
</body></html>`);
  w.document.close();
}

/* ---------- 把粒径分布发送到图表生成器（两工具数据互通） ---------- */
function sendToChart() {
  if (!lastResults || !lastResults.diameters || !lastResults.diameters.length) {
    alert("请先完成一次分析，再发送到图表生成器。");
    return;
  }
  const unit = lastResults.unit;
  const values = lastResults.diameters;
  const n = values.length;
  const min = Math.min(...values), max = Math.max(...values);
  const range = (max - min) || 1;
  const bins = Math.min(28, Math.max(8, Math.round(Math.sqrt(n))));
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
  let text = `# 粒径分布（来自 AI 粒径分析，单位 ${unit}）\n`;
  text += `Distribution, Diameter(${unit}), Frequency(%)\n`;
  for (let i = 0; i < bins; i++) {
    const f = (counts[i] / n) * 100;
    text += `Distribution, ${centers[i].toFixed(3)}, ${f.toFixed(2)}\n`;
  }
  try {
    localStorage.setItem("lw_chart_seed", JSON.stringify({
      text, type: "line", xTitle: `Diameter (${unit})`, yTitle: "Frequency (%)"
    }));
  } catch (e) { /* ignore */ }
  window.open("../research-charts/?from=particle", "_blank");
}

/* ---------- 实时预览 (拖动参数时彩色高亮被选中晶粒) ---------- */
function schedulePreview() {
  if (!imgLoaded) return;
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(runPreview, 50);
}
function schedulePreviewImmediate() {
  if (!imgLoaded) return;
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(runPreview, 0);
}
async function runPreview() {
  if (previewRunning) { previewPending = true; return; }
  previewRunning = true;
  $("previewBadge").textContent = "预览更新中…";
  $("previewBadge").hidden = false;
  let s = null, dst = null;
  try {
    await waitCv();
    const p = readParams();
    s = await segment(p);
    if (s.diametersPx.length > 0) {
      dst = s.src.clone();
      drawContoursColored(dst, s.contours, s.keptIdx, s.diametersPx, s.dMin, s.dMax, p.colorMode, s.labels, p.fill, s.src);
      cv.imshow(dstCanvas, dst);
      $("previewBadge").textContent = `预览 ${s.diametersPx.length} 颗`;
      $("previewBadge").hidden = false;
    } else {
      // 无颗粒时也要刷新画面，避免旧图/旧 badge 误导
      cv.imshow(dstCanvas, s.src);
      const ctx = dstCanvas.getContext("2d");
      ctx.fillStyle = "rgba(10,13,20,0.55)";
      ctx.fillRect(0, 0, dstCanvas.width, dstCanvas.height);
      const fs = Math.max(14, Math.floor(dstCanvas.width / 30));
      ctx.fillStyle = "#fb7185";
      ctx.font = `${fs}px Arial, sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("未检测到颗粒", dstCanvas.width / 2, dstCanvas.height / 2 - fs * 0.6);
      ctx.fillStyle = "#8b97ad";
      ctx.font = `${Math.max(12, Math.floor(fs * 0.75))}px Arial, sans-serif`;
      ctx.fillText("请调低 最小颗粒面积 / 最小圆度，或切换颗粒明暗", dstCanvas.width / 2, dstCanvas.height / 2 + fs * 0.8);
      $("previewBadge").textContent = "未检测到";
      $("previewBadge").hidden = false;
    }
  } catch (e) {
    // 预览失败不影响主流程，但记录日志便于排查
    // eslint-disable-next-line no-console
    console.error("Preview error:", e && e.message ? e.message : e);
  } finally {
    if (s) {
      try { if (dst) dst.delete(); } catch (_) {}
      try { s.src.delete(); } catch (_) {}
      try { s.gray.delete(); } catch (_) {}
      try { s.thresh.delete(); } catch (_) {}
      try { if (s.kernel) s.kernel.delete(); } catch (_) {}
      try { if (s.regionMask && s.regionMask !== s.thresh) s.regionMask.delete(); } catch (_) {}
      try { if (s.markers) s.markers.delete(); } catch (_) {}
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
  const calPx = +$("calpx").value, calLen = +$("calLen").value;
  let txt = `${len.toFixed(0)} px`;
  if (calPx > 0 && calLen > 0) {
    const real = (calLen * len) / calPx;
    txt = `${real.toFixed(2)} ${$("calUnit").value}  (${len.toFixed(0)} px)`;
  }
  ctx.fillText(txt, mx, my - tk - 2);
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
  $("expPdf").addEventListener("click", exportReport);
  $("sendChart").addEventListener("click", sendToChart);
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
  // 按分割方式显隐相关参数: 晶粒模式与阈值模式的可调项完全不同,
  // 把无关控件藏起来, 免得用户去调一个对当前模式毫无影响的滑块。
  let grainPresetDone = false;
  const syncModeUI = () => {
    const m = $("mode").value;
    const grain = m === "grain";
    $("manualWrap").hidden = m !== "manual";
    $("blockWrap").hidden = m !== "adaptive";
    if ($("grainWrap")) $("grainWrap").hidden = !grain;
    if ($("kernWrap")) $("kernWrap").hidden = grain;
    if ($("polarWrap")) $("polarWrap").hidden = grain;
    if ($("wsWrap")) $("wsWrap").hidden = grain;
    // 首次进入晶粒模式时给一组贴合致密晶粒的预设; 用户改过之后不再覆盖
    if (grain && !grainPresetDone) {
      const ma = $("minarea");
      if (+ma.value < 150) { ma.value = "150"; $("minVal").textContent = "150"; }
      const ci = $("circ");
      if (+ci.value > 0.30) { ci.value = "0.30"; $("cirVal").textContent = "0.30"; }
      grainPresetDone = true;
    }
  };
  $("mode").addEventListener("change", () => {
    syncModeUI();
    schedulePreviewImmediate();
  });
  syncModeUI();
  const bindRange = (id, labelId) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener("input", () => {
      if (labelId && $(labelId)) $(labelId).textContent = el.value;
      schedulePreview();
    });
  };
  bindRange("edgePct", "edgeVal");
  bindRange("dilateW", "dilVal");
  bindRange("grainMinSeed", "gseedVal");
  $("thr").addEventListener("input", () => { $("thrVal").textContent = $("thr").value; schedulePreview(); });
  $("thr").addEventListener("change", schedulePreviewImmediate);
  $("blk").addEventListener("input", () => { $("blkVal").textContent = $("blk").value; schedulePreview(); });
  $("blk").addEventListener("change", schedulePreviewImmediate);
  $("kern").addEventListener("input", () => { $("kVal").textContent = $("kern").value; schedulePreview(); });
  $("kern").addEventListener("change", schedulePreviewImmediate);
  $("minarea").addEventListener("input", () => { $("minVal").textContent = $("minarea").value; schedulePreview(); });
  $("minarea").addEventListener("change", schedulePreviewImmediate);
  $("circ").addEventListener("input", () => { $("cirVal").textContent = (+$("circ").value).toFixed(2); schedulePreview(); });
  $("circ").addEventListener("change", schedulePreviewImmediate);
  document.querySelectorAll('input[name="polar"]').forEach((r) =>
    r.addEventListener("change", schedulePreviewImmediate)
  );
  $("ws").addEventListener("change", schedulePreviewImmediate);
  $("colorMode").addEventListener("change", schedulePreviewImmediate);
  $("blur").addEventListener("change", schedulePreviewImmediate);
  $("fill").addEventListener("change", schedulePreviewImmediate);
  if ($("keepEdge")) $("keepEdge").addEventListener("change", schedulePreviewImmediate);

  // 标尺校准
  $("calpx").addEventListener("input", () => { $("calPxVal").textContent = $("calpx").value; updateScaleInfo(); drawScaleOverlay(); applyCalibration(); });
  $("calLen").addEventListener("input", () => { updateScaleInfo(); drawScaleOverlay(); applyCalibration(); });
  $("calUnit").addEventListener("change", () => { updateScaleInfo(); drawScaleOverlay(); applyCalibration(); });

  bindScale();
}

function updateScaleInfo() {
  const calPx = +$("calpx").value;
  const calLen = +$("calLen").value;
  const unit = $("calUnit").value;
  if (calPx > 0 && calLen > 0) {
    const perPx = calLen / calPx;
    $("scaleInfo").textContent = `✅ 已标定：1 px ≈ ${perPx.toFixed(4)} ${unit}（或 1 ${unit} ≈ ${(calPx / calLen).toFixed(2)} px），可进行分割调节与正式分析。`;
  } else {
    $("scaleInfo").textContent = "⚠️ 请先在图上拖线标出已知长度，并在右侧输入对应真实长度 / 单位，再进行分析。";
  }
}

/* ---------- 校准变更后实时重算结果 (无需重新"分析") ---------- */
function applyCalibration() {
  if (!lastResults || !lastResults.px || lastResults.px.length === 0) return;
  const p = readParams();
  const diameters = lastResults.px.map((d) => d * p.unitPerPx);
  const rowsUnit = lastResults.rowsPx.map((r) => ({
    d: r.dPx * p.unitPerPx,
    area: r.areaPx * p.unitPerPx * p.unitPerPx,
    circ: r.circ, cx: r.cx, cy: r.cy,
    minFeret: (r.minFeretPx || 0) * p.unitPerPx,
    maxFeret: (r.maxFeretPx || 0) * p.unitPerPx,
    solidity: (typeof r.solidity === "number") ? r.solidity : null,
    edgeGrain: !!r.edgeGrain,
  }));
  const stats = computeStats(diameters);
  if (!stats) return;
  renderStats(stats, p.unitLabel);
  const fit = lognormalFit(diameters);
  lastResults = { ...lastResults, diameters, unit: p.unitLabel, rows: rowsUnit, stats, fit };
  renderHistogram($("hist"), { values: diameters, unit: p.unitLabel, marks: { d10: stats.d10, d50: stats.d50, d90: stats.d90 }, fit });
  renderHistogramFitInfo(fit, p.unitLabel);
  renderTable(rowsUnit, p.unitLabel);
  $("chartBlock").hidden = false;
  $("tableBlock").hidden = false;
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
