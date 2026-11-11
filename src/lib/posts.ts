import { getCollection } from 'astro:content';

async function loadPosts() {
  const posts = await getCollection('blog');
  return posts.sort((a, b) => b.data.date.getTime() - a.data.date.getTime());
}

/** 已发布的文章。草稿不进首页、列表、标签页和 RSS。 */
export async function getPosts() {
  const posts = await loadPosts();
  return posts.filter((post) => !post.data.draft);
}

/**
 * 生产构建只生成已发布文章的页面。
 * 本地 `astro dev` 仍会生成草稿页面，方便自己打开链接预览，但列表里看不到。
 */
export async function getPostsForPaths() {
  const posts = await loadPosts();
  if (import.meta.env.PROD) return posts.filter((post) => !post.data.draft);
  return posts;
}

export function formatDate(date: Date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}.${m}.${d}`;
}

export function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

export function readingMinutes(text: string | undefined) {
  const raw = text ?? '';
  const cjk = (raw.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const words = raw
    .replace(/[\u4e00-\u9fff]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  return Math.max(1, Math.round(cjk / 400 + words / 220));
}
