"""比較不同 OR-Tools 搜尋策略的結果差異。

從專案根目錄執行：`python scripts/compare_ortools_strategies.py`
（腳本放在子目錄，sys.path[0] 會是 scripts/，所以先把專案根目錄補進去才找得到 core 套件；
 config.json 等相對路徑仍以「執行時的工作目錄」為準，請在根目錄下指令。）
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import copy
import json
from typing import Any, Dict

from core.app_config import load_config, merge_request_with_config
from core.route_service import optimize_route_request


STRATEGIES = [
    {
        "label": "baseline_path_cheapest_arc",
        "ortools": {
            "first_solution_strategy": "PATH_CHEAPEST_ARC",
            "local_search_metaheuristic": "GUIDED_LOCAL_SEARCH",
        },
    },
    {
        "label": "parallel_cheapest_insertion",
        "ortools": {
            "first_solution_strategy": "PARALLEL_CHEAPEST_INSERTION",
            "local_search_metaheuristic": "GUIDED_LOCAL_SEARCH",
        },
    },
]


def main() -> None:
    config = load_config()
    with open(config["input_payload_file"], "r", encoding="utf-8") as f:
        payload = json.load(f)

    base_request = merge_request_with_config(
        request_data=payload,
        config=config,
        config_overrides_payload=False,
    )
    base_request["solver"] = "ortools"

    comparison = []
    for strategy in STRATEGIES:
        request = copy.deepcopy(base_request)
        request["ortools"] = strategy["ortools"]
        result = optimize_route_request(request)
        comparison.append(_summarize(strategy["label"], result))

    print(json.dumps(comparison, ensure_ascii=False, indent=2))


def _summarize(label: str, result: Dict[str, Any]) -> Dict[str, Any]:
    if result["status"] != "SUCCESS":
        return {
            "label": label,
            "status": result["status"],
            "message": result.get("message"),
        }

    data = result["data"]
    return {
        "label": label,
        "status": result["status"],
        "solver_metadata": data.get("solver_metadata"),
        "total_time_minutes": data["total_time_minutes"],
        "total_elapsed_minutes": data["total_elapsed_minutes"],
        "total_distance_km": data["total_distance_km"],
        "total_lateness_minutes": data["total_lateness_minutes"],
        "route_indices": data["route_indices"],
        "route_sequence": data["route_sequence"],
    }


if __name__ == "__main__":
    main()
