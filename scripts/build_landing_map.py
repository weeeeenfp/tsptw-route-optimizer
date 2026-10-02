#!/usr/bin/env python3
"""產生首頁（index.html）衛星俯瞰動畫用的真實路網線稿與配送路線。

資料來源：OpenStreetMap（ODbL）經 Overpass API 取得路網。
站點座標取自範例測資 bast 的排程結果。

首頁是對外頁面，產出的 HTML **不含任何地名、店名或經緯度**：站點只以
「第 N 站」與預計抵達時間呈現。要換地區或站點請改本檔的 bbox 與 STOPS。

路線不是隨手畫的折線：以 OSM 路網建圖後，對相鄰兩站跑 Dijkstra 取最短路徑，
因此動畫中的路線會沿著背景的實際道路走。

重跑方式：
    # 1) 取得原始路網（bbox 已涵蓋所有站點）
    curl -s -X POST --data-binary @scripts/landing_map.overpassql \
         https://overpass-api.de/api/interpreter -o /tmp/osm.json
    # 2) 產生 SVG 片段與站點資料
    python scripts/build_landing_map.py /tmp/osm.json

輸出 `scripts/landing_map.generated.svg`（可直接貼進 index.html 的 .sat 區塊）。
"""
from __future__ import annotations

import heapq
import io
import json
import math
import pathlib
import sys
from collections import defaultdict

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT_SVG = ROOT / "scripts" / "landing_map.generated.svg"

# 畫布寬度固定 800，高度依實際地理範圍的長寬比推算
CANVAS_W = 800.0
CANVAS_H_TARGET = 430.0
MARGIN = 26.0

# 道路分級 → 線寬（線稿的層次感靠這個，不靠顏色）
ROAD_CLASS = {
    "motorway": ("major", 3.4), "trunk": ("major", 3.4), "primary": ("major", 2.8),
    "motorway_link": ("major", 2.0), "trunk_link": ("major", 2.0), "primary_link": ("major", 2.0),
    "secondary": ("mid", 2.1), "secondary_link": ("mid", 1.5),
    "tertiary": ("mid", 1.6), "tertiary_link": ("mid", 1.2),
    "residential": ("minor", 0.9), "unclassified": ("minor", 0.9), "living_street": ("minor", 0.8),
}

# 送貨站點：經緯度取自範例測資 bast 排程結果，順序＝系統實際排出的配送順序。
# 首頁是對外頁面，刻意不帶店家名稱——產出的 HTML 只會有「第 N 站」與預計抵達時間，
# 不標任何真實地點，頁面上也不顯示經緯度。
STOPS = [
    (24.14525, 120.73010, "09:00", True),
    (24.15178, 120.72959, "09:05", False),
    (24.14912, 120.72128, "09:18", False),
    (24.14743, 120.71344, "09:31", False),
    (24.14187, 120.70982, "09:43", False),
    (24.12979, 120.70568, "09:57", False),
    (24.12655, 120.71118, "10:09", False),
    (24.13251, 120.72414, "10:23", False),
    (24.13935, 120.73190, "10:38", False),
    (24.14373, 120.73388, "10:49", False),
]


def merc(lat: float, lon: float) -> tuple[float, float]:
    """Web Mercator（單位任意，後面會等比縮放到畫布）。"""
    x = math.radians(lon)
    y = math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
    return x, y


def haversine(a: tuple[float, float], b: tuple[float, float]) -> float:
    """兩點實際距離（公尺），作為圖的邊權重。"""
    lat1, lon1 = a
    lat2, lon2 = b
    p = math.pi / 180
    h = (0.5 - math.cos((lat2 - lat1) * p) / 2
         + math.cos(lat1 * p) * math.cos(lat2 * p) * (1 - math.cos((lon2 - lon1) * p)) / 2)
    return 12742000 * math.asin(math.sqrt(h))


def key(lat: float, lon: float) -> tuple[int, int]:
    """把座標量化成節點 id，讓不同 way 在同一路口能接起來。"""
    return (round(lat * 1e6), round(lon * 1e6))


