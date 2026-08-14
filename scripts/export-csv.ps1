# Exports the two source workbooks to CSV files ready for Supabase import.
#
#   inventory.csv    -> import into table  inventory_staging
#   master_data.csv  -> import into table  master_data_staging
#
# Then in the Supabase SQL editor run:
#   select swap_inventory(<row count printed below>);
#   select swap_master_data(<row count printed below>);
#
# Requires Excel installed (uses COM). Run:  .\scripts\export-csv.ps1

param(
  [string]$InventoryFile  = "D:\project\template querry upload.xlsm",
  [string]$MasterFile     = "D:\project\PFEP Simple Master Data_12 Aug 2026.xlsb",
  [string]$OutDir         = "D:\project\data"
)

$ErrorActionPreference = 'Stop'
$inv = [System.Globalization.CultureInfo]::InvariantCulture

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }

# --- value normalization -----------------------------------------------------

# Part numbers arrive as a MIX of Double and String. A double must render as
# "23588931", never "23588931.0" or "2.3588931E+07", or the join to master_data
# silently breaks. Text values keep their form (11559571-PMC, SM1367, 1261/1262).
function Norm($v) {
  if ($null -eq $v) { return '' }
  if ($v -is [double]) {
    if ([Math]::Floor($v) -eq $v -and [Math]::Abs($v) -lt 1e15) {
      return ([long]$v).ToString($inv)
    }
    return $v.ToString('R', $inv)
  }
  if ($v -is [bool]) { if ($v) { return 'Yes' } else { return 'No' } }
  return "$v".Trim()
}

# Timestamps in this export are text ("2026-01-11 19:10:32"), but handle real
# Excel date serials too in case a future file differs.
function NormDate($v) {
  if ($null -eq $v) { return '' }
  if ($v -is [double]) {
    try { return [DateTime]::FromOADate($v).ToString('yyyy-MM-dd HH:mm:ss', $inv) } catch { return '' }
  }
  return "$v".Trim()
}

function CsvEsc([string]$s) {
  if ($s -eq '') { return '' }
  if ($s.IndexOfAny([char[]]@(',', '"', "`r", "`n")) -ge 0) {
    return '"' + $s.Replace('"', '""') + '"'
  }
  return $s
}

function New-Writer([string]$path) {
  # UTF-8 with NO byte order mark - a BOM confuses some CSV importers.
  $enc = New-Object System.Text.UTF8Encoding($false)
  return New-Object System.IO.StreamWriter($path, $false, $enc)
}

# --- excel -------------------------------------------------------------------

$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false; $excel.DisplayAlerts = $false
$excel.AskToUpdateLinks = $false; $excel.AutomationSecurity = 3; $excel.EnableEvents = $false

$BLOCK = 20000   # read in blocks so a 195k-row sheet does not blow up memory

