/* =========================================================
   LW · 科研图表生成器
   浏览器端生成 SCI 规范图表（分组柱状图 / 折线 / 散点）
   纯静态、数据不上传，输出 SVG 与 300 DPI PNG
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

  // 示例数据（占位，请替换为你的实测 / 已计算值）
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
    }
  };

  const HINTS = {
    bar: "首行为表头：第一列是分组名（如化学键），其余每列是一个系列（如掺杂组分）。下方每行对应一个分组与各系列的数值。以 # 开头的行为注释。",
    line: "每行：系列名, X, Y。同一系列的多行按 X 排序连成线。以 # 开头的行为注释。不同量纲（如 εr 与 Q×f）请分图绘制。",
    scatter: "每行：系列名, X, Y。仅绘制散点，不连线。以 # 开头的行为注释。"
  };

  // ---- DOM ----
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
  const previewEl = $("preview");
  const statusEl = $("status");
  const dimsEl = $("dims");
  const dlSvg = $("dlSvg");
  const dlPng = $("dlPng");

  let currentType = "bar";
  const seriesColors = {}; // name -> hex

  // ---- helpers ----
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
    let s = (+v.toFixed(dec)).toString();
    return s;
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  // ---- parsing ----
  function parseData(text, type) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    if (!lines.length) return { error: "数据为空" };

    if (type === "bar") {
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

    // line / scatter
    const map = new Map();
    let count = 0;
    for (const ln of lines) {
      const p = ln.split(",").map((s) => s.trim());
      if (p.length < 3) continue;
      const name = p[0];
      const x = Number(p[1]);
      const y = Number(p[2]);
      if (isNaN(x) || isNaN(y)) continue;
      if (!map.has(name)) map.set(name, []);
      map.get(name).push({ x, y });
      count++;
    }
    if (!count) return { error: "未能解析到有效的 系列,X,Y 数据行" };
    const series = [...map.entries()].map(([name, points]) => ({
      name,
      points: points.sort((a, b) => a.x - b.x)
    }));
    return { series };
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
      legend: legendEl.checked
    };
  }

  // ---- legend ----
  function drawLegend(o, series, topY) {
    if (!o.legend || series.length < 2) return "";
    const fs = (9 * o.dpi) / 72;
    const sw = mm(5, o.dpi);
    const gap = mm(2.2, o.dpi);
    const pad = mm(1, o.dpi);
    // estimate widths
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
    // 字体值可能含单引号（如 'Times New Roman'），用双引号包裹属性并转义内部双引号
    const fam = String(o.font).replace(/"/g, "&quot;");
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${fam}">` +
      `<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>` + inner + `</svg>`;
  }

  // ---- bar render ----
  function renderBar(d, o) {
    const W = Math.round(mm(o.figW, o.dpi));
    const H = Math.round(mm(o.figH, o.dpi));
    o.W = W; o.H = H;
    const mL = Math.round(mm(15, o.dpi));
    const mR = Math.round(mm(8, o.dpi));
    let mB = Math.round(mm(16, o.dpi));
    let mT = Math.round(mm(8, o.dpi));
    let titleY = null, legendY = null;
    if (o.title) { titleY = mm(5.2, o.dpi); mT = Math.max(mT, Math.round(mm(9, o.dpi))); }
    if (o.legend && d.series.length > 1) { legendY = o.title ? mm(11.5, o.dpi) : mm(5.2, o.dpi); mT = Math.max(mT, o.title ? Math.round(mm(16, o.dpi)) : Math.round(mm(10, o.dpi))); }

    const plotL = mL, plotT = mT, plotW = W - mL - mR, plotH = H - mT - mB;
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

    let s2 = "";
    // grid
    if (o.grid) {
      tk.ticks.forEach((v) => { const yy = yPos(v); s2 += `<line x1="${plotL}" y1="${yy}" x2="${plotL + plotW}" y2="${yy}" stroke="${GRID}" stroke-width="1"/>`; });
    }
    // bars
    for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
      const v = d.series[j].values[i];
      const cx = catCenter(i) - innerW / 2 + barW * j + barW / 2;
      const bh = ((v - ymin) / (ymax - ymin)) * plotH;
      const bx = cx - effW / 2; const by = yPos(v);
      s2 += `<rect x="${bx.toFixed(2)}" y="${by.toFixed(2)}" width="${effW.toFixed(2)}" height="${Math.max(0, bh).toFixed(2)}" fill="${seriesColors[d.series[j].name] || "#888"}"/>`;
    }
    // axis lines + ticks + titles
    const tlen = mm(3, o.dpi); const fs2 = (9 * o.dpi) / 72; const small = (7.5 * o.dpi) / 72;
    const plotB = plotT + plotH, plotR = plotL + plotW;
    tk.ticks.forEach((v) => {
      const yy = yPos(v); const d2 = o.inward ? tlen : -tlen;
      s2 += `<line x1="${plotL}" y1="${yy}" x2="${plotL + d2}" y2="${yy}" stroke="${INK}" stroke-width="1"/>`;
      s2 += `<text x="${plotL - mm(3.5, o.dpi)}" y="${yy}" font-size="${fs2}" fill="${INK}" text-anchor="end" dominant-baseline="middle">${esc(fmtNum(v, tk.step))}</text>`;
    });
    d.categories.forEach((c, i) => {
      const xx = catCenter(i); const d2 = o.inward ? tlen : -tlen;
      s2 += `<line x1="${xx}" y1="${plotB}" x2="${xx}" y2="${plotB - d2}" stroke="${INK}" stroke-width="1"/>`;
    });
    s2 += `<line x1="${plotL}" y1="${plotT}" x2="${plotL}" y2="${plotB}" stroke="${INK}" stroke-width="1.4"/>`;
    s2 += `<line x1="${plotL}" y1="${plotB}" x2="${plotR}" y2="${plotB}" stroke="${INK}" stroke-width="1.4"/>`;
    if (o.yTitle) s2 += `<text x="${mm(4, o.dpi)}" y="${plotT + plotH / 2}" font-size="${small}" fill="${INK}" text-anchor="middle" transform="rotate(-90 ${mm(4, o.dpi)} ${plotT + plotH / 2})">${esc(o.yTitle)}</text>`;
    if (o.xTitle) s2 += `<text x="${plotL + plotW / 2}" y="${H - mm(4, o.dpi)}" font-size="${small}" fill="${INK}" text-anchor="middle">${esc(o.xTitle)}</text>`;
    // category labels
    d.categories.forEach((c, i) => { s2 += `<text x="${catCenter(i)}" y="${plotB + mm(4, o.dpi)}" font-size="${fs2}" fill="${INK}" text-anchor="middle" dominant-baseline="hanging">${esc(c)}</text>`; });

    if (o.title) s2 += `<text x="${W / 2}" y="${titleY}" font-size="${(11 * o.dpi) / 72}" fill="${INK}" text-anchor="middle" dominant-baseline="middle" font-weight="600">${esc(o.title)}</text>`;
    if (legendY != null) s2 += drawLegend(o, d.series, legendY);

    return svgWrap(o, s2);
  }

  // ---- line / scatter render ----
  function renderLine(d, o, scatter) {
    const W = Math.round(mm(o.figW, o.dpi));
    const H = Math.round(mm(o.figH, o.dpi));
    o.W = W; o.H = H;
    const mL = Math.round(mm(15, o.dpi));
    const mR = Math.round(mm(8, o.dpi));
    let mB = Math.round(mm(16, o.dpi));
    let mT = Math.round(mm(8, o.dpi));
    let titleY = null, legendY = null;
    if (o.title) { titleY = mm(5.2, o.dpi); mT = Math.max(mT, Math.round(mm(9, o.dpi))); }
    if (o.legend && d.series.length > 1) { legendY = o.title ? mm(11.5, o.dpi) : mm(5.2, o.dpi); mT = Math.max(mT, o.title ? Math.round(mm(16, o.dpi)) : Math.round(mm(10, o.dpi))); }

    const plotL = mL, plotT = mT, plotW = W - mL - mR, plotH = H - mT - mB;
    const allX = d.series.flatMap((s) => s.points.map((p) => p.x));
    const allY = d.series.flatMap((s) => s.points.map((p) => p.y));
    const xt = niceTicks(Math.min(...allX), Math.max(...allX), 5);
    const yt = niceTicks(Math.min(...allY), Math.max(...allY), 5);
    const xmin = xt.niceMin, xmax = xt.niceMax;
    const ymin = yt.niceMin, ymax = yt.niceMax;
    const xPos = (v) => plotL + ((v - xmin) / (xmax - xmin)) * plotW;
    const yPos = (v) => plotT + plotH - ((v - ymin) / (ymax - ymin)) * plotH;

    const lw = (1 * o.dpi) / 72;
    const r = (2.2 * o.dpi) / 72;
    const fs = (9 * o.dpi) / 72;
    const small = (7.5 * o.dpi) / 72;
    const plotB = plotT + plotH, plotR = plotL + plotW;
    const tlen = mm(3, o.dpi);

    let s = "";
    // grid
    if (o.grid) {
      yt.ticks.forEach((v) => { const yy = yPos(v); s += `<line x1="${plotL}" y1="${yy}" x2="${plotR}" y2="${yy}" stroke="${GRID}" stroke-width="1"/>`; });
      xt.ticks.forEach((v) => { const xx = xPos(v); s += `<line x1="${xx}" y1="${plotT}" x2="${xx}" y2="${plotB}" stroke="${GRID}" stroke-width="1"/>`; });
    }
    // series
    d.series.forEach((ser) => {
      const color = seriesColors[ser.name] || "#888";
      if (!scatter && ser.points.length > 1) {
        const pts = ser.points.map((p) => `${xPos(p.x).toFixed(2)},${yPos(p.y).toFixed(2)}`).join(" ");
        s += `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="${lw}" stroke-linejoin="round" stroke-linecap="round"/>`;
      }
      ser.points.forEach((p) => {
        s += `<circle cx="${xPos(p.x).toFixed(2)}" cy="${yPos(p.y).toFixed(2)}" r="${r.toFixed(2)}" fill="${color}" stroke="#ffffff" stroke-width="${(0.6 * o.dpi / 72).toFixed(2)}"/>`;
      });
    });
    // ticks
    yt.ticks.forEach((v) => {
      const yy = yPos(v); const d2 = o.inward ? tlen : -tlen;
      s += `<line x1="${plotL}" y1="${yy}" x2="${plotL + d2}" y2="${yy}" stroke="${INK}" stroke-width="1"/>`;
      s += `<text x="${plotL - mm(3.5, o.dpi)}" y="${yy}" font-size="${fs}" fill="${INK}" text-anchor="end" dominant-baseline="middle">${esc(fmtNum(v, yt.step))}</text>`;
    });
    xt.ticks.forEach((v) => {
      const xx = xPos(v); const d2 = o.inward ? tlen : -tlen;
      s += `<line x1="${xx}" y1="${plotB}" x2="${xx}" y2="${plotB - d2}" stroke="${INK}" stroke-width="1"/>`;
      s += `<text x="${xx}" y="${plotB + mm(4, o.dpi)}" font-size="${fs}" fill="${INK}" text-anchor="middle" dominant-baseline="hanging">${esc(fmtNum(v, xt.step))}</text>`;
    });
    // axis lines
    s += `<line x1="${plotL}" y1="${plotT}" x2="${plotL}" y2="${plotB}" stroke="${INK}" stroke-width="1.4"/>`;
    s += `<line x1="${plotL}" y1="${plotB}" x2="${plotR}" y2="${plotB}" stroke="${INK}" stroke-width="1.4"/>`;
    if (o.yTitle) s += `<text x="${mm(4, o.dpi)}" y="${plotT + plotH / 2}" font-size="${small}" fill="${INK}" text-anchor="middle" transform="rotate(-90 ${mm(4, o.dpi)} ${plotT + plotH / 2})">${esc(o.yTitle)}</text>`;
    if (o.xTitle) s += `<text x="${plotL + plotW / 2}" y="${H - mm(4, o.dpi)}" font-size="${small}" fill="${INK}" text-anchor="middle">${esc(o.xTitle)}</text>`;
    if (o.title) s += `<text x="${W / 2}" y="${titleY}" font-size="${(11 * o.dpi) / 72}" fill="${INK}" text-anchor="middle" dominant-baseline="middle" font-weight="600">${esc(o.title)}</text>`;
    if (legendY != null) s += drawLegend(o, d.series, legendY);

    return svgWrap(o, s);
  }

  // ---- main update ----
  function renderSeriesColors(series) {
    seriesColorsEl.innerHTML = series.map((s) => {
      const c = seriesColors[s.name] || "#888";
      return `<span class="sc"><input type="color" value="${c}" data-name="${esc(s.name)}" /><span>${esc(s.name)}</span></span>`;
    }).join("");
    seriesColorsEl.querySelectorAll('input[type="color"]').forEach((inp) => {
      inp.addEventListener("input", () => {
        seriesColors[inp.dataset.name] = inp.value;
        update();
      });
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
    ensureColors(parsed.series);
    renderSeriesColors(parsed.series);

    let svg;
    if (currentType === "bar") svg = renderBar(parsed, o);
    else svg = renderLine(parsed, o, currentType === "scatter");

    previewEl.innerHTML = svg;
    window.__lastSVG = svg;
    window.__W = o.W; window.__H = o.H;
    dimsEl.textContent = `${o.W} × ${o.H} px · ${o.dpi} DPI · ${o.figW}×${o.figH} mm`;
    statusEl.className = "status ok";
    statusEl.textContent = `✓ 已渲染 · ${parsed.series.length} 个系列`;
  }

  // ---- export ----
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
  window.svgToPng = svgToPng; // expose for testing

  // ---- type switch ----
  typeSeg.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      typeSeg.querySelectorAll("button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      currentType = b.dataset.type;
      fmtHint.textContent = HINTS[currentType];
      // load matching example text if current text looks empty/example
      if (!dataEl.value.trim() || EXAMPLE_LOADED) {
        dataEl.value = EXAMPLES[currentType].text;
        EXAMPLE_LOADED = true;
      }
      update();
    });
  });

  let EXAMPLE_LOADED = false;
  // example buttons
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

  // live updates
  [dataEl, titleEl, xTitleEl, yTitleEl, fontEl, dpiEl, figWEl, figHEl].forEach((el) => {
    el.addEventListener("input", update);
    el.addEventListener("change", update);
  });
  [inwardEl, gridEl, legendEl].forEach((el) => el.addEventListener("change", update));

  // init
  document.getElementById("year").textContent = new Date().getFullYear();
  fmtHint.textContent = HINTS.bar;
  dataEl.value = EXAMPLES.bar.text;
  EXAMPLE_LOADED = true;
  update();
})();
