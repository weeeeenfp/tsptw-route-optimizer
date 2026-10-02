from typing import Any, Dict, List, Mapping, Optional, Sequence

from ortools.constraint_solver import pywrapcp, routing_enums_pb2


FIRST_SOLUTION_STRATEGIES = {
    "PATH_CHEAPEST_ARC": routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC,
    "PARALLEL_CHEAPEST_INSERTION": routing_enums_pb2.FirstSolutionStrategy.PARALLEL_CHEAPEST_INSERTION,
    "LOCAL_CHEAPEST_INSERTION": routing_enums_pb2.FirstSolutionStrategy.LOCAL_CHEAPEST_INSERTION,
    "GLOBAL_CHEAPEST_ARC": routing_enums_pb2.FirstSolutionStrategy.GLOBAL_CHEAPEST_ARC,
    "AUTOMATIC": routing_enums_pb2.FirstSolutionStrategy.AUTOMATIC,
}

LOCAL_SEARCH_METAHEURISTICS = {
    "GUIDED_LOCAL_SEARCH": routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH,
    "GREEDY_DESCENT": routing_enums_pb2.LocalSearchMetaheuristic.GREEDY_DESCENT,
    "SIMULATED_ANNEALING": routing_enums_pb2.LocalSearchMetaheuristic.SIMULATED_ANNEALING,
    "TABU_SEARCH": routing_enums_pb2.LocalSearchMetaheuristic.TABU_SEARCH,
    "AUTOMATIC": routing_enums_pb2.LocalSearchMetaheuristic.AUTOMATIC,
}


