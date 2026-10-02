import copy
import re
from typing import Any, Dict, Mapping


class InputValidationError(ValueError):
    """Raised when a route request or runtime config violates supported input limits."""


TIME_PATTERN = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$")
MIN_LOCATIONS = 2
# 送貨與收貨都不設硬性站點上限；25 點只是本專題個案的建議適用規模，
# 超過時應依站數提高 solver_timeout_seconds，不再直接擋下請求。
RECOMMENDED_DELIVERY_LOCATIONS = 25
MAX_VIRTUAL_CURRENT_LOCATIONS = 1
MAX_GOOGLE_MAPS_POINTS_PER_URL = 10
MAX_GOOGLE_MAPS_CHUNK_SIZE = 10
MAX_PRIORITY = 5
SECONDS_PER_DAY = 24 * 60 * 60
MAX_TIME_OF_DAY_SECONDS = SECONDS_PER_DAY - 1
SUPPORTED_LOCATION_STATUSES = {
    "pending",
    "in_progress",
    "completed",
    "delayed",
    "cancelled",
    "skipped",
}
SUPPORTED_FIRST_SOLUTION_STRATEGIES = {
    "AUTOMATIC",
    "GLOBAL_CHEAPEST_ARC",
    "LOCAL_CHEAPEST_INSERTION",
    "PARALLEL_CHEAPEST_INSERTION",
    "PATH_CHEAPEST_ARC",
}
SUPPORTED_LOCAL_SEARCH_METAHEURISTICS = {
    "AUTOMATIC",
    "GREEDY_DESCENT",
    "GUIDED_LOCAL_SEARCH",
    "SIMULATED_ANNEALING",
    "TABU_SEARCH",
}
SUPPORTED_OPERATION_TYPES = {"delivery", "receiving"}


def validate_and_normalize_request(request_data: Mapping[str, Any]) -> Dict[str, Any]:
    """Validate user input and normalize time fields to seconds for the solvers."""
    normalized = copy.deepcopy(dict(request_data))
    locations = normalized.get("locations")
    _require(isinstance(locations, list), "locations 必須是陣列。")
    _require(len(locations) >= MIN_LOCATIONS, f"locations 至少需要 {MIN_LOCATIONS} 個地點。")
    operation_type = normalized.get("operation_type", "delivery")
    _require(operation_type in SUPPORTED_OPERATION_TYPES, "operation_type 只能是 delivery 或 receiving。")
    normalized["operation_type"] = operation_type

    normalized["solver_timeout_seconds"] = _validate_int_range(
        normalized.get("solver_timeout_seconds", 5),
        "solver_timeout_seconds",
        minimum=1,
        maximum=300,
    )
    normalized["depot_index"] = _validate_index(normalized.get("depot_index", 0), "depot_index", len(locations))

    if normalized.get("current_index") is not None:
        normalized["current_index"] = _validate_index(normalized["current_index"], "current_index", len(locations))
    if normalized.get("current_time_seconds") is not None:
        normalized["current_time_seconds"] = _parse_time_value(normalized["current_time_seconds"], "current_time_seconds")
    if normalized.get("start_index") is not None:
        normalized["start_index"] = _validate_index(normalized["start_index"], "start_index", len(locations))
    if normalized.get("end_index") is not None:
        normalized["end_index"] = _validate_index(normalized["end_index"], "end_index", len(locations))

    end_candidates = normalized.get("end_candidate_indices") or []
    _require(isinstance(end_candidates, list), "end_candidate_indices 必須是 index 陣列。")
    normalized["end_candidate_indices"] = [
        _validate_index(candidate, "end_candidate_indices", len(locations)) for candidate in end_candidates
    ]
    for field_name in ("completed_indices", "cancelled_indices", "skipped_indices"):
        normalized[field_name] = _validate_index_list(normalized.get(field_name) or [], field_name, len(locations))

    if normalized.get("manual_route_indices") is not None:
        manual_route_indices = _validate_index_list(
            normalized["manual_route_indices"], "manual_route_indices", len(locations)
        )
        _require(
            len(set(manual_route_indices)) == len(manual_route_indices),
            "manual_route_indices 不可重複。",
        )
        normalized["manual_route_indices"] = manual_route_indices

    _validate_solver(normalized.get("solver", "ortools"))
    _validate_google_maps_settings(normalized.get("google_maps", {}))
    _validate_navigation_settings(normalized.get("navigation", {}))
    _validate_constraints(normalized.get("constraints", {}))
    _validate_priority_settings(normalized.get("priority", {}))
    _validate_service_settings(normalized.get("service", {}))
    _validate_ortools_settings(normalized.get("ortools", {}))

    for index, location in enumerate(locations):
        _validate_location(location, index)

    return normalized


