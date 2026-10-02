from __future__ import annotations

import copy
import json
import sys
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Sequence


ROOT_DIR = Path(__file__).resolve().parents[1]
PAYLOAD_DIR = Path(__file__).resolve().parent / "payloads"

if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from core import route_service  # noqa: E402

COMPANY_NAME = "國立勤益科技大學"
COMPANY_ADDRESS = "411030臺中市太平區坪林里中山路二段57號"


def main() -> int:
    results = []
    for case_file in sorted(PAYLOAD_DIR.glob("*.json")):
        results.append(run_case(case_file))

    print(json.dumps(results, ensure_ascii=False, indent=2))
    return 0 if all(result["passed"] for result in results) else 1


def run_case(case_file: Path) -> Dict[str, Any]:
    case = json.loads(case_file.read_text(encoding="utf-8"))
    original_fetch_distance_matrix = route_service.fetch_distance_matrix

    try:
        if "mock_matrix" in case:
            route_service.fetch_distance_matrix = build_mock_fetcher(case)
        raw_result = route_service.optimize_route_request(copy.deepcopy(case["payload"]))
    except Exception as exc:  # pragma: no cover - runner should report unexpected exceptions plainly.
        raw_result = {"status": "EXCEPTION", "message": str(exc)}
    finally:
        route_service.fetch_distance_matrix = original_fetch_distance_matrix

    checks = evaluate_expectations(case, raw_result)
    summary = summarize_result(raw_result)
    return {
        "case_id": case["case_id"],
        "title": case["title"],
        "purpose": case["purpose"],
        "status": raw_result.get("status"),
        "passed": all(check["passed"] for check in checks),
        "checks": checks,
        "summary": summary,
    }


def build_mock_fetcher(case: Mapping[str, Any]) -> Callable[..., Dict[str, List[List[int]]]]:
    payload = case["payload"]
    matrix_config = case["mock_matrix"]
    address_order = [location["address"] for location in payload["locations"]]
    time_matrix, distance_matrix = build_full_matrix(len(address_order), matrix_config)

    def fake_fetch_distance_matrix(
        addresses: Sequence[str],
        *_args: Any,
        **_kwargs: Any,
    ) -> Dict[str, List[List[int]]]:
        indices = [address_order.index(address) for address in addresses]
        return {
            "time_matrix": subset_matrix(time_matrix, indices),
            "distance_matrix": subset_matrix(distance_matrix, indices),
        }

    return fake_fetch_distance_matrix


def build_full_matrix(size: int, matrix_config: Mapping[str, Any]) -> tuple[List[List[int]], List[List[int]]]:
    generator = matrix_config.get("generator", "linear")
    if generator != "linear":
        raise ValueError(f"Unsupported mock matrix generator: {generator}")

    travel_step = int(matrix_config.get("travel_seconds_per_step", 300))
    distance_step = int(matrix_config.get("distance_meters_per_step", 1000))
    min_travel = int(matrix_config.get("minimum_travel_seconds", travel_step))

    time_matrix = []
    distance_matrix = []
    for i in range(size):
        time_row = []
        distance_row = []
        for j in range(size):
            if i == j:
                time_row.append(0)
                distance_row.append(0)
            else:
                step_count = abs(i - j)
                time_row.append(max(min_travel, step_count * travel_step))
                distance_row.append(step_count * distance_step)
        time_matrix.append(time_row)
        distance_matrix.append(distance_row)
    return time_matrix, distance_matrix


def subset_matrix(matrix: Sequence[Sequence[int]], indices: Sequence[int]) -> List[List[int]]:
    return [[matrix[row][col] for col in indices] for row in indices]


def evaluate_expectations(case: Mapping[str, Any], result: Mapping[str, Any]) -> List[Dict[str, Any]]:
    expected = case.get("expected", {})
    checks = []

    def add_check(name: str, passed: bool, actual: Any = None, expected_value: Any = None) -> None:
        checks.append(
            {
                "name": name,
                "passed": passed,
                "actual": actual,
                "expected": expected_value,
            }
        )

    expected_status = expected.get("status")
    if expected_status is not None:
        add_check("status", result.get("status") == expected_status, result.get("status"), expected_status)

    company = case["payload"]["locations"][0]
    add_check(
        "company_baseline",
        company.get("name") == COMPANY_NAME and company.get("address") == COMPANY_ADDRESS,
        {"name": company.get("name"), "address": company.get("address")},
        {"name": COMPANY_NAME, "address": COMPANY_ADDRESS},
    )

    data = result.get("data", {}) if isinstance(result.get("data"), Mapping) else {}
    route_indices = data.get("route_indices", [])

    if "route_starts_with" in expected:
        add_check(
            "route_starts_with",
            bool(route_indices) and route_indices[0] == expected["route_starts_with"],
            route_indices[0] if route_indices else None,
            expected["route_starts_with"],
        )
    if "route_ends_with" in expected:
        add_check(
            "route_ends_with",
            bool(route_indices) and route_indices[-1] == expected["route_ends_with"],
            route_indices[-1] if route_indices else None,
            expected["route_ends_with"],
        )
    if "route_excludes" in expected:
        excluded = expected["route_excludes"]
        add_check(
            "route_excludes",
            all(index not in route_indices for index in excluded),
            route_indices,
            excluded,
        )
    if "min_total_lateness_minutes" in expected:
        actual_lateness = data.get("total_lateness_minutes", 0)
        add_check(
            "min_total_lateness_minutes",
            actual_lateness >= expected["min_total_lateness_minutes"],
            actual_lateness,
            expected["min_total_lateness_minutes"],
        )
    if "no_remaining_deliveries" in expected:
        actual_flag = data.get("reoptimization", {}).get("no_remaining_deliveries", False)
        add_check(
            "no_remaining_deliveries",
            actual_flag is expected["no_remaining_deliveries"],
            actual_flag,
            expected["no_remaining_deliveries"],
        )

    return checks


def summarize_result(result: Mapping[str, Any]) -> Dict[str, Any]:
    if result.get("status") != "SUCCESS":
        return {"message": result.get("message")}

    data = result.get("data", {})
    return {
        "route_indices": data.get("route_indices"),
        "selected_start_index": data.get("selected_start_index"),
        "selected_end_index": data.get("selected_end_index"),
        "total_time_minutes": data.get("total_time_minutes"),
        "total_travel_minutes": data.get("total_travel_minutes"),
        "total_service_minutes": data.get("total_service_minutes"),
        "total_elapsed_minutes": data.get("total_elapsed_minutes"),
        "total_lateness_minutes": data.get("total_lateness_minutes"),
        "reoptimization": data.get("reoptimization"),
    }


if __name__ == "__main__":
    raise SystemExit(main())