def solve_tsptw(
    time_matrix,
    distance_matrix,
    time_windows,
    depot_idx=0,
    timeout=5,
    *,
    start_idx=None,
    end_idx=None,
    service_times: Optional[Sequence[int]] = None,
    allow_late_arrival: bool = True,
    late_penalty_per_second: int = 1000,
    waiting_time_cost_per_second: int = 1,
    priorities: Optional[Sequence[int]] = None,
    priority_config: Optional[Mapping[str, Any]] = None,
    route_order_preferred_upper_bounds: Optional[Sequence[Optional[int]]] = None,
    route_order_penalty_per_second: int = 20,
    route_order_precedence_pairs: Optional[Sequence[Sequence[int]]] = None,
    manual_route_sequence: Optional[Sequence[int]] = None,
    ortools_config: Optional[Mapping[str, Any]] = None,
):
    """Solve a single-vehicle TSPTW problem with configurable OR-Tools search strategies."""
    ortools_config = ortools_config or {}
    first_solution_strategy_name = ortools_config.get("first_solution_strategy", "PATH_CHEAPEST_ARC")
    local_search_metaheuristic_name = ortools_config.get("local_search_metaheuristic", "GUIDED_LOCAL_SEARCH")

    print(
        "[OR-Tools] solving with "
        f"{first_solution_strategy_name} + {local_search_metaheuristic_name}"
    )

    node_count = len(time_matrix)
    start_node = depot_idx if start_idx is None else start_idx
    end_node = start_node if end_idx is None else end_idx
    service_times = list(service_times or [0] * node_count)
    service_times[start_node] = 0
    priorities = list(priorities or [priority_config.get("default_priority", 3) if priority_config else 3] * node_count)
    priority_config = priority_config or {}
    horizon = _calculate_time_horizon(time_matrix, time_windows, service_times)

    manager = pywrapcp.RoutingIndexManager(node_count, 1, [start_node], [end_node])
    routing = pywrapcp.RoutingModel(manager)

    def time_callback(from_index, to_index):
        from_node = manager.IndexToNode(from_index)
        to_node = manager.IndexToNode(to_index)
        return time_matrix[from_node][to_node] + service_times[from_node]

    transit_callback_index = routing.RegisterTransitCallback(time_callback)
    routing.SetArcCostEvaluatorOfAllVehicles(transit_callback_index)

    routing.AddDimension(transit_callback_index, horizon, horizon, False, "Time")
    time_dimension = routing.GetDimensionOrDie("Time")
    if waiting_time_cost_per_second > 0:
        time_dimension.SetSlackCostCoefficientForAllVehicles(waiting_time_cost_per_second)

    _apply_time_windows(
        routing=routing,
        manager=manager,
        time_dimension=time_dimension,
        time_windows=time_windows,
        start_node=start_node,
        end_node=end_node,
        horizon=horizon,
        allow_late_arrival=allow_late_arrival,
        late_penalty_per_second=late_penalty_per_second,
    )

    _pin_departure_time(
        routing=routing,
        time_dimension=time_dimension,
        departure_seconds=int(time_windows[start_node][0]),
    )

    _apply_priority_preferences(
        routing=routing,
        manager=manager,
        transit_callback_index=transit_callback_index,
        time_windows=time_windows,
        priorities=priorities,
        priority_config=priority_config,
        start_node=start_node,
        end_node=end_node,
        horizon=horizon,
    )
    _apply_route_order_preferences(
        routing=routing,
        manager=manager,
        transit_callback_index=transit_callback_index,
        preferred_upper_bounds=route_order_preferred_upper_bounds,
        route_order_penalty_per_second=route_order_penalty_per_second,
        start_node=start_node,
        end_node=end_node,
        horizon=horizon,
    )
    # 使用者手動排好的完整順序：直接把路徑釘死，求解器只算時間、不再搜尋順序。
    # 釘不成（順序不完整）才退回逐段的先後約束。
    pinned = _pin_route_sequence(
        routing=routing,
        manager=manager,
        sequence=manual_route_sequence,
        node_count=node_count,
        start_node=start_node,
        end_node=end_node,
    )
    if not pinned:
        _apply_route_order_precedence(
            routing=routing,
            manager=manager,
            time_dimension=time_dimension,
            precedence_pairs=route_order_precedence_pairs,
            start_node=start_node,
            end_node=end_node,
        )

    search_parameters = pywrapcp.DefaultRoutingSearchParameters()
    search_parameters.first_solution_strategy = _enum_value(
        FIRST_SOLUTION_STRATEGIES,
        first_solution_strategy_name,
        "first_solution_strategy",
    )
    search_parameters.local_search_metaheuristic = _enum_value(
        LOCAL_SEARCH_METAHEURISTICS,
        local_search_metaheuristic_name,
        "local_search_metaheuristic",
    )
    search_parameters.time_limit.seconds = timeout

    solution = routing.SolveWithParameters(search_parameters)
    if not solution:
        return {"status": "FAILED", "message": "無法找到路線；可嘗試開啟軟性時間窗或延長 timeout。"}

    result = _extract_solution(
        solution=solution,
        routing=routing,
        manager=manager,
        time_dimension=time_dimension,
        time_matrix=time_matrix,
        distance_matrix=distance_matrix,
        time_windows=time_windows,
        service_times=service_times,
        depot_node=depot_idx,
        start_node=start_node,
        end_node=end_node,
    )
    result["solver_metadata"] = {
        "solver": "ortools",
        "first_solution_strategy": first_solution_strategy_name,
        "local_search_metaheuristic": local_search_metaheuristic_name,
    }
    return result


def _enum_value(enum_map: Mapping[str, int], name: str, field_name: str) -> int:
    normalized_name = str(name).upper()
    if normalized_name not in enum_map:
        supported = ", ".join(sorted(enum_map))
        raise ValueError(f"{field_name} 不支援 {name}，可用選項：{supported}")
    return enum_map[normalized_name]


def _apply_time_windows(
    *,
    routing,
    manager,
    time_dimension,
    time_windows,
    start_node: int,
    end_node: int,
    horizon: int,
    allow_late_arrival: bool,
    late_penalty_per_second: int,
) -> None:
    """Apply hard or soft time windows."""
    for node, time_window in enumerate(time_windows):
        for index in _routing_indices_for_node(routing, manager, node, start_node, end_node):
            lower_bound, upper_bound = time_window
            if allow_late_arrival:
                time_dimension.CumulVar(index).SetRange(lower_bound, horizon)
                time_dimension.SetCumulVarSoftUpperBound(index, upper_bound, late_penalty_per_second)
            else:
                time_dimension.CumulVar(index).SetRange(lower_bound, upper_bound)


