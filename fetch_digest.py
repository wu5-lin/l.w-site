#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
多类别信息源聚合脚本（投资 / 科研 / web3 / 科技）
================================================
从公开 RSS / API 抓取多类别动态，按类别分组、去重、按时效排序，
写入本目录下的 digest.json（digest/ 页面会自动读取并渲染）。

类别：投资（含国内/国际）、科研、web3、科技
地区：region = "cn"（国内） / "en"（国际）

用法：
    python fetch_digest.py          # 抓取并生成 digest.json
    python fetch_digest.py --push   # 抓取生成后，自动 git add/commit/push digest.json

依赖：仅 Python 标准库（无需 pip install）。建议 Python 3.10+。

说明：部分源（尤其国际财经）在云端也可能被反爬，脚本对单个源失败一律跳过，
不会中断整体；缺失的类别会在下次成功抓取时补回。
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
# 可调参数
# ---------------------------------------------------------------------------
CATEGORIES = ["投资", "科研", "web3", "科技"]
PER_CATEGORY = 16      # 每个类别最终保留的条数
PER_SOURCE = 4         # 每个来源在每个类别里最多保留的条数（保证来源多样）
USER_AGENT = "Mozilla/5.0 (compatible; LWDigestBot/1.0)"

SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE

# ---------------------------------------------------------------------------
# 信息源（想增删源，直接改这里；type 支持 rss / atom / hn / arxiv / xueqiu）
# ---------------------------------------------------------------------------
SOURCES = [
    # ---------------- 投资 · 国内 ----------------
    {"name": "雪球·今日话题", "category": "投资", "region": "cn", "type": "xueqiu",
     "url": "https://xueqiu.com/statuses/hot/listV2.json?since_id=-1&size=20"},
    {"name": "36氪", "category": "投资", "region": "cn", "type": "rss",
     "url": "https://36kr.com/feed"},
    {"name": "华尔街见闻", "category": "投资", "region": "cn", "type": "rss",
     "url": "https://www.wallstreetcn.com/rss"},
    {"name": "新浪财经", "category": "投资", "region": "cn", "type": "rss",
     "url": "https://finance.sina.com.cn/roll/index.d.html"},

    # ---------------- 投资 · 国际 ----------------
    {"name": "CNBC Markets", "category": "投资", "region": "en", "type": "rss",
     "url": "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664"},
    {"name": "MarketWatch", "category": "投资", "region": "en", "type": "rss",
     "url": "https://www.marketwatch.com/rss/topstories"},
    {"name": "Seeking Alpha", "category": "投资", "region": "en", "type": "rss",
     "url": "https://seekingalpha.com/market_currents.xml"},
    {"name": "Financial Times", "category": "投资", "region": "en", "type": "rss",
     "url": "https://www.ft.com/?format=rss"},
    {"name": "The Block", "category": "投资", "region": "en", "type": "rss",
     "url": "https://www.theblock.co/rss.xml"},

    # ---------------- 科研 ----------------
    {"name": "arXiv cs.AI", "category": "科研", "region": "en", "type": "arxiv",
     "url": "https://export.arxiv.org/rss/cs.AI"},
    {"name": "arXiv cs.LG", "category": "科研", "region": "en", "type": "arxiv",
     "url": "https://export.arxiv.org/rss/cs.LG"},
    {"name": "arXiv 材料", "category": "科研", "region": "en", "type": "arxiv",
     "url": "https://export.arxiv.org/rss/cond-mat.mtrl-sci"},
    {"name": "arXiv 应用物理", "category": "科研", "region": "en", "type": "arxiv",
     "url": "https://export.arxiv.org/rss/physics.app-ph"},
    {"name": "Nature 材料", "category": "科研", "region": "en", "type": "rss",
     "url": "https://www.nature.com/subjects/materials-science.rss"},
    {"name": "Science 新闻", "category": "科研", "region": "en", "type": "rss",
     "url": "https://www.science.org/rss/news_current.xml"},
    {"name": "ScienceDaily 材料", "category": "科研", "region": "en", "type": "rss",
     "url": "https://www.sciencedaily.com/rss/matter_energy.xml"},

    # ---------------- web3 / 加密 ----------------
    {"name": "CoinDesk", "category": "web3", "region": "en", "type": "rss",
     "url": "https://www.coindesk.com/arc/outboundfeeds/rss/"},
    {"name": "Cointelegraph", "category": "web3", "region": "en", "type": "rss",
     "url": "https://cointelegraph.com/rss"},
    {"name": "Decrypt", "category": "web3", "region": "en", "type": "rss",
     "url": "https://decrypt.co/feed"},
    {"name": "巴比特", "category": "web3", "region": "cn", "type": "rss",
     "url": "https://www.8btc.com/feed"},
    {"name": "PANews", "category": "web3", "region": "cn", "type": "rss",
     "url": "https://www.panews.com/rss"},

    # ---------------- 科技 / AI（沿用现有高质量源） ----------------
    {"name": "钛媒体", "category": "科技", "region": "cn", "type": "rss",
     "url": "https://www.tmtpost.com/rss.xml"},
    {"name": "少数派", "category": "科技", "region": "cn", "type": "rss",
     "url": "https://sspai.com/feed"},
    {"name": "极客公园", "category": "科技", "region": "cn", "type": "rss",
     "url": "https://www.geekpark.net/rss"},
    {"name": "量子位", "category": "科技", "region": "cn", "type": "rss",
     "url": "https://www.qbitai.com/feed"},
    {"name": "爱范儿", "category": "科技", "region": "cn", "type": "rss",
     "url": "https://www.ifanr.com/feed"},
    {"name": "IT之家", "category": "科技", "region": "cn", "type": "rss",
     "url": "https://www.ithome.com/rss/"},
    {"name": "新智元", "category": "科技", "region": "cn", "type": "rss",
     "url": "https://www.zdzn.com/feed"},
    {"name": "虎嗅", "category": "科技", "region": "cn", "type": "rss",
     "url": "https://www.huxiu.com/rss/0.xml"},
    {"name": "MIT Tech Review", "category": "科技", "region": "en", "type": "rss",
     "url": "https://www.technologyreview.com/topic/artificial-intelligence/feed"},
    {"name": "The Verge AI", "category": "科技", "region": "en", "type": "rss",
     "url": "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml"},
    {"name": "Ars Technica", "category": "科技", "region": "en", "type": "rss",
     "url": "https://arstechnica.com/feed/"},
    {"name": "TechCrunch AI", "category": "科技", "region": "en", "type": "rss",
     "url": "https://techcrunch.com/category/artificial-intelligence/feed/"},
    {"name": "VentureBeat AI", "category": "科技", "region": "en", "type": "rss",
     "url": "https://venturebeat.com/category/ai/feed/"},
    {"name": "OpenAI", "category": "科技", "region": "en", "type": "rss",
     "url": "https://openai.com/blog/rss.xml"},
    {"name": "Hacker News", "category": "科技", "region": "en", "type": "hn",
     "url": "https://hn.algolia.com/api/v1/search?query=artificial%20intelligence&tags=story&hitsPerPage=30"},
]


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
        "tag": src["name"],
        "lang": src.get("region", "en"),
        "region": src.get("region", "en"),
        "category": src["category"],
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
    env = os.environ.get("XQ_TOKEN", "").strip()
    if env:
        return env if env.startswith("xq_a_token=") else "xq_a_token=" + env
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
        print("  [提示] 雪球 未能获取访客 token（可能被 WAF 拦截，建议设置 XQ_TOKEN 环境变量），已暂时跳过。")
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
# 抓取 / 分组 / 去重 / 筛选
# ---------------------------------------------------------------------------
def collect():
    all_items = []
    for src in SOURCES:
        try:
            if src["type"] == "xueqiu":
                items = fetch_xueqiu(src)
            elif src["type"] == "hn":
                items = parse_hn(fetch(src["url"]), src)
            else:
                items = parse_feed(fetch(src["url"]), src)
            print(f"  [OK]   {src['category']:<4} {src['name']:<18} 抓到 {len(items)} 条")
            all_items.extend(items)
        except Exception as e:
            print(f"  [跳过] {src['category']:<4} {src['name']:<18} 失败：{e}")
    return all_items


