import unittest

from core.or_tools_engine import solve_tsptw


# 0=公司（起點/終點），1、2 為送貨點；車程都很短（各 300 秒），
# 但兩個站點的時間窗都要到 09:00 之後才開，所以無論幾點出發都得等。
TIME_MATRIX = [
    [0, 300, 600],
    [300, 0, 300],
    [600, 300, 0],
]
DISTANCE_MATRIX = TIME_MATRIX
SERVICE_TIMES = [0, 600, 600]

DEPARTURE = 7 * 3600 + 30 * 60      # 07:30
WINDOW_START = 9 * 3600            # 09:00
WINDOW_END = 12 * 3600             # 12:00


def _solve(departure_seconds):
    time_windows = [
        [departure_seconds, 23 * 3600 + 59 * 60],
        [WINDOW_START, WINDOW_END],
        [WINDOW_START, WINDOW_END],
    ]
    result = solve_tsptw(
        TIME_MATRIX,
        DISTANCE_MATRIX,
        time_windows,
        depot_idx=0,
        timeout=5,
        start_idx=0,
        end_idx=0,
        service_times=SERVICE_TIMES,
    )
    assert result["status"] == "SUCCESS", result
    return result


class DepartureTimeTests(unittest.TestCase):
    """回歸測試：起點必須照設定的「預計出發時間」出發。

    先前的 bug：Time 維度對等待時間收費（SetSlackCostCoefficientForAllVehicles），
    而起點時間窗上界是一整天，求解器為了把等待成本降到 0 會自行延後出發——前端設
    07:30 卻回傳 08:55 出發，使用者以為出發時間欄位壞掉。
    """

    def test_departure_matches_requested_time(self):
        result = _solve(DEPARTURE)
        self.assertEqual(
            result["arrival_times_by_order"][0],
            DEPARTURE,
            f"起點出發時間應等於設定值 {DEPARTURE}，實得 {result['arrival_times_by_order'][0]}",
        )

    def test_changing_departure_changes_reported_start(self):
        early = _solve(DEPARTURE)["arrival_times_by_order"][0]
        late = _solve(WINDOW_START)["arrival_times_by_order"][0]
        self.assertEqual(early, DEPARTURE)
        self.assertEqual(late, WINDOW_START)

    def test_stop_time_windows_still_respected(self):
        # 早出發只是提早離開起點，站點仍不可早於時間窗開始被服務。
        result = _solve(DEPARTURE)
        for index, arrival in zip(result["route_indices"], result["arrival_times_by_order"]):
            if index == 0:
                continue
            self.assertGreaterEqual(arrival, WINDOW_START)


if __name__ == "__main__":
    unittest.main()
