import time
from typing import Any, Dict, Mapping, Optional, Sequence, Tuple


def solve_tsptw_dp(
    time_matrix,
    distance_matrix,
    time_windows,
    depot_idx=0,
    timeout=None,
    *,
    start_idx=None,
    end_idx=None,
    service_times: Optional[Sequence[int]] = None,
    allow_late_arrival: bool = True,
    late_penalty_per_second: int = 1000,
    priorities: Optional[Sequence[int]] = None,
    priority_config: Optional[Mapping[str, Any]] = None,
    **_unused_solver_options,
):
    """用動態規劃求解小規模 TSPTW；支援軟性逾時與不同起訖點。"""
    n = len(time_matrix)
    start_node = depot_idx if start_idx is None else start_idx
    end_node = start_node if end_idx is None else end_idx
    service_times = list(service_times or [0] * n)
    service_times[start_node] = 0
    priority_config = priority_config or {}
    priorities = list(priorities or [priority_config.get("default_priority", 3)] * n)
    priority_penalty = int(priority_config.get("priority_penalty_per_second", 0) or 0)
    priority_interval = int(priority_config.get("priority_interval_seconds", 1800) or 1800)

    if n > 15:
        print(f"\n[DP 引擎警告] 節點數為 {n}。DP 複雜度為 O(n^2 * 2^n)，記憶體與時間可能會爆炸。\n")

    start_cpu_time = time.time()
    memo = {}

    def dp(mask, u):
        """回傳走到 u 且已拜訪 mask 內節點時的最佳狀態。"""
        if timeout and time.time() - start_cpu_time > timeout:
            return _failed_state()

        if mask == (1 << start_node):
            if u == start_node:
                arrival_time = max(0, time_windows[start_node][0])
                return (0, arrival_time, 0, [start_node], 0, [arrival_time])
            return _failed_state()

        if (mask, u) in memo:
            return memo[(mask, u)]

        best_state = _failed_state()
        prev_mask = mask & ~(1 << u)

        for v in range(n):
            if not prev_mask & (1 << v):
                continue

            prev_score, prev_time, prev_dist, prev_path, prev_lateness, prev_arrivals = dp(prev_mask, v)
            if prev_score == float("inf"):
                continue

            arrival_time = prev_time + service_times[v] + time_matrix[v][u]
            actual_time = max(arrival_time, time_windows[u][0])
            lateness = max(0, actual_time - time_windows[u][1])
            if lateness > 0 and not allow_late_arrival:
                continue

            dist = prev_dist + distance_matrix[v][u]
            priority_delay = _priority_delay_seconds(
                node=u,
                arrival_time=actual_time,
                time_windows=time_windows,
                priorities=priorities,
                priority_interval=priority_interval,
            )
            score = prev_score + lateness * late_penalty_per_second + priority_delay * priority_penalty
            candidate = (
                score,
                actual_time,
                dist,
                prev_path + [u],
                prev_lateness + lateness,
                prev_arrivals + [actual_time],
            )
            best_state = _better_state(best_state, candidate)

        memo[(mask, u)] = best_state
        return best_state

    # 若 start/end 不同，end 節點只作為最後停靠點，不在中途拜訪。
    required_nodes = [node for node in range(n) if node != end_node or end_node == start_node]
    final_mask = 0
    for node in required_nodes:
        final_mask |= 1 << node

    best_final_state = _failed_state()
    for v in range(n):
        if v == end_node:
            continue

        prev_score, prev_time, prev_dist, prev_path, prev_lateness, prev_arrivals = dp(final_mask, v)
        if prev_score == float("inf"):
            continue

        arrival_time = prev_time + service_times[v] + time_matrix[v][end_node]
        actual_time = max(arrival_time, time_windows[end_node][0])
        lateness = max(0, actual_time - time_windows[end_node][1])
        if lateness > 0 and not allow_late_arrival:
            continue

        dist = prev_dist + distance_matrix[v][end_node]
        score = prev_score + lateness * late_penalty_per_second
        candidate = (
            score,
            actual_time,
            dist,
            prev_path + [end_node],
            prev_lateness + lateness,
            prev_arrivals + [actual_time],
        )
        best_final_state = _better_state(best_final_state, candidate)

    execution_time = time.time() - start_cpu_time
    print(f"[DP 引擎] 運算完成！耗時 {execution_time:.4f} 秒。快取狀態數：{len(memo)}")

    score, final_time, total_distance, route_indices, total_lateness, arrival_times = best_final_state
    if score == float("inf"):
        return {"status": "FAILED", "message": "DP 無法找到路線；可嘗試開啟軟性時間窗或改用 OR-Tools。"}

    return {
        "status": "SUCCESS",
        "objective_score": score,
        "total_time_seconds": final_time - arrival_times[0],
        "total_travel_seconds": _sum_travel_seconds(route_indices, time_matrix),
        "total_service_seconds": _sum_service_seconds(route_indices, service_times),
        "total_elapsed_seconds": final_time - arrival_times[0],
        "total_distance_meters": total_distance,
        "total_lateness_seconds": total_lateness,
        "route_indices": route_indices,
        "arrival_times_by_order": arrival_times,
        "physical_arrival_times_by_order": _physical_arrival_times_by_order(
            route_indices,
            arrival_times,
            service_times,
            time_matrix,
        ),
        "service_times_by_order": _service_times_by_order(route_indices, service_times),
        "lateness_seconds_by_index": _build_lateness_by_index(route_indices, arrival_times, time_windows),
        "start_index": start_node,
        "end_index": end_node,
    }


