import { getCollection } from 'astro:content';

export async function getPosts() {
  const posts = await getCollection('blog');
  return posts.sort((a, b) => b.data.date.getTime() - a.data.date.getTime());
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