def main() -> None:
    src = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/osm.json")
    data = json.loads(io.open(src, encoding="utf-8").read())
    elements = [e for e in data.get("elements", []) if e.get("type") == "way" and e.get("geometry")]
    print(f"ways: {len(elements)}")

    # ── 建圖 ─────────────────────────────────────────────────
    graph: dict[tuple[int, int], list[tuple[tuple[int, int], float]]] = defaultdict(list)
    coord: dict[tuple[int, int], tuple[float, float]] = {}
    roads: list[tuple[str, float, list[tuple[float, float]]]] = []

    for w in elements:
        hw = w.get("tags", {}).get("highway", "")
        grade, width = ROAD_CLASS.get(hw, ("minor", 0.9))
        pts = [(g["lat"], g["lon"]) for g in w["geometry"]]
        if len(pts) < 2:
            continue
        roads.append((grade, width, pts))
        for a, b in zip(pts, pts[1:]):
            ka, kb = key(*a), key(*b)
            coord[ka], coord[kb] = a, b
            d = haversine(a, b)
            graph[ka].append((kb, d))
            graph[kb].append((ka, d))   # 線稿用途，單行道不做方向限制
    print(f"nodes: {len(graph)}")

    # ── 站點吸附到最近的路網節點 ─────────────────────────────
    nodes = list(coord.items())

    def snap(lat: float, lon: float) -> tuple[int, int]:
        return min(nodes, key=lambda kv: haversine((lat, lon), kv[1]))[0]

    snapped = [snap(lat, lon) for lat, lon, _, _ in STOPS]
    for i, ((lat, lon, _, _), k) in enumerate(zip(STOPS, snapped)):
        print(f"  snap 站點 {i:<2} → {haversine((lat, lon), coord[k]):5.0f} m")

    # ── 相鄰站點間跑 Dijkstra，路線因此沿實際道路 ────────────
    def shortest(a: tuple[int, int], b: tuple[int, int]) -> list[tuple[float, float]]:
        dist = {a: 0.0}
        prev: dict[tuple[int, int], tuple[int, int]] = {}
        pq = [(0.0, a)]
        seen = set()
        while pq:
            d, u = heapq.heappop(pq)
            if u in seen:
                continue
            seen.add(u)
            if u == b:
                break
            for v, w in graph[u]:
                nd = d + w
                if nd < dist.get(v, math.inf):
                    dist[v] = nd
                    prev[v] = u
                    heapq.heappush(pq, (nd, v))
        if b not in dist:
            raise SystemExit(f"路網不連通：{a} → {b}")
        path, cur = [b], b
        while cur != a:
            cur = prev[cur]
            path.append(cur)
        return [coord[k] for k in reversed(path)]

    route: list[tuple[float, float]] = []
    leg_start_idx: list[int] = []
    order = snapped + [snapped[0]]          # 封閉路線，最後回到 depot
    for a, b in zip(order, order[1:]):
        seg = shortest(a, b)
        leg_start_idx.append(max(len(route) - 1, 0))
        route.extend(seg if not route else seg[1:])
    total_m = sum(haversine(a, b) for a, b in zip(route, route[1:]))
    print(f"route: {len(route)} pts, {total_m/1000:.1f} km")

    # ── 投影：以路線範圍決定畫布，再往外留白 ─────────────────
    rl = [merc(lat, lon) for lat, lon in route]
    xs, ys = [p[0] for p in rl], [p[1] for p in rl]
    pad_x, pad_y = (max(xs) - min(xs)) * 0.10, (max(ys) - min(ys)) * 0.10
    x0, x1 = min(xs) - pad_x, max(xs) + pad_x
    y0, y1 = min(ys) - pad_y, max(ys) + pad_y

    # hero 需要寬版面，但路線本身接近正方形；把較短的一軸往外擴到目標比例，
    # 擴出來的部分剛好多露出周邊路網，線稿更完整（不是把地圖拉變形）。
    want = (CANVAS_W - 2 * MARGIN) / (CANVAS_H_TARGET - 2 * MARGIN)
    have = (x1 - x0) / (y1 - y0)
    if have < want:
        grow = ((y1 - y0) * want - (x1 - x0)) / 2
        x0, x1 = x0 - grow, x1 + grow
    else:
        grow = ((x1 - x0) / want - (y1 - y0)) / 2
        y0, y1 = y0 - grow, y1 + grow

    scale = (CANVAS_W - 2 * MARGIN) / (x1 - x0)
    canvas_h = round((y1 - y0) * scale + 2 * MARGIN, 1)

    def project(lat: float, lon: float) -> tuple[float, float]:
        x, y = merc(lat, lon)
        return (round((x - x0) * scale + MARGIN, 1),
                round((y1 - y) * scale + MARGIN, 1))

    def to_path(pts: list[tuple[float, float]], tol: float = 0.9) -> str:
        """轉為 SVG path，並丟掉投影後幾乎重疊的點以縮小檔案。
        路線本身用小 tol 保持平滑，細小巷道用大 tol 換檔案大小。"""
        out: list[tuple[float, float]] = []
        for p in (project(*q) for q in pts):
            if not out or abs(p[0] - out[-1][0]) + abs(p[1] - out[-1][1]) >= tol:
                out.append(p)
        if len(out) < 2:
            return ""
        return "M" + " ".join(f"{x} {y}" for x, y in out).replace(" ", " ", 1)

    # 只保留落在畫布內的道路，避免 SVG 過肥
    def visible(pts: list[tuple[float, float]]) -> bool:
        for lat, lon in pts:
            x, y = project(lat, lon)
            if -40 <= x <= CANVAS_W + 40 and -40 <= y <= canvas_h + 40:
                return True
        return False

    layers: dict[str, list[str]] = defaultdict(list)
    for grade, width, pts in roads:
        if not visible(pts):
            continue
        d = to_path(pts, 0.8 if grade == "major" else 1.1 if grade == "mid" else 1.8)
        if d:
            layers[f"{grade}|{width}"].append(d)

    # ── 產出 SVG 片段 ────────────────────────────────────────
    stops_px = [project(lat, lon) for lat, lon, _, _ in STOPS]
    route_d = to_path(route, 0.5)

    body: list[str] = []
    body.append('        <g class="sat-roads" fill="none" stroke-linecap="round" stroke-linejoin="round">')
    for spec in sorted(layers, key=lambda s: float(s.split("|")[1])):
        grade, width = spec.split("|")
        body.append(f'          <g class="rd-{grade}" stroke-width="{width}">')
        for d in layers[spec]:
            body.append(f'            <path d="{d}"/>')
        body.append("          </g>")
    body.append("        </g>")
    # 路線幾何放進 <defs>：只供 <use> 與 JS 取點，本身不繪製。
    # 不可改成在畫面上放一個 stroke="none" 的 path——<use> 產生的複製體會保留
    # 原元素的 presentation attribute，反而蓋掉 <use> 上的樣式，整條路線就不見了。
    body.append(f'        <defs><path id="satRoute" pathLength="1000" d="{route_d}"/></defs>')

    # 站點標記：位置由圖資換算，序號／ETA 供互動時顯示，不必再手動對位。
    # 刻意不輸出店家名稱或經緯度——連 HTML 原始碼裡都不留真實地點。
    body.append('        <g id="satStops">')
    for i, ((_, _, eta, depot), (px, py)) in enumerate(zip(STOPS, stops_px)):
        label = "起訖點（公司）" if depot else f"第 {i} 站"
        cls = "sat-stop is-depot" if depot else "sat-stop"
        body.append(
            f'          <g class="{cls}" tabindex="0" role="button" data-i="{i}" '
            f'data-eta="{eta}" data-label="{label}" '
            f'transform="translate({px} {py})" aria-label="{label}，預計抵達 {eta}">'
            f'<circle class="sat-hit" r="15"/>'
            f'<circle class="sat-ping" r="6"/>'
            f'<circle class="sat-dot" r="{6 if depot else 5}"/>'
            f'</g>')
    body.append("        </g>")

    # 路網／路線幾何與站點分成兩塊注入：中間要夾 index.html 裡的路線描繪圖層，
    # 站點才會疊在路線之上。
    split = body.index('        <g id="satStops">')
    block_map = "\n".join(body[:split])
    block_stops = "\n".join(body[split:])
    OUT_SVG.write_text(block_map + "\n" + block_stops, encoding="utf-8")

    meta = {
        "canvas": [CANVAS_W, canvas_h],
        "stops": [
            {"eta": eta, "depot": depot, "x": p[0], "y": p[1]}
            for (_, _, eta, depot), p in zip(STOPS, stops_px)
        ],
        "route_km": round(total_m / 1000, 1),
    }
    (ROOT / "scripts" / "landing_map.meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    # 直接注入 index.html 的標記區塊，避免站點座標與圖資各改各的而對不上
    page = ROOT / "index.html"
    html = page.read_text(encoding="utf-8")
    for tag, content in (("MAP", block_map), ("STOPS", block_stops)):
        begin, end = f"<!-- SAT:{tag}:BEGIN -->", f"<!-- SAT:{tag}:END -->"
        if begin not in html or end not in html:
            print(f"index.html: 找不到 SAT:{tag} 標記，跳過注入")
            continue
        head, rest = html.split(begin, 1)
        _, tail = rest.split(end, 1)
        html = f"{head}{begin}\n{content}\n        {end}{tail}"
        print(f"index.html: 已更新 SAT:{tag} 區塊")
    page.write_text(html, encoding="utf-8")

    print(f"canvas: 800 x {canvas_h}")
    print(f"svg   : {OUT_SVG.stat().st_size/1024:.1f} KB  ({sum(len(v) for v in layers.values())} roads)")


if __name__ == "__main__":
    main()
