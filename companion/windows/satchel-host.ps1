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

# Large enough for one 25 MB audio chunk encoded as base64 (transcription requests).
$MaxRequestBytes = 40MB
$MaxAudioBytes = 25MB

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

function Get-NoKeyReply([string]$Provider) {
    $label = Get-SatchelProviderLabel $Provider
    return (Get-ErrorReply 'no_key' ("No $label API key is stored yet. Open the Start menu and run 'Satchel - Set $label key' (or run set-key.cmd in the companion folder)."))
}

function Invoke-SatchelRequest($Request) {
    $type = [string]$Request.type
    $provider = 'groq'
    if ($Request.provider) { $provider = [string]$Request.provider }
    if (-not (Test-SatchelProvider $provider)) { return (Get-ErrorReply 'bad_request' 'Unknown AI provider.') }
    switch ($type) {
        'ping' {
            $keys = [ordered]@{}
            foreach ($p in $script:SatchelProviders) { $keys[$p] = (Test-Path -LiteralPath (Get-SatchelKeyPath $p)) }
            return [ordered]@{ ok = $true; version = $script:SatchelVersion; hasKey = $keys['groq']; keys = $keys; keyStore = (Get-SatchelKeyStoreKind) }
        }
        'models' {
            $key = Get-ProviderKey $provider
            if (-not $key) { return (Get-NoKeyReply $provider) }
            return (Invoke-GroqRequest -Provider $provider -Method 'GET' -Path '/models' -Key $key -TimeoutSec 20)
        }
        'chat' {
            $body = [string]$Request.bodyJson
            if ([string]::IsNullOrWhiteSpace($body)) { return (Get-ErrorReply 'bad_request' 'Missing request body.') }
            # Validate that the body is JSON with a model and messages; the key is never part of it.
            try { $parsed = ConvertFrom-Json -InputObject $body } catch { return (Get-ErrorReply 'bad_request' 'Request body is not valid JSON.') }
            if (-not $parsed.model -or -not $parsed.messages) { return (Get-ErrorReply 'bad_request' 'Request must include model and messages.') }
            $key = Get-ProviderKey $provider
            if (-not $key) { return (Get-NoKeyReply $provider) }
            $timeout = 60
            if ($Request.timeoutSec) { $timeout = [int]$Request.timeoutSec }
            return (Invoke-GroqRequest -Provider $provider -Method 'POST' -Path '/chat/completions' -Body $body -Key $key -TimeoutSec $timeout)
        }
        'transcribe' {
            # One audio chunk -> Groq speech-to-text. Only whitelisted form fields are forwarded.
            $model = [string]$Request.model
            if ($model -notmatch '^[A-Za-z0-9._:/-]{1,100}$') { return (Get-ErrorReply 'bad_request' 'Invalid transcription model.') }
            $mime = [string]$Request.mime
            if ($mime -notmatch '^(audio|video)/[A-Za-z0-9.+-]{1,40}$') { return (Get-ErrorReply 'bad_request' 'Invalid audio type.') }
            $fileName = [string]$Request.fileName
            if ($fileName -notmatch '^[A-Za-z0-9._-]{1,80}\.(webm|wav|mp3|m4a|mp4|ogg|flac|mpeg|mpga|opus)$') { return (Get-ErrorReply 'bad_request' 'Invalid audio file name.') }
            try { $audio = [Convert]::FromBase64String([string]$Request.audioBase64) } catch { return (Get-ErrorReply 'bad_request' 'Audio data is not valid base64.') }
            if ($audio.Length -eq 0) { return (Get-ErrorReply 'bad_request' 'The audio chunk is empty.') }
            if ($audio.Length -gt $MaxAudioBytes) { return (Get-ErrorReply 'too_large' 'This audio chunk is larger than 25 MB.') }
            $format = 'verbose_json'
            if ($Request.responseFormat) { $format = [string]$Request.responseFormat }
            if ($format -ne 'verbose_json' -and $format -ne 'json') { return (Get-ErrorReply 'bad_request' 'Invalid response format.') }
            $key = Get-ProviderKey $provider
            if (-not $key) { return (Get-NoKeyReply $provider) }
            Initialize-SatchelHttp
            $form = New-Object System.Net.Http.MultipartFormDataContent
            $fileContent = New-Object System.Net.Http.ByteArrayContent(,$audio)
            $fileContent.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse($mime)
            $form.Add($fileContent, 'file', $fileName)
            $form.Add((New-Object System.Net.Http.StringContent($model)), 'model')
            $form.Add((New-Object System.Net.Http.StringContent($format)), 'response_format')
            # Segment timestamps are only available with verbose_json (Whisper models).
            if ($format -eq 'verbose_json') { $form.Add((New-Object System.Net.Http.StringContent('segment')), 'timestamp_granularities[]') }
            $form.Add((New-Object System.Net.Http.StringContent('0')), 'temperature')
            $lang = [string]$Request.language
            if ($lang -match '^[a-z]{2}$') { $form.Add((New-Object System.Net.Http.StringContent($lang)), 'language') }
            $prompt = [string]$Request.prompt
            if ($prompt) {
                if ($prompt.Length -gt 800) { $prompt = $prompt.Substring($prompt.Length - 800) }
                $form.Add((New-Object System.Net.Http.StringContent($prompt)), 'prompt')
            }
            $timeout = 120
            if ($Request.timeoutSec) { $timeout = [int]$Request.timeoutSec }
            return (Invoke-GroqRequest -Provider $provider -Method 'POST' -Path '/audio/transcriptions' -Content $form -Key $key -TimeoutSec $timeout)
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