def _pin_departure_time(*, routing, time_dimension, departure_seconds: int) -> None:
    """把起點的出發時刻固定在時間窗開始（＝使用者設定的「預計出發時間」）。

    Time 維度對等待時間收費（SetSlackCostCoefficientForAllVehicles），而起點的時間窗
    上界是一整天，求解器因此可以「乾脆晚點出發」把等待成本降為 0：設 07:30 出發卻回
    傳 08:55 出發，前端欄位看起來完全失效。這裡把起點累計值鎖在出發時刻，語意統一為
    「照設定時間出發，早到的等待發生在站點」，也與 DP 引擎（一律從 time_windows[start][0]
    出發）一致。

    只鎖 routing.Start(0)，不動 routing.End(0)，回程時間不受影響；起點的 slack 仍保留，
    否則首站時間窗較晚時會直接無解。
    """
    time_dimension.CumulVar(routing.Start(0)).SetRange(departure_seconds, departure_seconds)


def _apply_priority_preferences(
    *,
    routing,
    manager,
    transit_callback_index: int,
    time_windows,
    priorities: Sequence[int],
    priority_config: Mapping[str, Any],
    start_node: int,
    end_node: int,
    horizon: int,
) -> None:
    """Apply soft preferred arrival bounds for high-priority customers.

    兩個關鍵點：

    1) 絕對時鐘 vs 經過秒數：優先權偏好的上限是「絕對時鐘時間」
       （earliest + priority * interval，例如優先 1 = 出發後可至 09:30）。因此這條
       PriorityTime 維度必須錨定到出發時刻、並套用與時間窗相同的最早抵達下限，讓它
       的累計值代表真正的時鐘時間；否則累計值是「從 0 起算的經過秒數」，永遠到不了
       絕對時間門檻，軟性上限不會被違反、罰分恆為 0，優先權等於完全失效。

    2) 只約束「比預設更急」的站點：若連 default_priority 的一般站點都套用偏好上限，
       等於要求「每一站都盡量在 10:30 前送達」。整日配送本就不可能全部在 10:30 前
       完成，於是所有後段站點都被罰分，反而把真正高優先站點的差異淹沒掉——把某個
       高優先站點往前排會延後一整串後段站點、總罰分更高，求解器索性不動。因此這裡
       只對「priority < default_priority」（明確指定為更緊急）的站點套用偏好上限，
       未指定/一般站點只受時間窗與行駛成本約束。
    """
    penalty = int(priority_config.get("priority_penalty_per_second", 0) or 0)
    interval = int(priority_config.get("priority_interval_seconds", 1800) or 1800)
    default_priority = int(priority_config.get("default_priority", 3) or 3)
    if penalty <= 0:
        return

    # 只有存在「比預設更急」的站點時才建立維度，避免無謂的求解負擔。
    if not any(priority < default_priority for priority in priorities):
        return

    routing.AddDimension(transit_callback_index, horizon, horizon, False, "PriorityTime")
    priority_dimension = routing.GetDimensionOrDie("PriorityTime")

    # 起點累計值固定為出發時刻，使 PriorityTime 與真正的 Time 維度同樣以時鐘計時。
    departure = time_windows[start_node][0]
    priority_dimension.CumulVar(routing.Start(0)).SetRange(departure, departure)

    for node, priority in enumerate(priorities):
        if node in (start_node, end_node):
            continue
        if priority >= default_priority:
            continue  # 一般/低急迫站點不套用偏好上限，避免淹沒真正高優先站點

        earliest, latest = time_windows[node]
        preferred_upper = min(latest, earliest + max(1, priority) * interval)
        for index in _routing_indices_for_node(routing, manager, node, start_node, end_node):
            # 與時間窗一致的最早抵達下限，確保 PriorityTime 對齊真實抵達時間。
            priority_dimension.CumulVar(index).SetRange(earliest, horizon)
            priority_dimension.SetCumulVarSoftUpperBound(index, preferred_upper, penalty)