try {
  # ========================= INVENTORY =========================
  Write-Host "Reading inventory: $InventoryFile"
  $wb = $excel.Workbooks.Open($InventoryFile, 0, $true)
  $ws = $wb.Worksheets.Item('Sheet1')
  $last = $ws.UsedRange.Rows.Count
  $total = $last - 3
  Write-Host "  $total data rows (header row 3, data starts row 4)"

  $outInv = Join-Path $OutDir 'inventory.csv'
  $w = New-Writer $outInv
  $w.WriteLine('part_number,supplier_code,case_no,location,zone_type,quantity,status,is_case_opened,inbound_time,first_inbound_time')

  $written = 0
  for ($start = 4; $start -le $last; $start += $BLOCK) {
    $end = [Math]::Min($start + $BLOCK - 1, $last)
    # columns 1..10 only; 11 (Zonetype 1) and 12 (Area) are Excel formulas - ignored,
    # the app recomputes them via calc_zonetype/calc_area.
    $blk = $ws.Range($ws.Cells($start,1), $ws.Cells($end,10)).Value2
    $rows = $end - $start + 1
    $sb = New-Object System.Text.StringBuilder

    for ($r = 1; $r -le $rows; $r++) {
      $pn = Norm $blk.GetValue($r,1)
      if ($pn -eq '') { continue }   # skip stray blank rows

      $fields = @(
        (CsvEsc $pn),
        (CsvEsc (Norm     $blk.GetValue($r,2))),
        (CsvEsc (Norm     $blk.GetValue($r,3))),
        (CsvEsc (Norm     $blk.GetValue($r,4))),
        (CsvEsc (Norm     $blk.GetValue($r,5))),
        (CsvEsc (Norm     $blk.GetValue($r,6))),
        (CsvEsc (Norm     $blk.GetValue($r,7))),
        (CsvEsc (Norm     $blk.GetValue($r,8))),
        (CsvEsc (NormDate $blk.GetValue($r,9))),
        (CsvEsc (NormDate $blk.GetValue($r,10)))
      )
      [void]$sb.AppendLine($fields -join ',')
      $written++
    }
    $w.Write($sb.ToString())
    Write-Host ("  ...{0:N0} / {1:N0}" -f ($end - 3), $total)
  }
  $w.Flush(); $w.Close()
  $wb.Close($false); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($wb)
  Write-Host ("  WROTE {0}  ({1:N0} rows)" -f $outInv, $written) -ForegroundColor Green
  $invRows = $written

  # ========================= MASTER DATA =========================
  Write-Host ""
  Write-Host "Reading master data: $MasterFile"
  $wb2 = $excel.Workbooks.Open($MasterFile, 0, $true)
  $ws2 = $wb2.Worksheets.Item('MASDAT')
  $last2 = $ws2.UsedRange.Rows.Count
  $total2 = $last2 - 3
  Write-Host "  $total2 data rows"

  # 0-based indices from the brief -> Excel columns:
  #   idx 1 -> col 2  PART NUMBER
  #   idx 6 -> col 7  PART NAME
  #   idx 9 -> col 10 NEW DLOC   (idx 8 / col 9 is OLD DLOC - ignored)
  #   idx 42 -> col 43 Car Type
  $blk2 = $ws2.Range($ws2.Cells(4,1), $ws2.Cells($last2,43)).Value2

  $outMst = Join-Path $OutDir 'master_data.csv'
  $w2 = New-Writer $outMst
  $w2.WriteLine('part_number,part_name,car_type,dloc')

  $seen = @{}
  $dupes = 0
  $sb2 = New-Object System.Text.StringBuilder
  for ($r = 1; $r -le $total2; $r++) {
    $pn = Norm $blk2.GetValue($r,2)
    if ($pn -eq '') { continue }
    if ($seen.ContainsKey($pn)) { $dupes++; continue }   # de-dup: keep first
    $seen[$pn] = $true

    $fields = @(
      (CsvEsc $pn),
      (CsvEsc (Norm $blk2.GetValue($r,7))),
      (CsvEsc (Norm $blk2.GetValue($r,43))),
      (CsvEsc (Norm $blk2.GetValue($r,10)))
    )
    [void]$sb2.AppendLine($fields -join ',')
  }
  $w2.Write($sb2.ToString())
  $w2.Flush(); $w2.Close()
  $wb2.Close($false); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($wb2)
  Write-Host ("  WROTE {0}  ({1:N0} rows, {2:N0} duplicates skipped)" -f $outMst, $seen.Count, $dupes) -ForegroundColor Green

  Write-Host ""
  Write-Host "=============================================================" -ForegroundColor Cyan
  Write-Host " NEXT STEPS in Supabase" -ForegroundColor Cyan
  Write-Host "=============================================================" -ForegroundColor Cyan
  Write-Host " 1. Table Editor -> inventory_staging   -> Import data from CSV -> data\inventory.csv"
  Write-Host " 2. Table Editor -> master_data_staging -> Import data from CSV -> data\master_data.csv"
  Write-Host " 3. SQL Editor, run:"
  Write-Host ("      select swap_inventory({0});" -f $invRows) -ForegroundColor Yellow
  Write-Host ("      select swap_master_data({0});" -f $seen.Count) -ForegroundColor Yellow
  Write-Host ""
  Write-Host " Each returns the row count it moved. If a count does not match,"
  Write-Host " the swap refuses and your live tables are left untouched."
}
finally {
  $excel.Quit(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($excel)
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
}
