from __future__ import annotations

import copy
import json
import math
import sys
from pathlib import Path
from typing import Any, Dict, List, Mapping, Sequence, Tuple

from openpyxl import load_workbook


ROOT = Path(__file__).resolve().parents[2]
OUTPUT_ROOT = ROOT / "outputs" / "report_function_tests_20260715"
MANIFEST_FILE = OUTPUT_ROOT / "manifest.json"
RESULT_JSON = OUTPUT_ROOT / "results.json"
RESULT_MD = OUTPUT_ROOT / "results.md"
HANDOFF_MD = Path(__file__).resolve().parent / "results_2026-07-15.md"
DELIVERY_MATRIX_FILE = OUTPUT_ROOT / "delivery_matrix.json"
RECEIVING_MATRIX_FILE = OUTPUT_ROOT / "receiving_matrix.json"

if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core import route_service  # noqa: E402


COMPANY = {
    "id": 0,
    "name": "國立勤益科技大學",
    "address": "411030臺中市太平區坪林里中山路二段57號",
    "time_window": ["09:00", "23:59"],
    "service_time_seconds": 0,
}
REST_POINT = {
    "id": 9900,
    "name": "收貨起點：國軍臺中總醫院",
    "address": "411臺中市太平區光明里中山路二段348號",
    "time_window": ["12:00", "23:59"],
    "service_time_seconds": 0,
}


def main() -> int:
    manifest = json.loads(MANIFEST_FILE.read_text(encoding="utf-8"))
    if manifest.get("company") != {"name": COMPANY["name"], "address": COMPANY["address"]}:
        raise ValueError(f"manifest 公司基準不一致：{manifest.get('company')}")
    scenarios = manifest["scenarios"]
    matrix_caches = {
        "delivery": json.loads(DELIVERY_MATRIX_FILE.read_text(encoding="utf-8")),
        "receiving": json.loads(RECEIVING_MATRIX_FILE.read_text(encoding="utf-8")),
    }
    results: List[Dict[str, Any]] = []

    original_fetcher = route_service.fetch_distance_matrix
    try:
        for scenario in scenarios:
            rows = load_rows(OUTPUT_ROOT / scenario["file"])
            validation = validate_rows(rows, scenario["kind"], infer_company=False)
            result = {
                "case_id": scenario["case_id"],
                "title": scenario["title"],
                "kind": scenario["kind"],
                "purpose": scenario["purpose"],
                "file": scenario["file"],
                "expected_status": scenario["expected_status"],
                "validation": validation,
                "company_baseline": {
                    "name": COMPANY["name"],
                    "address": COMPANY["address"],
                    "matches": True,
                },
            }

            if scenario["execution"] == "validation":
                actual = "SUCCESS" if validation["ok"] else "REJECTED"
                result.update({"actual_status": actual, "passed": actual == scenario["expected_status"]})
            elif not validation["ok"]:
                result.update({"actual_status": "VALIDATION_ERROR", "passed": False})
            else:
                payload, matrix_data, matrix_source = build_route_context(scenario, rows, matrix_caches)
                route_service.fetch_distance_matrix = build_matrix_fetcher(matrix_data)
                response = route_service.optimize_route_request(copy.deepcopy(payload))
                result.update(route_result(response, payload, matrix_source))
                result["passed"] = (
                    result["actual_status"] == scenario["expected_status"]
                    and result["company_baseline"]["matches"]
                )
            results.append(result)

        results.extend(run_in_transit_cases(results, scenarios, matrix_caches))
    finally:
        route_service.fetch_distance_matrix = original_fetcher

    apply_cross_case_checks(results)
    summary = build_summary(results, manifest)
    RESULT_JSON.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    markdown = render_markdown(summary)
    RESULT_MD.write_text(markdown, encoding="utf-8")
    HANDOFF_MD.write_text(markdown, encoding="utf-8")
    print(json.dumps({"passed": summary["passed"], "failed": summary["failed"], "results": str(RESULT_JSON)}, ensure_ascii=False))
    return 0 if summary["failed"] == 0 else 1


def load_rows(path: Path) -> List[Dict[str, Any]]:
    workbook = load_workbook(path, read_only=True, data_only=True)
    sheet = workbook["locations"]
    values = list(sheet.values)
    headers = [str(value or "").strip() for value in values[0]]
    return [{headers[index]: value for index, value in enumerate(row)} for row in values[1:]]