def _validate_location(location: Dict[str, Any], index: int) -> None:
    """Validate and normalize one location record."""
    _require(isinstance(location.get("id"), int), f"locations[{index}].id 必須是整數。")
    _require(isinstance(location.get("name"), str) and location["name"], f"locations[{index}].name 必須是非空字串。")
    _require(isinstance(location.get("address"), str) and location["address"], f"locations[{index}].address 必須是非空字串。")

    time_window = location.get("time_window")
    _require(isinstance(time_window, list) and len(time_window) == 2, f"locations[{index}].time_window 必須有兩個值。")
    start_seconds = _parse_time_value(time_window[0], f"locations[{index}].time_window[0]")
    end_seconds = _parse_time_value(time_window[1], f"locations[{index}].time_window[1]")
    _require(start_seconds <= end_seconds, f"locations[{index}].time_window 開始時間不可晚於結束時間。")
    location["time_window"] = [start_seconds, end_seconds]

    if location.get("delay_by_seconds") is not None:
        location["delay_by_seconds"] = _validate_int_range(
            location["delay_by_seconds"],
            f"locations[{index}].delay_by_seconds",
            minimum=0,
            maximum=SECONDS_PER_DAY,
        )
    if location.get("delivery_delay_seconds") is not None:
        location["delivery_delay_seconds"] = _validate_int_range(
            location["delivery_delay_seconds"],
            f"locations[{index}].delivery_delay_seconds",
            minimum=0,
            maximum=SECONDS_PER_DAY,
        )
    if location.get("delay_until_seconds") is not None:
        location["delay_until_seconds"] = _parse_time_value(location["delay_until_seconds"], f"locations[{index}].delay_until_seconds")
    if location.get("rescheduled_time_window") is not None:
        rescheduled_time_window = location["rescheduled_time_window"]
        _require(
            isinstance(rescheduled_time_window, list) and len(rescheduled_time_window) == 2,
            f"locations[{index}].rescheduled_time_window 必須有兩個值。",
        )
        rescheduled_start = _parse_time_value(
            rescheduled_time_window[0],
            f"locations[{index}].rescheduled_time_window[0]",
        )
        rescheduled_end = _parse_time_value(
            rescheduled_time_window[1],
            f"locations[{index}].rescheduled_time_window[1]",
        )
        _require(
            rescheduled_start <= rescheduled_end,
            f"locations[{index}].rescheduled_time_window 開始時間不可晚於結束時間。",
        )
        location["rescheduled_time_window"] = [rescheduled_start, rescheduled_end]
    if location.get("service_time_seconds") is not None:
        location["service_time_seconds"] = _validate_int_range(
            location["service_time_seconds"],
            f"locations[{index}].service_time_seconds",
            minimum=0,
            maximum=SECONDS_PER_DAY,
        )
    if location.get("priority") is not None:
        location["priority"] = _validate_int_range(location["priority"], f"locations[{index}].priority", minimum=1, maximum=MAX_PRIORITY)
    if location.get("status") is not None:
        _require(
            location["status"] in SUPPORTED_LOCATION_STATUSES,
            f"locations[{index}].status 必須是 pending、in_progress、completed、delayed、cancelled 或 skipped。",
        )


def _parse_time_value(value: Any, field_name: str) -> int:
    """Accept the standard HH:MM[:SS] format, while preserving legacy second-based payloads."""
    if isinstance(value, int):
        return _validate_int_range(value, field_name, minimum=0, maximum=MAX_TIME_OF_DAY_SECONDS)

    _require(isinstance(value, str), f"{field_name} 必須是 24 小時制字串 HH:MM[:SS]。")
    match = TIME_PATTERN.match(value)
    _require(match is not None, f"{field_name} 必須是 24 小時制，例如 09:30 或 18:00:00。")
    hours, minutes, seconds = match.groups()
    return int(hours) * 3600 + int(minutes) * 60 + int(seconds or 0)


def _validate_solver(solver: Any) -> None:
    _require(solver in {"ortools", "dp"}, "solver 只能是 ortools 或 dp。")


