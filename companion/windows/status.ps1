# status.ps1 - shows whether the Satchel companion is installed and can reach each AI provider.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'SatchelCommon.ps1')
foreach ($browserKey in @('HKCU:\Software\Google\Chrome\NativeMessagingHosts', 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts')) {
    $keyPath = Join-Path $browserKey $script:SatchelHostName
    if (Test-Path $keyPath) {
        $manifest = (Get-ItemProperty -Path $keyPath).'(default)'
        if ($manifest -and (Test-Path -LiteralPath $manifest)) { Write-Host "[ok] Registered: $keyPath" -ForegroundColor Green }
        else { Write-Host "[!!] $keyPath points to a missing file. Run install.cmd again." -ForegroundColor Red }
    } else { Write-Host "[--] Not registered: $keyPath (run install.cmd)" -ForegroundColor Yellow }
}
$lang = $ExecutionContext.SessionState.LanguageMode
if ($lang -ne 'FullLanguage') { Write-Host "[!!] PowerShell is in $lang mode (school IT policy); the companion may be blocked." -ForegroundColor Red }
foreach ($p in $script:SatchelProviders) {
    $label = Get-SatchelProviderLabel $p
    $key = Get-ProviderKey $p
    if (-not $key) {
        if ($p -eq 'groq') { Write-Host "[!!] No $label key stored. Run 'Satchel - Set Groq key' from the Start menu." -ForegroundColor Red }
        else { Write-Host "[--] No $label key stored (optional)." -ForegroundColor Gray }
        continue
    }
    Write-Host "[ok] $label key is stored (encrypted)." -ForegroundColor Green
    $r = Invoke-GroqRequest -Provider $p -Method 'GET' -Path '/models' -Key $key -TimeoutSec 20
    $key = $null
    if ($r.ok -and $r.status -eq 200) {
        $count = @((ConvertFrom-Json -InputObject $r.body).data).Count
        Write-Host "[ok] $label reachable ($count models available to your account)." -ForegroundColor Green
    } elseif ($r.ok) { Write-Host ("[!!] $label answered HTTP " + $r.status + ". If 401, set a new key.") -ForegroundColor Red }
    else { Write-Host ('[!!] ' + $r.error.message) -ForegroundColor Red }
}
