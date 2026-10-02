param(
    [string]$OutputDirectory = ""
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $projectRoot "outputs\report_function_tests_20260715\map_screenshots"
}
$OutputDirectory = (Resolve-Path $OutputDirectory).Path

$resultsPath = Join-Path $projectRoot "outputs\report_function_tests_20260715\results.json"
$results = Get-Content $resultsPath -Raw -Encoding UTF8 | ConvertFrom-Json
$byId = @{}
foreach ($item in $results.results) {
    $byId[$item.case_id] = $item
}

function Get-Case([string]$CaseId) {
    if (-not $byId.ContainsKey($CaseId)) {
        throw "找不到測試結果：$CaseId"
    }
    return $byId[$CaseId]
}

function Format-Number([double]$Value) {
    if ([Math]::Abs($Value - [Math]::Round($Value)) -lt 0.005) {
        return ([Math]::Round($Value)).ToString("0")
    }
    return $Value.ToString("0.##")
}

function Format-Minutes($Value) {
    return "$(Format-Number ([double]$Value)) 分"
}

function Format-Delta($BaseValue, $ChangedValue) {
    $delta = [Math]::Round(([double]$ChangedValue - [double]$BaseValue), 2)
    if ([Math]::Abs($delta) -lt 0.005) {
        return "不變"
    }
    $prefix = if ($delta -gt 0) { "+" } else { "" }
    return "$prefix$(Format-Number $delta) 分"
}

function Format-Route($Case) {
    return (($Case.route_indices | ForEach-Object { [string]$_ }) -join " → ")
}

function Get-ChangedMetrics($BaseCase, $ChangedCase) {
    $changed = @("route")
    if ([Math]::Abs([double]$ChangedCase.total_travel_minutes - [double]$BaseCase.total_travel_minutes) -ge 0.005) { $changed += "travel" }
    if ([Math]::Abs([double]$ChangedCase.total_waiting_minutes - [double]$BaseCase.total_waiting_minutes) -ge 0.005) { $changed += "wait" }
    if ([Math]::Abs([double]$ChangedCase.total_lateness_minutes - [double]$BaseCase.total_lateness_minutes) -ge 0.005) { $changed += "late" }
    return $changed
}

function New-Card($Case, [string]$Title, [string]$Accent, [string]$Image, $BaseCase = $null) {
    $card = [ordered]@{
        Title = $Title
        Accent = $Accent
        Image = $Image
        Travel = Format-Minutes $Case.total_travel_minutes
        Wait = Format-Minutes $Case.total_waiting_minutes
        Late = Format-Minutes $Case.total_lateness_minutes
        Route = Format-Route $Case
        ChangedMetrics = @()
    }
    if ($null -ne $BaseCase) {
        $card.ChangedMetrics = Get-ChangedMetrics $BaseCase $Case
    }
    return [pscustomobject]$card
}

$d01 = Get-Case "D01"
$d02 = Get-Case "D02"
$d03 = Get-Case "D03"
$r01 = Get-Case "R01"
$r02 = Get-Case "R02"
$r03 = Get-Case "R03"
$e01 = Get-Case "E01"
$e02 = Get-Case "E02"

