import urllib.parse
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence

from core.dp_engine import solve_tsptw_dp
from core.google_maps_api import fetch_distance_matrix
from core.input_validator import InputValidationError, validate_and_normalize_request
from core.or_tools_engine import solve_tsptw


# 求解器登錄表：之後若新增演算法，只要在這裡掛上名稱與函式。
SolverFunction = Callable[..., Dict[str, Any]]
SOLVERS: Dict[str, SolverFunction] = {
    "ortools": solve_tsptw,
    "dp": solve_tsptw_dp,
}
TERMINAL_LOCATION_STATUSES = {"completed", "cancelled", "skipped"}


def optimize_route_request(request_data: Mapping[str, Any]) -> Dict[str, Any]:
    """執行完整路線最佳化流程，供 API 與本機 JSON 腳本共用。"""
    try:
        request_data = validate_and_normalize_request(request_data)
    except InputValidationError as exc:
        return {
            "status": "ERROR",
            "message": f"輸入資料格式錯誤: {exc}",
        }

    route_state = _apply_in_transit_state(request_data)
    if route_state["no_remaining_route"]:
        return _build_no_remaining_route_response(route_state)

    request_data = route_state["request_data"]
    locations = request_data["locations"]
    routing_context = _prepare_locations(
        locations,
        request_data.get("priority", {}),
        request_data.get("service", {}),
        current_index=request_data.get("current_index"),
        current_time_seconds=request_data.get("current_time_seconds"),
        depot_index=request_data.get("depot_index"),
        original_indices=route_state["active_original_indices"],
        route_order_config=request_data.get("constraints", {}),
    )

    google_maps_config = request_data.get("google_maps", {})
    matrix_data = fetch_distance_matrix(
        addresses=routing_context["addresses"],
        api_key=request_data["google_maps_api_key"],
        cache_filename=request_data.get("matrix_cache_file", "matrix_cache.json"),
        mode=google_maps_config.get("mode", "driving"),
        language=google_maps_config.get("language", "zh-TW"),
        chunk_size=google_maps_config.get("chunk_size", 10),
        request_delay_seconds=google_maps_config.get("request_delay_seconds", 1),
    )
    if not matrix_data:
        return {
            "status": "ERROR",
            "message": "無法取得 Google Maps 距離矩陣，請確認 API Key、地址與網路連線。",
        }

    solver = _select_solver(request_data.get("solver", "ortools"))
    result = _solve_route(
        solver=solver,
        request_data=request_data,
        matrix_data=matrix_data,
        routing_context=routing_context,
    )

    if result["status"] != "SUCCESS":
        return {
            "status": "FAILED",
            "message": result["message"],
        }

    navigation_config = request_data.get("navigation", {})
    active_route_indices = result["route_indices"]
    original_route_indices = _map_active_indices(active_route_indices, route_state)
    ordered_route_names = [routing_context["location_names"][idx] for idx in active_route_indices]
    navigation_urls = generate_maps_urls(
        route_indices=active_route_indices,
        addresses=routing_context["addresses"],
        max_points_per_url=navigation_config.get("max_points_per_url", 10),
        travelmode=navigation_config.get("travelmode", "driving"),
    )
    route_details = _map_route_details_to_original_indices(
        _build_route_details(result, routing_context),
        route_state,
    )

    return {
        "status": "SUCCESS",
        "data": {
            "total_time_minutes": round(result["total_time_seconds"] / 60, 1),
            "total_travel_minutes": round(result.get("total_travel_seconds", result["total_time_seconds"]) / 60, 1),
            "total_service_minutes": round(result.get("total_service_seconds", 0) / 60, 1),
            "total_elapsed_minutes": round(result.get("total_elapsed_seconds", result["total_time_seconds"]) / 60, 1),
            "total_distance_km": round(result["total_distance_meters"] / 1000, 2),
            "total_lateness_minutes": round(result.get("total_lateness_seconds", 0) / 60, 1),
            "route_sequence": ordered_route_names,
            "route_indices": original_route_indices,
            "route_details": route_details,
            "driver_navigation_urls": navigation_urls,
            "selected_start_index": _map_active_index(result.get("start_index"), route_state),
            "selected_end_index": _map_active_index(result.get("end_index"), route_state),
            "reoptimization": route_state["metadata"],
            "solver_metadata": result.get("solver_metadata"),
        },
    }


