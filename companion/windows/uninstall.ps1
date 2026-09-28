# uninstall.ps1 - removes the Satchel companion registration and files for the current user.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'SatchelCommon.ps1')
foreach ($browserKey in @('HKCU:\Software\Google\Chrome\NativeMessagingHosts', 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts')) {
    $keyPath = Join-Path $browserKey $script:SatchelHostName
    if (Test-Path $keyPath) { Remove-Item -Path $keyPath -Recurse -Force; Write-Host "Removed $keyPath" }
}
$installDir = Join-Path (Get-SatchelDataDir) 'companion'
if (Test-Path -LiteralPath $installDir) { Remove-Item -LiteralPath $installDir -Recurse -Force; Write-Host "Removed $installDir" }
$answer = Read-Host 'Also delete your stored Groq key? (y/N)'
if ($answer -match '^[yY]') { Remove-GroqKey; Write-Host 'Groq key deleted.' }
Write-Host 'Satchel companion uninstalled. Remove the extension itself from chrome://extensions or edge://extensions.'
