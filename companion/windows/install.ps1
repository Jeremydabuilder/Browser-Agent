# install.ps1 - installs the Satchel companion for the current Windows user (no admin needed).
#  1. Copies the companion into %LOCALAPPDATA%\Satchel\companion
#  2. Registers it as a native messaging host for Google Chrome and Microsoft Edge
#     (only the Satchel extension ID is allowed to talk to it)
#  3. Asks for your Groq API key and stores it encrypted with Windows DPAPI
param([string]$ExtensionId = '')

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'SatchelCommon.ps1')
if ($ExtensionId) { $script:SatchelExtensionId = $ExtensionId.Trim().ToLower() }

function Write-Step([string]$Text) { Write-Host ''; Write-Host ('==> ' + $Text) -ForegroundColor Cyan }

if (-not (Test-SatchelOnWindows)) { Write-Host 'This installer is for Windows.' -ForegroundColor Red; exit 1 }

Write-Host 'Satchel companion installer' -ForegroundColor Green
Write-Host 'This sets up the small helper program that lets the Satchel browser extension use your Groq account.'
Write-Host 'Your Groq key is stored encrypted for your Windows account only. It is never put in the extension.'

Write-Step 'Copying companion files'
$installDir = Join-Path (Get-SatchelDataDir) 'companion'
if (-not (Test-Path -LiteralPath $installDir)) { New-Item -ItemType Directory -Path $installDir -Force | Out-Null }
foreach ($f in @('SatchelCommon.ps1', 'satchel-host.ps1', 'satchel-host.bat', 'set-key.ps1', 'status.ps1', 'uninstall.ps1')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $f) -Destination (Join-Path $installDir $f) -Force
}
# Files copied out of a downloaded ZIP carry a "downloaded from the internet" mark; clear it.
Get-ChildItem -LiteralPath $installDir | ForEach-Object { try { Unblock-File -LiteralPath $_.FullName } catch { } }
Write-Host ('Installed to ' + $installDir)

Write-Step 'Registering with Chrome and Edge'
$manifestPath = Join-Path $installDir ($script:SatchelHostName + '.json')
$manifest = [ordered]@{
    name = $script:SatchelHostName
    description = 'Satchel companion (Groq access for the Satchel extension)'
    path = (Join-Path $installDir 'satchel-host.bat')
    type = 'stdio'
    allowed_origins = @('chrome-extension://' + $script:SatchelExtensionId + '/')
}
$json = ConvertTo-Json -InputObject $manifest -Depth 4
[IO.File]::WriteAllText($manifestPath, $json, (New-Object Text.UTF8Encoding($false)))
foreach ($browserKey in @('HKCU:\Software\Google\Chrome\NativeMessagingHosts', 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts')) {
    $keyPath = Join-Path $browserKey $script:SatchelHostName
    New-Item -Path $keyPath -Force | Out-Null
    Set-ItemProperty -Path $keyPath -Name '(default)' -Value $manifestPath
    Write-Host ('Registered: ' + $keyPath)
}

Write-Step 'Checking that PowerShell can run the companion'
$lang = $ExecutionContext.SessionState.LanguageMode
if ($lang -ne 'FullLanguage') {
    Write-Host "Warning: PowerShell is in $lang mode on this computer (often set by school IT)." -ForegroundColor Yellow
    Write-Host 'The companion may be blocked. The rest of Satchel will still work, but AI features will not.' -ForegroundColor Yellow
}

Write-Step 'Start menu shortcuts'
# So you can change keys or check the companion later without finding this folder again.
try {
    $menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Satchel'
    if (-not (Test-Path -LiteralPath $menu)) { New-Item -ItemType Directory -Path $menu -Force | Out-Null }
    $shell = New-Object -ComObject WScript.Shell
    $items = @(
        @('Satchel - Set Groq key', 'set-key.ps1', '-Provider groq'),
        @('Satchel - Set OpenAI key', 'set-key.ps1', '-Provider openai'),
        @('Satchel - Check companion', 'status.ps1', ''),
        @('Satchel - Uninstall companion', 'uninstall.ps1', '')
    )
    foreach ($it in $items) {
        $lnk = $shell.CreateShortcut((Join-Path $menu ($it[0] + '.lnk')))
        $lnk.TargetPath = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $lnk.Arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -NoExit -File "' + (Join-Path $installDir $it[1]) + '" ' + $it[2]
        $lnk.WorkingDirectory = $installDir
        $lnk.Save()
    }
    Write-Host ('Created shortcuts in Start menu > Satchel')
} catch {
    Write-Host 'Could not create Start menu shortcuts (this does not affect Satchel). Use set-key.cmd and status.cmd in this folder instead.' -ForegroundColor Yellow
}

Write-Step 'Groq API key (default AI provider)'
$setKey = $true
if (Test-Path -LiteralPath (Get-SatchelKeyPath 'groq')) {
    $answer = Read-Host 'A Groq key is already stored. Replace it? (y/N)'
    if ($answer -notmatch '^[yY]') { $setKey = $false }
}
if ($setKey) { & (Join-Path $PSScriptRoot 'set-key.ps1') -Provider groq -NoPause }

Write-Step 'OpenAI API key (optional)'
Write-Host 'Satchel can also use OpenAI for chat/notes or meeting transcription. OpenAI charges per request.'
$answer = Read-Host 'Add an OpenAI key now? You can do it later from the Start menu. (y/N)'
if ($answer -match '^[yY]') { & (Join-Path $PSScriptRoot 'set-key.ps1') -Provider openai -NoPause }

Write-Step 'Done'
Write-Host 'Next steps:'
Write-Host '  1. In Chrome (chrome://extensions) or Edge (edge://extensions), load the Satchel "extension" folder.'
Write-Host '  2. Restart the browser, click the Satchel toolbar icon, and follow the setup checklist.'
Write-Host '  Later: Start menu > Satchel has shortcuts to change keys or check the companion.'
Write-Host ''
Write-Host 'There is nothing to start at login: the browser launches the companion automatically when Satchel needs it.'
Write-Host ('Extension ID allowed: ' + $script:SatchelExtensionId)