def _apply_in_transit_state(request_data: Mapping[str, Any]) -> Dict[str, Any]:
    """Filter delivered or removed stops before re-solving an in-transit route."""
    locations = list(request_data["locations"])
    current_index = request_data.get("current_index")
    if current_index is None:
        current_index = request_data.get("start_index")
    if current_index is None:
        current_index = request_data.get("depot_index", 0)
    current_index = int(current_index if current_index is not None else 0)

    excluded_indices = set(request_data.get("completed_indices") or [])
    excluded_indices.update(request_data.get("cancelled_indices") or [])
    excluded_indices.update(request_data.get("skipped_indices") or [])
    excluded_indices.update(
        index
        for index, location in enumerate(locations)
        if location.get("status") in TERMINAL_LOCATION_STATUSES
    )
    excluded_indices.discard(current_index)

    active_original_indices = [
        index for index in range(len(locations)) if index not in excluded_indices
    ]
    original_to_active_index = {
        original_index: active_index
        for active_index, original_index in enumerate(active_original_indices)
    }
    active_request = dict(request_data)
    active_request["locations"] = [locations[index] for index in active_original_indices]

    current_active_index = original_to_active_index.get(current_index)
    if current_active_index is None:
        active_original_indices.insert(0, current_index)
        active_request["locations"].insert(0, locations[current_index])
        original_to_active_index = {
            original_index: active_index
            for active_index, original_index in enumerate(active_original_indices)
        }
        current_active_index = 0

    active_request["current_index"] = current_active_index
    active_request["start_index"] = current_active_index
    active_request["depot_index"] = _remap_or_default(
        request_data.get("depot_index", current_index),
        original_to_active_index,
        current_active_index,
    )
    active_request["end_index"] = _remap_optional_index(
        request_data.get("end_index"),
        original_to_active_index,
    )
    active_request["end_candidate_indices"] = [
        original_to_active_index[index]
        for index in request_data.get("end_candidate_indices", [])
        if index in original_to_active_index
    ]
    # 手動順序用原始 index 表示，這裡一併換成剩餘站點的 index；已完成/取消/跳過的站直接落掉。
    active_request["manual_route_indices"] = [
        original_to_active_index[index]
        for index in request_data.get("manual_route_indices") or []
        if index in original_to_active_index
    ]

    removed_indices = sorted(excluded_indices)
    metadata = {
        "mode": "in_transit" if _has_in_transit_state(request_data) else "full_route",
        "current_index": current_index,
        "current_time_seconds": request_data.get("current_time_seconds"),
        "active_indices": active_original_indices,
        "remaining_delivery_indices": [
            index for index in active_original_indices if index != current_index
        ],
        "removed_indices": removed_indices,
        "completed_indices": request_data.get("completed_indices", []),
        "cancelled_indices": request_data.get("cancelled_indices", []),
        "skipped_indices": request_data.get("skipped_indices", []),
    }

    return {
        "request_data": active_request,
        "original_locations": locations,
        "active_original_indices": active_original_indices,
        "original_to_active_index": original_to_active_index,
        "metadata": metadata,
        "no_remaining_route": len(active_original_indices) <= 1,
    }


def _has_in_transit_state(request_data: Mapping[str, Any]) -> bool:
    return any(
        request_data.get(field)
        for field in (
            "current_index",
            "completed_indices",
            "cancelled_indices",
            "skipped_indices",
        )
    ) or any(location.get("status") in TERMINAL_LOCATION_STATUSES for location in request_data["locations"])


def _remap_or_default(index: int, original_to_active_index: Mapping[int, int], default_index: int) -> int:
    return original_to_active_index.get(int(index), default_index)


def _remap_optional_index(index: Optional[int], original_to_active_index: Mapping[int, int]) -> Optional[int]:
    if index is None:
        return None
    return original_to_active_index.get(int(index))


def _map_active_index(index: Optional[int], route_state: Mapping[str, Any]) -> Optional[int]:
    if index is None:
        return None
    active_original_indices = route_state["active_original_indices"]
    if index < 0 or index >= len(active_original_indices):
        return None
    return active_original_indices[index]


def _map_active_indices(active_indices: Sequence[int], route_state: Mapping[str, Any]) -> List[int]:
    return [_map_active_index(index, route_state) for index in active_indices]


