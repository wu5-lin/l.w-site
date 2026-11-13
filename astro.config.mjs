import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { offlineServiceWorker } from './integrations/offline-sw.mjs';

const site = 'https://www.l-w.sryze.cc';

export default defineConfig({
  site,
  output: 'static',
  trailingSlash: 'always',
  integrations: [
    offlineServiceWorker(),
    sitemap({
      filter: (page) => {
        const path = new URL(page).pathname;
        if (path.includes('/404')) return false;
        if (path === '/offline' || path.startsWith('/offline/')) return false;
        if (path.startsWith('/ai-particle-size-analyzer')) return false;
        if (path === '/digest' || path === '/digest/') return false;
        if (path.startsWith('/research-charts')) return false;
        if (path === '/feed.xml' || path === '/feed.xml/') return false;
        return true;
      },
    }),
  ],
  redirects: {
    '/ai-particle-size-analyzer': '/tools/particle/',
    '/digest': '/tools/digest/',
    '/research-charts': '/tools/',
  },
});
