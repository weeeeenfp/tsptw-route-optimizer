# -*- coding: utf-8 -*-
"""地址驗證（/api/v1/validate-address 與 google_maps_api.validate_addresses）測試。

全部離線：以注入的 requester / monkeypatch 取代真實 Google Geocoding 呼叫。
"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import API_main
from core.google_maps_api import validate_addresses, _summarize_geocode


def _rooftop_result(formatted="411臺中市太平區中山路二段348號"):
    return [{
        "types": ["street_address"],
        "partial_match": False,
        "formatted_address": formatted,
        "geometry": {"location_type": "ROOFTOP", "location": {"lat": 24.15, "lng": 120.73}},
    }]


def _locality_result():
    return [{
        "types": ["locality", "political"],
        "formatted_address": "台灣台中市",
        "geometry": {"location_type": "APPROXIMATE", "location": {"lat": 24.14, "lng": 120.68}},
    }]


class SummarizeGeocodeTest(unittest.TestCase):
    def test_street_address_is_valid(self):
        entry = _summarize_geocode("某地址", _rooftop_result())
        self.assertTrue(entry["valid"])
        self.assertIsNone(entry["reason"])
        self.assertEqual(entry["location_type"], "ROOFTOP")
        self.assertAlmostEqual(entry["lat"], 24.15)

    def test_locality_only_is_invalid(self):
        entry = _summarize_geocode("台中市", _locality_result())
        self.assertFalse(entry["valid"])
        self.assertIn("太籠統", entry["reason"])

    def test_zero_results_is_invalid(self):
        entry = _summarize_geocode("asdfzxcv", [])
        self.assertFalse(entry["valid"])
        self.assertIn("查無", entry["reason"])

    def test_partial_match_flag_passthrough(self):
        result = _rooftop_result()
        result[0]["partial_match"] = True
        entry = _summarize_geocode("某地址", result)
        self.assertTrue(entry["valid"])
        self.assertTrue(entry["partial_match"])


class ValidateAddressesCacheTest(unittest.TestCase):
    def setUp(self):
        fd, self.cache_file = tempfile.mkstemp(suffix=".json")
        os.close(fd)
        os.remove(self.cache_file)

    def tearDown(self):
        if os.path.exists(self.cache_file):
            os.remove(self.cache_file)

    def test_blank_address_short_circuits(self):
        results = validate_addresses(
            ["   "], "fake-key", cache_filename=self.cache_file,
            requester=lambda a: self.fail("空白地址不應呼叫 Geocoding"),
        )
        self.assertFalse(results[0]["valid"])
        self.assertEqual(results[0]["reason"], "地址空白")

    def test_cache_prevents_second_request(self):
        calls = []

        def requester(addr):
            calls.append(addr)
            return _rooftop_result()

        for _ in range(2):
            results = validate_addresses(
                ["台中市太平區中山路二段348號"], "fake-key",
                cache_filename=self.cache_file, requester=requester,
            )
            self.assertTrue(results[0]["valid"])
        self.assertEqual(len(calls), 1, "第二次應命中快取，不再呼叫 Geocoding")
        with open(self.cache_file, encoding="utf-8") as f:
            self.assertIn("台中市太平區中山路二段348號", json.load(f))


class ValidateAddressEndpointTest(unittest.TestCase):
    def setUp(self):
        self._orig_key = API_main.APP_CONFIG.get("google_maps_api_key")
        self._orig_fn = API_main.validate_addresses

    def tearDown(self):
        API_main.APP_CONFIG["google_maps_api_key"] = self._orig_key
        API_main.validate_addresses = self._orig_fn

    def _payload(self, addresses):
        return API_main.AddressValidationRequest(addresses=addresses)

    def test_skipped_when_no_key(self):
        API_main.APP_CONFIG["google_maps_api_key"] = ""
        response = API_main.validate_address(self._payload(["任意地址"]))
        self.assertEqual(response["status"], "SKIPPED")

    def test_success_with_key(self):
        API_main.APP_CONFIG["google_maps_api_key"] = "fake-key"
        API_main.validate_addresses = lambda addrs, key: [
            {"address": a, "valid": True, "reason": None} for a in addrs
        ]
        response = API_main.validate_address(self._payload(["地址A", "地址B"]))
        self.assertEqual(response["status"], "SUCCESS")
        self.assertEqual(len(response["data"]["results"]), 2)

    def test_error_returns_502(self):
        API_main.APP_CONFIG["google_maps_api_key"] = "fake-key"

        def boom(addrs, key):
            raise RuntimeError("REQUEST_DENIED")

        API_main.validate_addresses = boom
        response = API_main.validate_address(self._payload(["地址A"]))
        self.assertEqual(response.status_code, 502)


if __name__ == "__main__":
    unittest.main()