def _map_route_details_to_original_indices(
    route_details: Sequence[Mapping[str, Any]],
    route_state: Mapping[str, Any],
) -> List[Dict[str, Any]]:
    mapped_details = []
    for detail in route_details:
        active_index = detail["index"]
        mapped_detail = dict(detail)
        mapped_detail["active_index"] = active_index
        mapped_detail["index"] = _map_active_index(active_index, route_state)
        mapped_details.append(mapped_detail)
    return mapped_details


def _build_no_remaining_route_response(route_state: Mapping[str, Any]) -> Dict[str, Any]:
    current_index = route_state["metadata"]["current_index"]
    location = route_state["original_locations"][current_index]
    service_config = route_state["request_data"].get("service", {})
    default_service_time = int(service_config.get("default_service_time_seconds", 600))
    service_time_seconds = location.get("service_time_seconds")
    return {
        "status": "SUCCESS",
        "data": {
            "total_time_minutes": 0.0,
            "total_travel_minutes": 0.0,
            "total_service_minutes": 0.0,
            "total_elapsed_minutes": 0.0,
            "total_distance_km": 0.0,
            "total_lateness_minutes": 0.0,
            "route_sequence": [location["name"]],
            "route_indices": [current_index],
            "route_details": [
                {
                    "order": 0,
                    "index": current_index,
                    "active_index": 0,
                    "name": location["name"],
                    "arrival_time_seconds": 0,
                    "service_start_time_seconds": 0,
                    "waiting_time_seconds": 0,
                    "waiting_time_minutes": 0.0,
                    "service_completion_time_seconds": 0,
                    "original_time_window": location["time_window"],
                    "effective_time_window": location["time_window"],
                    "service_time_seconds": default_service_time if service_time_seconds is None else service_time_seconds,
                    "charged_service_time_seconds": 0,
                    "lateness_seconds": 0,
                    "priority": location.get("priority"),
                    "delay": {
                        "delay_by_seconds": 0,
                        "delay_until_seconds": None,
                        "effective_start_seconds": location["time_window"][0],
                    },
                }
            ],
            "driver_navigation_urls": [],
            "selected_start_index": current_index,
            "selected_end_index": current_index,
            "reoptimization": {
                **route_state["metadata"],
                "no_remaining_deliveries": True,
            },
            "solver_metadata": {
                "solver": "none",
                "reason": "no_remaining_deliveries",
            },
        },
    }


def generate_maps_urls(
    route_indices: Sequence[int],
    addresses: Sequence[str],
    *,
    max_points_per_url: int = 10,
    travelmode: str = "driving",
) -> List[str]:
    """產生 Google Maps 導航網址，並把過長路線切成多段。"""
    if max_points_per_url > 10:
        raise ValueError("Google Maps 導航網址每段最多只能包含 10 個點。")

    urls = []
    max_points = max(2, max_points_per_url)
    step_size = max_points - 1

    for i in range(0, len(route_indices) - 1, step_size):
        chunk = route_indices[i : i + max_points]
        if len(chunk) < 2:
            break

        origin = addresses[chunk[0]]
        destination = addresses[chunk[-1]]
        waypoints = [addresses[idx] for idx in chunk[1:-1]]

        params = {
            "api": "1",
            "origin": origin,
            "destination": destination,
            "travelmode": travelmode,
        }
        if waypoints:
            params["waypoints"] = "|".join(waypoints)

        urls.append("https://www.google.com/maps/dir/?" + urllib.parse.urlencode(params))

    return urls


