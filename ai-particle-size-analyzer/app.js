/* ============================================================
 * AI 粒径分析 —— 浏览器端核心逻辑 (OpenCV.js / wasm)
 * 流程: 灰度 -> 阈值分割 -> 形态学去噪 -> 连通域 -> 粒径统计
 * 图像全程在本地处理，不上传服务器。
 * 借鉴思路: Microsphere Size Analyzer (传统CV), ParticleAnalyzer (统计指标)
 * ============================================================ */

const $ = (id) => document.getElementById(id);

let srcCanvas = $("src");
let dstCanvas = $("dst");
// 每次预览/分析都要把源画布整块读回内存交给 OpenCV，声明 willReadFrequently
// 让浏览器把画布放在 CPU 内存里，省掉 GPU->CPU 的来回拷贝。
// 注意: 同一画布的 2D 上下文属性只在第一次 getContext 时生效, 所以要在这里先取。
const srcCtx = srcCanvas.getContext("2d", { willReadFrequently: true });
let imgLoaded = false;
let srcScale = 1;                 // 工作分辨率 / 原图分辨率
let srcOrigSize = null;           // { w, h } 原图尺寸
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
/* ---------- 图像载入到工作画布 ----------
 * 工作分辨率上限。
 * 曾经硬编码 MAX=1200，导致 2048×1536 / 4096×3072 这类常见 SEM 图被静默降采样：
 * 3px 晶界被双线性模糊成 1.2px，晶粒内部连通域面积从 ~3000px² 掉到 ~480px²，
 * 而 grainMinSeed 是固定像素阈值，于是半数晶粒被当作"过小种子"丢弃
 * （实测 3000×2250 图：真值 2250 颗，只检出 1075 颗 = 47.8%，界面却显示"分析完成"）。
 * 全分辨率下同一张图检出 2249/2250 = 100%，耗时仅从 224ms 涨到 748ms，
 * 所以这里放宽上限，超大图才按总像素封顶，并且必须把缩放比显式告诉用户。 */
const MAX_DIM = 4000;      // 单边上限 px
const MAX_PIXELS = 12e6;   // 总像素上限（约 12MP，再大则按比例缩）

function drawToSrc(img) {
  const ow = img.naturalWidth || img.width;
  const oh = img.naturalHeight || img.height;
  let r = Math.min(1, MAX_DIM / Math.max(ow, oh));
  if (ow * oh * r * r > MAX_PIXELS) r = Math.sqrt(MAX_PIXELS / (ow * oh));
  const w = Math.max(1, Math.round(ow * r));
  const h = Math.max(1, Math.round(oh * r));
  srcCanvas.width = w;
  srcCanvas.height = h;
  dstCanvas.width = w;
  dstCanvas.height = h;
  const ctx = srcCtx;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  imgLoaded = true;
  srcScale = r;
  srcOrigSize = { w: ow, h: oh };
  $("imgMeta").classList.remove("meta-warn");
  if (r >= 0.999) {
    $("imgMeta").textContent = `原图 ${ow} × ${oh} px → 分析分辨率 ${w} × ${h} px（未降采样）`;
  } else {
    $("imgMeta").textContent = `原图 ${ow} × ${oh} px → 分析分辨率 ${w} × ${h} px`
      + `（已降采样至 ${(r * 100).toFixed(0)}%；晶界很细的样品建议先裁剪 ROI 再分析，否则可能漏检小晶粒）`;
    $("imgMeta").classList.add("meta-warn");
  }
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
  figureGray = null; figurePanels = null; lastBatch = null;
  $("batchBlock").hidden = true;
  detectFigureIfComposite();
  syncOverlay();
  schedulePreview();
}

/* 论文拼图检测: 只有当"白色分隔条把图切成 >=2 块"时才认定为拼图 */
function detectFigureIfComposite() {
  // OpenCV 还没就绪时先不检测, 等就绪后由 initImgAnalysis 补上
  if (!(window.cv && window.cv.imread)) return;
  try {
    const src = cv.imread(srcCanvas);
    const gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    const panels = detectFigurePanels(gray);
    if (!panels) {
      figureGray = null; figurePanels = null;
      $("figureBlock").hidden = true;
      gray.delete(); src.delete();
      return;
    }
    figureGray = gray;
    src.delete();
    for (const r of panels) r.bar = detectScaleBar(figureGray, r);
    figurePanels = panels;
    panelIndex = 0;
    renderPanelChips();
  } catch (e) {
    figureGray = null; figurePanels = null;
    $("figureBlock").hidden = true;
  }
}

const PANEL_NAMES = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];

