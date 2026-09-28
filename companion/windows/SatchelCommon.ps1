# SatchelCommon.ps1 - shared helpers for the Satchel companion.
# Compatible with Windows PowerShell 5.1 (built into Windows 10/11) and PowerShell 7.
# SECURITY: never write the API key to stdout, logs, or any unencrypted file on Windows.

$script:SatchelVersion = '1.0.0'
$script:SatchelHostName = 'com.satchel.companion'
$script:SatchelExtensionId = 'enhkjfoecodefiigkephlalmoebbfgmb'
# Extra entropy mixed into DPAPI so other programs can't trivially reuse the blob.
$script:SatchelEntropy = [Text.Encoding]::UTF8.GetBytes('Satchel companion v1 key protection')

function Test-SatchelOnWindows {
    return ($env:OS -eq 'Windows_NT')
}

function Get-SatchelDataDir {
    if ($env:SATCHEL_DATA_DIR) { $dir = $env:SATCHEL_DATA_DIR }
    elseif (Test-SatchelOnWindows) { $dir = Join-Path $env:LOCALAPPDATA 'Satchel' }
    else { $dir = Join-Path $HOME '.config/satchel-dev' }
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    return $dir
}

function Get-SatchelKeyPath {
    if (Test-SatchelOnWindows) { return (Join-Path (Get-SatchelDataDir) 'groq-key.dat') }
    return (Join-Path (Get-SatchelDataDir) 'groq-key.dev.txt')
}

function Get-SatchelKeyStoreKind {
    if (Test-SatchelOnWindows) { return 'windows-dpapi' }
    return 'dev-plaintext-file'
}

function Get-GroqBaseUrl {
    # SATCHEL_GROQ_BASE_URL exists ONLY for automated tests against a local fake server.
    if ($env:SATCHEL_GROQ_BASE_URL) { return $env:SATCHEL_GROQ_BASE_URL.TrimEnd('/') }
    return 'https://api.groq.com/openai/v1'
}

function Initialize-SatchelDpapi {
    try { Add-Type -AssemblyName System.Security -ErrorAction Stop } catch { }
}

function Save-GroqKey([string]$Key) {
    $Key = $Key.Trim()
    if ([string]::IsNullOrWhiteSpace($Key)) { throw 'The key is empty.' }
    $path = Get-SatchelKeyPath
    $bytes = [Text.Encoding]::UTF8.GetBytes($Key)
    if (Test-SatchelOnWindows) {
        Initialize-SatchelDpapi
        $enc = [Security.Cryptography.ProtectedData]::Protect($bytes, $script:SatchelEntropy,
            [Security.Cryptography.DataProtectionScope]::CurrentUser)
        [IO.File]::WriteAllBytes($path, $enc)
    } else {
        # Development/testing only (Linux/macOS). Not used on Windows.
        [IO.File]::WriteAllBytes($path, $bytes)
        try { & chmod 600 $path 2>$null } catch { }
    }
    [Array]::Clear($bytes, 0, $bytes.Length)
}

function Get-GroqKey {
    $path = Get-SatchelKeyPath
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    $raw = [IO.File]::ReadAllBytes($path)
    if (Test-SatchelOnWindows) {
        Initialize-SatchelDpapi
        $plain = [Security.Cryptography.ProtectedData]::Unprotect($raw, $script:SatchelEntropy,
            [Security.Cryptography.DataProtectionScope]::CurrentUser)
        $key = [Text.Encoding]::UTF8.GetString($plain)
        [Array]::Clear($plain, 0, $plain.Length)
        return $key
    }
    return ([Text.Encoding]::UTF8.GetString($raw)).Trim()
}

function Remove-GroqKey {
    $path = Get-SatchelKeyPath
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
}

function Write-SatchelErrorLog([string]$Code) {
    # Only error codes and timestamps are logged - never prompts, page text, email, or keys.
    try {
        $log = Join-Path (Get-SatchelDataDir) 'companion-errors.log'
        if ((Test-Path -LiteralPath $log) -and ((Get-Item -LiteralPath $log).Length -gt 200KB)) { Remove-Item -LiteralPath $log -Force }
        Add-Content -LiteralPath $log -Value ((Get-Date).ToString('s') + ' ' + $Code)
    } catch { }
}

function Initialize-SatchelHttp {
    try { Add-Type -AssemblyName System.Net.Http -ErrorAction Stop } catch { }
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    } catch { }
}

# Sends one HTTP request to Groq. Returns a hashtable safe to hand back to the extension
# (status, body text, retry-after). Throws nothing; failures become error codes.
function Invoke-GroqRequest {
    param(
        [string]$Method,
        [string]$Path,
        [string]$Body,
        [int]$TimeoutSec = 60,
        [string]$Key
    )
    Initialize-SatchelHttp
    if ($TimeoutSec -lt 5) { $TimeoutSec = 5 }
    if ($TimeoutSec -gt 180) { $TimeoutSec = 180 }
    $client = $null
    try {
        $handler = New-Object System.Net.Http.HttpClientHandler
        $client = New-Object System.Net.Http.HttpClient($handler)
        $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSec)
        $httpMethod = New-Object System.Net.Http.HttpMethod($Method)
        $req = New-Object System.Net.Http.HttpRequestMessage($httpMethod, ((Get-GroqBaseUrl) + $Path))
        $req.Headers.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue('Bearer', $Key)
        $req.Headers.Add('User-Agent', 'Satchel-Companion/' + $script:SatchelVersion)
        if ($Body) {
            $req.Content = New-Object System.Net.Http.StringContent($Body, [Text.Encoding]::UTF8, 'application/json')
        }
        $resp = $client.SendAsync($req).GetAwaiter().GetResult()
        $text = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        $retryAfter = $null
        $values = $null
        if ($resp.Headers.TryGetValues('retry-after', [ref]$values)) { $retryAfter = ($values | Select-Object -First 1) }
        return [ordered]@{ ok = $true; status = [int]$resp.StatusCode; retryAfter = $retryAfter; body = $text }
    } catch {
        $ex = $_.Exception
        while ($ex.InnerException -and -not ($ex -is [System.Threading.Tasks.TaskCanceledException])) { $ex = $ex.InnerException }
        if ($ex -is [System.Threading.Tasks.TaskCanceledException] -or $ex -is [System.OperationCanceledException] -or $ex -is [TimeoutException]) {
            Write-SatchelErrorLog 'timeout'
            return [ordered]@{ ok = $false; error = [ordered]@{ code = 'timeout'; message = "Groq did not respond within $TimeoutSec seconds." } }
        }
        Write-SatchelErrorLog 'network'
        return [ordered]@{ ok = $false; error = [ordered]@{ code = 'network'; message = 'Could not reach Groq. Check your internet connection (some school networks block AI services).' } }
    } finally {
        if ($client) { $client.Dispose() }
    }
}