def _prepare_locations(
    locations: Sequence[Mapping[str, Any]],
    priority_config: Mapping[str, Any],
    service_config: Mapping[str, Any],
    *,
    current_index: Optional[int] = None,
    current_time_seconds: Optional[int] = None,
    depot_index: Optional[int] = None,
    original_indices: Optional[Sequence[int]] = None,
    route_order_config: Optional[Mapping[str, Any]] = None,
) -> Dict[str, Any]:
    """整理地點欄位，並計算延後配送後的有效時間窗。"""
    default_priority = priority_config.get("default_priority", 3)
    default_service_time = int(service_config.get("default_service_time_seconds", 600))
    addresses = []
    location_names = []
    original_time_windows = []
    effective_time_windows = []
    service_times = []
    priorities = []
    delay_infos = []
    original_indices = list(original_indices or range(len(locations)))
    route_order_config = route_order_config or {}

    for index, location in enumerate(locations):
        addresses.append(location["address"])
        location_names.append(location["name"])

        original_start, original_end = location["time_window"]
        delay_by_seconds = int(location.get("delay_by_seconds", location.get("delivery_delay_seconds", 0)) or 0)
        delay_until_seconds = location.get("delay_until_seconds")
        rescheduled_time_window = location.get("rescheduled_time_window")

        delay_reference_seconds = current_time_seconds if current_time_seconds is not None else 0
        delayed_start = original_start + delay_by_seconds
        if delay_by_seconds and current_time_seconds is not None:
            delayed_start = max(delayed_start, int(current_time_seconds) + delay_by_seconds)
        delayed_end = original_end
        if rescheduled_time_window is not None:
            delayed_start, delayed_end = rescheduled_time_window
        elif delay_until_seconds is not None:
            delayed_start = max(delayed_start, int(delay_until_seconds))
        if current_time_seconds is not None and current_index is not None and index == int(current_index):
            delayed_start = int(current_time_seconds)
            delayed_end = int(current_time_seconds)

        original_time_windows.append([original_start, original_end])
        effective_time_windows.append([delayed_start, delayed_end])
        service_time_seconds = location.get("service_time_seconds")
        service_times.append(default_service_time if service_time_seconds is None else int(service_time_seconds))
        priorities.append(int(location.get("priority", default_priority) or default_priority))
        delay_infos.append(
            {
                "delay_by_seconds": delay_by_seconds,
                "delay_until_seconds": delay_until_seconds,
                "delay_reference_seconds": delay_reference_seconds if delay_by_seconds else None,
                "rescheduled_time_window": rescheduled_time_window,
                "effective_start_seconds": delayed_start,
                "effective_end_seconds": delayed_end,
            }
        )

    return {
        "addresses": addresses,
        "location_names": location_names,
        "original_time_windows": original_time_windows,
        "effective_time_windows": effective_time_windows,
        "service_times": service_times,
        "priorities": priorities,
        "delay_infos": delay_infos,
        "route_order_preferred_upper_bounds": _build_route_order_preferred_upper_bounds(
            locations=locations,
            effective_time_windows=effective_time_windows,
            current_index=current_index,
            current_time_seconds=current_time_seconds,
            depot_index=depot_index,
            original_indices=original_indices,
            interval_seconds=int(route_order_config.get("route_order_interval_seconds", 600) or 600),
        ),
        "route_order_precedence_pairs": _build_route_order_precedence_pairs(
            locations=locations,
            current_index=current_index,
            current_time_seconds=current_time_seconds,
            depot_index=depot_index,
            original_indices=original_indices,
            preserve_remaining_order=bool(route_order_config.get("preserve_remaining_order", True)),
        ),
    }


def _build_route_order_preferred_upper_bounds(
    *,
    locations: Sequence[Mapping[str, Any]],
    effective_time_windows: Sequence[Sequence[int]],
    current_index: Optional[int],
    current_time_seconds: Optional[int],
    depot_index: Optional[int],
    original_indices: Sequence[int],
    interval_seconds: int,
) -> List[Optional[int]]:
    """Build soft preferred arrival times for in-transit reroutes."""
    preferred_upper_bounds: List[Optional[int]] = [None] * len(locations)
    if current_index is None or current_time_seconds is None:
        return preferred_upper_bounds

    ranked_indices = _rank_in_transit_remaining_indices(
        locations=locations,
        current_index=int(current_index),
        depot_index=depot_index,
        original_indices=original_indices,
    )

    for rank, index in enumerate(ranked_indices, start=1):
        earliest_start = int(effective_time_windows[index][0])
        preferred_upper_bounds[index] = max(
            earliest_start,
            int(current_time_seconds) + rank * max(1, interval_seconds),
        )

    return preferred_upper_bounds


def _manual_route_sequence(
    manual_route_indices: Optional[Sequence[int]],
    *,
    start_index: int,
    end_index: Optional[int],
) -> List[int]:
    """把前端送來的手動順序整理成「中間站的走訪順序」（不含起點與終點）。

    求解器拿到這串就把路徑釘死、只算時間；順序照使用者的，塞不進時間窗的站算成逾時。
    """
    if not manual_route_indices:
        return []

    excluded = {int(start_index)}
    if end_index is not None:
        excluded.add(int(end_index))
    return [int(index) for index in manual_route_indices if int(index) not in excluded]