function renderPanelChips() {
  const box = $("panelChips");
  box.innerHTML = "";
  figurePanels.forEach((r, i) => {
    const b = document.createElement("button");
    b.className = "panel-chip" + (i === panelIndex ? " active" : "");
    b.textContent = `子图 ${PANEL_NAMES[i] || (i + 1)}`;
    b.addEventListener("click", () => { selectPanel(i); });
    box.appendChild(b);
  });
  const found = figurePanels.filter((r) => r.bar);
  let info = `识别到 ${figurePanels.length} 个子图，尺寸约 ${figurePanels[0].w}×${figurePanels[0].h} px。`;
  if (found.length === figurePanels.length) {
    const ws = found.map((r) => r.bar.widthPx);
    const mean = ws.reduce((s, v) => s + v, 0) / ws.length;
    const sd = Math.sqrt(ws.reduce((s, v) => s + (v - mean) ** 2, 0) / ws.length);
    info += ` ${figurePanels.length} 个子图都找到了比例尺白板，平均 ${mean.toFixed(1)} px`
      + `（子图间离散 ${(100 * sd / mean).toFixed(1)}% → 标定不确定度约 ±${(50 * sd / mean).toFixed(1)}%）。`;
  } else {
    info += ` 仅在 ${found.length} 个子图里找到比例尺白板，未找到的子图需要手动标定。`;
  }
  info += " 顶部文字带与右下角标尺已自动屏蔽，不参与分割。";
  $("figureInfo").textContent = info;
  $("figureBlock").hidden = false;
}

function selectPanel(i) {
  panelIndex = i;
  renderPanelChips();
  $("previewBadge").hidden = true;
  schedulePreviewImmediate();
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

/* ---------- 生成示例图（无需准备图片即可体验） ----------
 * 两张，分别对应两种分割方式：
 *   loadSampleGrain()   致密烧结晶粒（晶粒紧贴、暗晶界）→ 晶粒模式（默认）
 *   loadSamplePowder()  分散粉末（颗粒之间有背景）    → 阈值模式
 * 之前只有一个"分散粉末"示例，而默认模式已改成晶粒模式，
 * 用户点示例会得到与默认模式不匹配的结果。 */
function ctxImageData(w, h) {
  return srcCtx.createImageData(w, h);
}

/* 载入自绘示例图到工作画布 */
function drawSampleCanvas(w, h, paint, note) {
  srcCanvas.width = w; srcCanvas.height = h;
  dstCanvas.width = w; dstCanvas.height = h;
  const ctx = srcCtx;
  ctx.clearRect(0, 0, w, h);
  paint(ctx);
  imgLoaded = true;
  srcScale = 1;
  srcOrigSize = { w, h };
  $("imgMeta").classList.remove("meta-warn");
  $("imgMeta").textContent = `示例图像 ${w} × ${h} px（${note}）`;
  $("run").disabled = false;
  $("status").textContent = "";
  $("stats").hidden = true;
  $("chartBlock").hidden = true;
  $("tableBlock").hidden = true;
  $("previewBadge").hidden = true;
  $("fitInfo").hidden = true;
  scaleLine = null; drawEnd = null;
  figureGray = null; figurePanels = null; lastBatch = null;
  $("batchBlock").hidden = true;
  $("figureBlock").hidden = true;
  syncOverlay();
  schedulePreview();
}

/* 固定种子的伪随机：保证每次载入的示例图完全一致，便于对照与复现 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* 致密烧结晶粒：Voronoi 多边形 + 取向衬度 + 暗晶界，贴近抛光热腐蚀后的 SEM 断面 */
function loadSampleGrain() {
  const w = 720, h = 480, n = 150;
  const rnd = mulberry32(20261003);
  const sx = [], sy = [];
  for (let i = 0; i < n; i++) { sx.push(rnd() * w); sy.push(rnd() * h); }

  // 逐像素取最近种子 -> Voronoi 标号图
  const lab = new Int32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let best = 0, bd = Infinity;
      for (let i = 0; i < n; i++) {
        const dx = x - sx[i], dy = y - sy[i];
        const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = i; }
      }
      lab[y * w + x] = best;
    }
  }

  // 每个晶粒一个取向衬度灰度（SEM 中不同取向的背散射强度不同）
  const tone = new Float32Array(n), gx = new Float32Array(n), gy = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    tone[i] = 118 + rnd() * 92;
    gx[i] = rnd() * 2 - 1;
    gy[i] = rnd() * 2 - 1;
  }

  const img = ctxImageData(w, h);
  const d = img.data;
  const B = 2;   // 晶界半宽（px）——真实 SEM 晶界是有宽度的暗线，不是 1px 硬边
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = lab[y * w + x];
      // 晶粒内部轻微亮度梯度（取向衬度起伏）
      let v = tone[i] + gx[i] * (x / w - 0.5) * 16 + gy[i] * (y / h - 0.5) * 16;
      // 晶界：与 2px 内的邻居标号不同 -> 压暗
      let isEdge = false;
      for (let k = 1; k <= B && !isEdge; k++) {
        if ((x + k < w && lab[y * w + x + k] !== i)
          || (x - k >= 0 && lab[y * w + x - k] !== i)
          || (y + k < h && lab[(y + k) * w + x] !== i)
          || (y - k >= 0 && lab[(y - k) * w + x] !== i)) isEdge = true;
      }
      if (isEdge) v = 62 + rnd() * 16;
      v += (rnd() - 0.5) * 11;   // 高频噪声
      const p = (y * w + x) * 4;
      const g = v < 0 ? 0 : v > 255 ? 255 : v | 0;
      d[p] = g; d[p + 1] = g; d[p + 2] = g; d[p + 3] = 255;
    }
  }
  drawSampleCanvas(w, h, (ctx) => ctx.putImageData(img, 0, 0), "模拟致密烧结陶瓷 SEM，晶粒紧贴");
}

