param(
    [string]$OutputDirectory = ""
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$manifestPath = Join-Path $projectRoot "outputs\report_function_tests_20260715\manifest.json"
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $projectRoot "outputs\report_function_tests_20260715\data_comparisons"
}
[System.IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null
$manifest = Get-Content -Raw -Encoding UTF8 $manifestPath | ConvertFrom-Json

function Get-Scenario([string]$caseId) {
    $scenario = $manifest.scenarios | Where-Object { $_.case_id -eq $caseId } | Select-Object -First 1
    if ($null -eq $scenario) { throw "找不到測試情境：$caseId" }
    return $scenario
}

function New-Color([string]$html) {
    return [System.Drawing.ColorTranslator]::FromHtml($html)
}

function New-Brush([string]$html) {
    return [System.Drawing.SolidBrush]::new((New-Color $html))
}

function Draw-Table {
    param(
        [System.Drawing.Graphics]$Graphics,
        [object[]]$Rows,
        [object[]]$Columns,
        [int]$X,
        [int]$Y,
        [int]$HeaderHeight,
        [int]$RowHeight,
        [hashtable]$RowColors,
        [hashtable]$CellColors,
        [string]$OutlineColor
    )

    $tableWidth = ($Columns | Measure-Object -Property Width -Sum).Sum
    $tableHeight = $HeaderHeight + ($Rows.Count * $RowHeight)
    $whiteBrush = New-Brush "#FFFFFF"
    $headerBrush = New-Brush "#F8FAFC"
    $textBrush = New-Brush "#111827"
    $mutedBrush = New-Brush "#475569"
    $gridPen = [System.Drawing.Pen]::new((New-Color "#D1D5DB"), 1)
    $outlinePen = [System.Drawing.Pen]::new((New-Color $OutlineColor), 3)
    $headerFont = [System.Drawing.Font]::new("Arial", 18, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
    $bodyFont = [System.Drawing.Font]::new("Microsoft JhengHei", 17, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
    $addressFont = [System.Drawing.Font]::new("Microsoft JhengHei", 14, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
    $numberFont = [System.Drawing.Font]::new("Arial", 18, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)

    try {
        $Graphics.FillRectangle($whiteBrush, $X, $Y, $tableWidth, $tableHeight)
        $Graphics.FillRectangle($headerBrush, $X, $Y, $tableWidth, $HeaderHeight)

        $columnX = $X
        foreach ($column in $Columns) {
            $rect = [System.Drawing.RectangleF]::new($columnX + 9, $Y + 4, $column.Width - 18, $HeaderHeight - 8)
            $Graphics.DrawString($column.Label, $headerFont, $textBrush, $rect)
            $columnX += $column.Width
        }

        for ($rowIndex = 0; $rowIndex -lt $Rows.Count; $rowIndex++) {
            $row = $Rows[$rowIndex]
            $rowY = $Y + $HeaderHeight + ($rowIndex * $RowHeight)
            $rowKey = [string]$row.id
            if ($RowColors.ContainsKey($rowKey)) {
                $rowBrush = New-Brush $RowColors[$rowKey]
                try { $Graphics.FillRectangle($rowBrush, $X, $rowY, $tableWidth, $RowHeight) }
                finally { $rowBrush.Dispose() }
            }

            $columnX = $X
            foreach ($column in $Columns) {
                $cellKey = "$rowKey`:$($column.Key)"
                if ($CellColors.ContainsKey($cellKey)) {
                    $cellBrush = New-Brush $CellColors[$cellKey]
                    try { $Graphics.FillRectangle($cellBrush, $columnX, $rowY, $column.Width, $RowHeight) }
                    finally { $cellBrush.Dispose() }
                }

                $value = [string]$row.($column.Key)
                $font = if ($column.Key -eq "address") { $addressFont } elseif ($column.Key -in @("id", "priority", "time_window_start", "time_window_end")) { $numberFont } else { $bodyFont }
                $brush = if ($column.Key -eq "address") { $mutedBrush } else { $textBrush }
                $format = [System.Drawing.StringFormat]::new()
                try {
                    $format.LineAlignment = [System.Drawing.StringAlignment]::Center
                    $format.Alignment = if ($column.Key -in @("id", "priority")) { [System.Drawing.StringAlignment]::Far } else { [System.Drawing.StringAlignment]::Near }
                    $format.Trimming = [System.Drawing.StringTrimming]::EllipsisCharacter
                    $rect = [System.Drawing.RectangleF]::new($columnX + 9, $rowY + 4, $column.Width - 18, $RowHeight - 8)
                    $Graphics.DrawString($value, $font, $brush, $rect, $format)
                }
                finally {
                    $format.Dispose()
                }
                $columnX += $column.Width
            }
        }

        for ($index = 0; $index -le $Rows.Count; $index++) {
            $lineY = $Y + $HeaderHeight + ($index * $RowHeight)
            $Graphics.DrawLine($gridPen, $X, $lineY, $X + $tableWidth, $lineY)
        }
        $columnX = $X
        $Graphics.DrawLine($gridPen, $columnX, $Y, $columnX, $Y + $tableHeight)
        foreach ($column in $Columns) {
            $columnX += $column.Width
            $Graphics.DrawLine($gridPen, $columnX, $Y, $columnX, $Y + $tableHeight)
        }
        $Graphics.DrawRectangle($outlinePen, $X, $Y, $tableWidth, $tableHeight)
    }
    finally {
        $whiteBrush.Dispose()
        $headerBrush.Dispose()
        $textBrush.Dispose()
        $mutedBrush.Dispose()
        $gridPen.Dispose()
        $outlinePen.Dispose()
        $headerFont.Dispose()
        $bodyFont.Dispose()
        $addressFont.Dispose()
        $numberFont.Dispose()
    }
}

function Draw-Slide {
    param(
        [string]$Filename,
        [string]$Title,
        [string]$Subtitle,
        [object[]]$LeftRows,
        [object[]]$LeftColumns,
        [object[]]$RightRows,
        [object[]]$RightColumns,
        [string]$LeftLabel,
        [string]$RightLabel,
        [hashtable]$LeftRowColors,
        [hashtable]$LeftCellColors,
        [hashtable]$RightRowColors,
        [hashtable]$RightCellColors,
        [string]$Legend
    )

    $bitmap = [System.Drawing.Bitmap]::new(1920, 1080, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $backgroundBrush = New-Brush "#0B1018"
    $gridPen = [System.Drawing.Pen]::new((New-Color "#18212D"), 1)
    $orangeBrush = New-Brush "#F59E0B"
    $whiteBrush = New-Brush "#F8FAFC"
    $mutedBrush = New-Brush "#64748B"
    $labelBrush = New-Brush "#94A3B8"
    $titleFont = [System.Drawing.Font]::new("Microsoft JhengHei", 54, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $eyebrowFont = [System.Drawing.Font]::new("Microsoft JhengHei", 28, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $subtitleFont = [System.Drawing.Font]::new("Microsoft JhengHei", 20, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
    $labelFont = [System.Drawing.Font]::new("Microsoft JhengHei", 36, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
    $legendFont = [System.Drawing.Font]::new("Microsoft JhengHei", 17, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)

    try {
        $graphics.Clear((New-Color "#0B1018"))
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
        for ($x = 80; $x -lt 1920; $x += 120) { $graphics.DrawLine($gridPen, $x, 0, $x, 1080) }
        for ($y = 70; $y -lt 1080; $y += 120) { $graphics.DrawLine($gridPen, 0, $y, 1920, $y) }
        $graphics.FillRectangle($orangeBrush, 66, 52, 8, 70)
        $graphics.DrawString("測資項目", $eyebrowFont, $orangeBrush, 88, 63)
        $graphics.DrawString($Title, $titleFont, $whiteBrush, 285, 38)
        $graphics.DrawString($Subtitle, $subtitleFont, $labelBrush, 90, 126)

        Draw-Table -Graphics $graphics -Rows $LeftRows -Columns $LeftColumns -X 55 -Y 180 -HeaderHeight 58 -RowHeight 64 -RowColors $LeftRowColors -CellColors $LeftCellColors -OutlineColor "#8B5CF6"
        Draw-Table -Graphics $graphics -Rows $RightRows -Columns $RightColumns -X 985 -Y 180 -HeaderHeight 58 -RowHeight 64 -RowColors $RightRowColors -CellColors $RightCellColors -OutlineColor "#CBD5E1"

        $leftLabelRect = [System.Drawing.RectangleF]::new(55, 900, 875, 54)
        $rightLabelRect = [System.Drawing.RectangleF]::new(985, 900, 880, 54)
        $centerFormat = [System.Drawing.StringFormat]::new()
        try {
            $centerFormat.Alignment = [System.Drawing.StringAlignment]::Center
            $graphics.DrawString($LeftLabel, $labelFont, $mutedBrush, $leftLabelRect, $centerFormat)
            $graphics.DrawString($RightLabel, $labelFont, $mutedBrush, $rightLabelRect, $centerFormat)
        }
        finally { $centerFormat.Dispose() }

        if (-not [string]::IsNullOrWhiteSpace($Legend)) {
            $graphics.DrawString($Legend, $legendFont, $labelBrush, 70, 1005)
        }
        $graphics.DrawString("TSPTW 測試報告", $legendFont, $labelBrush, 1670, 1005)

        $outputPath = Join-Path $OutputDirectory $Filename
        $bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
        [pscustomobject]@{ Output = $Filename; Width = 1920; Height = 1080 }
    }
    finally {
        $graphics.Dispose()
        $bitmap.Dispose()
        $backgroundBrush.Dispose()
        $gridPen.Dispose()
        $orangeBrush.Dispose()
        $whiteBrush.Dispose()
        $mutedBrush.Dispose()
        $labelBrush.Dispose()
        $titleFont.Dispose()
        $eyebrowFont.Dispose()
        $subtitleFont.Dispose()
        $labelFont.Dispose()
        $legendFont.Dispose()
    }
}

$d01 = Get-Scenario "D01"
$r01 = Get-Scenario "R01"
$d02 = Get-Scenario "D02"
$r03 = Get-Scenario "R03"

$normalLeftColumns = @(
    [pscustomobject]@{ Key = "id"; Label = "id"; Width = 55 },
    [pscustomobject]@{ Key = "name"; Label = "name"; Width = 210 },
    [pscustomobject]@{ Key = "address"; Label = "address"; Width = 310 },
    [pscustomobject]@{ Key = "time_window_start"; Label = "time_window_start"; Width = 150 },
    [pscustomobject]@{ Key = "time_window_end"; Label = "time_window_end"; Width = 150 }
)
$normalRightColumns = @(
    [pscustomobject]@{ Key = "id"; Label = "id"; Width = 55 },
    [pscustomobject]@{ Key = "name"; Label = "name"; Width = 220 },
    [pscustomobject]@{ Key = "address"; Label = "address"; Width = 305 },
    [pscustomobject]@{ Key = "time_window_start"; Label = "time_window_start"; Width = 150 },
    [pscustomobject]@{ Key = "time_window_end"; Label = "time_window_end"; Width = 150 }
)
$priorityColumns = @(
    [pscustomobject]@{ Key = "id"; Label = "id"; Width = 55 },
    [pscustomobject]@{ Key = "name"; Label = "name"; Width = 185 },
    [pscustomobject]@{ Key = "address"; Label = "address"; Width = 260 },
    [pscustomobject]@{ Key = "time_window_start"; Label = "time_window_start"; Width = 130 },
    [pscustomobject]@{ Key = "time_window_end"; Label = "time_window_end"; Width = 130 },
    [pscustomobject]@{ Key = "priority"; Label = "priority"; Width = 110 }
)

$emptyColors = @{}
Draw-Slide -Filename "測資對比_01_正常情況.png" -Title "正常情況" -Subtitle "D01 送貨基準與 R01 收貨基準；時間欄位統一使用 24 小時制" `
    -LeftRows $d01.rows -LeftColumns $normalLeftColumns -RightRows $r01.rows -RightColumns $normalRightColumns `
    -LeftLabel "送貨基準 D01" -RightLabel "收貨基準 R01" `
    -LeftRowColors @{} -LeftCellColors @{} -RightRowColors @{} -RightCellColors @{} -Legend "基準測資：未套用優先級、窄時間窗或不同服務時間。"

$priorityRows = @{}
$priorityRows["9"] = "#DDD6FE"
$priorityCells = @{}
foreach ($row in $d02.rows) {
    if ([int]$row.id -eq 9) { $priorityCells["9:priority"] = "#A78BFA" }
    elseif ([int]$row.id -ne 0) { $priorityCells["$($row.id):priority"] = "#FEF3C7" }
}
$windowCells = @{}
foreach ($row in $r03.rows) {
    $windowCells["$($row.id):time_window_start"] = "#BAE6FD"
    $windowCells["$($row.id):time_window_end"] = "#BAE6FD"
}
Draw-Slide -Filename "測資對比_02_調整測資參數.png" -Title "調整測資參數" -Subtitle "D02 調整優先級；R03 將收貨時段改為連續窄時間窗" `
    -LeftRows $d02.rows -LeftColumns $priorityColumns -RightRows $r03.rows -RightColumns $normalRightColumns `
    -LeftLabel "增加優先級 D02" -RightLabel "設定時間窗 R03" `
    -LeftRowColors $priorityRows -LeftCellColors $priorityCells -RightRowColors @{} -RightCellColors $windowCells `
    -Legend "紫色列＝優先級 1 客戶；黃色儲存格＝其他優先級調整；藍色儲存格＝新的時間窗。"
