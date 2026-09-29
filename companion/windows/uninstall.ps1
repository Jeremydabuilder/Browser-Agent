# uninstall.ps1 - removes the Satchel companion registration, shortcuts and files for the current user.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'SatchelCommon.ps1')
foreach ($browserKey in @('HKCU:\Software\Google\Chrome\NativeMessagingHosts', 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts')) {
    $keyPath = Join-Path $browserKey $script:SatchelHostName
    if (Test-Path $keyPath) { Remove-Item -Path $keyPath -Recurse -Force; Write-Host "Removed $keyPath" }
}
$menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Satchel'
if (Test-Path -LiteralPath $menu) { Remove-Item -LiteralPath $menu -Recurse -Force; Write-Host 'Removed Start menu shortcuts' }
$installDir = Join-Path (Get-SatchelDataDir) 'companion'
if (Test-Path -LiteralPath $installDir) { Remove-Item -LiteralPath $installDir -Recurse -Force; Write-Host "Removed $installDir" }
foreach ($p in $script:SatchelProviders) {
    if (Test-Path -LiteralPath (Get-SatchelKeyPath $p)) {
        $label = Get-SatchelProviderLabel $p
        $answer = Read-Host "Also delete your stored $label key? (y/N)"
        if ($answer -match '^[yY]') { Remove-ProviderKey $p; Write-Host "$label key deleted." }
    }
}
Write-Host 'Satchel companion uninstalled. Remove the extension itself from chrome://extensions or edge://extensions.'
