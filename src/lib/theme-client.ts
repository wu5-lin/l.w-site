import { createHash } from 'node:crypto';

/** Browser chrome and page background. Kept in one place so the meta tags and the boot script match. */
export const THEME_COLOR = {
  light: '#fafafa',
  dark: '#111111',
} as const;

/**
 * Runs from the document head, before first paint.
 * A saved lw-theme wins over the system preference; otherwise the media-query
 * theme-color tags are left alone.
 */
export const themeBootSource = `(function () {
  var LIGHT = ${JSON.stringify(THEME_COLOR.light)};
  var DARK = ${JSON.stringify(THEME_COLOR.dark)};
  function paint(theme) {
    var color = theme === 'dark' ? DARK : LIGHT;
    var nodes = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].setAttribute('content', color);
      nodes[i].removeAttribute('media');
    }
  }
  try {
    var saved = localStorage.getItem('lw-theme');
    if (saved === 'light' || saved === 'dark') {
      document.documentElement.dataset.theme = saved;
      paint(saved);
    }
  } catch (e) {}
  function bind() {
    var btn = document.getElementById('theme-toggle');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var root = document.documentElement;
      var current = root.dataset.theme;
      if (!current) {
        current = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      }
      var next = current === 'dark' ? 'light' : 'dark';
      root.dataset.theme = next;
      try { localStorage.setItem('lw-theme', next); } catch (e) {}
      paint(next);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
`;

export const swRegisterSource = `if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(function () {});
}
`;

/** CSP hash of an inline script body. The emitted text must match this string exactly. */
export function sourceHash(source: string): string {
  return `'sha256-${createHash('sha256').update(source).digest('base64')}'`;
}

export const inlineScriptCsp = [themeBootSource, swRegisterSource].map(sourceHash).join(' ');
