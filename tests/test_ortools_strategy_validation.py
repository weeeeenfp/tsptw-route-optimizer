import unittest

from core.input_validator import InputValidationError, validate_and_normalize_request
from tests.test_input_validation import make_payload


class OrToolsStrategyValidationTests(unittest.TestCase):
    def test_accepts_parallel_cheapest_insertion_with_guided_local_search(self):
        payload = make_payload()
        payload["ortools"] = {
            "first_solution_strategy": "PARALLEL_CHEAPEST_INSERTION",
            "local_search_metaheuristic": "GUIDED_LOCAL_SEARCH",
        }

        normalized = validate_and_normalize_request(payload)

        self.assertEqual(normalized["ortools"]["first_solution_strategy"], "PARALLEL_CHEAPEST_INSERTION")

    def test_rejects_unknown_first_solution_strategy(self):
        payload = make_payload()
        payload["ortools"] = {
            "first_solution_strategy": "NOT_A_STRATEGY",
            "local_search_metaheuristic": "GUIDED_LOCAL_SEARCH",
        }

        with self.assertRaises(InputValidationError):
            validate_and_normalize_request(payload)


if __name__ == "__main__":
    unittest.main()
