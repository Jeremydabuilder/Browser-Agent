# status.ps1 - shows whether the Satchel companion is installed and can reach Groq.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'SatchelCommon.ps1')
$ok = $true
foreach ($browserKey in @('HKCU:\Software\Google\Chrome\NativeMessagingHosts', 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts')) {
    $keyPath = Join-Path $browserKey $script:SatchelHostName
    if (Test-Path $keyPath) {
        $manifest = (Get-ItemProperty -Path $keyPath).'(default)'
        if ($manifest -and (Test-Path -LiteralPath $manifest)) { Write-Host "[ok] Registered: $keyPath" -ForegroundColor Green }
        else { Write-Host "[!!] $keyPath points to a missing file. Run install.cmd again." -ForegroundColor Red; $ok = $false }
    } else { Write-Host "[--] Not registered: $keyPath (run install.cmd)" -ForegroundColor Yellow; $ok = $false }
}
$key = Get-GroqKey
if (-not $key) { Write-Host '[!!] No Groq key stored. Run set-key.cmd.' -ForegroundColor Red; exit 1 }
Write-Host '[ok] Groq key is stored (encrypted).' -ForegroundColor Green
$r = Invoke-GroqRequest -Method 'GET' -Path '/models' -Key $key -TimeoutSec 20
$key = $null
if ($r.ok -and $r.status -eq 200) {
    $models = (ConvertFrom-Json -InputObject $r.body).data | Where-Object { $_.active -ne $false } | ForEach-Object { $_.id } | Sort-Object
    Write-Host ('[ok] Groq reachable. Models available to you: ' + ($models -join ', ')) -ForegroundColor Green
} elseif ($r.ok) { Write-Host ('[!!] Groq answered HTTP ' + $r.status + '. If 401, run set-key.cmd with a new key.') -ForegroundColor Red }
else { Write-Host ('[!!] ' + $r.error.message) -ForegroundColor Red }