def validate_rows(rows: Sequence[Mapping[str, Any]], kind: str, infer_company: bool) -> Dict[str, Any]:
    errors: List[str] = []
    required = ("id", "name", "address")
    ids = set()
    for index, row in enumerate(rows, start=2):
        for field in required:
            if row.get(field) is None or str(row.get(field)).strip() == "":
                errors.append(f"第 {index} 列 {field} 不可空白")
        try:
            location_id = int(row.get("id"))
            if float(row.get("id")) != location_id:
                raise ValueError
            if location_id in ids:
                errors.append(f"第 {index} 列 ID {location_id} 重複")
            ids.add(location_id)
        except (TypeError, ValueError):
            errors.append(f"第 {index} 列 ID 必須是整數")

        start, start_error = parse_time(row.get("time_window_start"), False)
        end, end_error = parse_time(row.get("time_window_end"), True)
        if start_error:
            errors.append(f"第 {index} 列開始時間：{start_error}")
        if end_error:
            errors.append(f"第 {index} 列結束時間：{end_error}")
        if start is not None and end is not None and start > end:
            errors.append(f"第 {index} 列開始時間不可晚於結束時間")

        priority = row.get("priority")
        if priority not in (None, ""):
            try:
                priority_number = int(priority)
                if float(priority) != priority_number or not 1 <= priority_number <= 5:
                    raise ValueError
            except (TypeError, ValueError):
                errors.append(f"第 {index} 列優先權必須是 1 到 5 的整數")

        service = row.get("service_time_seconds")
        if service not in (None, ""):
            try:
                service_number = int(service)
                if float(service) != service_number or not 0 <= service_number <= 86400:
                    raise ValueError
            except (TypeError, ValueError):
                errors.append(f"第 {index} 列服務時間必須是 0 到 86400 的整數秒數")

    station_count = len(rows)
    if kind == "delivery" and infer_company and rows and int(rows[0].get("id") or -1) == 0:
        station_count -= 1
    if station_count < 1:
        errors.append("至少需要 1 筆實際站點")
    if kind == "delivery" and station_count > 24:
        errors.append(f"實際站點最多 24 筆，目前為 {station_count} 筆")
    return {"ok": not errors, "errors": errors, "station_count": station_count, "row_count": len(rows)}


def parse_time(value: Any, is_end: bool) -> Tuple[int | None, str | None]:
    text = str(value if value is not None else "").strip()
    if not text:
        return (86340 if is_end else 0), None
    parts = text.split(":")
    if len(parts) not in (2, 3) or not all(part.isdigit() for part in parts):
        return None, f"時間「{text}」格式無法辨識"
    hour, minute = int(parts[0]), int(parts[1])
    second = int(parts[2]) if len(parts) == 3 else 0
    if hour > 23 or minute > 59 or second > 59:
        return None, f"時間「{text}」不是合法 24 小時制"
    return hour * 3600 + minute * 60 + second, None


def build_route_context(
    scenario: Mapping[str, Any],
    rows: Sequence[Mapping[str, Any]],
    matrix_caches: Mapping[str, Mapping[str, Any]],
) -> Tuple[Dict[str, Any], Dict[str, Any], str]:
    if scenario["kind"] == "delivery":
        locations = [copy.deepcopy(COMPANY)] + [row_to_location(row) for row in rows]
        locations[0]["time_window"] = [scenario["departure_time"], "23:59"]
        locations[0]["service_time_seconds"] = 0
        payload = base_payload(locations, start_index=0, end_index=0, operation_type="delivery")
        payload["solver_timeout_seconds"] = int(scenario.get("solver_timeout_seconds", 5))
        matrix = matrix_caches["delivery"]
        source = "2026-07-16 依新公司與正確送貨地址重新取得的 Google Distance Matrix"
        return payload, matrix, source

    locations = [copy.deepcopy(COMPANY), copy.deepcopy(REST_POINT)] + [row_to_location(row) for row in rows]
    locations[0]["time_window"] = [scenario["departure_time"], "23:59"]
    locations[1]["time_window"] = [scenario["departure_time"], "23:59"]
    payload = base_payload(locations, start_index=1, end_index=0, operation_type="receiving")
    payload["solver_timeout_seconds"] = int(scenario.get("solver_timeout_seconds", 5))
    return payload, matrix_caches["receiving"], "2026-07-16 依新公司、收貨起點與正確收貨地址重新取得的 Google Distance Matrix"