def _apply_route_order_preferences(
    *,
    routing,
    manager,
    transit_callback_index: int,
    preferred_upper_bounds: Optional[Sequence[Optional[int]]],
    route_order_penalty_per_second: int,
    start_node: int,
    end_node: int,
    horizon: int,
) -> None:
    """Prefer the original remaining delivery order during in-transit reroutes."""
    if not preferred_upper_bounds or route_order_penalty_per_second <= 0:
        return

    routing.AddDimension(transit_callback_index, horizon, horizon, False, "RouteOrderTime")
    route_order_dimension = routing.GetDimensionOrDie("RouteOrderTime")

    for node, preferred_upper in enumerate(preferred_upper_bounds):
        if preferred_upper is None or node in (start_node, end_node):
            continue

        for index in _routing_indices_for_node(routing, manager, node, start_node, end_node):
            route_order_dimension.SetCumulVarSoftUpperBound(
                index,
                int(preferred_upper),
                route_order_penalty_per_second,
            )


def _pin_route_sequence(
    *,
    routing,
    manager,
    sequence: Optional[Sequence[int]],
    node_count: int,
    start_node: int,
    end_node: int,
) -> bool:
    """把使用者手動排好的完整順序直接釘成路徑，回傳是否成功釘住。

    為什麼不用「相鄰兩站 time(前) <= time(後)」的先後約束：那串約束會把整條鏈鎖死，
    但求解器仍要靠 PATH_CHEAPEST_ARC 之類的首解啟發式「湊」出一條同時滿足全部約束的路徑。
    站數一多就湊不出來，`SolveWithParameters` 直接回 None，使用者看到的就是
    「無法找到路線」——但其實順序早就決定好了，根本沒有東西需要搜尋。

    改成固定 NextVar：路徑完全確定，首解不需要任何選擇，時間由 Time 維度算出來。
    時間窗上界在 allow_late_arrival 時是軟的，所以照使用者的順序走一定有解，
    塞不進時間窗的站會如實算成逾時，而不是讓整趟變成無解。

    只有當 sequence 恰好涵蓋所有中間站（不含起點與終點）時才釘；否則回 False 交給呼叫端退回舊行為。
    """
    if not sequence:
        return False

    ordered = [int(node) for node in sequence]
    endpoints = {int(start_node), int(end_node)}
    expected = node_count - len(endpoints)
    if len(ordered) != expected or len(set(ordered)) != len(ordered):
        return False
    if any(node in endpoints or node < 0 or node >= node_count for node in ordered):
        return False

    solver = routing.solver()
    chain = [routing.Start(0)] + [manager.NodeToIndex(node) for node in ordered] + [routing.End(0)]
    for current_index, next_index in zip(chain, chain[1:]):
        solver.Add(routing.NextVar(current_index) == next_index)
    return True


def _apply_route_order_precedence(
    *,
    routing,
    manager,
    time_dimension,
    precedence_pairs: Optional[Sequence[Sequence[int]]],
    start_node: int,
    end_node: int,
) -> None:
    """Keep the remaining in-transit delivery direction when requested."""
    if not precedence_pairs:
        return

    solver = routing.solver()
    for first_node, second_node in precedence_pairs:
        if first_node in (start_node, end_node) or second_node in (start_node, end_node):
            continue

        first_index = manager.NodeToIndex(int(first_node))
        second_index = manager.NodeToIndex(int(second_node))
        if first_index < 0 or second_index < 0:
            continue

        solver.Add(time_dimension.CumulVar(first_index) <= time_dimension.CumulVar(second_index))


