# satchel-host.ps1 - Chrome/Edge native messaging host for Satchel.
# The browser starts this process on demand (via satchel-host.bat), sends ONE JSON message on
# stdin using the native messaging framing (4-byte little-endian length + UTF-8 JSON), and reads
# ONE framed JSON reply from stdout. Nothing else may be written to stdout.
#
# Supported requests (anything else is rejected):
#   { "type": "ping" }
#   { "type": "models" }
#   { "type": "chat", "bodyJson": "<OpenAI-compatible chat completion request>", "timeoutSec": 60 }

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'SatchelCommon.ps1')

$MaxRequestBytes = 8MB

function Read-Exact([IO.Stream]$Stream, [int]$Count) {
    $buf = New-Object byte[] $Count
    $read = 0
    while ($read -lt $Count) {
        $n = $Stream.Read($buf, $read, $Count - $read)
        if ($n -le 0) { return $null }
        $read += $n
    }
    return ,$buf
}

function Read-NativeMessage([IO.Stream]$Stream) {
    $lenBytes = Read-Exact $Stream 4
    if ($null -eq $lenBytes) { return $null }
    $len = [BitConverter]::ToInt32($lenBytes, 0)
    if ($len -le 0 -or $len -gt $MaxRequestBytes) { throw 'bad_length' }
    $payload = Read-Exact $Stream $len
    if ($null -eq $payload) { return $null }
    return [Text.Encoding]::UTF8.GetString($payload)
}

function Write-NativeMessage([IO.Stream]$Stream, $Object) {
    $json = ConvertTo-Json -InputObject $Object -Depth 8 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    if ($bytes.Length -gt 1000000) {
        $json = ConvertTo-Json -InputObject ([ordered]@{ ok = $false; error = [ordered]@{ code = 'response_too_large'; message = 'The AI response was too large to return.' } }) -Compress
        $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    }
    $Stream.Write([BitConverter]::GetBytes([int]$bytes.Length), 0, 4)
    $Stream.Write($bytes, 0, $bytes.Length)
    $Stream.Flush()
}

function Get-ErrorReply([string]$Code, [string]$Message) {
    return [ordered]@{ ok = $false; error = [ordered]@{ code = $Code; message = $Message } }
}

function Invoke-SatchelRequest($Request) {
    $type = [string]$Request.type
    switch ($type) {
        'ping' {
            $hasKey = Test-Path -LiteralPath (Get-SatchelKeyPath)
            return [ordered]@{ ok = $true; version = $script:SatchelVersion; hasKey = $hasKey; keyStore = (Get-SatchelKeyStoreKind) }
        }
        'models' {
            $key = Get-GroqKey
            if (-not $key) { return (Get-ErrorReply 'no_key' 'No Groq API key is stored yet. Run "Set Groq key" from the Satchel companion folder.') }
            return (Invoke-GroqRequest -Method 'GET' -Path '/models' -Key $key -TimeoutSec 20)
        }
        'chat' {
            $body = [string]$Request.bodyJson
            if ([string]::IsNullOrWhiteSpace($body)) { return (Get-ErrorReply 'bad_request' 'Missing request body.') }
            # Validate that the body is JSON with a model and messages; the key is never part of it.
            try { $parsed = ConvertFrom-Json -InputObject $body } catch { return (Get-ErrorReply 'bad_request' 'Request body is not valid JSON.') }
            if (-not $parsed.model -or -not $parsed.messages) { return (Get-ErrorReply 'bad_request' 'Request must include model and messages.') }
            $key = Get-GroqKey
            if (-not $key) { return (Get-ErrorReply 'no_key' 'No Groq API key is stored yet. Run "Set Groq key" from the Satchel companion folder.') }
            $timeout = 60
            if ($Request.timeoutSec) { $timeout = [int]$Request.timeoutSec }
            return (Invoke-GroqRequest -Method 'POST' -Path '/chat/completions' -Body $body -Key $key -TimeoutSec $timeout)
        }
        default { return (Get-ErrorReply 'unsupported' "Unsupported request type.") }
    }
}

# Defense in depth: the browser passes the caller's origin as the first argument.
$callerOrigin = $null
if ($args.Count -gt 0) { $callerOrigin = [string]$args[0] }
$allowedOrigin = 'chrome-extension://' + $script:SatchelExtensionId + '/'
if ($env:SATCHEL_ALLOWED_ORIGIN) { $allowedOrigin = $env:SATCHEL_ALLOWED_ORIGIN }

$stdin = [Console]::OpenStandardInput()
$stdout = [Console]::OpenStandardOutput()
try {
    $text = Read-NativeMessage $stdin
    if ($null -eq $text) { exit 0 }
    if ($callerOrigin -and $callerOrigin.StartsWith('chrome-extension://') -and $callerOrigin -ne $allowedOrigin) {
        Write-NativeMessage $stdout (Get-ErrorReply 'forbidden' 'This companion only serves the Satchel extension.')
        exit 0
    }
    $request = ConvertFrom-Json -InputObject $text
    $reply = Invoke-SatchelRequest $request
    Write-NativeMessage $stdout $reply
} catch {
    Write-SatchelErrorLog 'internal'
    try { Write-NativeMessage $stdout (Get-ErrorReply 'internal' 'The Satchel companion hit an unexpected error.') } catch { }
}
exit 0
