import unittest

from core.or_tools_engine import solve_tsptw


# 三點對稱環路（0=depot, 1, 2）：兩個方向總成本相同（10+25+30=65），
# 因此純粹由「優先權偏好」決定誰先被拜訪 —— 高優先的站點應排在前面。
TIME_MATRIX = [
    [0, 10, 30],
    [10, 0, 25],
    [30, 25, 0],
]
DISTANCE_MATRIX = TIME_MATRIX
TIME_WINDOWS = [[0, 100000], [0, 100000], [0, 100000]]
SERVICE_TIMES = [0, 0, 0]
PRIORITY_CONFIG = {
    "default_priority": 3,
    "priority_interval_seconds": 20,
    "priority_penalty_per_second": 1000,
}


def _solve(priorities):
    result = solve_tsptw(
        TIME_MATRIX,
        DISTANCE_MATRIX,
        TIME_WINDOWS,
        depot_idx=0,
        timeout=5,
        start_idx=0,
        end_idx=0,
        service_times=SERVICE_TIMES,
        priorities=priorities,
        priority_config=PRIORITY_CONFIG,
    )
    assert result["status"] == "SUCCESS", result
    return result["route_indices"]


class PriorityPreferenceTests(unittest.TestCase):
    """回歸測試：優先權必須真的影響拜訪順序。

    先前的 bug：PriorityTime 維度未錨定出發時刻，累計值是「從 0 起算的經過秒數」，
    永遠到不了絕對時鐘門檻，導致優先權罰分恆為 0、完全不影響路線。
    """

    def test_high_priority_node1_is_visited_first(self):
        route = _solve([3, 1, 3])  # node1 最優先
        self.assertLess(route.index(1), route.index(2),
                        f"高優先 node1 應比 node2 早被拜訪，實得 {route}")

    def test_high_priority_node2_is_visited_first(self):
        route = _solve([3, 3, 1])  # node2 最優先
        self.assertLess(route.index(2), route.index(1),
                        f"高優先 node2 應比 node1 早被拜訪，實得 {route}")

    def test_priority_changes_the_route(self):
        # 對調哪個站點高優先，路線（拜訪順序）必須跟著改變。
        self.assertNotEqual(_solve([3, 1, 3]), _solve([3, 3, 1]))

    def test_default_priority_stops_get_no_preference(self):
        # 全部維持預設優先權時，不套用任何偏好上限（純行駛最佳化）；
        # 把 node2 提升為高優先後，它應比「全預設」時更早被拜訪。
        baseline = _solve([3, 3, 3])      # 全預設 → node2 不被特別提前
        elevated = _solve([3, 3, 1])      # node2 高優先 → 應被提前
        self.assertLess(elevated.index(2), baseline.index(2),
                        f"高優先應比全預設更早拜訪 node2：baseline={baseline} elevated={elevated}")


if __name__ == "__main__":
    unittest.main()
