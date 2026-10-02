import json
import os
import time
from typing import Any, Dict, List, Mapping, Optional, Sequence

import googlemaps


# 簡單型別別名，讓輔助函式標註可讀一點。
MappingLike = Mapping[str, Any]


def fetch_distance_matrix(
    addresses: Sequence[str],
    api_key: str,
    cache_filename: str = "matrix_cache.json",
    *,
    mode: str = "driving",
    language: str = "zh-TW",
    chunk_size: int = 10,
    request_delay_seconds: float = 1,
) -> Optional[Dict[str, Any]]:
    """取得 Google Maps 時間與距離矩陣，優先使用本地快取。"""
    if os.path.exists(cache_filename):
        cached_data = _read_cache(cache_filename)
        if cached_data and _cache_matches(cached_data, addresses):
            print("[地圖模組] 讀取本地快取矩陣...")
            return cached_data

        # 途中重排常只用原地點的子集合；能從快取切出子矩陣就不必重打 API，
        # 也避免子集合結果覆蓋掉完整地點的快取。
        sliced_data = _slice_cached_matrix(cached_data, addresses)
        if sliced_data:
            print("[地圖模組] 由快取矩陣切出子集合，免重新呼叫 API...")
            return sliced_data

        print("[地圖模組] 地點清單已改變，重新呼叫 Google Maps API...")

    if not api_key:
        print("[地圖模組] 缺少 Google Maps API Key。")
        return None

    print("[地圖模組] 呼叫 Google Maps API 中...")
    gmaps = googlemaps.Client(key=api_key)
    n = len(addresses)
    safe_chunk_size = max(1, chunk_size)
    time_matrix = [[0] * n for _ in range(n)]
    distance_matrix = [[0] * n for _ in range(n)]

    # Google Maps Distance Matrix 一次可查多個 origins/destinations，這裡分批避免請求過大。
    for i in range(0, n, safe_chunk_size):
        origins = addresses[i : i + safe_chunk_size]
        for j in range(0, n, safe_chunk_size):
            destinations = addresses[j : j + safe_chunk_size]
            response = _request_distance_matrix(
                gmaps=gmaps,
                origins=origins,
                destinations=destinations,
                mode=mode,
                language=language,
            )
            if response is None:
                return None

            _fill_matrix_block(
                response=response,
                time_matrix=time_matrix,
                distance_matrix=distance_matrix,
                row_offset=i,
                column_offset=j,
            )

            # 避免連續打 API 太快；若設定為 0 則不等待。
            if request_delay_seconds > 0:
                time.sleep(request_delay_seconds)

    result = {
        "addresses": list(addresses),
        "time_matrix": time_matrix,
        "distance_matrix": distance_matrix,
    }
    _write_cache(cache_filename, result)
    return result


def _request_distance_matrix(
    *,
    gmaps,
    origins: Sequence[str],
    destinations: Sequence[str],
    mode: str,
    language: str,
) -> Optional[Dict[str, Any]]:
    """包裝單次 Google Maps API 呼叫，集中處理例外。"""
    try:
        return gmaps.distance_matrix(
            origins=origins,
            destinations=destinations,
            mode=mode,
            language=language,
        )
    except Exception as exc:
        print(f"[地圖模組] API 錯誤: {exc}")
        return None


def _fill_matrix_block(
    *,
    response: MappingLike,
    time_matrix: List[List[int]],
    distance_matrix: List[List[int]],
    row_offset: int,
    column_offset: int,
) -> None:
    """把單次 API 回傳的區塊填回完整矩陣。"""
    for x, row in enumerate(response["rows"]):
        for y, element in enumerate(row["elements"]):
            row_index = row_offset + x
            column_index = column_offset + y

            if element["status"] == "OK":
                time_matrix[row_index][column_index] = element["duration"]["value"]
                distance_matrix[row_index][column_index] = element["distance"]["value"]
            else:
                # 不可達點用極大成本表示，讓求解器自然避開。
                time_matrix[row_index][column_index] = 999999
                distance_matrix[row_index][column_index] = 999999


# ─── 地址驗證（Geocoding）────────────────────────────────────
# 新增訂單前確認地址能被 Google 定位到「可導航」的精度，
# 擋掉查無此地址或只到行政區層級（導航不到定點）的輸入。

GEOCODE_CACHE_FILENAME = "geocode_validate_cache.json"

# Geocoding 首要型別若落在行政區/郵遞區號層級，代表地址太籠統。
_COARSE_PRIMARY_TYPES = {
    "political",
    "locality",
    "sublocality",
    "sublocality_level_1",
    "neighborhood",
    "colloquial_area",
    "administrative_area_level_1",
    "administrative_area_level_2",
    "administrative_area_level_3",
    "administrative_area_level_4",
    "postal_code",
    "country",
}


