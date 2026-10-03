/* =========================================================
   LW · 科研图表生成器
   浏览器端生成 SCI 规范图表
   图型：分组柱状图 / 折线 / 散点 / 分组箱线图
   纯静态、数据不上传，输出 SVG 与 300/600 DPI PNG
   ========================================================= */
(function () {
  "use strict";

  const PALETTE = [
    "#22d3ee", "#818cf8", "#f472b6", "#34d399",
    "#fbbf24", "#fb7185", "#60a5fa", "#a78bfa",
    "#2dd4bf", "#f97316", "#e879f9", "#4ade80"
  ];
  const INK = "#111111";
  const GRID = "#e6e6e6";
  const MM_PER_IN = 25.4;

  /* 示例数据（占位，请替换为你的实测 / 已计算值） */
  const EXAMPLES = {
    bar: {
      label: "示例 · 分组柱状图",
      text:
`# 首列=分组(化学键)，其余列=系列(掺杂组分 x)；示例数据，请替换
化学键, x=0.02, x=0.05, x=0.08, x=0.11
Sm-O, 0.62, 0.60, 0.58, 0.59
Zr-O, 0.71, 0.69, 0.67, 0.68
Mo-O, 0.78, 0.76, 0.75, 0.77`
    },
    line: {
      label: "示例 · 折线图",
      text:
`# 系列, X(掺杂量 x), Y(介电常数 εr)；示例数据，请替换
εr, 0.02, 18.2
εr, 0.05, 20.5
εr, 0.08, 19.8
εr, 0.11, 17.6`
    },
    scatter: {
      label: "示例 · 散点图",
      text:
`# 系列, X(烧结温度 °C), Y(Q×f, GHz)；示例数据，请替换
Q×f, 725, 9200
Q×f, 750, 13800
Q×f, 800, 21500
Q×f, 825, 16700`
    },
    box: {
      label: "示例 · 箱线图",
      text:
`# 首列=分组，其余列=系列；每行是一条独立观测（多行=重复样）。示例数据
条件, 样品A, 样品B
750°C, 8.1, 7.6
750°C, 8.3, 7.9
750°C, 8.0, 7.55
800°C, 8.4, 8.0
800°C, 8.6, 8.2
800°C, 8.5, 7.95
825°C, 8.3, 7.9
825°C, 8.1, 7.7`
    }
  };

  /* 陶瓷研究模板（P-V-L 键离子性 fᵢ 为真实计算值；εr / Q×f 为结构示例） */
  const PRESETS = {
    "pvl-fi": {
      label: "P-V-L 键离子性 fᵢ",
      type: "bar",
      xTitle: "掺杂组分 x",
      yTitle: "平均键离子性 fᵢ",
      title: "Sm₂[Zr₁₋ₓ(Cr₀.₅Ta₀.₅)ₓ]₃[MoO₄]₉ 键离子性",
      text:
`# 真实 P-V-L 计算值（平均 fᵢ，来源：pvl 计算表 x=0.02/0.05/0.08/0.11）
化学键, x=0.02, x=0.05, x=0.08, x=0.11
Sm-O, 0.8503, 0.8489, 0.8511, 0.8506
Zr(Cr/Ta)-O, 0.7923, 0.7918, 0.7917, 0.7880
Mo-O, 0.7253, 0.7258, 0.7232, 0.7233`
    },
    "epsr": {
      label: "介电常数 εr",
      type: "line",
      xTitle: "掺杂量 x",
      yTitle: "εr",
      title: "εr 随掺杂量变化（示例结构，请替换实测值）",
      text:
`# 系列, X(掺杂量 x), Y(εr)；示例结构，请替换为你的实测值
εr, 0.02, 18.2
εr, 0.05, 20.5
εr, 0.08, 19.8
εr, 0.11, 17.6`
    },
    "qf": {
      label: "品质因数 Q×f",
      type: "scatter",
      xTitle: "烧结温度 (°C)",
      yTitle: "Q×f (GHz)",
      title: "Q×f 随烧结温度变化（示例结构，请替换实测值）",
      text:
`# 系列, X(烧结温度 °C), Y(Q×f, GHz)；示例结构，请替换
Q×f, 725, 9200
Q×f, 750, 13800
Q×f, 800, 21500
Q×f, 825, 16700`
    }
  };

  const HINTS = {
    bar: "首行为表头：第一列是分组名（如化学键），其余每列是一个系列（如掺杂组分）。下方每行对应一个分组与各系列的数值。以 # 开头的行为注释。",
    line: "每行：系列名, X, Y。同一系列的多行按 X 排序连成线。以 # 开头的行为注释。不同量纲请分图绘制。",
    scatter: "每行：系列名, X, Y。仅绘制散点，不连线。以 # 开头的行为注释。",
    box: "首列=分组（如烧结温度），其余列=系列（如样品/批次）；每行是一条独立观测，同一分组可有多行（重复样）。程序自动算中位数/四分位/须/异常点。以 # 开头的行为注释。"
  };

  const $ = (id) => document.getElementById(id);
  const typeSeg = $("typeSeg");
  const dataEl = $("data");
  const fmtHint = $("fmtHint");
  const examplesEl = $("examples");
  const seriesColorsEl = $("seriesColors");
  const titleEl = $("title");
  const xTitleEl = $("xTitle");
  const yTitleEl = $("yTitle");
  const fontEl = $("font");
  const dpiEl = $("dpi");
  const figWEl = $("figW");
  const figHEl = $("figH");
  const inwardEl = $("inward");
  const gridEl = $("grid");
  const legendEl = $("legend");
  const fitEl = $("fit");
  const previewEl = $("preview");
  const statusEl = $("status");
  const dimsEl = $("dims");
  const dlSvg = $("dlSvg");
  const dlPng = $("dlPng");

  let currentType = "bar";
  const seriesColors = {};

  function mm(v, dpi) { return (v * dpi) / MM_PER_IN; }

  function niceNum(range, round) {
    if (range <= 0) return 1;
    const exp = Math.floor(Math.log10(range));
    const frac = range / Math.pow(10, exp);
    let nf;
    if (round) {
      if (frac < 1.5) nf = 1; else if (frac < 3) nf = 2; else if (frac < 7) nf = 5; else nf = 10;
    } else {
      if (frac <= 1) nf = 1; else if (frac <= 2) nf = 2; else if (frac <= 5) nf = 5; else nf = 10;
    }
    return nf * Math.pow(10, exp);
  }

  function niceTicks(min, max, maxTicks) {
    if (min === max) { max = min + 1; }
    const range = niceNum(max - min, false);
    const step = niceNum(range / Math.max(1, maxTicks - 1), true);
    const niceMin = Math.floor(min / step) * step;
    const niceMax = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = niceMin; v <= niceMax + step * 0.5; v += step) ticks.push(+v.toFixed(10));
    return { ticks, niceMin, niceMax, step };
  }

  function fmtNum(v, step) {
    if (!isFinite(v)) return "";
    if (v === 0) return "0";
    const a = Math.abs(v);
    let dec;
    if (step >= 1) dec = 0;
    else dec = Math.min(4, Math.ceil(-Math.log10(step)) + 1);
    return (+v.toFixed(dec)).toString();
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  /* ---- quantile (linear interpolation) ---- */
  function quantile(sorted, p) {
    if (sorted.length === 0) return 0;
    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }
  function boxStats(arr) {
    const s = arr.slice().sort((a, b) => a - b);
    const q1 = quantile(s, 0.25), med = quantile(s, 0.5), q3 = quantile(s, 0.75);
    const iqr = q3 - q1;
    const loFence = q1 - 1.5 * iqr, hiFence = q3 + 1.5 * iqr;
    const inl = s.filter((v) => v >= loFence && v <= hiFence);
    const wMin = inl.length ? inl[0] : s[0];
    const wMax = inl.length ? inl[inl.length - 1] : s[s.length - 1];
    const outliers = s.filter((v) => v < loFence || v > hiFence);
    return { q1, med, q3, wMin, wMax, min: s[0], max: s[s.length - 1], outliers, n: s.length };
  }

  /* ---- 最小二乘线性拟合 ---- */
  function linFit(points) {
    const n = points.length;
    if (n < 2) return null;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const p of points) { sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y; }
    const denom = n * sxx - sx * sx;
    if (Math.abs(denom) < 1e-12) return null;
    const b = (n * sxy - sx * sy) / denom;
    const a = (sy - b * sx) / n;
    let ssTot = 0, ssRes = 0; const my = sy / n;
    for (const p of points) { const yh = a + b * p.x; ssTot += (p.y - my) ** 2; ssRes += (p.y - yh) ** 2; }
    const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 1;
    return { a, b, r2, n };
  }

  /* ---- parsing ---- */
  function parseData(text, type) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    if (!lines.length) return { error: "数据为空" };

    if (type === "bar") {
      return parseBar(lines);
    }
    if (type === "box") {
      return parseBox(lines);
    }
    // line / scatter
    return parseXY(lines);
  }

  function parseBar(lines) {
    const header = lines[0].split(",").map((s) => s.trim());
    if (header.length < 2) return { error: "分组柱状图至少需要 1 个分组 + 1 个系列（表头至少两列）" };
    const catLabel = header[0] || "分组";
    const seriesNames = header.slice(1);
    const categories = [];
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(",").map((s) => s.trim());
      if (parts.length < seriesNames.length + 1) return { error: `第 ${i + 1} 行列数不足` };
      categories.push(parts[0]);
      const vals = parts.slice(1, seriesNames.length + 1).map((x) => Number(x));
      if (vals.some((v) => isNaN(v))) return { error: `第 ${i + 1} 行存在非数值` };
      rows.push(vals);
    }
    const series = seriesNames.map((name, j) => ({ name, values: rows.map((r) => r[j]) }));
    return { categories, series };
  }

  function parseXY(lines) {
    const map = new Map();
    let count = 0;
    for (const ln of lines) {
      const p = ln.split(",").map((s) => s.trim());
      if (p.length < 3) continue;
      const name = p[0];
      const x = Number(p[1]), y = Number(p[2]);
      if (isNaN(x) || isNaN(y)) continue;
      if (!map.has(name)) map.set(name, []);
      map.get(name).push({ x, y });
      count++;
    }
    if (!count) return { error: "未能解析到有效的 系列,X,Y 数据行" };
    const series = [...map.entries()].map(([name, points]) => ({ name, points: points.sort((a, b) => a.x - b.x) }));
    return { series };
  }

  function parseBox(lines) {
    const header = lines[0].split(",").map((s) => s.trim());
    if (header.length < 2) return { error: "箱线图至少需要 1 个分组 + 1 个系列（表头至少两列）" };
    const catLabel = header[0] || "分组";
    const seriesNames = header.slice(1);
    const groups = [];          // [{ name, series: [ [v,...], [v,...] ] }]
    const gIndex = new Map();
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(",").map((s) => s.trim());
      if (parts.length < seriesNames.length + 1) return { error: `第 ${i + 1} 行列数不足` };
      const gname = parts[0];
      const vals = parts.slice(1, seriesNames.length + 1).map((x) => Number(x));
      if (vals.some((v) => isNaN(v))) return { error: `第 ${i + 1} 行存在非数值` };
      let g = gIndex.get(gname);
      if (!g) { g = { name: gname, series: seriesNames.map(() => []) }; gIndex.set(gname, g); groups.push(g); }
      for (let j = 0; j < seriesNames.length; j++) g.series[j].push(vals[j]);
    }
    if (!groups.length) return { error: "未解析到任何分组数据" };
    return { groups, seriesNames, catLabel };
  }

  function ensureColors(series) {
    series.forEach((s, i) => {
      if (!seriesColors[s.name]) seriesColors[s.name] = PALETTE[i % PALETTE.length];
    });
  }

  function readOpts() {
    return {
      title: titleEl.value.trim(),
      xTitle: xTitleEl.value.trim(),
      yTitle: yTitleEl.value.trim(),
      font: fontEl.value,
      dpi: parseInt(dpiEl.value, 10) || 300,
      figW: Math.max(20, parseFloat(figWEl.value) || 86),
      figH: Math.max(20, parseFloat(figHEl.value) || 64),
      inward: inwardEl.checked,
      grid: gridEl.checked,
      legend: legendEl.checked,
      fit: fitEl.checked
    };
  }

  /* ---- legend ---- */
  function drawLegend(o, series, topY) {
    if (!o.legend || series.length < 2) return "";
    const fs = (9 * o.dpi) / 72;
    const sw = mm(5, o.dpi);
    const gap = mm(2.2, o.dpi);
    const pad = mm(1, o.dpi);
    const cw = (name) => {
      let w = 0;
      for (const ch of name) w += /[一-鿿]/.test(ch) ? fs : fs * 0.56;
      return w;
    };
    const items = series.map((s) => ({ name: s.name, color: seriesColors[s.name] || "#888", w: sw + gap + cw(s.name) }));
    const total = items.reduce((a, b) => a + b.w, 0) + gap * (items.length - 1);
    let x = (o.W - total) / 2;
    let s = "";
    items.forEach((it) => {
      const cy = topY - fs * 0.35;
      s += `<rect x="${x}" y="${cy - sw / 2}" width="${sw}" height="${sw}" fill="${it.color}"/>`;
      s += `<text x="${x + sw + gap}" y="${topY}" font-size="${fs}" fill="${INK}" text-anchor="start" dominant-baseline="middle">${esc(it.name)}</text>`;
      x += it.w + gap;
    });
    return s;
  }

  function svgWrap(o, inner) {
    const W = o.W, H = o.H;
    const fam = String(o.font).replace(/"/g, "&quot;");
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${fam}">` +
      `<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>` + inner + `</svg>`;
  }

  /* ---- 通用轴绘制（供 bar/line/box 复用） ---- */
  function drawAxes(o, g) {
    const tlen = mm(3, o.dpi);
    const fs2 = (9 * o.dpi) / 72;
    const small = (7.5 * o.dpi) / 72;
    const plotB = g.plotT + g.plotH, plotR = g.plotL + g.plotW;
    let s = "";
    g.yTicks.forEach((v) => {
      const yy = g.yPos(v);
      if (o.grid) s += `<line x1="${g.plotL}" y1="${yy}" x2="${plotR}" y2="${yy}" stroke="${GRID}" stroke-width="1"/>`;
      const d = o.inward ? tlen : -tlen;
      s += `<line x1="${g.plotL}" y1="${yy}" x2="${g.plotL + d}" y2="${yy}" stroke="${INK}" stroke-width="1"/>`;
      s += `<text x="${g.plotL - mm(3.5, o.dpi)}" y="${yy}" font-size="${fs2}" fill="${INK}" text-anchor="end" dominant-baseline="middle">${esc(fmtNum(v, g.yStep))}</text>`;
    });
    g.xTicks.forEach((v, i) => {
      const xx = g.xPos(v);
      if (o.grid) s += `<line x1="${xx}" y1="${g.plotT}" x2="${xx}" y2="${plotB}" stroke="${GRID}" stroke-width="1"/>`;
      const d = o.inward ? tlen : -tlen;
      s += `<line x1="${xx}" y1="${plotB}" x2="${xx}" y2="${plotB - d}" stroke="${INK}" stroke-width="1"/>`;
      const label = g.xTickLabels ? g.xTickLabels[i] : fmtNum(v, g.xStep);
      s += `<text x="${xx}" y="${plotB + mm(4, o.dpi)}" font-size="${fs2}" fill="${INK}" text-anchor="middle" dominant-baseline="hanging">${esc(label)}</text>`;
    });
    s += `<line x1="${g.plotL}" y1="${g.plotT}" x2="${g.plotL}" y2="${plotB}" stroke="${INK}" stroke-width="1.4"/>`;
    s += `<line x1="${g.plotL}" y1="${plotB}" x2="${plotR}" y2="${plotB}" stroke="${INK}" stroke-width="1.4"/>`;
    if (o.yTitle) s += `<text x="${mm(4, o.dpi)}" y="${g.plotT + g.plotH / 2}" font-size="${small}" fill="${INK}" text-anchor="middle" transform="rotate(-90 ${mm(4, o.dpi)} ${g.plotT + g.plotH / 2})">${esc(o.yTitle)}</text>`;
    if (o.xTitle) s += `<text x="${g.plotL + g.plotW / 2}" y="${o.H - mm(4, o.dpi)}" font-size="${small}" fill="${INK}" text-anchor="middle">${esc(o.xTitle)}</text>`;
    return s;
  }

  function titleAndLegend(o, W, titleY, legendY, series) {
    let s = "";
    if (o.title) s += `<text x="${W / 2}" y="${titleY}" font-size="${(11 * o.dpi) / 72}" fill="${INK}" text-anchor="middle" dominant-baseline="middle" font-weight="600">${esc(o.title)}</text>`;
    if (legendY != null) s += drawLegend(o, series, legendY);
    return s;
  }

  function frame(o, plotL, plotT, plotW, plotH) {
    let mT = Math.round(mm(8, o.dpi));
    let titleY = null, legendY = null;
    if (o.title) { titleY = mm(5.2, o.dpi); mT = Math.max(mT, Math.round(mm(9, o.dpi))); }
    if (o.legend) { legendY = o.title ? mm(11.5, o.dpi) : mm(5.2, o.dpi); mT = Math.max(mT, o.title ? Math.round(mm(16, o.dpi)) : Math.round(mm(10, o.dpi))); }
    const mL = Math.round(mm(15, o.dpi));
    const mR = Math.round(mm(8, o.dpi));
    const mB = Math.round(mm(16, o.dpi));
    if (plotL == null) plotL = mL;
    if (plotT == null) plotT = mT;
    const W = Math.round(mm(o.figW, o.dpi));
    const H = Math.round(mm(o.figH, o.dpi));
    const realW = plotL + (plotW || (W - mL - mR));
    const realH = plotT + (plotH || (H - mT - mB));
    return { W, H, mL, mR, mB, mT, plotL, plotT, plotW: realW - plotL, plotH: realH - plotT, titleY, legendY };
  }

  /* ---- bar render ---- */
  function renderBar(d, o) {
    const f = frame(o);
    o.W = f.W; o.H = f.H;
    const plotL = f.plotL, plotT = f.plotT, plotW = f.plotW, plotH = f.plotH;
    const n = d.categories.length, m = d.series.length;
    const allV = d.series.flatMap((s) => s.values);
    const maxV = Math.max(...allV, 0);
    const tk = niceTicks(0, maxV, 5);
    const ymin = 0, ymax = tk.niceMax;
    const yPos = (v) => plotT + plotH - ((v - ymin) / (ymax - ymin)) * plotH;
    const step = plotW / Math.max(1, n);
    const catCenter = (i) => plotL + step * (i + 0.5);
    const innerPad = step * 0.14;
    const innerW = step - 2 * innerPad;
    const barW = innerW / Math.max(1, m);
    const gap = barW * 0.14;
    const effW = barW - gap;

    let s = "";
    if (o.grid) tk.ticks.forEach((v) => { const yy = yPos(v); s += `<line x1="${plotL}" y1="${yy}" x2="${plotL + plotW}" y2="${yy}" stroke="${GRID}" stroke-width="1"/>`; });
    for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
      const v = d.series[j].values[i];
      const cx = catCenter(i) - innerW / 2 + barW * j + barW / 2;
      const bh = ((v - ymin) / (ymax - ymin)) * plotH;
      const bx = cx - effW / 2; const by = yPos(v);
      s += `<rect x="${bx.toFixed(2)}" y="${by.toFixed(2)}" width="${effW.toFixed(2)}" height="${Math.max(0, bh).toFixed(2)}" fill="${seriesColors[d.series[j].name] || "#888"}"/>`;
    }
    s += drawAxes(o, { plotL, plotT, plotW, plotH, yTicks: tk.ticks, yStep: tk.step, xTicks: d.categories.map((_, i) => catCenter(i)), xTickLabels: d.categories, xStep: 1, yPos });
    d.categories.forEach((c, i) => { s += `<text x="${catCenter(i)}" y="${plotT + plotH + mm(4, o.dpi)}" font-size="${(9 * o.dpi) / 72}" fill="${INK}" text-anchor="middle" dominant-baseline="hanging">${esc(c)}</text>`; });
    s += titleAndLegend(o, f.W, f.titleY, f.legendY, d.series);
    return svgWrap(o, s);
  }

  /* ---- line / scatter render ---- */
  function renderLine(d, o, scatter) {
    const f = frame(o);
    o.W = f.W; o.H = f.H;
    const plotL = f.plotL, plotT = f.plotT, plotW = f.plotW, plotH = f.plotH;
    const allX = d.series.flatMap((s) => s.points.map((p) => p.x));
    const allY = d.series.flatMap((s) => s.points.map((p) => p.y));
    const xt = niceTicks(Math.min(...allX), Math.max(...allX), 5);
    const yt = niceTicks(Math.min(...allY), Math.max(...allY), 5);
    const xmin = xt.niceMin, xmax = xt.niceMax, ymin = yt.niceMin, ymax = yt.niceMax;
    const xPos = (v) => plotL + ((v - xmin) / (xmax - xmin)) * plotW;
    const yPos = (v) => plotT + plotH - ((v - ymin) / (ymax - ymin)) * plotH;
    const lw = (1 * o.dpi) / 72;
    const r = (2.2 * o.dpi) / 72;
    const plotB = plotT + plotH, plotR = plotL + plotW;
    const tlen = mm(3, o.dpi);

    let s = "";
    if (o.grid) {
      yt.ticks.forEach((v) => { const yy = yPos(v); s += `<line x1="${plotL}" y1="${yy}" x2="${plotR}" y2="${yy}" stroke="${GRID}" stroke-width="1"/>`; });
      xt.ticks.forEach((v) => { const xx = xPos(v); s += `<line x1="${xx}" y1="${plotT}" x2="${xx}" y2="${plotB}" stroke="${GRID}" stroke-width="1"/>`; });
    }
    const fitSumm = [];
    d.series.forEach((ser) => {
      const color = seriesColors[ser.name] || "#888";
      if (!scatter && ser.points.length > 1) {
        const pts = ser.points.map((p) => `${xPos(p.x).toFixed(2)},${yPos(p.y).toFixed(2)}`).join(" ");
        s += `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="${lw}" stroke-linejoin="round" stroke-linecap="round"/>`;
      }
      ser.points.forEach((p) => {
        s += `<circle cx="${xPos(p.x).toFixed(2)}" cy="${yPos(p.y).toFixed(2)}" r="${r.toFixed(2)}" fill="${color}" stroke="#ffffff" stroke-width="${(0.6 * o.dpi / 72).toFixed(2)}"/>`;
      });
      if (o.fit && ser.points.length >= 2) {
        const fit = linFit(ser.points);
        if (fit) {
          const x1 = xmin, x2 = xmax;
          const y1 = fit.a + fit.b * x1, y2 = fit.a + fit.b * x2;
          s += `<line x1="${xPos(x1).toFixed(2)}" y1="${yPos(y1).toFixed(2)}" x2="${xPos(x2).toFixed(2)}" y2="${yPos(y2).toFixed(2)}" stroke="${color}" stroke-width="${(0.9 * o.dpi / 72).toFixed(2)}" stroke-dasharray="${(4 * o.dpi / 72).toFixed(2)},${(3 * o.dpi / 72).toFixed(2)}" opacity="0.8"/>`;
          fitSumm.push(`${ser.name}: y=${fit.a.toFixed(2)}+${fit.b.toFixed(2)}x (R²=${fit.r2.toFixed(3)})`);
        }
      }
    });
    s += drawAxes(o, { plotL, plotT, plotW, plotH, yTicks: yt.ticks, yStep: yt.step, xTicks: xt.ticks, xStep: xt.step, xPos, yPos });
    s += titleAndLegend(o, f.W, f.titleY, f.legendY, d.series);
    return { svg: svgWrap(o, s), fitSumm };
  }

  /* ---- box render ---- */
  function renderBox(d, o) {
    const f = frame(o);
    o.W = f.W; o.H = f.H;
    const plotL = f.plotL, plotT = f.plotT, plotW = f.plotW, plotH = f.plotH;
    const m = d.seriesNames.length;
    const allV = d.groups.flatMap((g) => g.series.flatMap((arr) => arr));
    if (!allV.length) return { error: "无有效数值" };
    const yt = niceTicks(Math.min(...allV), Math.max(...allV), 5);
    const ymin = yt.niceMin, ymax = yt.niceMax;
    const yPos = (v) => plotT + plotH - ((v - ymin) / (ymax - ymin)) * plotH;
    const step = plotW / Math.max(1, d.groups.length);
    const catCenter = (i) => plotL + step * (i + 0.5);
    const innerPad = step * 0.14;
    const innerW = step - 2 * innerPad;
    const boxW = innerW / Math.max(1, m) * 0.62;
    const slot = innerW / Math.max(1, m);

    let s = "";
    if (o.grid) yt.ticks.forEach((v) => { const yy = yPos(v); s += `<line x1="${plotL}" y1="${yy}" x2="${plotL + plotW}" y2="${yy}" stroke="${GRID}" stroke-width="1"/>`; });

    const seriesList = d.seriesNames.map((name, j) => ({ name, j }));
    d.groups.forEach((g, i) => {
      for (let j = 0; j < m; j++) {
        const arr = g.series[j];
        if (!arr.length) continue;
        const st = boxStats(arr);
        const cx = catCenter(i) - innerW / 2 + slot * j + slot / 2;
        const color = seriesColors[d.seriesNames[j]] || PALETTE[j % PALETTE.length];
        const bw = boxW;
        const xL = cx - bw / 2, xR = cx + bw / 2;
        const yQ1 = yPos(st.q1), yQ3 = yPos(st.q3), yMed = yPos(st.med);
        const yWmin = yPos(st.wMin), yWmax = yPos(st.wMax);
        // whisker
        s += `<line x1="${cx}" y1="${yQ3}" x2="${cx}" y2="${yWmax}" stroke="${INK}" stroke-width="1"/>`;
        s += `<line x1="${cx}" y1="${yQ1}" x2="${cx}" y2="${yWmin}" stroke="${INK}" stroke-width="1"/>`;
        s += `<line x1="${xL}" y1="${yWmax}" x2="${xR}" y2="${yWmax}" stroke="${INK}" stroke-width="1"/>`;
        s += `<line x1="${xL}" y1="${yWmin}" x2="${xR}" y2="${yWmin}" stroke="${INK}" stroke-width="1"/>`;
        // box
        s += `<rect x="${xL.toFixed(2)}" y="${yQ3.toFixed(2)}" width="${bw.toFixed(2)}" height="${Math.max(1, yQ1 - yQ3).toFixed(2)}" fill="${color}" fill-opacity="0.18" stroke="${color}" stroke-width="1.2"/>`;
        // median
        s += `<line x1="${xL}" y1="${yMed}" x2="${xR}" y2="${yMed}" stroke="${INK}" stroke-width="1.6"/>`;
        // outliers
        st.outliers.forEach((v) => { const yy = yPos(v); s += `<circle cx="${cx}" cy="${yy.toFixed(2)}" r="${(1.8 * o.dpi / 72).toFixed(2)}" fill="${color}" fill-opacity="0.7"/>`; });
      }
    });
    s += drawAxes(o, { plotL, plotT, plotW, plotH, yTicks: yt.ticks, yStep: yt.step, xTicks: d.groups.map((_, i) => catCenter(i)), xTickLabels: d.groups.map((g) => g.name), xStep: 1, yPos });
    s += titleAndLegend(o, f.W, f.titleY, f.legendY, seriesList);
    return { svg: svgWrap(o, s) };
  }

  /* ---- main update ---- */
  function renderSeriesColors(series) {
    seriesColorsEl.innerHTML = series.map((s) => {
      const c = seriesColors[s.name] || "#888";
      return `<span class="sc"><input type="color" value="${c}" data-name="${esc(s.name)}" /><span>${esc(s.name)}</span></span>`;
    }).join("");
    seriesColorsEl.querySelectorAll('input[type="color"]').forEach((inp) => {
      inp.addEventListener("input", () => { seriesColors[inp.dataset.name] = inp.value; update(); });
    });
  }

  function update() {
    const o = readOpts();
    const parsed = parseData(dataEl.value, currentType);
    if (parsed.error) {
      previewEl.innerHTML = "";
      statusEl.className = "status err";
      statusEl.textContent = "⚠ " + parsed.error;
      dimsEl.textContent = "—";
      window.__lastSVG = "";
      return;
    }
    let seriesMeta;
    if (currentType === "box") seriesMeta = parsed.seriesNames.map((n) => ({ name: n }));
    else seriesMeta = parsed.series;
    ensureColors(seriesMeta);
    renderSeriesColors(seriesMeta);

    let svg, fitSumm = [];
    if (currentType === "bar") svg = renderBar(parsed, o);
    else if (currentType === "box") { const r = renderBox(parsed, o); if (r.error) { statusEl.className = "status err"; statusEl.textContent = "⚠ " + r.error; return; } svg = r.svg; }
    else { const r = renderLine(parsed, o, currentType === "scatter"); svg = r.svg; fitSumm = r.fitSumm; }

    previewEl.innerHTML = svg;
    window.__lastSVG = svg;
    window.__W = o.W; window.__H = o.H;
    dimsEl.textContent = `${o.W} × ${o.H} px · ${o.dpi} DPI · ${o.figW}×${o.figH} mm`;
    statusEl.className = "status ok";
    let msg = `✓ 已渲染 · ${seriesMeta.length} 个系列`;
    if (fitSumm.length) msg += ` ｜ 趋势线: ${fitSumm.join("；")}`;
    statusEl.textContent = msg;
    fitEl.parentElement.style.display = (currentType === "line" || currentType === "scatter") ? "flex" : "none";
  }

  /* ---- export ---- */
  function triggerDownload(href, name) {
    const a = document.createElement("a");
    a.href = href; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
  }
  function svgToPng(svgStr, w, h) {
    return new Promise((resolve, reject) => {
      const blob = new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        try { resolve(c.toDataURL("image/png")); } catch (e) { reject(e); }
      };
      img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
      img.src = url;
    });
  }
  dlSvg.addEventListener("click", () => {
    if (!window.__lastSVG) return;
    const blob = new Blob([window.__lastSVG], { type: "image/svg+xml;charset=utf-8" });
    triggerDownload(URL.createObjectURL(blob), "lw-chart.svg");
  });
  dlPng.addEventListener("click", async () => {
    if (!window.__lastSVG) return;
    statusEl.className = "status ok";
    statusEl.textContent = "正在生成 PNG…";
    try {
      const data = await svgToPng(window.__lastSVG, window.__W, window.__H);
      triggerDownload(data, "lw-chart.png");
      statusEl.className = "status ok";
      statusEl.textContent = "✓ PNG 已生成";
    } catch (e) {
      statusEl.className = "status err";
      statusEl.textContent = "⚠ PNG 生成失败：" + e.message;
    }
  });
  window.svgToPng = svgToPng;

  /* ---- type switch ---- */
  typeSeg.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      typeSeg.querySelectorAll("button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      currentType = b.dataset.type;
      fmtHint.textContent = HINTS[currentType];
      if (!dataEl.value.trim() || window.__EXAMPLE_LOADED) {
        dataEl.value = EXAMPLES[currentType].text;
        window.__EXAMPLE_LOADED = true;
      }
      update();
    });
  });

  let EXAMPLE_LOADED = false;
  examplesEl.innerHTML = Object.keys(EXAMPLES).map((k) =>
    `<button data-type="${k}">${EXAMPLES[k].label}</button>`).join("");
  examplesEl.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      currentType = b.dataset.type;
      typeSeg.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x.dataset.type === currentType));
      dataEl.value = EXAMPLES[currentType].text;
      EXAMPLE_LOADED = true;
      fmtHint.textContent = HINTS[currentType];
      update();
    });
  });

  /* ---- 陶瓷模板预设 ---- */
  const presetWrap = $("presets");
  if (presetWrap) {
    presetWrap.innerHTML = Object.keys(PRESETS).map((k) =>
      `<button data-preset="${k}">${PRESETS[k].label}</button>`).join("");
    presetWrap.querySelectorAll("button").forEach((b) => {
      b.addEventListener("click", () => {
        const p = PRESETS[b.dataset.preset];
        currentType = p.type;
        typeSeg.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x.dataset.type === currentType));
        dataEl.value = p.text;
        titleEl.value = p.title || "";
        xTitleEl.value = p.xTitle || "";
        yTitleEl.value = p.yTitle || "";
        EXAMPLE_LOADED = true;
        fmtHint.textContent = HINTS[currentType];
        update();
      });
    });
  }

  /* ---- 来自 AI 粒径分析 的互通数据 ---- */
  function applySeed(text, type, xTitle, yTitle) {
    currentType = type || "line";
    typeSeg.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x.dataset.type === currentType));
    dataEl.value = text;
    if (xTitle != null) xTitleEl.value = xTitle;
    if (yTitle != null) yTitleEl.value = yTitle;
    EXAMPLE_LOADED = true;
    fmtHint.textContent = HINTS[currentType];
    update();
  }

  function checkDeepLinks() {
    const params = new URLSearchParams(location.search);
    const from = params.get("from");
    const preset = params.get("preset");
    if (from === "particle") {
      try {
        const raw = localStorage.getItem("lw_chart_seed");
        if (raw) {
          const obj = JSON.parse(raw);
          applySeed(obj.text, obj.type || "line", obj.xTitle, obj.yTitle);
          return;
        }
      } catch (e) { /* ignore */ }
    }
    if (preset && PRESETS[preset]) {
      const p = PRESETS[preset];
      applySeed(p.text, p.type, p.xTitle, p.yTitle);
      titleEl.value = p.title || "";
      return;
    }
  }

  /* ---- live updates ---- */
  [dataEl, titleEl, xTitleEl, yTitleEl, fontEl, dpiEl, figWEl, figHEl].forEach((el) => {
    el.addEventListener("input", update);
    el.addEventListener("change", update);
  });
  [inwardEl, gridEl, legendEl, fitEl].forEach((el) => el.addEventListener("change", update));

  /* ---- init ---- */
  document.getElementById("year").textContent = new Date().getFullYear();
  fmtHint.textContent = HINTS.bar;
  dataEl.value = EXAMPLES.bar.text;
  EXAMPLE_LOADED = true;
  checkDeepLinks();
  if (!window.__lastSVG) update();
})();