def _manual_order_precedence_pairs(
    manual_route_indices: Optional[Sequence[int]],
    *,
    start_index: int,
    end_index: Optional[int],
) -> List[List[int]]:
    """把使用者手動調整的站點順序轉成相鄰的先後順序約束。

    前端「完成調整」時送 `manual_route_indices`（剩餘站點的完整順序）。相鄰兩站各給一條
    `time(前) <= time(後)`，等於把整條路線的順序鎖死，求解器只負責照這個順序算抵達/完成
    時間，不再自行換順序。起點與終點由 start_index / end_index 決定，這裡不納入。
    """
    if not manual_route_indices:
        return []

    excluded = {int(start_index)}
    if end_index is not None:
        excluded.add(int(end_index))
    ordered = [int(index) for index in manual_route_indices if int(index) not in excluded]
    return [[first, second] for first, second in zip(ordered, ordered[1:])]


def _build_route_order_precedence_pairs(
    *,
    locations: Sequence[Mapping[str, Any]],
    current_index: Optional[int],
    current_time_seconds: Optional[int],
    depot_index: Optional[int],
    original_indices: Sequence[int],
    preserve_remaining_order: bool,
) -> List[List[int]]:
    """Keep remaining order as a soft preference, not a hard precedence constraint."""
    return []


def _rank_in_transit_remaining_indices(
    *,
    locations: Sequence[Mapping[str, Any]],
    current_index: int,
    depot_index: Optional[int],
    original_indices: Sequence[int],
) -> List[int]:
    """Rank normal remaining stops first, then rescheduled stops, preserving original order."""
    excluded_indices = {int(current_index)}
    if depot_index is not None:
        excluded_indices.add(int(depot_index))

    ranked_indices = [
        index
        for index in range(len(locations))
        if index not in excluded_indices
    ]
    ranked_indices.sort(
        key=lambda index: (
            _has_delivery_reschedule(locations[index]),
            original_indices[index] if index < len(original_indices) else index,
        )
    )
    return ranked_indices


def _has_delivery_reschedule(location: Mapping[str, Any]) -> bool:
    """Return whether a stop has been delayed or explicitly rescheduled."""
    return bool(
        location.get("status") == "delayed"
        or location.get("rescheduled_time_window") is not None
        or location.get("delay_until_seconds") is not None
        or location.get("delay_by_seconds")
        or location.get("delivery_delay_seconds")
    )


def _solve_route(
    *,
    solver: SolverFunction,
    request_data: Mapping[str, Any],
    matrix_data: Mapping[str, Any],
    routing_context: Mapping[str, Any],
) -> Dict[str, Any]:
    """依設定決定起點、終點與候選終點，並執行求解器。"""
    start_index = _resolve_start_index(request_data)
    fixed_end_index = _resolve_fixed_end_index(request_data, start_index)
    end_candidate_indices = request_data.get("end_candidate_indices") or []

    if fixed_end_index is not None:
        return _run_solver(
            solver=solver,
            request_data=request_data,
            matrix_data=matrix_data,
            routing_context=routing_context,
            start_index=start_index,
            end_index=fixed_end_index,
        )

    candidates = end_candidate_indices or [start_index]
    candidate_results = [
        _run_solver(
            solver=solver,
            request_data=request_data,
            matrix_data=matrix_data,
            routing_context=routing_context,
            start_index=start_index,
            end_index=end_index,
        )
        for end_index in candidates
    ]
    successful_results = [result for result in candidate_results if result["status"] == "SUCCESS"]
    if not successful_results:
        return candidate_results[0]

    return min(
        successful_results,
        key=lambda result: (
            result.get("objective_score", 0),
            result.get("total_lateness_seconds", 0),
            result.get("total_time_seconds", 0),
            result.get("total_distance_meters", 0),
        ),
    )