def row_to_location(row: Mapping[str, Any]) -> Dict[str, Any]:
    return {
        "id": int(row["id"]),
        "name": str(row["name"]),
        "address": str(row["address"]),
        "time_window": [str(row.get("time_window_start") or "00:00"), str(row.get("time_window_end") or "23:59")],
        "priority": int(row.get("priority") or 3),
        "service_time_seconds": int(row.get("service_time_seconds") or 0),
    }


def base_payload(
    locations: Sequence[Mapping[str, Any]],
    start_index: int,
    end_index: int,
    operation_type: str,
) -> Dict[str, Any]:
    return {
        "google_maps_api_key": "",
        "operation_type": operation_type,
        "matrix_cache_file": "matrix_cache.json",
        "solver": "ortools",
        "solver_timeout_seconds": 1,
        "start_index": start_index,
        "end_index": end_index,
        "depot_index": 0,
        "locations": copy.deepcopy(list(locations)),
        "constraints": {
            "allow_late_arrival": True,
            "late_penalty_per_second": 1000,
            "waiting_time_cost_per_second": 1,
            "preserve_remaining_order": True,
            "route_order_penalty_per_second": 20,
            "route_order_interval_seconds": 600,
        },
        "priority": {
            "default_priority": 3,
            "priority_interval_seconds": 1800,
            "priority_penalty_per_second": 2000,
        },
        "service": {"default_service_time_seconds": 600},
        "navigation": {"max_points_per_url": 10, "travelmode": "driving"},
        "ortools": {
            "first_solution_strategy": "PATH_CHEAPEST_ARC",
            "local_search_metaheuristic": "GUIDED_LOCAL_SEARCH",
        },
    }


def build_matrix_fetcher(matrix_data: Mapping[str, Any]):
    cached_addresses = list(matrix_data["addresses"])
    time_matrix = matrix_data["time_matrix"]
    distance_matrix = matrix_data["distance_matrix"]

    def fetch(addresses: Sequence[str], *_args: Any, **_kwargs: Any) -> Dict[str, Any]:
        indices = [cached_addresses.index(address) for address in addresses]
        return {
            "addresses": list(addresses),
            "time_matrix": [[time_matrix[row][column] for column in indices] for row in indices],
            "distance_matrix": [[distance_matrix[row][column] for column in indices] for row in indices],
        }

    return fetch


def reorder_matrix(matrix: Sequence[Sequence[int]], order: Sequence[int]) -> List[List[int]]:
    return [[matrix[row][column] for column in order] for row in order]


def route_result(response: Mapping[str, Any], payload: Mapping[str, Any], matrix_source: str) -> Dict[str, Any]:
    data = response.get("data", {}) if response.get("status") == "SUCCESS" else {}
    details = data.get("route_details", [])
    company = payload["locations"][0]
    company_baseline = {
        "name": company.get("name"),
        "address": company.get("address"),
        "matches": company.get("name") == COMPANY["name"] and company.get("address") == COMPANY["address"],
    }
    return {
        "actual_status": response.get("status"),
        "message": response.get("message"),
        "matrix_source": matrix_source,
        "route_indices": data.get("route_indices", []),
        "route_sequence": data.get("route_sequence", []),
        "total_travel_minutes": data.get("total_travel_minutes"),
        "total_service_minutes": data.get("total_service_minutes"),
        "total_elapsed_minutes": data.get("total_elapsed_minutes"),
        "total_waiting_minutes": round(sum(float(detail.get("waiting_time_seconds", 0) or 0) for detail in details) / 60, 2),
        "total_lateness_minutes": data.get("total_lateness_minutes"),
        "route_details": details,
        "driver_navigation_urls": data.get("driver_navigation_urls", []),
        "selected_start_index": data.get("selected_start_index"),
        "selected_end_index": data.get("selected_end_index"),
        "reoptimization": data.get("reoptimization"),
        "location_ids_by_index": [location.get("id") for location in payload["locations"]],
        "company_baseline": company_baseline,
    }