def _validate_google_maps_settings(settings: Mapping[str, Any]) -> None:
    chunk_size = settings.get("chunk_size", 10)
    _validate_int_range(chunk_size, "google_maps.chunk_size", minimum=1, maximum=MAX_GOOGLE_MAPS_CHUNK_SIZE)
    request_delay = settings.get("request_delay_seconds", 1)
    _require(isinstance(request_delay, (int, float)) and 0 <= request_delay <= 60, "google_maps.request_delay_seconds 必須介於 0 到 60。")
    _require(settings.get("mode", "driving") in {"driving", "walking", "bicycling", "transit"}, "google_maps.mode 不支援。")
    _require(isinstance(settings.get("language", "zh-TW"), str), "google_maps.language 必須是字串。")


def _validate_navigation_settings(settings: Mapping[str, Any]) -> None:
    max_points = settings.get("max_points_per_url", 10)
    _validate_int_range(max_points, "navigation.max_points_per_url", minimum=2, maximum=MAX_GOOGLE_MAPS_POINTS_PER_URL)
    _require(settings.get("travelmode", "driving") in {"driving", "walking", "bicycling", "transit"}, "navigation.travelmode 不支援。")


def _validate_constraints(settings: Mapping[str, Any]) -> None:
    _require(isinstance(settings.get("allow_late_arrival", True), bool), "constraints.allow_late_arrival 必須是布林值。")
    _validate_int_range(settings.get("late_penalty_per_second", 1000), "constraints.late_penalty_per_second", minimum=0, maximum=1_000_000)
    _validate_int_range(settings.get("waiting_time_cost_per_second", 1), "constraints.waiting_time_cost_per_second", minimum=0, maximum=1_000_000)
    _validate_int_range(settings.get("route_order_penalty_per_second", 20), "constraints.route_order_penalty_per_second", minimum=0, maximum=1_000_000)
    _validate_int_range(settings.get("route_order_interval_seconds", 600), "constraints.route_order_interval_seconds", minimum=1, maximum=SECONDS_PER_DAY)
    _require(isinstance(settings.get("preserve_remaining_order", True), bool), "constraints.preserve_remaining_order 必須是布林值。")


def _validate_priority_settings(settings: Mapping[str, Any]) -> None:
    _validate_int_range(settings.get("default_priority", 3), "priority.default_priority", minimum=1, maximum=MAX_PRIORITY)
    _validate_int_range(settings.get("priority_interval_seconds", 1800), "priority.priority_interval_seconds", minimum=1, maximum=SECONDS_PER_DAY)
    _validate_int_range(settings.get("priority_penalty_per_second", 20), "priority.priority_penalty_per_second", minimum=0, maximum=1_000_000)


def _validate_service_settings(settings: Mapping[str, Any]) -> None:
    _validate_int_range(
        settings.get("default_service_time_seconds", 600),
        "service.default_service_time_seconds",
        minimum=0,
        maximum=SECONDS_PER_DAY,
    )


def _validate_ortools_settings(settings: Mapping[str, Any]) -> None:
    first_solution_strategy = str(settings.get("first_solution_strategy", "PATH_CHEAPEST_ARC")).upper()
    local_search_metaheuristic = str(settings.get("local_search_metaheuristic", "GUIDED_LOCAL_SEARCH")).upper()
    _require(
        first_solution_strategy in SUPPORTED_FIRST_SOLUTION_STRATEGIES,
        f"ortools.first_solution_strategy 不支援 {first_solution_strategy}。",
    )
    _require(
        local_search_metaheuristic in SUPPORTED_LOCAL_SEARCH_METAHEURISTICS,
        f"ortools.local_search_metaheuristic 不支援 {local_search_metaheuristic}。",
    )


def _validate_index(value: Any, field_name: str, location_count: int) -> int:
    return _validate_int_range(value, field_name, minimum=0, maximum=location_count - 1)


def _validate_index_list(value: Any, field_name: str, location_count: int) -> list[int]:
    _require(isinstance(value, list), f"{field_name} 必須是 index 陣列。")
    return [_validate_index(item, field_name, location_count) for item in value]


def _validate_int_range(value: Any, field_name: str, *, minimum: int, maximum: int) -> int:
    _require(isinstance(value, int), f"{field_name} 必須是整數。")
    _require(minimum <= value <= maximum, f"{field_name} 必須介於 {minimum} 到 {maximum}。")
    return value


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise InputValidationError(message)
