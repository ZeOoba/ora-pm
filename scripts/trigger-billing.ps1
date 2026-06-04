# Trigger monthly billing — run on 1st of month
# Usage: .\trigger-billing.ps1 [-Secret "your-secret"] [-BaseUrl "https://pm.oxfordra.net"]
param(
  [string]$Secret  = $env:ORA_PM_CRON_SECRET,
  [string]$BaseUrl = "https://ora-pm.pages.dev"
)

$year  = (Get-Date).Year
$month = (Get-Date).Month
$url   = "$BaseUrl/api/cron/monthly-billing?year=$year&month=$month"

try {
  $response = Invoke-RestMethod -Method POST -Uri $url `
    -Headers @{ Authorization = "Bearer $Secret" } `
    -ContentType "application/json"
  Write-Host "Billing triggered: posted=$($response.posted) skipped=$($response.skipped) errors=$($response.errors)"
  if ($response.errors -gt 0) {
    Write-Warning "Errors: $($response.errorMessages -join ', ')"
  }
} catch {
  Write-Error "Billing trigger failed: $_"
  exit 1
}
