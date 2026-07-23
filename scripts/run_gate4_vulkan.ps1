# TriWorld V4 Gate 4 — One-Click Vulkan Runtime Test & Visual Verification Script

$LevelName = "triworld_v4_gate4_roadmesh1"
$ArtifactsDir = Join-Path $PSScriptRoot "..\artifacts\gate4-runtime-verification"
New-Item -ItemType Directory -Force -Path $ArtifactsDir | Out-Null

$UserModPath = Join-Path $env:LOCALAPPDATA "BeamNG\BeamNG.drive\current\mods\$LevelName.zip"
$BeamNgLogPath = Join-Path $env:LOCALAPPDATA "BeamNG\BeamNG.drive\current\beamng.log"

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " TRIWORLD V4 GATE 4 -- VULKAN RUNTIME TEST AND LOG AUDIT" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "Target Level: $LevelName"
Write-Host "Mod Location: $UserModPath"

if (-not (Test-Path $UserModPath)) {
    Write-Host "ERROR: Installed mod ZIP not found at $UserModPath!" -ForegroundColor Red
    exit 1
}

$ZipHash = (Get-FileHash $UserModPath -Algorithm SHA256).Hash
Write-Host "Mod ZIP SHA-256: $ZipHash" -ForegroundColor Green

Write-Host ""
Write-Host "Instructions for Visual Verification:" -ForegroundColor Yellow
Write-Host "1. Launch BeamNG.drive in Vulkan mode." -ForegroundColor Yellow
Write-Host "2. Load level: 'TriWorld V4 Native Gate 4 -- Road Surface Mesh V3'" -ForegroundColor Yellow
Write-Host "3. Verify in-game:" -ForegroundColor Yellow
Write-Host "   - Visible dark charcoal asphalt road mesh with physical collision" -ForegroundColor Yellow
Write-Host "   - Vehicle tires contact the road surface cleanly" -ForegroundColor Yellow
Write-Host "   - No z-fighting, floating road, or terrain penetration" -ForegroundColor Yellow
Write-Host "4. Save screenshots to:" -ForegroundColor Yellow
Write-Host "   $ArtifactsDir" -ForegroundColor Yellow

if (Test-Path $BeamNgLogPath) {
    Write-Host ""
    Write-Host "Scanning previous BeamNG log for potential errors..." -ForegroundColor Cyan
    $LogContent = Get-Content $BeamNgLogPath -ErrorAction SilentlyContinue
    $Errors = $LogContent | Select-String -Pattern "error|failed|Vulkan|TSStatic|material|texture"
    if ($Errors) {
        Write-Host "Found $($Errors.Count) relevant log entries:" -ForegroundColor Gray
        $Errors | Select-Object -First 10 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
    } else {
        Write-Host "No recent error entries detected in beamng.log." -ForegroundColor Green
    }
}
