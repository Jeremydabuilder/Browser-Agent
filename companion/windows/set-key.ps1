# set-key.ps1 - store or replace an AI provider API key (encrypted with Windows DPAPI for your account).
#   set-key.ps1                    asks which provider
#   set-key.ps1 -Provider groq     Groq key (default provider)
#   set-key.ps1 -Provider openai   OpenAI key (optional)
param([string]$Provider = '', [switch]$NoPause)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'SatchelCommon.ps1')

if (-not $Provider) {
    $answer = Read-Host 'Which key do you want to set? Type G for Groq (default) or O for OpenAI'
    if ($answer -match '^[oO]') { $Provider = 'openai' } else { $Provider = 'groq' }
}
$Provider = $Provider.ToLower()
if (-not (Test-SatchelProvider $Provider)) { Write-Host 'Unknown provider. Use groq or openai.' -ForegroundColor Red; exit 1 }
$label = Get-SatchelProviderLabel $Provider
$keyUrl = 'https://console.groq.com/keys'
$prefix = 'gsk_'
if ($Provider -eq 'openai') { $keyUrl = 'https://platform.openai.com/api-keys'; $prefix = 'sk-' }

Write-Host "Set your $label API key" -ForegroundColor Green
Write-Host "Get a key at $keyUrl (sign in, then create a new secret key)."
if ($Provider -eq 'openai') { Write-Host 'OpenAI charges for every request. Satchel shows cost estimates and has a spending guard in Settings.' -ForegroundColor Yellow }
Write-Host 'Paste it below and press Enter. The characters are hidden on purpose.'
for ($attempt = 1; $attempt -le 3; $attempt++) {
    $secure = Read-Host "$label API key" -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    $plain = $plain.Trim()
    if (-not $plain) { Write-Host 'Nothing was entered.' -ForegroundColor Yellow; continue }
    if (-not $plain.StartsWith($prefix)) { Write-Host "Note: $label keys usually start with ""$prefix"". Checking it anyway..." -ForegroundColor Yellow }
    Write-Host "Checking the key with $label..."
    $result = Invoke-GroqRequest -Provider $Provider -Method 'GET' -Path '/models' -Key $plain -TimeoutSec 20
    if ($result.ok -and $result.status -eq 200) {
        Save-ProviderKey $Provider $plain
        $plain = $null
        Write-Host "$label key verified and saved (encrypted for your Windows account)." -ForegroundColor Green
        return
    }
    if ($result.ok -and $result.status -eq 401) {
        Write-Host "$label rejected this key (401). Please copy it again." -ForegroundColor Red
        continue
    }
    $why = 'unknown error'
    if (-not $result.ok) { $why = $result.error.message } else { $why = 'HTTP ' + $result.status }
    $answer = Read-Host "Could not verify the key right now ($why). Save it anyway? (y/N)"
    if ($answer -match '^[yY]') { Save-ProviderKey $Provider $plain; $plain = $null; Write-Host 'Key saved (encrypted).' -ForegroundColor Green; return }
}
Write-Host 'No key was saved.' -ForegroundColor Red
