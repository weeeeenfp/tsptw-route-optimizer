from __future__ import annotations

import copy
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Mapping, Sequence


ROOT_DIR = Path(__file__).resolve().parents[2]
CASE_DIR = Path(__file__).resolve().parent
GENERATED_PAYLOAD_DIR = CASE_DIR / "generated_payloads"
RESULT_FILE = CASE_DIR / "results_2026-07-16.md"
COMPANY_NAME = "國立勤益科技大學"
COMPANY_ADDRESS = "411030臺中市太平區坪林里中山路二段57號"

if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from core import route_service  # noqa: E402


def main() -> int:
    base_payload = load_json(ROOT_DIR / "samples" / "request_payload_bast.json")
    validate_company_baseline(base_payload)
    cases = load_json(CASE_DIR / "cases.json")
    cache = load_json(ROOT_DIR / "matrix_cache.json")
    GENERATED_PAYLOAD_DIR.mkdir(exist_ok=True)

    original_fetch_distance_matrix = route_service.fetch_distance_matrix
    route_service.fetch_distance_matrix = build_cached_matrix_fetcher(cache)

    results = []
    try:
        for case in cases:
            payload = build_payload(base_payload, case)
            payload_path = GENERATED_PAYLOAD_DIR / f"{case['case_id']}.json"
            payload_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            response = route_service.optimize_route_request(copy.deepcopy(payload))
            results.append(build_case_result(case, response, payload_path))
    finally:
        route_service.fetch_distance_matrix = original_fetch_distance_matrix

    RESULT_FILE.write_text(render_markdown(results), encoding="utf-8")
    print(json.dumps(results, ensure_ascii=False, indent=2))
    return 0 if all(result["status"] == "SUCCESS" for result in results) else 1


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))

def validate_company_baseline(payload: Mapping[str, Any]) -> None:
    locations = payload.get("locations") or []
    if not locations:
        raise ValueError("BAST locations 不可為空")
    company = locations[0]
    if company.get("name") != COMPANY_NAME or company.get("address") != COMPANY_ADDRESS:
        raise ValueError(f"BAST 公司基準不一致：{company.get('name')} / {company.get('address')}")
    if int(payload.get("depot_index", -1)) != 0:
        raise ValueError("BAST depot_index 必須固定為 0")


def build_payload(base_payload: Mapping[str, Any], case: Mapping[str, Any]) -> Dict[str, Any]:
    payload = copy.deepcopy(base_payload)
    payload["solver"] = "ortools"
    payload["matrix_cache_file"] = "matrix_cache.json"
    payload["solver_timeout_seconds"] = case.get("solver_timeout_seconds", payload.get("solver_timeout_seconds", 5))
    payload.setdefault("constraints", {"allow_late_arrival": True, "late_penalty_per_second": 1000})
    payload.setdefault("service", {"default_service_time_seconds": 600})

    for location_template in case.get("append_locations", []):
        payload["locations"].append(build_appended_location(payload, location_template))

    deep_update(payload, case.get("overrides", {}))

    for index_text, updates in case.get("location_updates", {}).items():
        index = int(index_text)
        deep_update(payload["locations"][index], updates)

    return payload


def build_appended_location(payload: Mapping[str, Any], location_template: Mapping[str, Any]) -> Dict[str, Any]:
    if "copy_from_index" in location_template:
        location = copy.deepcopy(payload["locations"][int(location_template["copy_from_index"])])
    else:
        location = {}

    for key, value in location_template.items():
        if key == "copy_from_index":
            continue
        location[key] = value
    return location


def deep_update(target: Dict[str, Any], updates: Mapping[str, Any]) -> None:
    for key, value in updates.items():
        if isinstance(value, Mapping) and isinstance(target.get(key), dict):
            deep_update(target[key], value)
        else:
            target[key] = value


def build_cached_matrix_fetcher(cache: Mapping[str, Any]):
    cached_addresses = list(cache["addresses"])
    cached_time_matrix = cache["time_matrix"]
    cached_distance_matrix = cache["distance_matrix"]

    def fake_fetch_distance_matrix(
        addresses: Sequence[str],
        *_args: Any,
        **_kwargs: Any,
    ) -> Dict[str, List[List[int]]]:
        indices = [cached_addresses.index(address) for address in addresses]
        return {
            "addresses": list(addresses),
            "time_matrix": subset_matrix(cached_time_matrix, indices),
            "distance_matrix": subset_matrix(cached_distance_matrix, indices),
        }

    return fake_fetch_distance_matrix


def subset_matrix(matrix: Sequence[Sequence[int]], indices: Sequence[int]) -> List[List[int]]:
    return [[matrix[row][col] for col in indices] for row in indices]


def build_case_result(case: Mapping[str, Any], response: Mapping[str, Any], payload_path: Path) -> Dict[str, Any]:
    data = response.get("data", {}) if response.get("status") == "SUCCESS" else {}
    return {
        "case_id": case["case_id"],
        "title": case["title"],
        "purpose": case["purpose"],
        "payload_file": str(payload_path.relative_to(CASE_DIR)).replace("\\", "/"),
        "status": response.get("status"),
        "route_indices": data.get("route_indices", []),
        "route_sequence": data.get("route_sequence", []),
        "total_time_minutes": data.get("total_time_minutes"),
        "total_travel_minutes": data.get("total_travel_minutes"),
        "total_service_minutes": data.get("total_service_minutes"),
        "total_elapsed_minutes": data.get("total_elapsed_minutes"),
        "total_lateness_minutes": data.get("total_lateness_minutes"),
        "selected_start_index": data.get("selected_start_index"),
        "selected_end_index": data.get("selected_end_index"),
        "driver_navigation_urls": data.get("driver_navigation_urls", []),
        "route_details": data.get("route_details", []),
        "reoptimization": data.get("reoptimization"),
        "message": response.get("message"),
    }


