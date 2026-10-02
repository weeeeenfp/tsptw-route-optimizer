import json
import os
import tempfile
import unittest
from unittest import mock

from core.app_config import API_KEY_ENV_VARS, load_config


def _write(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)


class LoadConfigSecretOverlayTest(unittest.TestCase):
    """API 金鑰不入版控：config.local.json 與環境變數的覆蓋順序。"""

    def _clean_env(self):
        patcher = mock.patch.dict(os.environ)
        patcher.start()
        self.addCleanup(patcher.stop)
        for name in API_KEY_ENV_VARS:
            os.environ.pop(name, None)

    def test_base_config_only(self):
        self._clean_env()
        with tempfile.TemporaryDirectory() as tmpdir:
            base = os.path.join(tmpdir, "config.json")
            _write(base, {"google_maps_api_key": "base-key", "solver": "dp"})
            config = load_config(base)
        self.assertEqual(config["google_maps_api_key"], "base-key")
        self.assertEqual(config["solver"], "dp")

    def test_local_overlay_overrides_base(self):
        self._clean_env()
        with tempfile.TemporaryDirectory() as tmpdir:
            base = os.path.join(tmpdir, "config.json")
            _write(base, {"google_maps_api_key": "", "solver": "dp"})
            _write(os.path.join(tmpdir, "config.local.json"), {"google_maps_api_key": "local-key"})
            config = load_config(base)
        self.assertEqual(config["google_maps_api_key"], "local-key")
        # 其他欄位仍沿用 base 設定。
        self.assertEqual(config["solver"], "dp")

    def test_env_var_wins_over_files(self):
        self._clean_env()
        with tempfile.TemporaryDirectory() as tmpdir:
            base = os.path.join(tmpdir, "config.json")
            _write(base, {"google_maps_api_key": "base-key"})
            _write(os.path.join(tmpdir, "config.local.json"), {"google_maps_api_key": "local-key"})
            with mock.patch.dict(os.environ, {"ROUTING_API_KEY": "env-key"}):
                config = load_config(base)
        self.assertEqual(config["google_maps_api_key"], "env-key")

    def test_render_env_var_name_is_supported(self):
        """Render 後台實際使用的變數名（2026-08-14 輪替後）要能取到金鑰。"""
        self._clean_env()
        with tempfile.TemporaryDirectory() as tmpdir:
            base = os.path.join(tmpdir, "config.json")
            _write(base, {"google_maps_api_key": ""})
            with mock.patch.dict(os.environ, {"ROUTING_API_KEY_0814": "render-key"}):
                config = load_config(base)
        self.assertEqual(config["google_maps_api_key"], "render-key")

    def test_env_var_priority_follows_declared_order(self):
        """同時設定多個名稱時，依 API_KEY_ENV_VARS 的順序取第一個有值的。"""
        self._clean_env()
        with tempfile.TemporaryDirectory() as tmpdir:
            base = os.path.join(tmpdir, "config.json")
            _write(base, {"google_maps_api_key": ""})
            env = {name: f"{name}-value" for name in API_KEY_ENV_VARS}
            with mock.patch.dict(os.environ, env):
                config = load_config(base)
        self.assertEqual(config["google_maps_api_key"], f"{API_KEY_ENV_VARS[0]}-value")

    def test_empty_env_var_falls_through_to_next_name(self):
        """變數存在但值是空字串（Render 上很容易誤設）時要往下一個名稱找，不能吃到空值。"""
        self._clean_env()
        with tempfile.TemporaryDirectory() as tmpdir:
            base = os.path.join(tmpdir, "config.json")
            _write(base, {"google_maps_api_key": ""})
            with mock.patch.dict(os.environ, {"ROUTING_API_KEY_0814": "", "ROUTING_API_KEY": "fallback-key"}):
                config = load_config(base)
        self.assertEqual(config["google_maps_api_key"], "fallback-key")

    def test_missing_files_fall_back_to_defaults(self):
        self._clean_env()
        with tempfile.TemporaryDirectory() as tmpdir:
            config = load_config(os.path.join(tmpdir, "config.json"))
        self.assertEqual(config["google_maps_api_key"], "")
        self.assertEqual(config["solver"], "ortools")


if __name__ == "__main__":
    unittest.main()
