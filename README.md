# lw 的网站

这是我的个人博客。文章是 Markdown，用 [Astro](https://astro.build) 生成静态网页，再由 GitHub Actions 发布到 GitHub Pages。线上地址是 [www.l-w.sryze.cc](https://www.l-w.sryze.cc)。

## 写一篇新文章

只要新增一个 Markdown 文件。

1. 在 `src/content/blog/` 里新建文件。文件名用英文和短横线，例如 `my-note.md`。这个文件名会变成网址：`/blog/my-note/`。
2. 开头照下面抄，改成自己的标题、日期、标签和摘要：

```md
---
title: 文章标题
date: 2026-11-11
tags:
  - 随笔
summary: 一句话摘要，会出现在首页列表里。
---

正文从这里开始写。
```

3. 标签只能用这三个：`科研×AI`、`新手编程`、`随笔`。可以写一个，也可以写多个。
4. 本地先看效果：

```bash
npm install
npm run dev
```

终端里会给出一个本地地址，用浏览器打开即可。

5. 满意之后，把改动推送到 `main` 分支。GitHub Actions 会自动构建并发布，一般一两分钟后线上就更新了。

## 改「现在在做什么」

打开 `src/pages/now.md`，改正文，保存，再推送到 `main`。

## 发布前要改的一项设置

网站不再把仓库里的 HTML 直接当成网页。每次推送都会先用 Astro 构建，再由 Actions 发布构建结果。

**请打开仓库的 Settings → Pages → Build and deployment，把 Source 改成 GitHub Actions。**

建议在合并这次改动**之前**就改好：

- 先改 Source。旧网站会暂时保持上一次发布的样子，不会立刻坏掉。
- 再合并。Actions 跑完后，新网站上线。

如果先合并、Source 还是 “Deploy from a branch”，Pages 会把仓库根目录直接发出去。根目录里已经没有原来的 `index.html`，首页会暂时打不开。这时把 Source 改成 GitHub Actions，再在 Actions 里重跑 “Deploy to GitHub Pages” 即可。

自定义域名继续用 `www.l-w.sryze.cc`，不要删掉。`public/CNAME` 会在每次发布时一起带上。

## 每日简报

`.github/workflows/digest.yml` 每天北京时间 09:00 抓取公开 RSS，只写入 `public/tools/digest/digest.json`，不再改 HTML。

这次推送不会直接触发别的 Actions（GitHub 的默认令牌有这个限制），所以 `deploy.yml` 另外监听了简报工作流：简报成功写完并推送后，会再构建、发布一次。

简报页面在 `/tools/digest/`。首页不放入口，只有「工具」页和页脚的小链接。

## 粒径分析

页面在 `/tools/particle/`。算法是阈值、形态学和分水岭，不是深度学习。OpenCV.js 只在打开这个页面时从 jsDelivr 下载，仓库里不再保存那个十几 MB 的文件。

## 旧地址

这些地址会跳到新页面，以前的链接不会直接 404：

| 旧地址 | 新地址 |
| --- | --- |
| `/ai-particle-size-analyzer/` | `/tools/particle/` |
| `/digest/` | `/tools/digest/` |
| `/research-charts/` | `/tools/`（图表生成器已去掉） |
| `/feed.xml` | 仍返回一份很短的 RSS，说明订阅已改到 `/rss.xml`（GitHub Pages 不能对这个文件做 HTTP 跳转） |