def render_markdown(results: Sequence[Mapping[str, Any]]) -> str:
    lines = [
        "# BAST 真實地圖測資結果",
        "",
        "執行日期：2026-07-16",
        "",
        "執行指令：",
        "",
        "```bash",
        "python test_cases/bast_map_cases/run_bast_map_cases.py",
        "```",
        "",
        f"所有情境都使用 `samples/request_payload_bast.json` 的統一基準：{COMPANY_NAME}（{COMPANY_ADDRESS}），並用 `matrix_cache.json` 既有矩陣求解。",
        "",
        "| 測資 | 狀態 | 路線 | 行駛 | 服務 | 延誤 | 地圖 |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]

    for result in results:
        map_links = render_map_links(result["driver_navigation_urls"], compact=True)
        route_text = " -> ".join(str(index) for index in result["route_indices"])
        lines.append(
            f"| `{result['case_id']}` | {result['status']} | `{route_text}` | "
            f"{result['total_travel_minutes']}m | {result['total_service_minutes']}m | "
            f"{result['total_lateness_minutes']}m | {map_links} |"
        )

    for result in results:
        lines.extend(render_result_detail(result))

    return "\n".join(lines) + "\n"


def render_result_detail(result: Mapping[str, Any]) -> List[str]:
    lines = [
        "",
        f"## {result['case_id']} - {result['title']}",
        "",
        f"目的：{result['purpose']}",
        "",
        f"Payload：`{result['payload_file']}`",
        "",
        f"狀態：`{result['status']}`",
        "",
        "路線 index：",
        "",
        "```text",
        " -> ".join(str(index) for index in result["route_indices"]),
        "```",
        "",
        "路線站名：",
        "",
        "```text",
        " -> ".join(result["route_sequence"]),
        "```",
        "",
        "時間：",
        "",
        f"- 純路線行駛時間：{result['total_travel_minutes']} 分鐘",
        f"- 上下貨/服務時間：{result['total_service_minutes']} 分鐘",
        f"- 合計作業時間：{result['total_time_minutes']} 分鐘",
        f"- 實際經過時間：{result['total_elapsed_minutes']} 分鐘",
        f"- 總延誤：{result['total_lateness_minutes']} 分鐘",
        "",
        "每站延誤摘要：",
        "",
        render_lateness_table(result.get("route_details", [])),
        "",
        "每站等待與服務時間：",
        "",
        render_route_detail_table(result.get("route_details", [])),
        "",
        "Google Maps 導航：",
        "",
        render_map_links(result["driver_navigation_urls"], compact=False),
    ]

    if result.get("reoptimization"):
        lines.extend(
            [
                "",
                "重排資訊：",
                "",
                "```json",
                json.dumps(result["reoptimization"], ensure_ascii=False, indent=2),
                "```",
            ]
        )

    return lines


def render_map_links(urls: Sequence[str], *, compact: bool) -> str:
    if not urls:
        return "無"
    links = [f"[地圖 {index + 1}]({url})" for index, url in enumerate(urls)]
    separator = " / " if compact else "\n\n"
    return separator.join(links)


def render_route_detail_table(route_details: Sequence[Mapping[str, Any]]) -> str:
    if not route_details:
        return "無"

    lines = [
        "| 順序 | index | 站名 | 到站 | 等待 | 開始下貨 | 完成 | 延誤 |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for detail in route_details:
        lines.append(
            "| {order} | `{index}` | {name} | {arrival} | {wait} 分 | {start} | {complete} | {late} 分 |".format(
                order=detail.get("order"),
                index=detail.get("index"),
                name=str(detail.get("name", "")).replace("|", "\\|"),
                arrival=format_seconds_as_time(detail.get("arrival_time_seconds")),
                wait=detail.get("waiting_time_minutes", 0),
                start=format_seconds_as_time(detail.get("service_start_time_seconds")),
                complete=format_seconds_as_time(detail.get("service_completion_time_seconds")),
                late=format_minutes(detail.get("lateness_seconds", 0)),
            )
        )
    return "\n".join(lines)


def render_lateness_table(route_details: Sequence[Mapping[str, Any]]) -> str:
    late_details = [
        detail
        for detail in route_details
        if int(detail.get("lateness_seconds") or 0) > 0
    ]
    if not late_details:
        return "無"

    lines = [
        "| 順序 | index | 站名 | 最晚可收貨 | 開始下貨 | 延誤 |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for detail in late_details:
        effective_window = detail.get("effective_time_window") or [None, None]
        latest_time = effective_window[1] if len(effective_window) > 1 else None
        lines.append(
            "| {order} | `{index}` | {name} | {latest} | {start} | {late} 分 |".format(
                order=detail.get("order"),
                index=detail.get("index"),
                name=str(detail.get("name", "")).replace("|", "\\|"),
                latest=format_seconds_as_time(latest_time),
                start=format_seconds_as_time(detail.get("service_start_time_seconds")),
                late=format_minutes(detail.get("lateness_seconds", 0)),
            )
        )
    return "\n".join(lines)


def format_seconds_as_time(value: Any) -> str:
    if value is None:
        return "-"
    seconds = int(value)
    hours = seconds // 3600
    minutes = (seconds % 3600) // 60
    return f"{hours:02d}:{minutes:02d}"


def format_minutes(seconds: Any) -> str:
    return str(round(int(seconds or 0) / 60, 1))


if __name__ == "__main__":
    raise SystemExit(main())
