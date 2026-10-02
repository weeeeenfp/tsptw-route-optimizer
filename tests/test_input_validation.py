import unittest

from API_main import RoutingRequest, _model_to_dict
from core.input_validator import InputValidationError, validate_and_normalize_request
from core.or_tools_engine import solve_tsptw
from core.route_service import (
    _apply_in_transit_state,
    _build_route_details,
    _build_no_remaining_route_response,
    _map_active_indices,
    _prepare_locations,
    generate_maps_urls,
)


def make_payload(location_count=2):
    return {
        "google_maps_api_key": "test-key",
        "solver": "ortools",
        "solver_timeout_seconds": 5,
        "depot_index": 0,
        "google_maps": {
            "mode": "driving",
            "language": "zh-TW",
            "chunk_size": 10,
            "request_delay_seconds": 0,
        },
        "navigation": {
            "max_points_per_url": 10,
            "travelmode": "driving",
        },
        "constraints": {
            "allow_late_arrival": True,
            "late_penalty_per_second": 1000,
        },
        "priority": {
            "default_priority": 3,
            "priority_interval_seconds": 1800,
            "priority_penalty_per_second": 20,
        },
        "service": {
            "default_service_time_seconds": 600,
        },
        "locations": [
            {
                "id": index,
                "name": "國立勤益科技大學" if index == 0 else f"stop-{index}",
                "address": "411030臺中市太平區坪林里中山路二段57號" if index == 0 else f"address-{index}",
                "time_window": ["08:00", "18:00"],
            }
            for index in range(location_count)
        ],
    }


