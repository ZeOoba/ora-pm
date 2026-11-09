<#
.SYNOPSIS
  Stage tenant statements as Outlook DRAFTS from a packet downloaded from ora-pm (/statements →
  "Download Outlook draft packet", served by GET /api/statements/packet). NEVER sends.

.INVARIANT
  Hard Invariant 1: a tenant email is an external counterparty send and needs Gabriel's explicit
  in-turn confirmation. This script only creates drafts (MailItem.Save()); it has no send call.
  To send reviewed drafts, use the sanctioned path, interactively, after an in-turn yes:
    ~\.claude\scheduled-tasks\_shared\send-parked-drafts.ps1 -EntryId '<id1>','<id2>' -Confirm SEND
  Never run either from a scheduled/unattended task.

.USAGE
  # Validate only (no Outlook):
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\stage-statement-drafts.ps1 -Packet <file> -DryRun
  # Create drafts:
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\stage-statement-drafts.ps1 -Packet <file>

.BEHAVIOR
  - The whole packet is validated before any draft is created; one bad item stages nothing.
  - A draft already in the Drafts folder with the same To + Subject is skipped (re-run safe).
  - Output carries lease ids and Outlook EntryIDs only — never names, addresses or amounts — so
    the console/transcript holds no tenant PII. Delete the packet file when done; it does.
  Exit 0 = ok. Exit 2 = Outlook COM unavailable. Exit 3 = packet missing or invalid (nothing staged).
#>
param(
  [Parameter(Mandatory = $true)][string]$Packet,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

function Fail([string]$msg) { Write-Output "INVALID $msg"; exit 3 }

if (-not (Test-Path -LiteralPath $Packet -PathType Leaf)) { Fail 'packet file not found' }
try {
  $doc = Get-Content -LiteralPath $Packet -Raw -Encoding UTF8 | ConvertFrom-Json
} catch { Fail 'packet is not valid JSON' }

if ($doc.version -ne 1) { Fail 'unsupported packet version' }
$items = @($doc.items)
if ($null -eq $doc.items) { Fail 'packet has no items array' }

# One plain address: exactly one '@', a dot in the domain, no separators/whitespace/brackets.
$emailRe = '^[^@\s;,<>"]+@[^@\s;,<>"]+\.[^@\s;,<>"]+$'
$i = 0
foreach ($it in $items) {
  $i++
  if (-not ($it.lease_id -is [string]) -or $it.lease_id.Trim() -eq '') { Fail "item $i has no lease_id" }
  if (-not ($it.to -is [string]) -or $it.to -notmatch $emailRe) { Fail "item $i (lease $($it.lease_id)) has an invalid recipient" }
  if (-not ($it.subject -is [string]) -or $it.subject.Trim() -eq '' -or $it.subject -match '[\r\n]') { Fail "item $i (lease $($it.lease_id)) has an invalid subject" }
  if (-not ($it.html -is [string]) -or $it.html.Trim() -eq '') { Fail "item $i (lease $($it.lease_id)) has an empty body" }
}
Write-Output "VALID $($items.Count) items"

if ($DryRun) {
  foreach ($it in $items) { Write-Output "WOULD-STAGE lease=$($it.lease_id)" }
  exit 0
}

try {
  $ol = New-Object -ComObject Outlook.Application
  $drafts = $ol.GetNamespace('MAPI').GetDefaultFolder(16) # olFolderDrafts
} catch { Write-Output 'NO_COM'; exit 2 }

$existing = @{}
foreach ($d in $drafts.Items) {
  try { if ($d.Class -eq 43) { $existing[("{0}|{1}" -f ([string]$d.To).Trim().ToLower(), [string]$d.Subject)] = $true } } catch {}
}

$staged = 0
foreach ($it in $items) {
  $key = "{0}|{1}" -f $it.to.Trim().ToLower(), $it.subject
  if ($existing.ContainsKey($key)) { Write-Output "SKIP-EXISTING lease=$($it.lease_id)"; continue }
  $mail = $ol.CreateItem(0) # olMailItem
  $mail.To = $it.to.Trim()
  $mail.Subject = $it.subject
  $mail.HTMLBody = $it.html
  $mail.Save()
  $existing[$key] = $true
  $staged++
  Write-Output "STAGED lease=$($it.lease_id) EntryID=$($mail.EntryID)"
}
Write-Output "DONE staged=$staged. Review the drafts in Outlook. Nothing was sent."
exit 0
