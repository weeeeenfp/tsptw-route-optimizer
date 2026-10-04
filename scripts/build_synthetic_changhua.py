# -*- coding: utf-8 -*-
"""產生「彰化市大量模擬測資_送.xlsx」。

所有店名皆為虛構（模擬客戶 01…），地址只取彰化市真實道路名稱搭配隨機門牌，
不對應任何真實客戶或合作業者。固定亂數種子，重跑結果一致。
用法：python scripts/build_synthetic_changhua.py
"""
import random
from pathlib import Path

from openpyxl import Workbook

SEED = 20260614
STOPS = 31
OUT = Path(__file__).resolve().parent.parent / "報告用測資" / "彰化市大量模擬測資_送.xlsx"

# (道路, 門牌上限, 里別示意) — 僅為道路名稱，門牌為隨機數
ROADS = [
    ("中山路二段", 480), ("中山路三段", 130), ("中正路一段", 420), ("中正路二段", 360),
    ("成功路", 220), ("民生路", 280), ("光復路", 150), ("彰美路一段", 210),
    ("三民路", 90), ("中華路", 160), ("介壽北路", 130), ("中央路", 110),
    ("南瑤路", 320), ("崇文街", 70), ("卦山路", 120), ("彰南路二段", 230),
    ("彰鹿路", 260), ("民族路", 240), ("曉陽路", 150), ("自強南路", 140),
]
# 5 站帶客戶指定時間窗，其餘為 09:00–18:00
CUSTOM_WINDOWS = [("09:00", "11:00"), ("10:00", "12:00"), ("13:00", "15:00"),
                  ("14:00", "16:30"), ("09:30", "12:30")]


def main() -> None:
    rng = random.Random(SEED)
    custom_idx = set(rng.sample(range(STOPS), len(CUSTOM_WINDOWS)))
    windows = iter(CUSTOM_WINDOWS)

    wb = Workbook()
    ws = wb.active
    ws.title = "locations"
    ws.append(["id", "name", "address", "time_window_start", "time_window_end",
               "priority", "service_time_seconds"])
    used = set()
    for i in range(STOPS):
        while True:
            road, hi = rng.choice(ROADS)
            addr = f"500彰化縣彰化市{road}{rng.randint(1, hi)}號"
            if addr not in used:
                used.add(addr)
                break
        start, end = next(windows) if i in custom_idx else ("09:00", "18:00")
        ws.append([i, f"模擬客戶{i + 1:02d}", addr, start, end, 3, 600])

    note = wb.create_sheet("使用說明")
    for row in [
        ("彰化市大量模擬測資（送貨）",),
        ("資料角色", f"{STOPS} 個虛構送貨站點，用來重現大量站點情境；不含公司。"),
        ("資料來源", "店名為虛構；地址為彰化市真實道路名稱搭配隨機門牌，不對應任何真實客戶。"),
        ("產生方式", "scripts/build_synthetic_changhua.py（固定亂數種子，可重現）。"),
        ("時間窗", f"{len(CUSTOM_WINDOWS)} 站為客戶指定時間窗，其餘為 09:00–18:00。"),
        ("使用建議", "站數較多時，請把畫面右上角「逾時(秒)」調到 30 秒以上。"),
    ]:
        note.append(row)

    OUT.parent.mkdir(exist_ok=True)
    wb.save(OUT)
    print(f"wrote {OUT} ({STOPS} stops)")


if __name__ == "__main__":
    main()
