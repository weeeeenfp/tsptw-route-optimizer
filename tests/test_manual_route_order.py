import unittest

from core.input_validator import InputValidationError, validate_and_normalize_request
from core.or_tools_engine import solve_tsptw
from core.route_service import (
    _apply_in_transit_state,
    _manual_order_precedence_pairs,
    _manual_route_sequence,
)


# 0=公司（起點/終點），1、2、3 為送貨點；時間窗全開，純由距離決定最佳解，
# 因此可以驗證「手動順序」確實蓋過求解器自己的偏好。
TIME_MATRIX = [
    [0, 300, 600, 900],
    [300, 0, 300, 600],
    [600, 300, 0, 300],
    [900, 600, 300, 0],
]
DISTANCE_MATRIX = TIME_MATRIX
TIME_WINDOWS = [[0, 86399], [0, 86399], [0, 86399], [0, 86399]]
SERVICE_TIMES = [0, 60, 60, 60]


def _solve(precedence_pairs):
    result = solve_tsptw(
        TIME_MATRIX,
        DISTANCE_MATRIX,
        TIME_WINDOWS,
        depot_idx=0,
        timeout=5,
        start_idx=0,
        end_idx=0,
        service_times=SERVICE_TIMES,
        route_order_precedence_pairs=precedence_pairs,
    )
    assert result["status"] == "SUCCESS", result
    return [index for index in result["route_indices"] if index != 0]


def _location(index):
    return {
        "id": index,
        "name": f"站{index}",
        "address": f"地址{index}",
        "time_window": ["00:00", "23:59"],
    }


class ManualOrderPrecedencePairTests(unittest.TestCase):
    def test_pairs_are_consecutive_and_skip_start_end(self):
        pairs = _manual_order_precedence_pairs([3, 1, 2], start_index=0, end_index=0)
        self.assertEqual(pairs, [[3, 1], [1, 2]])

    def test_start_and_end_nodes_are_dropped(self):
        pairs = _manual_order_precedence_pairs([0, 2, 1, 5], start_index=0, end_index=5)
        self.assertEqual(pairs, [[2, 1]])

    def test_empty_without_manual_order(self):
        self.assertEqual(_manual_order_precedence_pairs(None, start_index=0, end_index=0), [])
        self.assertEqual(_manual_order_precedence_pairs([], start_index=0, end_index=0), [])


class ManualOrderSolverTests(unittest.TestCase):
    """手動調整順序後，後端必須照那個順序算，不可自己換回最佳順序。"""

    def test_solver_follows_manual_order(self):
        self.assertEqual(_solve(None), [1, 2, 3])          # 未指定時的最佳順序
        self.assertEqual(_solve([[3, 2], [2, 1]]), [3, 2, 1])
        self.assertEqual(_solve([[2, 1], [1, 3]]), [2, 1, 3])


class ManualRouteSequenceTests(unittest.TestCase):
    def test_sequence_drops_start_and_end(self):
        self.assertEqual(_manual_route_sequence([3, 1, 2], start_index=0, end_index=0), [3, 1, 2])
        self.assertEqual(_manual_route_sequence([0, 2, 1, 5], start_index=0, end_index=5), [2, 1])

    def test_empty_without_manual_order(self):
        self.assertEqual(_manual_route_sequence(None, start_index=0, end_index=0), [])
        self.assertEqual(_manual_route_sequence([], start_index=0, end_index=0), [])


