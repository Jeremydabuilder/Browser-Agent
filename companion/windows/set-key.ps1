# set-key.ps1 - store or replace your Groq API key (encrypted with Windows DPAPI for your account).
param([switch]$NoPause)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'SatchelCommon.ps1')

Write-Host 'Get a key at https://console.groq.com/keys (sign in, then "Create API Key").'
Write-Host 'Paste it below and press Enter. The characters are hidden on purpose.'
for ($attempt = 1; $attempt -le 3; $attempt++) {
    $secure = Read-Host 'Groq API key' -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    $plain = $plain.Trim()
    if (-not $plain) { Write-Host 'Nothing was entered.' -ForegroundColor Yellow; continue }
    if (-not $plain.StartsWith('gsk_')) { Write-Host 'Note: Groq keys usually start with "gsk_". Checking it anyway...' -ForegroundColor Yellow }
    Write-Host 'Checking the key with Groq...'
    $result = Invoke-GroqRequest -Method 'GET' -Path '/models' -Key $plain -TimeoutSec 20
    if ($result.ok -and $result.status -eq 200) {
        Save-GroqKey $plain
        $plain = $null
        Write-Host 'Key verified and saved (encrypted).' -ForegroundColor Green
        return
    }
    if ($result.ok -and $result.status -eq 401) {
        Write-Host 'Groq rejected this key (401). Please copy it again.' -ForegroundColor Red
        continue
    }
    $why = 'unknown error'
    if (-not $result.ok) { $why = $result.error.message } else { $why = 'HTTP ' + $result.status }
    $answer = Read-Host "Could not verify the key right now ($why). Save it anyway? (y/N)"
    if ($answer -match '^[yY]') { Save-GroqKey $plain; $plain = $null; Write-Host 'Key saved (encrypted).' -ForegroundColor Green; return }
}
Write-Host 'No key was saved.' -ForegroundColor Red