def norm(s):
    return re.sub(r"\W+", "", (s or "").lower())


def build(all_items):
    now = datetime.now(timezone.utc)
    seen_url, seen_title = set(), set()
    merged = []
    for it in all_items:
        u, t = norm(it["url"]), norm(it["title"])
        if u and u in seen_url:
            continue
        if t and t in seen_title:
            continue
        seen_url.add(u)
        seen_title.add(t)
        merged.append(it)

    # 全局按日期倒序，便于后续每类挑选最新
    merged.sort(key=lambda m: m["date"] or datetime.min.replace(tzinfo=timezone.utc),
                reverse=True)

    # 每类：先按来源分散（每源最多 PER_SOURCE），再封顶 PER_CATEGORY
    result = {c: [] for c in CATEGORIES}
    by_src = {}
    picked_ids = set()
    for m in merged:
        c = m["category"]
        if c not in result:
            continue
        s = m["source"]
        by_src.setdefault((c, s), 0)
        if by_src[(c, s)] >= PER_SOURCE:
            continue
        by_src[(c, s)] += 1
        result[c].append(m)
        picked_ids.add(id(m))

    # 若某类不足 PER_CATEGORY，放开每源上限补满
    for c in CATEGORIES:
        if len(result[c]) >= PER_CATEGORY:
            continue
        for m in merged:
            if id(m) in picked_ids or m["category"] != c:
                continue
            result[c].append(m)
            picked_ids.add(id(m))
            if len(result[c]) >= PER_CATEGORY:
                break

    # 最终每类按日期倒序
    for c in CATEGORIES:
        result[c].sort(key=lambda m: m["date"] or datetime.min.replace(tzinfo=timezone.utc),
                       reverse=True)
        result[c] = result[c][:PER_CATEGORY]
    return result


def fmt(it):
    d = it["date"]
    return {
        "date": d.strftime("%Y-%m-%d") if d else "",
        "tag": it["source"],
        "title": it["title"],
        "summary": it["summary"],
        "url": it["url"],
        "source": it["source"],
        "region": it["region"],
        "category": it["category"],
    }


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    out_path = os.path.join(here, "digest.json")

    print("开始抓取多类别资讯…")
    items = collect()
    print(f"合计原始条目：{len(items)}")

    cats = build(items)
    payload = {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "categories": {c: [fmt(m) for m in cats.get(c, [])] for c in CATEGORIES},
    }

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    total = sum(len(v) for v in payload["categories"].values())
    print(f"已写入 {out_path}（共 {total} 条）")
    for c in CATEGORIES:
        print(f"   - {c}: {len(payload['categories'][c])} 条")

    if "--push" in sys.argv:
        try:
            import subprocess
            subprocess.run(["git", "add", "digest.json"], check=True, cwd=here)
            subprocess.run(["git", "commit", "-m", "auto: update digest"], check=True, cwd=here)
            subprocess.run(["git", "push"], check=True, cwd=here)
            print("已自动推送到远程仓库（GitHub Pages 将自动重新发布）。")
        except Exception as e:
            print("git 推送失败（需本地已配置 git 与远程）：", e)


if __name__ == "__main__":
    main()
