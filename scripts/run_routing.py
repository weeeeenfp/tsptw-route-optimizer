"""以 config.json 執行一次路線最佳化（本機 CLI，不經 API）。

從專案根目錄執行：`python scripts/run_routing.py`
（腳本放在子目錄，sys.path[0] 會是 scripts/，所以先把專案根目錄補進去才找得到 core 套件；
 config.json 等相對路徑仍以「執行時的工作目錄」為準，請在根目錄下指令。）
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import json

from core.app_config import load_config, merge_request_with_config
from core.route_service import optimize_route_request


def process_routing_request(config_file="config.json"):
    """從設定檔讀取輸入/輸出位置，執行一次路線最佳化。"""
    config = load_config(config_file)

    # 本機執行時，輸入檔只放地點資料也可以；solver、API key 等控制項由 config.json 補上。
    input_payload_file = config["input_payload_file"]
    output_result_file = config["output_result_file"]
    with open(input_payload_file, "r", encoding="utf-8") as f:
        request_data = json.load(f)

    runtime_request = merge_request_with_config(
        request_data=request_data,
        config=config,
        config_overrides_payload=config.get("cli_config_overrides_payload", True),
    )

    # 執行核心服務，並把結果同時印出與寫入輸出檔。
    final_response = optimize_route_request(runtime_request)
    print(json.dumps(final_response, ensure_ascii=False, indent=4))

    with open(output_result_file, "w", encoding="utf-8") as out_f:
        json.dump(final_response, out_f, ensure_ascii=False, indent=4)


if __name__ == "__main__":
    process_routing_request()