def _failed_state() -> Tuple[float, float, float, list, float, list]:
    """DP 使用的不可行狀態。"""
    return (float("inf"), float("inf"), float("inf"), [], float("inf"), [])


def _better_state(current, candidate):
    """依分數、抵達時間、距離選出較佳 DP 狀態。"""
    current_key = (current[0], current[1], current[2])
    candidate_key = (candidate[0], candidate[1], candidate[2])
    return candidate if candidate_key < current_key else current


def _priority_delay_seconds(
    *,
    node: int,
    arrival_time: int,
    time_windows,
    priorities: Sequence[int],
    priority_interval: int,
) -> int:
    """估算優先客戶被排太晚的懲罰秒數。"""
    earliest, latest = time_windows[node]
    preferred_upper = min(latest, earliest + max(1, priorities[node]) * priority_interval)
    return max(0, arrival_time - preferred_upper)


def _build_lateness_by_index(route_indices, arrival_times, time_windows) -> Dict[int, int]:
    """整理每個地點的最大延誤秒數。"""
    lateness_by_index: Dict[int, int] = {}
    for node, arrival_time in zip(route_indices, arrival_times):
        lateness = max(0, arrival_time - time_windows[node][1])
        lateness_by_index[node] = max(lateness_by_index.get(node, 0), lateness)
    return lateness_by_index


def _sum_travel_seconds(route_indices, time_matrix) -> int:
    return sum(
        time_matrix[from_node][to_node]
        for from_node, to_node in zip(route_indices, route_indices[1:])
    )


def _sum_service_seconds(route_indices, service_times) -> int:
    return sum(_service_times_by_order(route_indices, service_times))


def _service_times_by_order(route_indices, service_times) -> list[int]:
    if not route_indices:
        return []
    charged = [service_times[node] for node in route_indices[:-1]]
    charged.append(0)
    return charged


def _physical_arrival_times_by_order(route_indices, service_start_times, service_times, time_matrix) -> list[int]:
    if not route_indices:
        return []

    physical_arrivals = [service_start_times[0]]
    for order, (from_node, to_node) in enumerate(zip(route_indices, route_indices[1:])):
        physical_arrivals.append(
            service_start_times[order] + service_times[from_node] + time_matrix[from_node][to_node]
        )
    return physical_arrivals
