#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AI 资讯自动抓取脚本
==================
从公开 RSS / API 抓取前沿 AI 动态，去重 -> 按 AI 关键词打分 -> 取最新 N 条，
写入本目录下的 news.json（网站会自动读取并渲染）。

用法：
    python fetch_news.py            # 抓取并生成 news.json
    python fetch_news.py --push     # 抓取生成后，自动 git add/commit/push（需本地已配好 git 与远程）

依赖：仅 Python 标准库（无需 pip install）。建议 Python 3.10+。
"""

import json
import os
import re
import ssl
import sys
import html
import urllib.request
import urllib.error
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import xml.etree.ElementTree as ET

# ---------------------------------------------------------------------------
# 可配置：信息源（中英混合）。想增删源，直接改这里即可。
# type: rss（RSS 2.0 / Atom 通用）| hn（Hacker News Algolia API）| arxiv（arXiv RSS）
# ---------------------------------------------------------------------------
SOURCES = [
    # ---- 中文高质量科技 / 财经源（均已实测可用 RSS）----
    {"name": "钛媒体", "lang": "zh", "type": "rss",
     "url": "https://www.tmtpost.com/rss.xml"},
    {"name": "少数派", "lang": "zh", "type": "rss",
     "url": "https://sspai.com/feed"},
    {"name": "极客公园", "lang": "zh", "type": "rss",
     "url": "https://www.geekpark.net/rss"},
    {"name": "量子位", "lang": "zh", "type": "rss",
     "url": "https://www.qbitai.com/feed"},
    {"name": "爱范儿", "lang": "zh", "type": "rss",
     "url": "https://www.ifanr.com/feed"},
    {"name": "IT之家", "lang": "zh", "type": "rss",
     "url": "https://www.ithome.com/rss/"},
    {"name": "新智元", "lang": "zh", "type": "rss",
     "url": "https://www.zdzn.com/feed"},
    {"name": "虎嗅", "lang": "zh", "type": "rss",
     "url": "https://www.huxiu.com/rss/0.xml"},
    # ---- 雪球·今日话题（自动获取访客 token；本机家宽可抓，云端可能被 WAF 跳过；
    #      若想云端也稳定，可在环境变量配置登录 token：XQ_TOKEN=xxxx）----
    {"name": "雪球·今日话题", "lang": "zh", "type": "xueqiu",
     "url": "https://xueqiu.com/statuses/hot/listV2.json?since_id=-1&size=20"},
    # ---- 英文一手前沿源 ----
    {"name": "MIT Tech Review", "lang": "en", "type": "rss",
     "url": "https://www.technologyreview.com/topic/artificial-intelligence/feed"},
    {"name": "The Verge AI", "lang": "en", "type": "rss",
     "url": "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml"},
    {"name": "Ars Technica", "lang": "en", "type": "rss",
     "url": "https://arstechnica.com/feed/"},
    {"name": "TechCrunch AI", "lang": "en", "type": "rss",
     "url": "https://techcrunch.com/category/artificial-intelligence/feed/"},
    {"name": "VentureBeat AI", "lang": "en", "type": "rss",
     "url": "https://venturebeat.com/category/ai/feed/"},
    {"name": "OpenAI", "lang": "en", "type": "rss",
     "url": "https://openai.com/blog/rss.xml"},
    {"name": "arXiv cs.AI", "lang": "en", "type": "arxiv",
     "url": "https://export.arxiv.org/rss/cs.AI"},
    {"name": "Hacker News", "lang": "en", "type": "hn",
     "url": "https://hn.algolia.com/api/v1/search?query=artificial%20intelligence&tags=story&hitsPerPage=25"},
]

# 相关关键词（命中越多分越高；标题命中权重更大）。覆盖 AI / 科技 / 财经。
KEYWORDS = [
    "ai", "artificial intelligence", "gpt", "llm", "large language model",
    "openai", "anthropic", "claude", "gemini", "deepseek", "qwen", "llama",
    "agent", "multimodal", "multi-modal", "diffusion", "neural", "machine learning",
    "deep learning", "transformer", "rag", "fine-tune", "nvidia", "chip", "gpu",
    "robotics", "reinforcement learning", "computer vision", "nlp", "generative",
    "人工智能", "大模型", "语言模型", "多模态", "智能体", "机器学习", "深度学习",
    "神经网络", "生成式", "推理", "训练", "开源模型", "机器人", "芯片", "算力", "agent",
    "科技", "创业", "投资", "财经", "融资", "财报", "股价", "基金", "半导体",
    "新能源", "开源", "量子", "航天", "区块链", "加密", "政策", "市场", "数据",
]

MAX_ITEMS = 12      # 最终保留的资讯条数
FRESH_DAYS = 60     # 只保留最近 N 天内的内容
USER_AGENT = "Mozilla/5.0 (compatible; LynnAINewsBot/1.0)"

SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE


# ---------------------------------------------------------------------------
# 网络 / 解析工具
# ---------------------------------------------------------------------------
def fetch(url, timeout=15, headers=None):
    h = {"User-Agent": USER_AGENT}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=timeout, context=SSL_CTX) as r:
        return r.read().decode("utf-8", "ignore")


def text_of(el):
    if el is None or el.text is None:
        return ""
    return el.text.strip()


def strip_html(s):
    if not s:
        return ""
    s = re.sub(r"<[^>]+>", " ", s)
    s = html.unescape(s)
    return re.sub(r"\s+", " ", s).strip()


def clean_title(s):
    return strip_html(s)[:160]


def parse_date(s):
    if not s:
        return None
    s = s.strip()
    try:
        dt = parsedate_to_datetime(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        pass
    s2 = s.replace("Z", "+00:00")
    for fmt in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%S.%f%z",
                "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            if "T" in s2:
                return datetime.fromisoformat(s2)
            return datetime.strptime(s, fmt).replace(tzinfo=timezone.utc)
        except Exception:
            continue
    return None


def atom_link(entry, ns):
    for l in entry.findall(ns + "link"):
        if l.get("rel") in (None, "alternate"):
            return l.get("href") or ""
    l = entry.find(ns + "link")
    return l.get("href") if l is not None else ""


def mk_item(title, link, summ, date, src):
    return {
        "title": clean_title(title),
        "url": (link or "").strip(),
        "summary": strip_html(summ),
        "date": date,
        "source": src["name"],
        "lang": src["lang"],
    }


def parse_feed(raw, src):
    out = []
    try:
        root = ET.fromstring(raw)
    except Exception:
        return out

    if root.tag.lower().endswith("feed"):  # Atom
        ns = "{http://www.w3.org/2005/Atom}"
        for e in root.findall(ns + "entry"):
            title = text_of(e.find(ns + "title"))
            link = atom_link(e, ns)
            summ = text_of(e.find(ns + "summary")) or text_of(e.find(ns + "content"))
            date = parse_date(text_of(e.find(ns + "updated")) or text_of(e.find(ns + "published")))
            if title:
                out.append(mk_item(title, link, summ, date, src))
    else:  # RSS 2.0
        ch = root.find("channel")
        items = ch.findall("item") if ch is not None else []
        dc = "{http://purl.org/dc/elements/1.1/}"
        for it in items:
            title = text_of(it.find("title"))
            link = text_of(it.find("link"))
            summ = text_of(it.find("description"))
            date_el = it.find("pubDate")
            if date_el is None:
                date_el = it.find(dc + "date")
            date = parse_date(text_of(date_el))
            if title:
                out.append(mk_item(title, link, summ, date, src))
    return out


def parse_hn(raw, src):
    out = []
    try:
        data = json.loads(raw)
    except Exception:
        return out
    for h in data.get("hits", []):
        title = h.get("title") or h.get("story_title")
        if not title:
            continue
        oid = h.get("objectID", "")
        url = h.get("url") or ("https://news.ycombinator.com/item?id=" + str(oid))
        summ = h.get("story_text") or ""
        date = parse_date(h.get("created_at", ""))
        out.append(mk_item(title, url, summ, date, src))
    return out


# ---------------------------------------------------------------------------
# 雪球·今日话题（接口：/statuses/hot/listV2.json）
# 雪球有阿里云 WAF 反爬，需要先拿到 xq_a_token 访客 Cookie 才能请求接口。
# 策略：① 优先用环境变量 XQ_TOKEN（用户登录后复制的 token，最稳）；
#      ② 否则自动访问首页拿访客 token（家宽本机通常可直接拿到；
#         云服务器 IP 可能触发 JS 挑战导致拿不到，此时自动跳过）。
# ---------------------------------------------------------------------------
def get_xueqiu_token():
    # ① 环境变量（可填裸 token 或完整 cookie 串）
    env = os.environ.get("XQ_TOKEN", "").strip()
    if env:
        return env if env.startswith("xq_a_token=") else "xq_a_token=" + env
    # ② 自动获取访客 token：访问首页，从 Set-Cookie 读取 xq_a_token
    try:
        req = urllib.request.Request("https://xueqiu.com/", headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=15, context=SSL_CTX) as r:
            for c in (r.headers.get_all("Set-Cookie") or []):
                m = re.search(r"xq_a_token=([A-Za-z0-9_]+)", c)
                if m:
                    return "xq_a_token=" + m.group(1)
    except Exception:
        pass
    return None


def fetch_xueqiu(src):
    token = get_xueqiu_token()
    if not token:
        print("  [提示] 雪球 未能获取访客 token（可能被 WAF 拦截，建议在本机运行；"
              "或设置 XQ_TOKEN 环境变量），已暂时跳过。")
        return []
    raw = fetch(src["url"], headers={
        "Referer": "https://xueqiu.com/",
        "Accept": "application/json",
        "Cookie": token,
    })
    return parse_xueqiu(raw, src)


def parse_xueqiu(raw, src):
    out = []
    try:
        data = json.loads(raw)
    except Exception:
        return out
    # listV2.json 结构：data["items"] -> 每条含 original_status（转发的原帖）
    arr = data.get("items") or data.get("list") or []
    for it in arr:
        st = it.get("original_status") or it
        title = (st.get("title") or st.get("rawTitle")
                 or strip_html(st.get("description", ""))).strip()
        if not title:
            continue
        target = st.get("target") or ""
        if target.startswith("/"):
            url = "https://xueqiu.com" + target
        else:
            url = target or "https://xueqiu.com/"
        summ = st.get("description") or ""
        ca = st.get("created_at")
        date = parse_date(ca) if ca else None
        out.append(mk_item(title, url, summ, date, src))
    return out


# ---------------------------------------------------------------------------
# 打分 / 去重 / 筛选
# ---------------------------------------------------------------------------
def score_of(it):
    text = (it["title"] + " " + it["summary"]).lower()
    s = 0
    for k in KEYWORDS:
        if k in text:
            s += 3 if k in it["title"].lower() else 1
    return s


def norm(s):
    return re.sub(r"\W+", "", (s or "").lower())


def collect():
    all_items = []
    for src in SOURCES:
        try:
            if src["type"] == "xueqiu":
                items = fetch_xueqiu(src)
            else:
                raw = fetch(src["url"])
                items = parse_hn(raw, src) if src["type"] == "hn" else parse_feed(raw, src)
            print(f"  [OK]   {src['name']:<18} 抓到 {len(items)} 条")
            all_items.extend(items)
        except Exception as e:
            print(f"  [跳过] {src['name']:<18} 失败：{e}")
    return all_items


def build(all_items):
    now = datetime.now(timezone.utc)
    seen_url, seen_title, merged = set(), set(), []
    for it in all_items:
        u, t = norm(it["url"]), norm(it["title"])
        if u and u in seen_url:
            continue
        if t and t in seen_title:
            continue
        seen_url.add(u)
        seen_title.add(t)
        it["score"] = score_of(it)
        merged.append(it)

    def age_days(it):
        if not it["date"]:
            return 14  # 无日期的条目按"约两周前"处理，降权但不丢弃
        return max(0, (now - it["date"]).days)

    def combined(it):
        # 相关度 × 时效衰减（约每 7 天减半）
        recency = 1.0 / (1.0 + age_days(it) / 7.0)
        return it["score"] * recency

    # 先按"相关度×时效"总排序
    ranked = sorted(merged, key=combined, reverse=True)

    # 每源最多保留 PER_SOURCE 条，保证来源多样
    PER_SOURCE = 3
    by_src, picked, picked_ids = {}, [], set()
    for m in ranked:
        s = m["source"]
        by_src.setdefault(s, 0)
        if by_src[s] >= PER_SOURCE:
            continue
        by_src[s] += 1
        picked.append(m)
        picked_ids.add(id(m))

    # 若不足 MAX_ITEMS（部分源条目少），放开上限补满
    if len(picked) < MAX_ITEMS:
        for m in ranked:
            if id(m) in picked_ids:
                continue
            picked.append(m)
            picked_ids.add(id(m))
            if len(picked) >= MAX_ITEMS:
                break

    # 输出按日期倒序，阅读更自然
    picked.sort(key=lambda m: m["date"] or datetime.min.replace(tzinfo=timezone.utc),
                 reverse=True)
    return picked[:MAX_ITEMS]


def fmt(it):
    d = it["date"]
    return {
        "date": d.strftime("%Y-%m-%d") if d else "",
        "tag": it["source"],
        "title": it["title"],
        "summary": it["summary"],
        "url": it["url"],
        "source": it["source"],
    }


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    out_path = os.path.join(here, "news.json")

    print("开始抓取 AI 资讯…")
    items = collect()
    print(f"合计原始条目：{len(items)}")

    top = build(items)
    payload = {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M"),
        "items": [fmt(m) for m in top],
    }

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    print(f"已写入 {out_path}（{len(top)} 条）")
    for m in top:
        print(f"   - {m['date']} [{m['source']}] {m['title'][:50]}")

    if "--push" in sys.argv:
        try:
            import subprocess
            subprocess.run(["git", "add", "news.json"], check=True, cwd=here)
            subprocess.run(["git", "commit", "-m", "auto: update AI news"], check=True, cwd=here)
            subprocess.run(["git", "push"], check=True, cwd=here)
            print("已自动推送到远程仓库（GitHub Pages 将自动重新发布）。")
        except Exception as e:
            print("git 推送失败（需本地已配置 git 与远程）：", e)


if __name__ == "__main__":
    main()