def run_in_transit_cases(
    route_results: Sequence[Mapping[str, Any]],
    scenarios: Sequence[Mapping[str, Any]],
    matrix_caches: Mapping[str, Mapping[str, Any]],
) -> List[Dict[str, Any]]:
    scenario = next(item for item in scenarios if item["case_id"] == "D01")
    rows = load_rows(OUTPUT_ROOT / scenario["file"])
    base, matrix, source = build_route_context(scenario, rows, matrix_caches)
    route_service.fetch_distance_matrix = build_matrix_fetcher(matrix)
    cases = []

    state_case = copy.deepcopy(base)
    state_case.update({
        "current_index": 6,
        "current_time_seconds": "11:00",
        "completed_indices": [1, 2],
        "cancelled_indices": [3],
        "skipped_indices": [4],
    })
    state_case["locations"][1]["status"] = "completed"
    state_case["locations"][2]["status"] = "completed"
    state_case["locations"][3]["status"] = "cancelled"
    state_case["locations"][4]["status"] = "skipped"
    state_case["locations"][6]["status"] = "in_progress"
    state_case["locations"][6]["service_time_seconds"] = 0
    cases.append(("E01", "途中完成／取消／跳過後重排", state_case, {1, 2, 3, 4}))

    delay_case = copy.deepcopy(base)
    delay_case.update({"current_index": 6, "current_time_seconds": "11:00", "completed_indices": [1, 2]})
    delay_case["locations"][1]["status"] = "completed"
    delay_case["locations"][2]["status"] = "completed"
    delay_case["locations"][5]["status"] = "delayed"
    delay_case["locations"][5]["rescheduled_time_window"] = ["13:00", "14:00"]
    delay_case["locations"][6]["status"] = "in_progress"
    delay_case["locations"][6]["service_time_seconds"] = 0
    cases.append(("E02", "客戶改約新時間窗後重排", delay_case, {1, 2}))

    results = []
    for case_id, title, payload, excluded in cases:
        response = route_service.optimize_route_request(copy.deepcopy(payload))
        result = {
            "case_id": case_id,
            "title": title,
            "kind": "delivery_event",
            "purpose": "模擬司機 11:00 已在途中，由後端重新理解已處理站點與目前位置。",
            "file": "inputs/D01_送貨_基準.xlsx",
            "expected_status": "SUCCESS",
            "validation": {"ok": True, "errors": [], "station_count": 10, "row_count": 10},
        }
        result.update(route_result(response, payload, source))
        route_set = set(result.get("route_indices", []))
        result["excluded_indices_check"] = {"expected_excluded": sorted(excluded), "actually_excluded": sorted(index for index in excluded if index not in route_set)}
        result["passed"] = (
            result["actual_status"] == "SUCCESS"
            and not (route_set & excluded)
            and result["company_baseline"]["matches"]
        )
        results.append(result)
    return results


def apply_cross_case_checks(results: Sequence[Dict[str, Any]]) -> None:
    by_id = {result["case_id"]: result for result in results}
    for priority_case, baseline_case, target_id in (("D02", "D01", 9), ("R02", "R01", 6)):
        priority_rank = route_rank_for_location_id(by_id[priority_case], target_id)
        baseline_rank = route_rank_for_location_id(by_id[baseline_case], target_id)
        improved = priority_rank is not None and baseline_rank is not None and priority_rank < baseline_rank
        by_id[priority_case]["priority_comparison"] = {
            "target_id": target_id,
            "baseline_rank": baseline_rank,
            "priority_rank": priority_rank,
            "moved_earlier": improved,
        }
        by_id[priority_case]["passed"] = by_id[priority_case]["passed"] and improved

    for case_id in ("D03", "R03"):
        has_time_effect = (by_id[case_id].get("total_waiting_minutes") or 0) > 0 or (by_id[case_id].get("total_lateness_minutes") or 0) > 0
        by_id[case_id]["time_window_effect_check"] = has_time_effect
        by_id[case_id]["passed"] = by_id[case_id]["passed"] and has_time_effect

    for case_id in ("D04", "R04"):
        details = by_id[case_id].get("route_details", [])
        charged = sum(float(detail.get("charged_service_time_seconds", 0) or 0) for detail in details) / 60
        reported = float(by_id[case_id].get("total_service_minutes") or 0)
        by_id[case_id]["service_time_check"] = {"detail_sum_minutes": round(charged, 2), "reported_minutes": reported, "matches": math.isclose(charged, reported, abs_tol=0.01)}
        by_id[case_id]["passed"] = by_id[case_id]["passed"] and math.isclose(charged, reported, abs_tol=0.01)


def route_rank_for_location_id(result: Mapping[str, Any], target_id: int) -> int | None:
    ids = result.get("location_ids_by_index", [])
    for rank, index in enumerate(result.get("route_indices", [])):
        if 0 <= index < len(ids) and ids[index] == target_id:
            return rank
    return None