def _extract_solution(
    *,
    solution,
    routing,
    manager,
    time_dimension,
    time_matrix,
    distance_matrix,
    time_windows,
    service_times,
    depot_node: int,
    start_node: int,
    end_node: int,
) -> Dict[str, Any]:
    """Convert an OR-Tools solution to the project response shape."""
    route_indices: List[int] = []
    arrival_times_by_order: List[int] = []
    physical_arrival_times_by_order: List[int] = []
    total_distance = 0
    total_travel_time = 0
    total_service_time = 0
    total_lateness = 0
    lateness_by_index: Dict[int, int] = {}
    service_times_by_order: List[int] = []

    index = routing.Start(0)
    service_start_time = solution.Value(time_dimension.CumulVar(index))
    physical_arrival_time = service_start_time
    while not routing.IsEnd(index):
        node_idx = manager.IndexToNode(index)
        route_indices.append(node_idx)
        arrival_times_by_order.append(service_start_time)
        physical_arrival_times_by_order.append(physical_arrival_time)

        lateness = max(0, service_start_time - time_windows[node_idx][1])
        total_lateness += lateness
        lateness_by_index[node_idx] = max(lateness_by_index.get(node_idx, 0), lateness)

        next_index = solution.Value(routing.NextVar(index))
        next_node_idx = manager.IndexToNode(next_index)
        total_distance += distance_matrix[node_idx][next_node_idx]
        total_travel_time += time_matrix[node_idx][next_node_idx]
        total_service_time += service_times[node_idx]
        service_times_by_order.append(service_times[node_idx])
        physical_arrival_time = service_start_time + service_times[node_idx] + time_matrix[node_idx][next_node_idx]
        service_start_time = max(physical_arrival_time, time_windows[next_node_idx][0])
        index = next_index

    end_node_idx = manager.IndexToNode(index)
    end_arrival_time = service_start_time
    route_indices.append(end_node_idx)
    arrival_times_by_order.append(end_arrival_time)
    physical_arrival_times_by_order.append(physical_arrival_time)
    end_service_time = 0 if end_node_idx in (depot_node, start_node) else service_times[end_node_idx]
    service_times_by_order.append(end_service_time)
    total_service_time += end_service_time

    end_lateness = max(0, end_arrival_time - time_windows[end_node][1])
    total_lateness += end_lateness
    lateness_by_index[end_node] = max(lateness_by_index.get(end_node, 0), end_lateness)
    route_completion_time = end_arrival_time + end_service_time

    return {
        "status": "SUCCESS",
        "objective_score": solution.ObjectiveValue(),
        "total_time_seconds": total_travel_time + total_service_time,
        "total_travel_seconds": total_travel_time,
        "total_service_seconds": total_service_time,
        "total_elapsed_seconds": route_completion_time - arrival_times_by_order[0],
        "total_distance_meters": total_distance,
        "total_lateness_seconds": total_lateness,
        "route_indices": route_indices,
        "arrival_times_by_order": arrival_times_by_order,
        "physical_arrival_times_by_order": physical_arrival_times_by_order,
        "service_times_by_order": service_times_by_order,
        "lateness_seconds_by_index": lateness_by_index,
        "start_index": start_node,
        "end_index": end_node,
    }


def _routing_indices_for_node(routing, manager, node: int, start_node: int, end_node: int):
    """Return all OR-Tools indices that represent a node."""
    indices = []
    if node == start_node:
        indices.append(routing.Start(0))
    if node == end_node:
        indices.append(routing.End(0))

    index = manager.NodeToIndex(node)
    if index >= 0 and index not in indices:
        indices.append(index)
    return indices


def _calculate_time_horizon(time_matrix, time_windows, service_times: Sequence[int]) -> int:
    """Estimate a large enough time horizon for soft time windows."""
    max_window_end = max(max(window) for window in time_windows)
    max_arc_time = max(max(row) for row in time_matrix) if time_matrix else 0
    total_service_time = sum(service_times)
    return max(100000, max_window_end + max_arc_time * max(1, len(time_matrix)) + total_service_time)
