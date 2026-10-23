/* =========================================================
   LW · 输入增强
   为所有 <input type="range"> 自动补一个数字输入框：
   - 可直接键入精确值，不必再拖鼠标
   - 滑块与数字框双向同步（含程序化赋值）
   - 失焦时自动规范化到 [min, max]
   ========================================================= */
(function () {
  "use strict";

  function clamp(v, min, max) {
    if (isNaN(v)) return null;
    if (min !== "" && min != null && v < +min) v = +min;
    if (max !== "" && max != null && v > +max) v = +max;
    return v;
  }

  var ranges = Array.prototype.slice.call(document.querySelectorAll('input[type="range"]'));
  if (!ranges.length) return;

  ranges.forEach(function (r) {
    // 若已增强过则跳过（避免重复）
    if (r.dataset.enhanced === "1") return;
    r.dataset.enhanced = "1";

    var row = document.createElement("div");
    row.className = "range-row";
    r.parentNode.insertBefore(row, r);
    row.appendChild(r);

    var num = document.createElement("input");
    num.type = "number";
    num.className = "range-num";
    num.inputMode = "decimal";
    if (r.min !== "") num.min = r.min;
    if (r.max !== "") num.max = r.max;
    num.step = r.step || "1";
    num.value = r.value;

    // 无障碍：沿用同一 field 的标题文本作为标签
    var field = r.closest ? r.closest(".field") : null;
    var span = field ? field.querySelector("span") : null;
    if (span) num.setAttribute("aria-label", span.textContent.replace(/\s+/g, " ").trim());

    row.appendChild(num);

    // typing 标记：用户正在数字框输入时，避免回写打断输入
    var typing = false;

    // 数字框 → 滑块
    num.addEventListener("input", function () {
      var v = clamp(parseFloat(num.value), r.min, r.max);
      if (v === null) return;              // 空或非法字符：暂不处理
      typing = true;
      if (String(v) !== r.value) {
        r.value = v;                       // 走下方自定义 setter
        r.dispatchEvent(new Event("input", { bubbles: true }));
      }
      typing = false;
    });

    // 失焦：把数字框回填为规范值
    num.addEventListener("blur", function () {
      var v = clamp(parseFloat(num.value), r.min, r.max);
      num.value = (v === null) ? r.value : v;
    });

    // 滑块拖拽 → 数字框
    function pull() { if (!typing) num.value = r.value; }
    r.addEventListener("input", pull);
    r.addEventListener("change", pull);

    // 程序化赋值（r.value = X）也要同步数字框：
    // 在实例上重定义 value 访问器，拦截所有赋值
    try {
      var proto = Object.getPrototypeOf(r);
      var desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.get && desc.set) {
        Object.defineProperty(r, "value", {
          configurable: true,
          get: function () { return desc.get.call(this); },
          set: function (v) {
            desc.set.call(this, v);
            if (num && !typing) num.value = v;
          }
        });
      }
    } catch (e) { /* 极端环境下退化为仅事件同步 */ }
  });
})();