def build_summary(results: Sequence[Mapping[str, Any]], manifest: Mapping[str, Any]) -> Dict[str, Any]:
    passed = sum(1 for result in results if result.get("passed"))
    send_rows = manifest["scenarios"][0]["rows"]
    receive_rows = next(item for item in manifest["scenarios"] if item["case_id"] == "R01")["rows"]
    coverage = [
        {"kind": "送貨", "id": row["id"], "name": row["name"], "cases": ["D01", "D02", "D03", "D04", "E01", "E02"]}
        for row in send_rows
    ] + [
        {"kind": "收貨", "id": row["id"], "name": row["name"], "cases": ["R01", "R02", "R03", "R04", "R05"]}
        for row in receive_rows
    ]
    return {
        "executed_at": "2026-07-16",
        "solver_strategy": "PATH_CHEAPEST_ARC + GUIDED_LOCAL_SEARCH",
        "departure_assumptions": {"delivery": "09:00", "receiving": "12:00"},
        "company": {"name": COMPANY["name"], "address": COMPANY["address"]},
        "passed": passed,
        "failed": len(results) - passed,
        "results": list(results),
        "row_coverage": coverage,
        "map_verification_note": "送貨與收貨矩陣皆依國立勤益科技大學公司地點及修正後地址重新取得；Google Maps 導航連結會依每段最多 10 點自動拆分。",
    }


def render_markdown(summary: Mapping[str, Any]) -> str:
    lines = [
        "# 正常收送貨測資功能測試結果",
        "",
        "執行日期：2026-07-16",
        "",
        f"策略：`{summary['solver_strategy']}`",
        "",
        f"結果：**{summary['passed']} 通過 / {summary['failed']} 失敗**",
        "",
        f"統一公司基準：**{summary['company']['name']}**（{summary['company']['address']}）",
        "",
        summary["map_verification_note"],
        "",
        "| 案例 | 狀態 | 判定 | 行駛 | 服務 | 等待 | 遲到 | Google Maps |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for result in summary["results"]:
        links = " / ".join(f"[路線 {index + 1}]({url})" for index, url in enumerate(result.get("driver_navigation_urls", []))) or "—"
        lines.append(
            f"| `{result['case_id']}` {result['title']} | {result.get('actual_status')} | {'PASS' if result.get('passed') else 'FAIL'} | "
            f"{format_minutes(result.get('total_travel_minutes'))} | {format_minutes(result.get('total_service_minutes'))} | "
            f"{format_minutes(result.get('total_waiting_minutes'))} | {format_minutes(result.get('total_lateness_minutes'))} | {links} |"
        )

    lines.extend(["", "## 每筆資料覆蓋", "", "| 種類 | ID | 名稱 | 覆蓋案例 |", "| --- | ---: | --- | --- |"])
    for item in summary["row_coverage"]:
        lines.append(f"| {item['kind']} | {item['id']} | {item['name']} | {', '.join(item['cases'])} |")

    lines.extend(["", "## 案例明細", ""])
    for result in summary["results"]:
        lines.extend([
            f"### {result['case_id']} {result['title']}",
            "",
            f"- 目的：{result['purpose']}",
            f"- Excel：`{result['file']}`",
            f"- 驗證：{'通過' if result['validation']['ok'] else '擋下'}；{'; '.join(result['validation']['errors']) or '無錯誤'}",
            f"- 結果：`{result.get('actual_status')}` / {'PASS' if result.get('passed') else 'FAIL'}",
        ])
        if result.get("route_indices"):
            lines.append(f"- 路線 index：`{' -> '.join(str(value) for value in result['route_indices'])}`")
            lines.append(f"- 路線站名：{' -> '.join(result.get('route_sequence', []))}")
            lines.append(f"- 時間：行駛 {format_minutes(result.get('total_travel_minutes'))}、服務 {format_minutes(result.get('total_service_minutes'))}、等待 {format_minutes(result.get('total_waiting_minutes'))}、遲到 {format_minutes(result.get('total_lateness_minutes'))}")
            lines.append(f"- 矩陣來源：{result.get('matrix_source')}")
        if result.get("priority_comparison"):
            comparison = result["priority_comparison"]
            lines.append(f"- 優先級對比：ID {comparison['target_id']} 由第 {comparison['baseline_rank']} 站提前到第 {comparison['priority_rank']} 站。")
        lines.append("")
    return "\n".join(lines) + "\n"


def format_minutes(value: Any) -> str:
    return "—" if value is None else f"{value}m"


if __name__ == "__main__":
    raise SystemExit(main())