/* 分散粉末：颗粒之间有背景，适用阈值模式。
 * 颗粒数与半径经过标定：先前 120 颗 / 半径上限 38 px 会让颗粒大量粘连
 * （Otsu + 连通域只剩 57 块，其中大半因圆度不足被正确剔除，只剩 20 颗），
 * 演示效果很差。现取 72 颗、半径 5~21 px，保证绝大多数颗粒彼此分离。 */
function loadSamplePowder() {
  const w = 640, h = 420, n = 72;
  const rnd = mulberry32(20261004);
  const img = ctxImageData(w, h);
  const d = img.data;
  for (let i = 0; i < w * h; i++) {          // 暗背景 + 噪声
    const g = 12 + rnd() * 10;
    const p = i * 4;
    d[p] = g; d[p + 1] = g; d[p + 2] = g + 4; d[p + 3] = 255;
  }
  const placed = [];                          // 拒绝采样，保证颗粒互不粘连
  let guard = 0;
  while (placed.length < n && guard++ < 4000) {
    const rad = 5 + Math.pow(rnd(), 2.0) * 16;
    const cx = rad + rnd() * (w - 2 * rad);
    const cy = rad + rnd() * (h - 2 * rad);
    let ok = true;
    for (const q of placed) {
      const dx = q.x - cx, dy = q.y - cy;
      if (dx * dx + dy * dy < (q.r + rad + 3) * (q.r + rad + 3)) { ok = false; break; }
    }
    if (!ok) continue;
    placed.push({ x: cx, y: cy, r: rad, g: 185 + rnd() * 60 });
  }
  for (const c of placed) {
    const x0 = Math.max(0, Math.floor(c.x - c.r)), x1 = Math.min(w - 1, Math.ceil(c.x + c.r));
    const y0 = Math.max(0, Math.floor(c.y - c.r)), y1 = Math.min(h - 1, Math.ceil(c.y + c.r));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - c.x, dy = y - c.y;
        if (dx * dx + dy * dy > c.r * c.r) continue;
        const p = (y * w + x) * 4;
        const g = Math.min(255, c.g + (rnd() - 0.5) * 14) | 0;
        d[p] = g; d[p + 1] = Math.max(0, g - 20); d[p + 2] = Math.max(0, g - 60);
      }
    }
  }
  drawSampleCanvas(w, h, (ctx) => ctx.putImageData(img, 0, 0),
    `模拟分散粉末 SEM，颗粒间有背景（实际绘出 ${placed.length} 颗）`);
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
  const thrPct = $("thrPct") ? +$("thrPct").value : 65;
  const block = +$("blk").value;
  const kern = +$("kern").value;
  const minArea = +$("minarea").value;
  const minCirc = +$("circ").value;
  const polar = document.querySelector('input[name="polar"]:checked').value; // bright | dark
  const calPx = +$("calpx").value;
  const calLen = +$("calLen").value;
  const calUnit = $("calUnit").value;
  // 拼图模式: 若当前子图找到了比例尺白板, 直接用自动标定的比例, 优先于手动输入
  const autoUm = panelUmPerPx();
  const useAuto = autoUm !== null;
  const effPx = useAuto ? 1 : calPx;
  const effLen = useAuto ? autoUm : calLen;
  const effUnit = useAuto ? "um" : calUnit;
  const calOkay = effPx > 0 && effLen > 0 && !Number.isNaN(effLen);
  const calibrated = effUnit !== "px" && calOkay;
  const unitPerPx = calibrated ? (effLen / effPx) : 1;
  const unitLabel = calibrated ? effUnit : "px";
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
    mode, thr, thrPct, block, kern, minArea, minCirc, effMinCirc, polar,
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
  const n = rows * cols;
  // 只处理"空洞"像素(<=0), 避免每轮都全图扫描+整块拷贝。
  // 6.75MP 图上原实现要 3 次全图扫描, 这里降为只扫空洞(晶界像素约占 3~5%)。
  let holes = [];
  for (let i = 0; i < n; i++) if (d[i] <= 0) holes.push(i);
  const copy = new Int32Array(n);
  for (let it = 0; it < iters && holes.length; it++) {
    copy.set(d);
    const next = [];
    for (const i of holes) {
      const y = (i / cols) | 0, x = i - y * cols;
      const y0 = y > 0 ? y - 1 : 0, y1 = y < rows - 1 ? y + 1 : rows - 1;
      const x0 = x > 0 ? x - 1 : 0, x1 = x < cols - 1 ? x + 1 : cols - 1;
      let best = 0;
      for (let yy = y0; yy <= y1; yy++) {
        const r2 = yy * cols;
        for (let xx = x0; xx <= x1; xx++) {
          const v = copy[r2 + xx];
          if (v > best) best = v;
        }
      }
      if (best > 0) d[i] = best; else next.push(i);
    }
    if (next.length === holes.length) break;   // 一轮下来没有任何变化, 提前结束
    holes = next;
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
function extractByLabel(labelMat, p, W, H, out, skipLabel) {
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
    if (v === skipLabel) continue;                 // 背景标签不是颗粒
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
/* ---------- 论文插图模式: 多子图拆分 + 标尺自动识别 + 文字屏蔽 ----------
 * 论文里的 SEM 拼图通常是 2×2 / 1×N 版式, 子图之间有白色分隔条,
 * 每张子图左上角有 "(a)"、右上角有 "S.T=xxx℃", 右下角有比例尺白板与 "20μm"。
 * 这些都是后期叠加的标注, 不属于显微组织, 直接参与分割会污染结果, 所以要:
 *   ① 按分隔条拆出子图   ② 定位并屏蔽标注区   ③ 亚像素测出标尺像素宽度 -> 自动标定
 * 其中标尺必须用"半高插值"而不是阈值法: 标尺白板是饱和平台(灰度 241~255),
 * 阈值法会把边缘的 JPEG 振铃算进去, 四个子图之间能差出 10%。 */
let figureGray = null;      // 整图灰度 Mat(缓存)
let figurePanels = null;   // [{x,y,w,h,bar}] 或 null(非拼图)
let panelIndex = 0;
let lastBatch = null;      // [{i,name,barPx,umPerPx,stats,...}]

function longestSpan(arr, n) {
  let best = null, cur = -1;
  for (let i = 0; i <= n; i++) {
    if (i < n && arr[i]) { if (cur < 0) cur = i; }
    else if (cur >= 0) { if (!best || i - 1 - cur > best[1] - best[0]) best = [cur, i - 1]; cur = -1; }
  }
  return best;
}

function detectFigurePanels(gray) {
  const H = gray.rows, W = gray.cols, d = gray.data;
  const rowHit = new Uint8Array(H), colHit = new Uint8Array(W);
  for (let y = 0; y < H; y++) {
    const off = y * W; let c = 0;
    for (let x = 0; x < W; x++) if (d[off + x] > 235) c++;
    if (c / W > 0.5) rowHit[y] = 1;
  }
  for (let x = 0; x < W; x++) {
    let c = 0;
    for (let y = 0; y < H; y++) if (d[y * W + x] > 235) c++;
    if (c / H > 0.5) colHit[x] = 1;
  }
  const rs = longestSpan(rowHit, H), cs = longestSpan(colHit, W);
  if (!rs && !cs) return null;
  const yBands = rs ? [[0, rs[0]], [rs[1] + 1, H]] : [[0, H]];
  const xBands = cs ? [[0, cs[0]], [cs[1] + 1, W]] : [[0, W]];
  const rects = [];
  for (const [y0, y1] of yBands) {
    for (const [x0, x1] of xBands) {
      if (y1 - y0 < 120 || x1 - x0 < 120) continue;
      rects.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    }
  }
  return rects.length >= 2 ? rects : null;
}

/* 在子图内找右下角的标尺白板, 并用半高插值亚像素定边 */
function detectScaleBar(gray, rect) {
  const d = gray.data, cols = gray.cols;
  const H = rect.h, W = rect.w;
  let best = null;
  for (let y = Math.floor(H * 0.55); y < H; y++) {
    const off = (rect.y + y) * cols + rect.x;
    let run = 0, bRun = 0, bStart = 0, cStart = 0;
    for (let x = 0; x < W; x++) {
      if (d[off + x] > 232) {
        if (run === 0) cStart = x;
        run++;
        if (run > bRun) { bRun = run; bStart = cStart; }
      } else run = 0;
    }
    if (bRun >= 80 && (!best || bRun > best.len)) best = { row: y, x0: bStart, len: bRun };
  }
  if (!best) return null;
  // 取"白板 ±45px"的亮度剖面
  const xa = Math.max(0, best.x0 - 45), xb = Math.min(W, best.x0 + best.len + 45);
  const ya = Math.max(0, best.row - 3), yb = Math.min(H, best.row + 17);
  const n = xb - xa;
  if (n < 60) return null;
  const prof = new Float32Array(n);
  for (let x = 0; x < n; x++) {
    let s = 0;
    for (let y = ya; y < yb; y++) s += d[(rect.y + y) * cols + rect.x + xa + x];
    prof[x] = s / (yb - ya);
  }
  const edge = [];
  for (let x = 0; x < 25; x++) edge.push(prof[x], prof[n - 1 - x]);
  edge.sort((a, b) => a - b);
  const bg = edge[Math.floor(edge.length / 2)];
  const pa = Math.max(0, best.x0 - xa - 10), pb = Math.min(n, best.x0 - xa + best.len + 10);
  const plat = Array.from(prof.slice(pa, pb)).sort((a, b) => a - b);
  const peak = plat[Math.floor(plat.length * 0.75)];
  if (peak - bg < 40) return null;
  const half = bg + 0.5 * (peak - bg);
  let L = best.x0 - xa - 1;
  while (L > 0 && prof[L] > half) L--;
  const tL = (prof[L + 1] - half) / ((prof[L + 1] - prof[L]) || 1);
  const leftPx = L + tL;
  let R = best.x0 - xa + best.len;
  while (R < n - 1 && prof[R] > half) R++;
  const tR = (half - prof[R - 1]) / ((prof[R] - prof[R - 1]) || 1);
  const rightPx = R - 1 + tR;
  return {
    rowAbs: rect.y + best.row,
    leftAbs: rect.x + xa + leftPx,
    rightAbs: rect.x + xa + rightPx,
    widthPx: rightPx - leftPx,
  };
}

/* 标注屏蔽区: 顶部文字带 + 右下角标尺(含 "20µm" 文字) */
function buildValidMask(rect, bar) {
  const W = rect.w, H = rect.h;
  const m = new Uint8Array(W * H);
  const top = Math.floor(H * 0.16);
  for (let y = 0; y < top; y++) m.fill(1, y * W, y * W + W);
  if (bar) {
    // 注意必须取整: 标尺边界是亚像素浮点数(如 621.16), 直接拿它当 Uint8Array
    // 下标会因非整数索引而静默失效, 屏蔽区会一个像素都没盖上。
    const y0 = Math.max(0, Math.floor(bar.rowAbs - rect.y - 75));
    const y1 = Math.min(H, Math.ceil(bar.rowAbs - rect.y + 30));
    const x0 = Math.max(0, Math.floor(bar.leftAbs - rect.x - 40));
    const x1 = Math.min(W, Math.ceil(bar.rightAbs - rect.x + 40));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * W + x] = 1;
  }
  return m;
}

/* 标注区填成有效区的平均灰, 既不制造假边界, 也不改变整体灰度分布 */
function applyValidMask(gray, mask) {
  const d = gray.data, n = gray.rows * gray.cols;
  let s = 0, c = 0;
  for (let i = 0; i < n; i++) if (!mask[i]) { s += d[i]; c++; }
  const mean = c ? s / c : 128;
  for (let i = 0; i < n; i++) if (mask[i]) d[i] = mean;
}

/* 取子图并转成 RGBA Mat(与整图 imread 同构), 供 segment 复用 */
function panelMat(rect, mask) {
  const g = new cv.Mat(rect.h, rect.w, cv.CV_8UC1);
  const src = figureGray.data, cols = figureGray.cols;
  const dst = g.data;
  for (let y = 0; y < rect.h; y++) {
    const so = (rect.y + y) * cols + rect.x;
    dst.set(src.subarray(so, so + rect.w), y * rect.w);
  }
  applyValidMask(g, mask);
  const rgba = new cv.Mat();
  cv.cvtColor(g, rgba, cv.COLOR_GRAY2RGBA);
  g.delete();
  return rgba;
}

function currentPanel() {
  return figurePanels ? figurePanels[panelIndex] : null;
}

/* 当前视图的标定比例(µm/px); 非拼图或未检出标尺时返回 null */
function panelUmPerPx() {
  const rect = currentPanel();
  if (!rect || !rect.bar) return null;
  const barUm = +$("barUm").value;
  if (!(barUm > 0)) return null;
  return barUm / rect.bar.widthPx;
}

async function segment(p, srcIn, validMask) {
  const src = srcIn || cv.imread(srcCanvas);
  let gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  if (validMask) applyValidMask(gray, validMask);
  if (p.blur) {
    const tmp = new cv.Mat();
    cv.GaussianBlur(gray, tmp, new cv.Size(3, 3), 0);
    gray.delete();
    gray = tmp;
  }
  const W = gray.cols, H = gray.rows;
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
    } else if (p.mode === "percentile") {
      // 分位阈值: 取灰度的第 p.percentile 分位做分割。
      // 断口面 SEM 里晶粒是凸起的亮区、晶界/孔洞是暗网络, 灰度分布双峰不明显,
      // Otsu 会在四张子图之间飘(Otsu 阈值实测 85~107), 而分位阈值对整体明暗不敏感,
      // 更适合"按亮度切出凸起晶粒"这种用法。
      const t = matPercentile(gray, p.thrPct);
      const flag = p.polar === "bright" ? cv.THRESH_BINARY : cv.THRESH_BINARY_INV;
      cv.threshold(gray, thresh, t, 255, flag);
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
    let splitByLabel = false;
    let wsBgLabel = 0;
    if (p.ws) {
      const wsRes = await watershedSplit(gray, thresh, src, p.wsPeakK);
      // 若没有有效种子(颗粒过小), 退回直接阈值掩膜, 避免漏检
      if (wsRes && wsRes.bgLabel > 1) {
        markers = wsRes.markers;
        // 分水岭把颗粒/背景的交界标成 -1, 直接丢弃会让每颗颗粒被削掉一圈:
        // 实测分散粉末 72 颗只剩 23 颗(31 颗被最小面积误杀、18 颗被圆度误杀)。
        // 晶粒模式已用 fillLabelZeros 处理同类问题, 这里照做, 面积得以守恒。
        fillLabelZeros(markers, 1);
        // 必须逐标签提取: 若对二值图求外轮廓, 相邻标签会重新连成一整片,
        // 分水岭的拆分效果就白费了。
        splitByLabel = true;
        wsBgLabel = wsRes.bgLabel;
        wsRes.regionMask.delete();
      } else {
        if (wsRes) { wsRes.markers.delete(); wsRes.regionMask.delete(); }
        regionMask = thresh;
      }
    } else {
      regionMask = thresh;
    }

    if (splitByLabel) {
      extractByLabel(markers, p, W, H, out, wsBgLabel);
    } else {
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
/* ---------- 统计量 ----------
 * 除 D10/D50/D90、Cu/Cc/Span 外，补上论文常用的离散度与置信区间：
 *   σ  = 样本标准差 (n-1)
 *   CV = 变异系数 σ/mean×100%
 *   CI95 = 均值的 95% 置信区间半宽 t(0.975,n-1)·σ/√n
 * 陶瓷文献报告晶粒尺寸惯例为 "x ± y µm"，直接用这里的 σ；样本量小时用 CI95 更有说服力。 */
const T975 = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
  2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
  2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042,
];
function tCrit975(df) {
  if (df < 1) return NaN;
  return df <= T975.length ? T975[df - 1] : 1.96;
}

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
  // 样本标准差与均值置信区间
  let std = 0, cv = 0, ci95 = 0;
  if (n >= 2) {
    const ss = diameters.reduce((s, v) => s + (v - mean) ** 2, 0);
    std = Math.sqrt(ss / (n - 1));
    cv = mean > 0 ? (std / mean) * 100 : 0;
    ci95 = tCrit975(n - 1) * std / Math.sqrt(n);
  }
  return { n, mean, median: d50, d10, d30, d50, d60, d90, cu, cc, span, std, cv, ci95 };
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
  $("sStd").textContent = stats.n >= 2 ? `${fmt(stats.std)} ${unit}` : "–";
  $("sCv").textContent = stats.n >= 2 ? `${stats.cv.toFixed(1)} %` : "–";
  $("sCi").textContent = stats.n >= 2 ? `± ${fmt(stats.ci95)} ${unit}` : "–";
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
  // 拼图模式: 只分析当前选中的子图, 并套用该子图的标注屏蔽
  const rect = currentPanel();
  try {
    s = rect ? await segment(p, panelMat(rect, buildValidMask(rect, rect.bar)), null)
             : await segment(p);
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
    if (currentPanel()) { dstCanvas.width = currentPanel().w; dstCanvas.height = currentPanel().h; }
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
  if (stats.n >= 2) {
    csv += `标准差σ(${unit}),${fmt(stats.std)}\n`;
    csv += `变异系数CV,${stats.cv.toFixed(2)}%\n`;
    csv += `均值95%置信区间半宽(${unit}),${fmt(stats.ci95)}\n`;
  }
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

/* ---------- 论文插图模式: 批量测量所有子图 ---------- */
async function runBatch() {
  if (!figurePanels) return;
  const status = $("status");
  status.style.color = "var(--warn)";
  try { await waitCv(); } catch (e) { status.style.color = "var(--bad)"; status.textContent = e.message; return; }
  const barUm = +$("barUm").value;
  if (!(barUm > 0)) { status.textContent = "请先填写比例尺代表的真实长度。"; return; }
  const saved = panelIndex;
  const out = [];
  for (let i = 0; i < figurePanels.length; i++) {
    panelIndex = i;
    const rect = figurePanels[i];
    status.textContent = `正在测量子图 ${PANEL_NAMES[i] || (i + 1)} / ${figurePanels.length}…`;
    const p = readParams();               // 内部按当前子图的标尺自动标定
    let src = null;
    if (rect.bar) src = panelMat(rect, buildValidMask(rect, rect.bar));
    const s = src ? await segment(p, src, null) : await segment(p);
    const diam = s.diametersPx.map((d) => d * p.unitPerPx);
    const stats = computeStats(diam);
    const sol = s.rows.map((r) => r.solidity).filter((v) => typeof v === "number");
    out.push({
      name: PANEL_NAMES[i] || String(i + 1),
      barPx: rect.bar ? rect.bar.widthPx : null,
      umPerPx: p.unitPerPx,
      unit: p.unitLabel,
      n: s.diametersPx.length,
      stats,
      solidity: sol.length ? sol.reduce((a, b) => a + b, 0) / sol.length : null,
    });
  }
  panelIndex = saved;
  lastBatch = out;
  renderBatchTable(out);
  $("batchBlock").hidden = false;
  status.style.color = "var(--good)";
  status.textContent = `批量测量完成：${out.length} 个子图。`;
}

function renderBatchTable(out) {
  const tb = $("batchTbl").querySelector("tbody");
  tb.innerHTML = "";
  const unit = out[0] ? out[0].unit : "µm";
  for (const r of out) {
    const st = r.stats;
    const f = (v, n = 2) => (typeof v === "number" && isFinite(v) ? v.toFixed(n) : "–");
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${r.name}</td><td>${r.barPx ? r.barPx.toFixed(1) : "–"}</td>`
      + `<td>${st ? st.n : 0}</td>`
      + `<td>${st ? f(st.mean) : "–"}</td><td>${st ? f(st.std) : "–"}</td>`
      + `<td>${st ? f(st.d10) : "–"}</td><td>${st ? f(st.d50) : "–"}</td><td>${st ? f(st.d90) : "–"}</td>`
      + `<td>${st ? f(st.cv, 1) + "%" : "–"}</td>`
      + `<td>${f(r.solidity, 3)}</td>`;
    tb.appendChild(tr);
  }
  $("batchTitle").textContent = `多子图对比（单位：${unit}）`;
  $("batchNote").textContent = "标尺像素数为各子图自动测得的半高插值宽度；σ、CV、D10/D50/D90 由各子图全部晶粒统计；"
    + "「实心度」明显偏低（<0.9）说明该子图存在较多未分开的粘连体，横向比较时需留意。";
}

function exportBatchCsv() {
  if (!lastBatch) return;
  const unit = lastBatch[0] ? lastBatch[0].unit : "um";
  const f = (v, n = 3) => (typeof v === "number" && isFinite(v) ? v.toFixed(n) : "");
  let csv = "论文插图多子图测量结果\n";
  csv += `单位,${unit}\n`;
  csv += `子图,标尺px,计数n,平均,标准差,D10,D50,D90,变异系数CV%,平均实心度\n`;
  for (const r of lastBatch) {
    const st = r.stats || {};
    csv += `${r.name},${f(r.barPx, 1)},${st.n || 0},${f(st.mean)},${f(st.std)},`
      + `${f(st.d10)},${f(st.d50)},${f(st.d90)},${f(st.cv, 2)},${f(r.solidity, 4)}\n`;
  }
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "figure_panels_result.csv";
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
  <div class="sub">生成时间：${now} ｜ ${noun}数：${stats.n} ｜ 单位：${unit} ｜ 分割方式：${isGrain ? "晶粒模式(梯度晶界+分水岭)" : "阈值分割"} ｜ 标尺校准：${p.calibrated ? "已标定" : "未标定(像素)"} ｜ 分析分辨率：${srcOrigSize ? srcOrigSize.w + "×" + srcOrigSize.h + (srcScale < 0.999 ? "（已降采样至 " + (srcScale * 100).toFixed(0) + "%）" : "（未降采样）") : "–"}</div>
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
      ${stats.n >= 2 ? `
      <div>标准差 σ<b>${fmt(stats.std)} ${unit}</b></div>
      <div>变异系数 CV<b>${stats.cv.toFixed(1)} %</b></div>
      <div>均值 95% CI<b>± ${fmt(stats.ci95)} ${unit}</b></div>` : ""}
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
    const rect = currentPanel();
    s = rect ? await segment(p, panelMat(rect, buildValidMask(rect, rect.bar)), null)
             : await segment(p);
    if (s.diametersPx.length > 0) {
      if (rect) { dstCanvas.width = rect.w; dstCanvas.height = rect.h; }
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
  // 拼图模式: 把当前子图框出来, 并把被屏蔽的标注区标出来
  const rect = currentPanel();
  if (rect && figurePanels) {
    const lw = Math.max(2, ov.width / 300);
    ctx.lineWidth = lw;
    // 其他子图压暗
    ctx.fillStyle = "rgba(8,10,16,0.55)";
    ctx.beginPath();
    ctx.rect(0, 0, ov.width, ov.height);
    ctx.rect(rect.x, rect.y, rect.w, rect.h);
    ctx.fill("evenodd");
    // 当前子图边框
    ctx.strokeStyle = "#38e1ff";
    ctx.setLineDash([]);
    ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
    ctx.fillStyle = "#38e1ff";
    ctx.font = `${Math.max(14, Math.round(ov.width / 45))}px Arial, sans-serif`;
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillText(`子图 ${PANEL_NAMES[panelIndex] || panelIndex + 1}`, rect.x + 8, rect.y + 8);
    // 标注屏蔽区
    const mask = buildValidMask(rect, rect.bar);
    ctx.fillStyle = "rgba(248,113,113,0.28)";
    const W = rect.w;
    for (let y = 0; y < rect.h; y++) {
      let run = 0;
      for (let x = 0; x <= rect.w; x++) {
        const on = x < rect.w && mask[y * W + x];
        if (on) run++;
        else if (run) { ctx.fillRect(rect.x + x - run, rect.y + y, run, 1); run = 0; }
      }
    }
    // 标尺白板位置
    if (rect.bar) {
      ctx.strokeStyle = "#fbbf24";
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(rect.bar.leftAbs, rect.bar.rowAbs);
      ctx.lineTo(rect.bar.rightAbs, rect.bar.rowAbs);
      ctx.stroke();
    }
  }
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
  $("sample").addEventListener("click", loadSampleGrain);
  $("samplePowder").addEventListener("click", loadSamplePowder);
  $("run").addEventListener("click", analyze);
  $("expCsv").addEventListener("click", exportCsv);
  $("expPng").addEventListener("click", exportHistPng);
  $("expPdf").addEventListener("click", exportReport);
  $("sendChart").addEventListener("click", sendToChart);
  $("batchRun").addEventListener("click", runBatch);
  $("batchCsv").addEventListener("click", exportBatchCsv);
  $("barUm").addEventListener("input", () => {
    $("barUmVal").textContent = $("barUm").value;
    updateScaleInfo();
    applyCalibration();
  });
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
  // 两种分割方式各自的参数预设。
  // 之前只在首次进入晶粒模式时把最小面积/圆度调紧, 切回阈值模式却不还原,
  // 结果用户从默认的晶粒模式切到粉末模式后, 仍然带着 minarea=150 / circ=0.30,
  // 实测 72 颗的分散粉末只剩 38 颗。改为双向生效: 用户手动调过的滑块不再被覆盖。
  const MODE_PRESETS = {
    grain: { minarea: "150", circ: "0.30" },
    otsu: { minarea: "20", circ: "0.50" },
    percentile: { minarea: "100", circ: "0.20" },
    adaptive: { minarea: "20", circ: "0.50" },
    manual: { minarea: "20", circ: "0.50" },
  };
  const PRESET_LABEL = { minarea: "minVal", circ: "cirVal", kern: "kVal", thrPct: "thrPctVal" };
  const userTouched = { minarea: false, circ: false, kern: false, thrPct: false };

  const syncModeUI = () => {
    const m = $("mode").value;
    const grain = m === "grain";
    $("manualWrap").hidden = m !== "manual";
    $("pctWrap").hidden = m !== "percentile";
    $("blockWrap").hidden = m !== "adaptive";
    if ($("grainWrap")) $("grainWrap").hidden = !grain;
    if ($("kernWrap")) $("kernWrap").hidden = grain;
    if ($("polarWrap")) $("polarWrap").hidden = grain;
    if ($("wsWrap")) $("wsWrap").hidden = grain;
    const preset = MODE_PRESETS[m];
    if (preset) {
      for (const id of Object.keys(preset)) {
        if (userTouched[id]) continue;
        const el = $(id);
        if (!el) continue;
        el.value = preset[id];
        const lab = $(PRESET_LABEL[id]);
        if (lab) lab.textContent = (id === "circ") ? (+preset[id]).toFixed(2) : preset[id];
      }
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
  $("thrPct").addEventListener("input", () => { userTouched.thrPct = true; $("thrPctVal").textContent = $("thrPct").value; schedulePreview(); });
  $("thrPct").addEventListener("change", schedulePreviewImmediate);
  $("blk").addEventListener("input", () => { $("blkVal").textContent = $("blk").value; schedulePreview(); });
  $("blk").addEventListener("change", schedulePreviewImmediate);
  $("kern").addEventListener("input", () => { userTouched.kern = true; $("kVal").textContent = $("kern").value; schedulePreview(); });
  $("kern").addEventListener("change", schedulePreviewImmediate);
  $("minarea").addEventListener("input", () => { userTouched.minarea = true; $("minVal").textContent = $("minarea").value; schedulePreview(); });
  $("minarea").addEventListener("change", schedulePreviewImmediate);
  $("circ").addEventListener("input", () => { userTouched.circ = true; $("cirVal").textContent = (+$("circ").value).toFixed(2); schedulePreview(); });
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
  const rect = currentPanel();
  if (rect && rect.bar) {
    const barUm = +$("barUm").value;
    if (barUm > 0) {
      const perPx = barUm / rect.bar.widthPx;
      $("scaleInfo").textContent = `✅ 已自动标定（子图 ${PANEL_NAMES[panelIndex] || panelIndex + 1}）：比例尺白板宽 ${rect.bar.widthPx.toFixed(1)} px = ${barUm} µm，即 1 px ≈ ${perPx.toFixed(4)} µm。此标定优先于手动输入。`;
      return;
    }
  }
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
    // 若用户在 OpenCV 就绪前就上传了图, 此刻补做拼图检测
    if (imgLoaded) detectFigureIfComposite();
  }).catch((e) => {
    $("status").style.color = "var(--bad)";
    $("status").textContent = e.message;
  });
});
