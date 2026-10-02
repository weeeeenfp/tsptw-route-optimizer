from typing import Any, Dict, List, Literal, Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from core.app_config import load_config, merge_request_with_config
from core.google_maps_api import validate_addresses
from core.route_service import optimize_route_request


# API 啟動時載入一次設定檔；修改 config.json 後請重新啟動服務。
APP_CONFIG = load_config()


class LocationItem(BaseModel):
    """單一配送地點。"""

    id: int
    name: str
    address: str
    time_window: List[Any] = Field(..., min_length=2, max_length=2, description="[開始時間, 結束時間]，建議使用 HH:MM")
    priority: Optional[int] = Field(default=None, description="配送優先權，1 到 5，數字越小越優先")
    delay_by_seconds: Optional[int] = Field(default=None, description="延後配送秒數")
    delay_until_seconds: Optional[Any] = Field(default=None, description="延後到指定時間，可用 HH:MM 或秒數")
    rescheduled_time_window: Optional[List[Any]] = Field(default=None, min_length=2, max_length=2, description="客戶臨時改約後的新時間窗")
    service_time_seconds: Optional[int] = Field(default=None, description="此站服務時間秒數")
    status: Optional[Literal["pending", "in_progress", "completed", "delayed", "cancelled", "skipped"]] = Field(default=None, description="配送途中狀態")


class RoutingRequest(BaseModel):
    """路線最佳化 API request。"""

    google_maps_api_key: Optional[str] = None
    operation_type: Optional[Literal["delivery", "receiving"]] = Field(default="delivery", description="行程種類；收貨不套用 25 點硬上限")
    solver_timeout_seconds: Optional[int] = Field(default=None, description="求解最長等待秒數")
    depot_index: Optional[int] = Field(default=None, description="預設起終點 index")
    current_index: Optional[int] = Field(default=None, description="途中重排時司機目前所在地點 index")
    current_time_seconds: Optional[Any] = Field(default=None, description="途中重排當下時間，可用 HH:MM、HH:MM:SS 或秒數")
    start_index: Optional[int] = Field(default=None, description="實際出發地點 index")
    end_index: Optional[int] = Field(default=None, description="固定結束地點 index")
    end_candidate_indices: Optional[List[int]] = Field(default=None, description="候選結束地點 index 清單")
    completed_indices: Optional[List[int]] = Field(default=None, description="已完成配送、重排時需排除的地點 index")
    cancelled_indices: Optional[List[int]] = Field(default=None, description="取消配送、重排時需排除的地點 index")
    skipped_indices: Optional[List[int]] = Field(default=None, description="暫時跳過、重排時需排除的地點 index")
    manual_route_indices: Optional[List[int]] = Field(default=None, description="手動調整後的站點順序（原始 index）；後端固定照此順序重算時間，不再自行換順序")
    solver: Optional[Literal["ortools", "dp"]] = Field(default=None, description="求解器")
    constraints: Optional[Dict[str, Any]] = Field(default=None, description="軟性時間窗設定")
    priority_settings: Optional[Dict[str, Any]] = Field(default=None, alias="priority", description="優先權設定")
    service: Optional[Dict[str, Any]] = Field(default=None, description="每站上下貨/服務時間設定")
    ortools: Optional[Dict[str, Any]] = Field(default=None, description="OR-Tools 搜尋策略設定")
    locations: List[LocationItem]


app = FastAPI(
    title="台中路線最佳化 (TSPTW API)",
    description="使用 Google Maps 距離矩陣與 OR-Tools/DP 求解有時間窗限制的最佳路線。",
    version="1.0.0",
)


def _install_cors_middleware() -> None:
    """允許前端開發伺服器跨網域呼叫 API。"""
    api_server_config = APP_CONFIG.get("api_server", {})
    allow_origins = api_server_config.get(
        "cors_allow_origins",
        [
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "http://localhost:5173",
            "http://127.0.0.1:5173",
        ],
    )

    # 除了 config.json 明列的本機開發網址外，另以 regex 放行常見免費靜態主機的 https 網址
    # （Netlify / Vercel / Cloudflare Pages / Render / GitHub Pages），
    # 這樣前端部署到任一免費平台都不必再改後端 CORS。
    allow_origin_regex = api_server_config.get(
        "cors_allow_origin_regex",
        r"https://([a-z0-9-]+\.)*(netlify\.app|vercel\.app|pages\.dev|onrender\.com|github\.io)$",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=allow_origins,
        allow_origin_regex=allow_origin_regex,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )


_install_cors_middleware()


@app.get("/api/v1/health", summary="API 健康檢查")
def health_check():
    """給前端確認 API 是否可連線。"""
    return {"status": "OK"}


class AddressValidationRequest(BaseModel):
    """地址驗證 API request：新增訂單前確認地址可被定位。"""

    google_maps_api_key: Optional[str] = None
    addresses: List[str] = Field(..., min_length=1, max_length=25, description="單批要驗證的地址清單；總清單可由前端分批送出")


@app.post("/api/v1/validate-address", summary="驗證地址可否定位")
def validate_address(payload: AddressValidationRequest):
    """用 Google Geocoding 逐一檢查地址：查無此地址或只到行政區層級都視為無法導航。

    後端沒有金鑰時回 `SKIPPED`（讓前端軟性放行並提示），Geocoding 服務錯誤回 502。
    """
    api_key = payload.google_maps_api_key or APP_CONFIG.get("google_maps_api_key") or ""
    if not api_key:
        return {"status": "SKIPPED", "message": "後端未設定 Google Maps API Key，無法驗證地址"}
    try:
        results = validate_addresses(payload.addresses, api_key)
        return {"status": "SUCCESS", "data": {"results": results}}
    except Exception as exc:
        return JSONResponse(
            status_code=502,
            content={"status": "ERROR", "message": f"地址驗證服務錯誤: {exc}"},
        )


@app.post("/api/v1/optimize-route", summary="計算最佳路徑")
def optimize_route(payload: RoutingRequest):
    """接收地點清單，回傳最佳拜訪順序、延誤資訊與導航網址。"""
    try:
        request_data = _model_to_dict(payload)
        runtime_request = merge_request_with_config(
            request_data=request_data,
            config=APP_CONFIG,
            config_overrides_payload=APP_CONFIG.get("api_config_overrides_payload", False),
        )

        response = optimize_route_request(runtime_request)
        if response["status"] == "SUCCESS":
            return response
        if response["status"] in {"FAILED", "ERROR"}:
            return JSONResponse(status_code=400, content=response)
        return JSONResponse(status_code=400, content=response)
    except Exception as exc:
        return JSONResponse(
            status_code=500,
            content={"status": "ERROR", "message": f"伺服器內部錯誤: {exc}"},
        )


def _model_to_dict(model: BaseModel):
    """相容 Pydantic v1/v2，把模型轉成 dict。"""
    if hasattr(model, "model_dump"):
        return model.model_dump(by_alias=True)
    return model.dict(by_alias=True)
