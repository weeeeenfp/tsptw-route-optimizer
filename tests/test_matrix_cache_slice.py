import unittest

import core.google_maps_api as google_maps_api


class CacheSliceTest(unittest.TestCase):
    """矩陣快取子集合切片：途中重排常只用原地點的子集合，直接切片可免重打 API。"""

    def setUp(self):
        self.cached = {
            "addresses": ["A", "B", "C"],
            "time_matrix": [[0, 1, 2], [10, 0, 12], [20, 21, 0]],
            "distance_matrix": [[0, 100, 200], [110, 0, 120], [210, 220, 0]],
        }

    def test_subset_sliced_without_refetch(self):
        sliced = google_maps_api._slice_cached_matrix(self.cached, ["C", "A"])
        self.assertEqual(sliced["addresses"], ["C", "A"])
        self.assertEqual(sliced["time_matrix"], [[0, 20], [2, 0]])
        self.assertEqual(sliced["distance_matrix"], [[0, 210], [200, 0]])

    def test_duplicate_address_maps_to_same_point(self):
        # 途中重排的虛擬目前位置會複製既有地址，必須也能切片。
        sliced = google_maps_api._slice_cached_matrix(self.cached, ["A", "B", "A"])
        self.assertEqual(sliced["time_matrix"][0][2], 0)
        self.assertEqual(sliced["time_matrix"][2][1], 1)

    def test_unknown_address_returns_none(self):
        self.assertIsNone(google_maps_api._slice_cached_matrix(self.cached, ["A", "X"]))

    def test_incomplete_cache_returns_none(self):
        self.assertIsNone(google_maps_api._slice_cached_matrix(None, ["A"]))
        self.assertIsNone(
            google_maps_api._slice_cached_matrix({"addresses": ["A"]}, ["A"])
        )


if __name__ == "__main__":
    unittest.main()