class PinnedManualOrderTests(unittest.TestCase):
    """手動順序改用「釘死路徑」：站數多也一定算得出來，且順序完全照走。

    舊做法是把相鄰兩站轉成 time(前) <= time(後) 的硬約束，路徑仍要靠首解啟發式湊；
    站數一多就湊不出來、`SolveWithParameters` 回 None，使用者看到「無法找到路線」。
    """

    @staticmethod
    def _grid_case(stop_count):
        """造一個 stop_count 站的合成案例（0 為起點兼終點）。"""
        node_count = stop_count + 1
        points = [((index * 7) % 11, (index * 5) % 13) for index in range(node_count)]
        time_matrix = [
            [int((abs(points[i][0] - points[j][0]) + abs(points[i][1] - points[j][1])) * 180)
             for j in range(node_count)]
            for i in range(node_count)
        ]
        time_windows = [[9 * 3600, 23 * 3600]] + [[9 * 3600, 17 * 3600]] * stop_count
        service_times = [0] + [600] * stop_count
        return time_matrix, time_windows, service_times

    def _solve_pinned(self, stop_count, order):
        time_matrix, time_windows, service_times = self._grid_case(stop_count)
        return solve_tsptw(
            time_matrix,
            time_matrix,
            time_windows,
            depot_idx=0,
            timeout=5,
            start_idx=0,
            end_idx=0,
            service_times=service_times,
            allow_late_arrival=True,
            manual_route_sequence=order,
        )

    def test_large_manual_order_still_solves_and_is_followed(self):
        """20 站：舊的先後約束做法在這個規模幾乎必定失敗，釘死路徑必須成功。"""
        order = list(range(1, 21))[::-1]
        result = self._solve_pinned(20, order)
        self.assertEqual(result["status"], "SUCCESS", result.get("message"))
        self.assertEqual(result["route_indices"], [0] + order + [0])

    def test_order_that_breaks_time_windows_reports_lateness_not_failure(self):
        """順序把時間窗撞爛時要算成逾時，不可整趟變無解——不然使用者無從比較。"""
        order = list(range(1, 16))[::-1]
        result = self._solve_pinned(15, order)
        self.assertEqual(result["status"], "SUCCESS", result.get("message"))
        self.assertEqual(result["route_indices"], [0] + order + [0])
        self.assertGreater(result["total_lateness_seconds"], 0)

    def test_partial_order_is_not_pinned(self):
        """順序沒涵蓋所有中間站時不可釘死（會漏站），要退回原本的先後約束行為。"""
        result = self._solve_pinned(6, [3, 1])
        self.assertEqual(result["status"], "SUCCESS", result.get("message"))
        self.assertEqual(sorted(result["route_indices"][1:-1]), [1, 2, 3, 4, 5, 6])


class ManualOrderRequestTests(unittest.TestCase):
    def test_validator_accepts_manual_route_indices(self):
        request = {
            "locations": [_location(i) for i in range(4)],
            "manual_route_indices": [3, 1, 2],
        }
        normalized = validate_and_normalize_request(request)
        self.assertEqual(normalized["manual_route_indices"], [3, 1, 2])

    def test_validator_rejects_duplicated_indices(self):
        request = {
            "locations": [_location(i) for i in range(4)],
            "manual_route_indices": [1, 1, 2],
        }
        with self.assertRaises(InputValidationError):
            validate_and_normalize_request(request)

    def test_validator_rejects_out_of_range_index(self):
        request = {
            "locations": [_location(i) for i in range(4)],
            "manual_route_indices": [1, 9],
        }
        with self.assertRaises(InputValidationError):
            validate_and_normalize_request(request)

    def test_in_transit_remaps_manual_indices_and_drops_finished_stops(self):
        # 站 1 已完成 → 剩餘站點重新編號（0=公司, 1=站2, 2=站3），手動順序要跟著換算。
        request = {
            "locations": [_location(i) for i in range(4)],
            "completed_indices": [1],
            "current_index": 1,
            "current_time_seconds": 36000,
            "manual_route_indices": [3, 1, 2],
        }
        state = _apply_in_transit_state(validate_and_normalize_request(request))
        active = state["request_data"]
        remapped = [state["active_original_indices"][i] for i in active["manual_route_indices"]]
        self.assertEqual(remapped, [3, 1, 2])
        self.assertNotIn(2, [i for i in active["manual_route_indices"] if i > len(active["locations"]) - 1])


if __name__ == "__main__":
    unittest.main()