$pairs = @(
    [pscustomobject]@{
        Output = "比較_送貨_基準_vs_優先級.png"
        Title = "送貨：基準路線 vs 優先級路線"
        Subtitle = "檢查高優先級客戶是否確實提前，並比較額外行駛成本。"
        Note = "ID $($d02.priority_comparison.target_id) 的順位由 $($d02.priority_comparison.baseline_rank) 提前至 $($d02.priority_comparison.priority_rank)；行駛 $(Format-Delta $d01.total_travel_minutes $d02.total_travel_minutes)。"
        Cards = @(
            (New-Card $d01 "D01 基準" "#3974A8" "D01_送貨_基準_主路線.png"),
            (New-Card $d02 "D02 優先級" "#BD5A35" "D02_送貨_優先級_主路線.png" $d01)
        )
    },
    [pscustomobject]@{
        Output = "比較_送貨_基準_vs_時間窗.png"
        Title = "送貨：基準路線 vs 指定時間窗"
        Subtitle = "檢查時間窗造成的改道與等待時間。"
        Note = "時間窗情境等待 $(Format-Minutes $d03.total_waiting_minutes)、遲到 $(Format-Minutes $d03.total_lateness_minutes)；行駛 $(Format-Delta $d01.total_travel_minutes $d03.total_travel_minutes)。"
        Cards = @(
            (New-Card $d01 "D01 基準" "#3974A8" "D01_送貨_基準_主路線.png"),
            (New-Card $d03 "D03 指定時間窗" "#8B5DA8" "D03_送貨_時間窗_主路線.png" $d01)
        )
    },
    [pscustomobject]@{
        Output = "比較_收貨_基準_vs_優先級.png"
        Title = "收貨：基準路線 vs 優先級路線"
        Subtitle = "檢查收貨優先級保留後，指定站點是否提前。"
        Note = "ID $($r02.priority_comparison.target_id) 的順位由 $($r02.priority_comparison.baseline_rank) 提前至 $($r02.priority_comparison.priority_rank)；行駛 $(Format-Delta $r01.total_travel_minutes $r02.total_travel_minutes)。"
        Cards = @(
            (New-Card $r01 "R01 基準" "#3974A8" "R01_收貨_基準_主路線.png"),
            (New-Card $r02 "R02 優先級" "#BD5A35" "R02_收貨_優先級_主路線.png" $r01)
        )
    },
    [pscustomobject]@{
        Output = "比較_收貨_基準_vs_軟性時間窗.png"
        Title = "收貨：基準路線 vs 軟性時間窗"
        Subtitle = "檢查必然逾時時，系統是否仍提供可執行的最少延誤路線。"
        Note = "軟性時間窗情境成功求解並明列 $(Format-Minutes $r03.total_lateness_minutes) 遲到；行駛 $(Format-Delta $r01.total_travel_minutes $r03.total_travel_minutes)，不會回傳無解。"
        Cards = @(
            (New-Card $r01 "R01 基準" "#3974A8" "R01_收貨_基準_主路線.png"),
            (New-Card $r03 "R03 軟性時間窗" "#8B5DA8" "R03_收貨_軟性時間窗_主路線.png" $r01)
        )
    },
    [pscustomobject]@{
        Output = "比較_途中狀態更新_vs_客戶改約.png"
        Title = "途中重排：狀態更新 vs 客戶改約"
        Subtitle = "兩組都以 11:00、目前位置 ID 6 為起點，只規劃尚未完成的站點。"
        Note = "改約後等待 $(Format-Minutes $e02.total_waiting_minutes)、行駛 $(Format-Delta $e01.total_travel_minutes $e02.total_travel_minutes)；兩組最終都回公司 index 0。"
        Cards = @(
            (New-Card $e01 "E01 完成／取消／跳過" "#3974A8" "E01_途中重排_狀態更新_主路線.png"),
            (New-Card $e02 "E02 客戶改約" "#BD5A35" "E02_途中重排_客戶改約_主路線.png" $e01)
        )
    }
)

$canvasWidth = 2670
$canvasHeight = 1280
$cardWidth = 1280
$mapHeight = 900
$leftX = 35
$rightX = 1355
$cardY = 110
$cardHeaderHeight = 90
$routeHeight = 65

$titleFont = [System.Drawing.Font]::new("Microsoft JhengHei", 32, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$subtitleFont = [System.Drawing.Font]::new("Microsoft JhengHei", 17, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$cardTitleFont = [System.Drawing.Font]::new("Microsoft JhengHei", 23, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$metricFont = [System.Drawing.Font]::new("Microsoft JhengHei", 16, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$routeFont = [System.Drawing.Font]::new("Microsoft JhengHei", 15, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$noteFont = [System.Drawing.Font]::new("Microsoft JhengHei", 17, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$titleBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml("#172033"))
$secondaryBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml("#526174"))
$whiteBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
$borderPen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml("#CBD4DF"), 1)
$badgeBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml("#F8FAFC"))
$noteAccentBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml("#3974A8"))
$highlightBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml("#FEF3C7"))
$highlightTextBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml("#991B1B"))
$highlightPen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml("#DC2626"), 3)
$highlightFont = [System.Drawing.Font]::new("Microsoft JhengHei", 16, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)