def _run_solver(
    *,
    solver: SolverFunction,
    request_data: Mapping[str, Any],
    matrix_data: Mapping[str, Any],
    routing_context: Mapping[str, Any],
    start_index: int,
    end_index: int,
) -> Dict[str, Any]:
    """統一把服務層設定傳給不同求解器。"""
    constraints = request_data.get("constraints", {})
    manual_sequence = _manual_route_sequence(
        request_data.get("manual_route_indices"),
        start_index=start_index,
        end_index=end_index,
    )
    precedence_pairs = _manual_order_precedence_pairs(
        request_data.get("manual_route_indices"),
        start_index=start_index,
        end_index=end_index,
    ) or routing_context.get("route_order_precedence_pairs")
    result = solver(
        time_matrix=matrix_data["time_matrix"],
        distance_matrix=matrix_data["distance_matrix"],
        time_windows=routing_context["effective_time_windows"],
        depot_idx=request_data.get("depot_index", start_index),
        start_idx=start_index,
        end_idx=end_index,
        timeout=request_data.get("solver_timeout_seconds", 5),
        service_times=routing_context["service_times"],
        allow_late_arrival=constraints.get("allow_late_arrival", True),
        late_penalty_per_second=constraints.get("late_penalty_per_second", 1000),
        waiting_time_cost_per_second=constraints.get("waiting_time_cost_per_second", 1),
        priorities=routing_context["priorities"],
        priority_config=request_data.get("priority", {}),
        route_order_preferred_upper_bounds=routing_context.get("route_order_preferred_upper_bounds"),
        route_order_penalty_per_second=constraints.get("route_order_penalty_per_second", 20),
        route_order_precedence_pairs=precedence_pairs,
        manual_route_sequence=manual_sequence,
        ortools_config=request_data.get("ortools", {}),
    )
    result["start_index"] = start_index
    result["end_index"] = end_index
    return result


def _build_route_details(result: Mapping[str, Any], routing_context: Mapping[str, Any]) -> List[Dict[str, Any]]:
    """整理每個站點的抵達時間、延誤與優先權，方便司機或客服通知客戶。"""
    service_start_times_by_order = result.get("arrival_times_by_order", [])
    physical_arrival_times_by_order = result.get("physical_arrival_times_by_order", service_start_times_by_order)
    service_times_by_order = result.get("service_times_by_order", [])
    lateness = result.get("lateness_seconds_by_index", {})
    details = []

    for order, location_index in enumerate(result["route_indices"]):
        service_start_time = (
            service_start_times_by_order[order]
            if order < len(service_start_times_by_order)
            else None
        )
        physical_arrival_time = (
            physical_arrival_times_by_order[order]
            if order < len(physical_arrival_times_by_order)
            else service_start_time
        )
        charged_service_time = (
            service_times_by_order[order]
            if order < len(service_times_by_order)
            else 0
        )
        waiting_time = (
            max(0, service_start_time - physical_arrival_time)
            if service_start_time is not None and physical_arrival_time is not None
            else 0
        )
        service_completion_time = (
            service_start_time + charged_service_time
            if service_start_time is not None
            else None
        )
        details.append(
            {
                "order": order,
                "index": location_index,
                "name": routing_context["location_names"][location_index],
                "arrival_time_seconds": physical_arrival_time,
                "service_start_time_seconds": service_start_time,
                "waiting_time_seconds": waiting_time,
                "waiting_time_minutes": round(waiting_time / 60, 1),
                "service_completion_time_seconds": service_completion_time,
                "original_time_window": routing_context["original_time_windows"][location_index],
                "effective_time_window": routing_context["effective_time_windows"][location_index],
                "service_time_seconds": routing_context["service_times"][location_index],
                "charged_service_time_seconds": charged_service_time,
                "lateness_seconds": lateness.get(location_index, 0),
                "priority": routing_context["priorities"][location_index],
                "delay": routing_context["delay_infos"][location_index],
            }
        )

    return details


def _resolve_start_index(request_data: Mapping[str, Any]) -> int:
    """決定實際起點；未設定 start_index 時沿用 depot_index。"""
    start_index = request_data.get("start_index")
    if start_index is not None:
        return int(start_index)
    return int(request_data.get("depot_index", 0))


def _resolve_fixed_end_index(request_data: Mapping[str, Any], start_index: int) -> Optional[int]:
    """決定固定終點；end_index 明確為 null 時代表可使用候選終點。"""
    if "end_index" in request_data and request_data.get("end_index") is not None:
        return int(request_data["end_index"])

    if request_data.get("end_candidate_indices"):
        return None

    return int(request_data.get("depot_index", start_index))


def _select_solver(solver_name: str) -> SolverFunction:
    """依設定名稱取得求解器函式。"""
    try:
        return SOLVERS[solver_name.lower()]
    except KeyError as exc:
        supported = ", ".join(sorted(SOLVERS))
        raise ValueError(f"不支援的 solver：{solver_name}。可用選項：{supported}") from exc
