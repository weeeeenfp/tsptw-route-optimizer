import json
import os
from pathlib import Path
from typing import Any, Dict, Mapping, MutableMapping, Optional


# 專案預設設定：當 config.json 不存在或缺少欄位時，使用這些保守預設值。
DEFAULT_CONFIG: Dict[str, Any] = {
    "input_payload_file": "samples/request_payload_bast.json",
    "output_result_file": "outputs/routing_result_central_dp.json",
    "google_maps_api_key": "",
    "solver": "ortools",
    "solver_timeout_seconds": 5,
    "depot_index": 0,
    "start_index": None,
    "end_index": None,
    "end_candidate_indices": [],
    "matrix_cache_file": "matrix_cache.json",
    "cli_config_overrides_payload": True,
    "api_config_overrides_payload": False,
    "constraints": {
        "allow_late_arrival": True,
        "late_penalty_per_second": 1000,
        "waiting_time_cost_per_second": 1,
        "route_order_penalty_per_second": 20,
        "route_order_interval_seconds": 600,
        "preserve_remaining_order": True,
    },
    "priority": {
        "default_priority": 3,
        "priority_interval_seconds": 1800,
        "priority_penalty_per_second": 20,
    },
    "service": {
        "default_service_time_seconds": 600,
    },
    "ortools": {
        "first_solution_strategy": "PATH_CHEAPEST_ARC",
        "local_search_metaheuristic": "GUIDED_LOCAL_SEARCH",
    },
    "google_maps": {
        "mode": "driving",
        "language": "zh-TW",
        "chunk_size": 10,
        "request_delay_seconds": 1,
    },
    "navigation": {
        "max_points_per_url": 10,
        "travelmode": "driving",
    },
    "api_server": {
        "host": "127.0.0.1",
        "port": 8000,
        "cors_allow_origins": [
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "http://localhost:5173",
            "http://127.0.0.1:5173",
        ],
    },
}


# 金鑰環境變數的候選名稱，依序取第一個有值的。
# `ROUTING_API_KEY_0814` 是 2026-08-14 金鑰輪替後 Render 後台使用的名稱；
# 後面兩個保留相容，之後再輪替金鑰時「只換值、不換名」就不必動到程式碼。
API_KEY_ENV_VARS = (
    "ROUTING_API_KEY_0814",
    "ROUTING_API_KEY",
    "GOOGLE_MAPS_API_KEY",
)


def load_config(config_file: str = "config.json") -> Dict[str, Any]:
    """讀取設定檔，並把缺少的欄位補上預設值。

    金鑰等機密不進版控：`config.local.json`（已 gitignore）會覆蓋 `config.json`，
    環境變數（見 `API_KEY_ENV_VARS`）再覆蓋其上。
    """
    config = _deep_copy(DEFAULT_CONFIG)

    config_path = Path(config_file)
    if config_path.exists():
        with config_path.open("r", encoding="utf-8") as f:
            config = _merge_dicts(config, json.load(f))

    local_path = config_path.with_name(config_path.stem + ".local" + config_path.suffix)
    if local_path.exists():
        with local_path.open("r", encoding="utf-8") as f:
            config = _merge_dicts(config, json.load(f))

    env_api_key = next(
        (os.environ[name] for name in API_KEY_ENV_VARS if os.environ.get(name)), None
    )
    if env_api_key:
        config["google_maps_api_key"] = env_api_key

    return config


def merge_request_with_config(
    request_data: Mapping[str, Any],
    config: Optional[Mapping[str, Any]] = None,
    *,
    config_overrides_payload: bool = False,
) -> Dict[str, Any]:
    """把設定檔與單次請求合併成真正要執行的參數。"""
    runtime_config = load_config() if config is None else config
    merged_request = dict(request_data)

    # 這些是會直接影響求解流程的可調欄位。
    adjustable_fields = [
        "google_maps_api_key",
        "solver",
        "solver_timeout_seconds",
        "depot_index",
        "start_index",
        "end_index",
        "end_candidate_indices",
        "matrix_cache_file",
    ]

    for field in adjustable_fields:
        config_value = runtime_config.get(field)
        if _is_empty(config_value):
            continue

        if config_overrides_payload or _is_empty(merged_request.get(field)):
            merged_request[field] = config_value

    # 巢狀設定集中放在 request 裡，讓 route_service 不需要知道設定檔來源。
    merged_request["google_maps"] = _merge_dicts(
        _deep_copy(DEFAULT_CONFIG["google_maps"]),
        runtime_config.get("google_maps", {}),
    )
    merged_request["navigation"] = _merge_dicts(
        _deep_copy(DEFAULT_CONFIG["navigation"]),
        runtime_config.get("navigation", {}),
    )
    merged_request["constraints"] = _merge_nested_runtime_setting(
        "constraints",
        merged_request,
        runtime_config,
        config_overrides_payload=config_overrides_payload,
    )
    merged_request["priority"] = _merge_nested_runtime_setting(
        "priority",
        merged_request,
        runtime_config,
        config_overrides_payload=config_overrides_payload,
    )
    merged_request["service"] = _merge_nested_runtime_setting(
        "service",
        merged_request,
        runtime_config,
        config_overrides_payload=config_overrides_payload,
    )
    merged_request["ortools"] = _merge_nested_runtime_setting(
        "ortools",
        merged_request,
        runtime_config,
        config_overrides_payload=config_overrides_payload,
    )

    return merged_request


def _merge_dicts(base: MutableMapping[str, Any], override: Mapping[str, Any]) -> Dict[str, Any]:
    """遞迴合併 dict，讓使用者只需要在 config.json 放想調整的欄位。"""
    for key, value in override.items():
        if key.startswith("_"):
            continue
        if isinstance(value, Mapping) and isinstance(base.get(key), MutableMapping):
            base[key] = _merge_dicts(base[key], value)
        else:
            base[key] = value
    return dict(base)


def _merge_nested_runtime_setting(
    key: str,
    request_data: Mapping[str, Any],
    config: Mapping[str, Any],
    *,
    config_overrides_payload: bool,
) -> Dict[str, Any]:
    """合併巢狀設定，支援 config 或單次 payload 覆蓋。"""
    default_value = _deep_copy(DEFAULT_CONFIG[key])
    config_value = config.get(key, {})
    request_value = request_data.get(key, {})
    if not isinstance(config_value, Mapping):
        config_value = {}
    if not isinstance(request_value, Mapping):
        request_value = {}

    if config_overrides_payload:
        return _merge_dicts(_merge_dicts(default_value, request_value), config_value)

    return _merge_dicts(_merge_dicts(default_value, config_value), request_value)


def _deep_copy(data: Mapping[str, Any]) -> Dict[str, Any]:
    """用 JSON 序列化建立純資料深拷貝，避免修改到 DEFAULT_CONFIG。"""
    return json.loads(json.dumps(data, ensure_ascii=False))


def _is_empty(value: Any) -> bool:
    """判斷設定值是否代表「沒有填」。"""
    return value is None or value == "" or value == [] or value == {}
