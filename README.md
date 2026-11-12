# lw 的网站

这是我的个人博客。文章是 Markdown，用 [Astro](https://astro.build) 生成静态网页，再由 GitHub Actions 发布到 GitHub Pages。线上地址是 [www.l-w.sryze.cc](https://www.l-w.sryze.cc)。

## 用编辑器写文章（推荐）

网站是静态的，没有后台账号密码。改内容用 [Pages CMS](https://pagescms.org)：用 GitHub 登录，只有这个仓库的协作者能保存。访客只能看页面。

编辑器地址：<https://app.pagescms.org/wu5-lin/l.w-site/main>

页脚最右边有一个很淡的「编辑」，也是这个地址。导航里没有入口。

### 第一次要做的事

1. 用你自己的 GitHub 账号打开上面的地址（仓库主人，或你加进来的协作者）。
2. 点 **Sign in with GitHub** 登录。不要用下面的邮箱。邮箱登录写不进这个仓库。
3. 安装并授权 **Pages CMS** 这个 GitHub App。仓库列表里只勾选 `wu5-lin/l.w-site` 就够了，不必开放全部仓库。
4. 回到编辑器。左上角的分支选 **main**。选别的分支，保存不会更新线上网站。

这一步只做一次。以后打开链接、登录，就能改。

### 写一篇文章并发布

1. 左侧点「文章」，再点新建。
2. 填标题、日期、标签、摘要和正文。标签只能选 `科研×AI`、`新手编程`、`随笔`。
3. 新建时会问文件名。改成英文短横线，例如 `lab-note`。网址会变成 `/blog/lab-note/`。不要用中文当文件名。
4. 正文里要插图：用编辑器的插图按钮，图片会存到 `public/images/`，页面上的地址是 `/images/文件名`。
5. 点保存。这会在 `main` 上提交一次。GitHub Actions 里的 “Deploy to GitHub Pages” 会自动开始，一两分钟后线上就有了。

文章里有一项「草稿」。勾上之后，这篇不会出现在首页、标签、RSS 和网站上。写到一半可以先勾着，改完再取消，保存后才会公开。写文章时用的格式可以看《Markdown 速查》。

「现在在做什么」在编辑器左侧单独一项。最上面的「布局」保持 `../layouts/Page.astro`，不要改。

### 还没合并这个改动时

编辑器要等 `.pages.yml` 出现在 `main` 上才完整。合并之前如果打开 main，可能还看不到「文章」。可以先在这个分支上看配置，但保存到分支不会发布到线上。真正给访客看，是合并之后在 **main** 上保存。

## 用文件写文章

不想用编辑器时，也可以直接新增一个 Markdown 文件。

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

3. 标签只能用这三个：`科研×AI`、`新手编程`、`随笔`。可以写一个，也可以写多个。不想公开时加上 `draft: true`，默认是公开。
4. 本地先看效果：

```bash
npm install
npm run dev
```

终端里会给出一个本地地址，用浏览器打开即可。

5. 满意之后，把改动推送到 `main` 分支。GitHub Actions 会自动构建并发布，一般一两分钟后线上就更新了。

## 改「现在在做什么」

编辑器左侧有「现在在做什么」。也可以打开 `src/pages/now.md` 改正文，再推送到 `main`。布局那一行保持 `../layouts/Page.astro`。

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

这次推送用的是 Actions 自带的令牌。GitHub 不会让这种推送再触发「推送到 main 就发布」，所以 `deploy.yml` 在简报工作流成功结束后，再按 `main` 上的最新提交构建并发布。它监听的名字必须和 `digest.yml` 第一行完全一样（`Refresh Digest (投资/科研/web3/科技)`），写短了就不会发布。

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