def validate_addresses(
    addresses: Sequence[str],
    api_key: str,
    *,
    language: str = "zh-TW",
    region: str = "tw",
    cache_filename: str = GEOCODE_CACHE_FILENAME,
    requester=None,
) -> List[Dict[str, Any]]:
    """逐一驗證地址可否被 Google Geocoding 定位（帶檔案快取）。

    requester 供測試注入，簽名為 (address) -> geocode 結果 list；
    正式路徑用 googlemaps client，REQUEST_DENIED 等錯誤會往上拋由 API 層轉成錯誤回應。
    """
    if requester is None:
        gmaps = googlemaps.Client(key=api_key)

        def requester(addr: str):
            return gmaps.geocode(addr, language=language, region=region)

    cache = _read_cache(cache_filename) or {}
    results: List[Dict[str, Any]] = []
    dirty = False
    for address in addresses:
        key = str(address or "").strip()
        if not key:
            results.append({"address": address, "valid": False, "reason": "地址空白"})
            continue
        entry = cache.get(key)
        if not isinstance(entry, dict) or "valid" not in entry:
            entry = _summarize_geocode(key, requester(key))
            cache[key] = entry
            dirty = True
        results.append(entry)
    if dirty:
        _write_cache(cache_filename, cache)
    return results


def _summarize_geocode(address: str, geocode_results) -> Dict[str, Any]:
    """把單一地址的 Geocoding 回應整理成前端可直接使用的驗證結果。"""
    if not geocode_results:
        return {"address": address, "valid": False, "reason": "查無此地址，Google 無法定位"}
    first = geocode_results[0]
    types = first.get("types") or []
    primary = types[0] if types else ""
    geometry = first.get("geometry") or {}
    location = geometry.get("location") or {}
    entry: Dict[str, Any] = {
        "address": address,
        "valid": primary not in _COARSE_PRIMARY_TYPES,
        "partial_match": bool(first.get("partial_match")),
        "formatted_address": first.get("formatted_address", ""),
        "location_type": geometry.get("location_type", ""),
        "lat": location.get("lat"),
        "lng": location.get("lng"),
        "reason": None,
    }
    if not entry["valid"]:
        entry["reason"] = "地址太籠統（只到行政區層級），無法導航到定點"
    return entry


def _read_cache(cache_filename: str) -> Optional[Dict[str, Any]]:
    """讀取矩陣快取；快取壞掉時視為不存在。"""
    try:
        with open(cache_filename, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"[地圖模組] 快取讀取失敗，將重新產生: {exc}")
        return None


def _write_cache(cache_filename: str, data: MappingLike) -> None:
    """寫入矩陣快取，供下一次相同地點清單重複使用。"""
    with open(cache_filename, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=4)


def _slice_cached_matrix(
    cached_data: Optional[MappingLike],
    addresses: Sequence[str],
) -> Optional[Dict[str, Any]]:
    """若快取地址為本次請求的超集合，直接切出對應子矩陣。"""
    if not cached_data:
        return None

    cached_addresses = cached_data.get("addresses")
    time_matrix = cached_data.get("time_matrix")
    distance_matrix = cached_data.get("distance_matrix")
    if not cached_addresses or not time_matrix or not distance_matrix:
        return None

    try:
        index_map = [cached_addresses.index(address) for address in addresses]
    except ValueError:
        return None

    size = len(cached_addresses)
    if len(time_matrix) != size or any(len(row) != size for row in time_matrix):
        return None
    if len(distance_matrix) != size or any(len(row) != size for row in distance_matrix):
        return None

    return {
        "addresses": list(addresses),
        "time_matrix": [[time_matrix[i][j] for j in index_map] for i in index_map],
        "distance_matrix": [[distance_matrix[i][j] for j in index_map] for i in index_map],
    }


def _cache_matches(cached_data: MappingLike, addresses: Sequence[str]) -> bool:
    """確認快取矩陣大小與地址清單是否符合本次請求。"""
    time_matrix = cached_data.get("time_matrix", [])
    distance_matrix = cached_data.get("distance_matrix", [])
    expected_size = len(addresses)

    matrix_size_matches = (
        len(time_matrix) == expected_size
        and len(distance_matrix) == expected_size
        and all(len(row) == expected_size for row in time_matrix)
        and all(len(row) == expected_size for row in distance_matrix)
    )
    if not matrix_size_matches:
        return False

    cached_addresses = cached_data.get("addresses")
    if cached_addresses is None:
        print("[地圖模組] 使用舊版快取；下次重新產生後會改用地址比對。")
        return True

    return cached_addresses == list(addresses)