class InputValidationTests(unittest.TestCase):
    def test_api_model_preserves_in_transit_reschedule_fields(self):
        payload = make_payload(location_count=3)
        payload["current_index"] = 1
        payload["current_time_seconds"] = "10:30"
        payload["completed_indices"] = [0]
        payload["locations"][2]["rescheduled_time_window"] = ["14:30", "16:00"]

        request_data = _model_to_dict(RoutingRequest(**payload))

        self.assertEqual(request_data["current_time_seconds"], "10:30")
        self.assertEqual(request_data["completed_indices"], [0])
        self.assertEqual(request_data["locations"][2]["rescheduled_time_window"], ["14:30", "16:00"])

    def test_accepts_24_hour_time_window_and_normalizes_to_seconds(self):
        payload = make_payload()

        normalized = validate_and_normalize_request(payload)

        self.assertEqual(normalized["locations"][0]["time_window"], [28800, 64800])

    def test_rejects_invalid_24_hour_time(self):
        payload = make_payload()
        payload["locations"][0]["time_window"] = ["25:00", "18:00"]

        with self.assertRaises(InputValidationError):
            validate_and_normalize_request(payload)

    def test_rejects_time_window_start_after_end(self):
        payload = make_payload()
        payload["locations"][0]["time_window"] = ["18:00", "08:00"]

        with self.assertRaises(InputValidationError):
            validate_and_normalize_request(payload)

    def test_preserves_legacy_second_based_time_window(self):
        payload = make_payload()
        payload["locations"][0]["time_window"] = [0, 3600]

        normalized = validate_and_normalize_request(payload)

        self.assertEqual(normalized["locations"][0]["time_window"], [0, 3600])

    def test_rejects_legacy_second_time_window_at_24_hours(self):
        payload = make_payload()
        payload["locations"][0]["time_window"] = [0, 86400]

        with self.assertRaises(InputValidationError):
            validate_and_normalize_request(payload)

    def test_rejects_too_few_locations(self):
        payload = make_payload(location_count=1)

        with self.assertRaises(InputValidationError):
            validate_and_normalize_request(payload)

    def test_delivery_accepts_more_than_25_locations(self):
        """送貨不再設硬性站點上限，25 點只是建議適用規模。"""
        payload = make_payload(location_count=32)

        normalized = validate_and_normalize_request(payload)

        self.assertEqual(normalized["operation_type"], "delivery")
        self.assertEqual(len(normalized["locations"]), 32)

    def test_receiving_accepts_more_than_25_locations(self):
        payload = make_payload(location_count=30)
        payload["operation_type"] = "receiving"

        normalized = validate_and_normalize_request(payload)

        self.assertEqual(normalized["operation_type"], "receiving")
        self.assertEqual(len(normalized["locations"]), 30)

    def test_api_model_preserves_receiving_operation_type(self):
        payload = make_payload(location_count=3)
        payload["operation_type"] = "receiving"

        request_data = _model_to_dict(RoutingRequest(**payload))

        self.assertEqual(request_data["operation_type"], "receiving")

    def test_accepts_maximum_25_delivery_locations(self):
        payload = make_payload(location_count=25)

        normalized = validate_and_normalize_request(payload)

        self.assertEqual(len(normalized["locations"]), 25)

    def test_accepts_maximum_locations_with_virtual_current_position(self):
        payload = make_payload(location_count=26)
        payload["current_index"] = 25
        payload["current_time_seconds"] = "10:30"
        payload["locations"][25]["id"] = 990025
        payload["locations"][25]["name"] = "目前位置"
        payload["locations"][25]["service_time_seconds"] = 0
        payload["locations"][25]["virtual_current_position"] = True

        normalized = validate_and_normalize_request(payload)

        self.assertEqual(len(normalized["locations"]), 26)
        self.assertEqual(normalized["current_index"], 25)

    def test_rejects_out_of_range_index(self):
        payload = make_payload()
        payload["end_candidate_indices"] = [99]

        with self.assertRaises(InputValidationError):
            validate_and_normalize_request(payload)

    def test_rejects_out_of_range_completed_index(self):
        payload = make_payload()
        payload["completed_indices"] = [99]

        with self.assertRaises(InputValidationError):
            validate_and_normalize_request(payload)

    def test_accepts_in_transit_status_fields(self):
        payload = make_payload(location_count=3)
        payload["current_index"] = 1
        payload["current_time_seconds"] = "10:30"
        payload["completed_indices"] = [0]
        payload["locations"][0]["status"] = "completed"
        payload["locations"][2]["status"] = "delayed"

        normalized = validate_and_normalize_request(payload)

        self.assertEqual(normalized["current_index"], 1)
        self.assertEqual(normalized["current_time_seconds"], 37800)
        self.assertEqual(normalized["completed_indices"], [0])
        self.assertEqual(normalized["locations"][2]["status"], "delayed")

    def test_in_transit_state_filters_terminal_stops_and_preserves_original_indices(self):
        payload = validate_and_normalize_request(make_payload(location_count=5))
        payload["current_index"] = 2
        payload["completed_indices"] = [0, 1]
        payload["cancelled_indices"] = [3]

        route_state = _apply_in_transit_state(payload)

        self.assertEqual(route_state["active_original_indices"], [2, 4])
        self.assertEqual(route_state["request_data"]["start_index"], 0)
        self.assertEqual(_map_active_indices([0, 1], route_state), [2, 4])

    def test_no_remaining_route_response_keeps_default_service_time(self):
        payload = validate_and_normalize_request(make_payload(location_count=2))
        payload["current_index"] = 1
        payload["completed_indices"] = [0]

        route_state = _apply_in_transit_state(payload)
        response = _build_no_remaining_route_response(route_state)

        self.assertTrue(response["data"]["reoptimization"]["no_remaining_deliveries"])
        self.assertEqual(response["data"]["route_indices"], [1])
        self.assertEqual(response["data"]["route_details"][0]["service_time_seconds"], 600)
        self.assertEqual(response["data"]["route_details"][0]["charged_service_time_seconds"], 0)
        self.assertEqual(response["data"]["total_service_minutes"], 0.0)

    def test_rejects_priority_out_of_range(self):
        payload = make_payload()
        payload["locations"][0]["priority"] = 6

        with self.assertRaises(InputValidationError):
            validate_and_normalize_request(payload)

    def test_rejects_default_service_time_over_24_hours(self):
        payload = make_payload()
        payload["service"]["default_service_time_seconds"] = 86401

        with self.assertRaises(InputValidationError):
            validate_and_normalize_request(payload)

    def test_prepare_locations_uses_default_service_time_unless_location_overrides(self):
        payload = validate_and_normalize_request(make_payload())
        payload["locations"][1]["service_time_seconds"] = 900

        routing_context = _prepare_locations(
            payload["locations"],
            payload["priority"],
            payload["service"],
        )

        self.assertEqual(routing_context["service_times"], [600, 900])

    def test_prepare_locations_uses_rescheduled_time_window(self):
        payload = make_payload()
        payload["locations"][1]["rescheduled_time_window"] = ["11:00", "12:15"]
        payload = validate_and_normalize_request(payload)

        routing_context = _prepare_locations(
            payload["locations"],
            payload["priority"],
            payload["service"],
        )

        self.assertEqual(routing_context["effective_time_windows"][1], [39600, 44100])
        self.assertEqual(routing_context["delay_infos"][1]["rescheduled_time_window"], [39600, 44100])

    def test_prepare_locations_locks_current_location_to_current_time(self):
        payload = make_payload(location_count=3)
        payload["current_index"] = 1
        payload["current_time_seconds"] = "10:00"
        payload = validate_and_normalize_request(payload)

        routing_context = _prepare_locations(
            payload["locations"],
            payload["priority"],
            payload["service"],
            current_index=payload["current_index"],
            current_time_seconds=payload["current_time_seconds"],
        )

        self.assertEqual(routing_context["effective_time_windows"][1], [36000, 36000])

    def test_prepare_locations_softly_prefers_non_delayed_remaining_stops_before_rescheduled_stop(self):
        payload = make_payload(location_count=4)
        payload["current_index"] = 0
        payload["current_time_seconds"] = "10:00"
        payload["locations"][1]["rescheduled_time_window"] = ["12:00", "13:00"]
        payload = validate_and_normalize_request(payload)

        routing_context = _prepare_locations(
            payload["locations"],
            payload["priority"],
            payload["service"],
            current_index=payload["current_index"],
            current_time_seconds=payload["current_time_seconds"],
            depot_index=None,
            original_indices=[10, 5, 6, 7],
            route_order_config={
                "route_order_interval_seconds": 600,
            },
        )
        preferred = routing_context["route_order_preferred_upper_bounds"]

        self.assertLess(preferred[2], preferred[3])
        self.assertLess(preferred[3], preferred[1])
        self.assertEqual(routing_context["route_order_precedence_pairs"], [])

    def test_solver_splits_travel_and_service_time_without_charging_start(self):
        result = solve_tsptw(
            time_matrix=[
                [0, 300],
                [300, 0],
            ],
            distance_matrix=[
                [0, 1000],
                [1000, 0],
            ],
            time_windows=[
                [0, 86399],
                [0, 86399],
            ],
            depot_idx=0,
            start_idx=0,
            end_idx=0,
            timeout=1,
            service_times=[600, 600],
        )

        self.assertEqual(result["status"], "SUCCESS")
        self.assertEqual(result["route_indices"], [0, 1, 0])
        self.assertEqual(result["total_travel_seconds"], 600)
        self.assertEqual(result["total_service_seconds"], 600)
        self.assertEqual(result["total_time_seconds"], 1200)
        self.assertEqual(result["service_times_by_order"], [0, 600, 0])

    def test_solver_charges_service_when_customer_is_end_stop(self):
        result = solve_tsptw(
            time_matrix=[
                [0, 300],
                [300, 0],
            ],
            distance_matrix=[
                [0, 1000],
                [1000, 0],
            ],
            time_windows=[
                [0, 86399],
                [0, 86399],
            ],
            depot_idx=0,
            start_idx=0,
            end_idx=1,
            timeout=1,
            service_times=[600, 600],
        )

        self.assertEqual(result["status"], "SUCCESS")
        self.assertEqual(result["route_indices"], [0, 1])
        self.assertEqual(result["total_travel_seconds"], 300)
        self.assertEqual(result["total_service_seconds"], 600)
        self.assertEqual(result["total_time_seconds"], 900)
        self.assertEqual(result["total_elapsed_seconds"], 900)
        self.assertEqual(result["service_times_by_order"], [0, 600])

    def test_route_details_show_waiting_before_service_start(self):
        result = solve_tsptw(
            time_matrix=[
                [0, 300],
                [300, 0],
            ],
            distance_matrix=[
                [0, 1000],
                [1000, 0],
            ],
            time_windows=[
                [0, 0],
                [900, 3600],
            ],
            depot_idx=0,
            start_idx=0,
            end_idx=0,
            timeout=1,
            service_times=[600, 600],
        )
        routing_context = {
            "location_names": ["公司", "客戶 A"],
            "original_time_windows": [[0, 0], [900, 3600]],
            "effective_time_windows": [[0, 0], [900, 3600]],
            "service_times": [600, 600],
            "priorities": [3, 3],
            "delay_infos": [{}, {}],
        }

        details = _build_route_details(result, routing_context)

        self.assertEqual(details[1]["arrival_time_seconds"], 300)
        self.assertEqual(details[1]["service_start_time_seconds"], 900)
        self.assertEqual(details[1]["waiting_time_seconds"], 600)
        self.assertEqual(details[1]["waiting_time_minutes"], 10.0)
        self.assertEqual(details[1]["service_completion_time_seconds"], 1500)

    def test_rejects_google_maps_chunk_size_over_10(self):
        payload = make_payload()
        payload["google_maps"]["chunk_size"] = 11

        with self.assertRaises(InputValidationError):
            validate_and_normalize_request(payload)

    def test_rejects_navigation_url_point_limit_over_10(self):
        payload = make_payload()
        payload["navigation"]["max_points_per_url"] = 11

        with self.assertRaises(InputValidationError):
            validate_and_normalize_request(payload)

    def test_generate_maps_urls_rejects_more_than_10_points_per_url(self):
        route_indices = list(range(11))
        addresses = [f"address-{index}" for index in route_indices]

        with self.assertRaises(ValueError):
            generate_maps_urls(route_indices, addresses, max_points_per_url=11)


if __name__ == "__main__":
    unittest.main()