try {
    foreach ($pair in $pairs) {
        $bitmap = [System.Drawing.Bitmap]::new($canvasWidth, $canvasHeight, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.Clear([System.Drawing.ColorTranslator]::FromHtml("#EEF2F6"))
            $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
            $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
            $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
            $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

            $graphics.DrawString($pair.Title, $titleFont, $titleBrush, 35, 20)
            $graphics.DrawString($pair.Subtitle, $subtitleFont, $secondaryBrush, 35, 68)
            $graphics.DrawString("原圖 1:1｜相同視野｜相同尺寸", $subtitleFont, $secondaryBrush, 2250, 32)

            for ($index = 0; $index -lt 2; $index++) {
                $card = $pair.Cards[$index]
                $x = if ($index -eq 0) { $leftX } else { $rightX }
                $accentColor = [System.Drawing.ColorTranslator]::FromHtml($card.Accent)
                $accentBrush = [System.Drawing.SolidBrush]::new($accentColor)
                $metricValueBrush = [System.Drawing.SolidBrush]::new($accentColor)
                $mapPath = Join-Path $OutputDirectory $card.Image
                $map = [System.Drawing.Image]::FromFile($mapPath)
                try {
                    if ($map.Width -ne 1280 -or $map.Height -ne $mapHeight) {
                        throw "地圖尺寸不符：$($card.Image) 實際為 $($map.Width)x$($map.Height)，預期為 1280x900。"
                    }

                    $graphics.FillRectangle($whiteBrush, $x, $cardY, $cardWidth, $cardHeaderHeight + $mapHeight + $routeHeight)
                    $graphics.DrawRectangle($borderPen, $x, $cardY, $cardWidth - 1, $cardHeaderHeight + $mapHeight + $routeHeight - 1)
                    $graphics.FillRectangle($accentBrush, $x, $cardY, $cardWidth, 6)
                    $graphics.DrawString($card.Title, $cardTitleFont, $titleBrush, $x + 18, $cardY + 21)
                    if ($index -eq 1) {
                        $graphics.FillRectangle($highlightBrush, $x + 1108, $cardY + 24, 142, 40)
                        $graphics.DrawRectangle($highlightPen, $x + 1108, $cardY + 24, 142, 40)
                        $graphics.DrawString("變更後", $highlightFont, $highlightTextBrush, $x + 1142, $cardY + 34)
                    }

                    $metrics = @(
                        [pscustomobject]@{ Key = "travel"; Label = "行駛"; Value = $card.Travel },
                        [pscustomobject]@{ Key = "wait"; Label = "等待"; Value = $card.Wait },
                        [pscustomobject]@{ Key = "late"; Label = "遲到"; Value = $card.Late }
                    )
                    $badgeX = $x + 345
                    foreach ($metric in $metrics) {
                        $isChanged = $index -eq 1 -and $card.ChangedMetrics -contains $metric.Key
                        $graphics.FillRectangle($(if ($isChanged) { $highlightBrush } else { $badgeBrush }), $badgeX, $cardY + 24, 170, 40)
                        $graphics.DrawRectangle($(if ($isChanged) { $highlightPen } else { $borderPen }), $badgeX, $cardY + 24, 170, 40)
                        $graphics.DrawString($metric.Label, $metricFont, $secondaryBrush, $badgeX + 12, $cardY + 34)
                        $graphics.DrawString($metric.Value, $metricFont, $(if ($isChanged) { $highlightTextBrush } else { $metricValueBrush }), $badgeX + 62, $cardY + 34)
                        $badgeX += 182
                    }

                    $graphics.DrawImageUnscaled($map, $x, $cardY + $cardHeaderHeight)
                    $routeY = $cardY + $cardHeaderHeight + $mapHeight
                    $isRouteChanged = $index -eq 1 -and $card.ChangedMetrics -contains "route"
                    if ($isRouteChanged) {
                        $graphics.FillRectangle($highlightBrush, $x + 2, $routeY + 2, $cardWidth - 4, $routeHeight - 4)
                        $graphics.DrawRectangle($highlightPen, $x + 2, $routeY + 2, $cardWidth - 5, $routeHeight - 5)
                    } else {
                        $graphics.DrawLine($borderPen, $x, $routeY, $x + $cardWidth, $routeY)
                    }
                    $graphics.DrawString("後端路線 index：$($card.Route)", $routeFont, $(if ($isRouteChanged) { $highlightTextBrush } else { $titleBrush }), $x + 18, $routeY + 22)
                }
                finally {
                    $map.Dispose()
                    $accentBrush.Dispose()
                    $metricValueBrush.Dispose()
                }
            }

            $graphics.FillRectangle($whiteBrush, 35, 1180, 2600, 70)
            $graphics.FillRectangle($noteAccentBrush, 35, 1180, 5, 70)
            $graphics.DrawString($pair.Note, $noteFont, $secondaryBrush, 55, 1204)

            $outputPath = Join-Path $OutputDirectory $pair.Output
            $bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
            [pscustomobject]@{ Output = $pair.Output; Width = $canvasWidth; Height = $canvasHeight; MapScale = "1:1" }
        }
        finally {
            $graphics.Dispose()
            $bitmap.Dispose()
        }
    }
}
finally {
    $titleFont.Dispose()
    $subtitleFont.Dispose()
    $cardTitleFont.Dispose()
    $metricFont.Dispose()
    $routeFont.Dispose()
    $noteFont.Dispose()
    $titleBrush.Dispose()
    $secondaryBrush.Dispose()
    $whiteBrush.Dispose()
    $borderPen.Dispose()
    $badgeBrush.Dispose()
    $noteAccentBrush.Dispose()
    $highlightBrush.Dispose()
    $highlightTextBrush.Dispose()
    $highlightPen.Dispose()
    $highlightFont.Dispose()
}
