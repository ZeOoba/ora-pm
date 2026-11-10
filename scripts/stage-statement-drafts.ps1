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
  - Each draft carries a hidden named MAPI string property OraStatementKey = <lease_id>|<start>|<end>,
    set through PropertyAccessor (PS_PUBLIC_STRINGS). NOT MailItem.UserProperties: a custom user
    property can make Outlook send the message as TNEF, so non-Outlook tenants would receive a
    winmail.dat instead of the statement (REFUTE round 2, 2026-11-09).
    A draft already in the Drafts folder with that key is skipped, so a re-run never duplicates
    one. The key is per LEASE, not per To+Subject: two leases on one suite (an expired lease with
    a balance plus its renewal) share To and Subject and must both be staged (REFUTE 2026-11-09).
    A skipped draft keeps its OLD figures — after a ledger correction, delete it and re-run.
    Only the Drafts folder is checked: re-running a packet after its drafts were SENT stages them
    again (nothing is sent; delete the duplicates). Download a fresh packet for each run.
  - Two items with the same key in one packet are refused (nothing staged).
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
$isoRe = '^\d{4}-\d{2}-\d{2}$'
if (-not ($doc.start -is [string]) -or $doc.start -notmatch $isoRe -or -not ($doc.end -is [string]) -or $doc.end -notmatch $isoRe) { Fail 'packet has no valid start/end period' }
function KeyOf($it) { return "{0}|{1}|{2}" -f $it.lease_id.Trim(), $doc.start, $doc.end }

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
$seen = @{}
foreach ($it in $items) {
  $k = KeyOf $it
  if ($seen.ContainsKey($k)) { Fail "lease $($it.lease_id) appears twice in the packet" }
  $seen[$k] = $true
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

# Named string property in PS_PUBLIC_STRINGS. GetProperty throws when a draft lacks it.
$PROP = 'http://schemas.microsoft.com/mapi/string/{00020329-0000-0000-C000-000000000046}/OraStatementKey'
$existing = @{}
foreach ($d in $drafts.Items) {
  try {
    if ($d.Class -ne 43) { continue }
    $v = $d.PropertyAccessor.GetProperty($PROP)
    if ($v) { $existing[[string]$v] = $true }
  } catch {}
}

$staged = 0
foreach ($it in $items) {
  $key = KeyOf $it
  if ($existing.ContainsKey($key)) { Write-Output "SKIP-EXISTING lease=$($it.lease_id) (draft for this lease and period already exists; delete it to restage)"; continue }
  $mail = $ol.CreateItem(0) # olMailItem
  $mail.To = $it.to.Trim()
  $mail.Subject = $it.subject
  $mail.HTMLBody = $it.html
  $mail.PropertyAccessor.SetProperty($PROP, $key)
  $mail.Save()
  $existing[$key] = $true
  $staged++
  Write-Output "STAGED lease=$($it.lease_id) EntryID=$($mail.EntryID)"
}
Write-Output "DONE staged=$staged. Review the drafts in Outlook. Nothing was sent."
exit 0
