$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# Ensure the Cert: provider is available even when npm clears PSModulePath.
$securityModule = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1"
Import-Module -Name $securityModule
if (-not (Get-PSDrive -Name Cert -ErrorAction SilentlyContinue)) {
    throw "Windows certificate provider could not be loaded"
}

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$packageJson = Get-Content -LiteralPath (Join-Path $projectRoot "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$version = [string]$packageJson.version
$versionParts = $version.Split(".")
if ($versionParts.Count -ne 3) {
    throw "package.json version must contain three numeric parts"
}
$msixVersion = "$version.0"

Push-Location $projectRoot
try {
    & npm.cmd run tauri build -- --no-bundle
    if ($LASTEXITCODE -ne 0) {
        throw "Tauri release build failed"
    }
} finally {
    Pop-Location
}

$releaseRoot = Join-Path $projectRoot "src-tauri\target\release"
$stage = Join-Path $releaseRoot "msix-stage"
$bundleRoot = Join-Path $releaseRoot "bundle\msix"
$expectedStageRoot = [System.IO.Path]::GetFullPath($releaseRoot) + [System.IO.Path]::DirectorySeparatorChar
$resolvedStage = [System.IO.Path]::GetFullPath($stage)
if (-not $resolvedStage.StartsWith($expectedStageRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clear an MSIX stage outside the release directory: $resolvedStage"
}
if (Test-Path -LiteralPath $stage) {
    Remove-Item -LiteralPath $stage -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $stage, (Join-Path $stage "Assets"), $bundleRoot | Out-Null

Copy-Item -LiteralPath (Join-Path $releaseRoot "spotify-now-playing-widget.exe") -Destination (Join-Path $stage "spotify-now-playing-widget.exe") -Force
$manifest = Get-Content -LiteralPath (Join-Path $projectRoot "packaging\msix\AppxManifest.xml") -Raw -Encoding UTF8
$manifest.Replace("__VERSION__", $msixVersion) | Set-Content -LiteralPath (Join-Path $stage "AppxManifest.xml") -Encoding UTF8

Add-Type -AssemblyName System.Drawing
$icon = New-Object System.Drawing.Icon((Join-Path $projectRoot "src-tauri\icons\icon.ico"))
try {
    foreach ($size in @(44, 150)) {
        $bitmap = New-Object System.Drawing.Bitmap $size, $size
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.Clear([System.Drawing.Color]::Transparent)
            $rectangle = New-Object System.Drawing.Rectangle 0, 0, $size, $size
            $graphics.DrawIcon($icon, $rectangle)
            $logoPath = Join-Path $stage "Assets\Square${size}x${size}Logo.png"
            $bitmap.Save($logoPath, [System.Drawing.Imaging.ImageFormat]::Png)
        } finally {
            $graphics.Dispose()
            $bitmap.Dispose()
        }
    }
} finally {
    $icon.Dispose()
}

$sdkBin = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin" -Directory |
    Where-Object { Test-Path (Join-Path $_.FullName "x64\makeappx.exe") } |
    Sort-Object { [version]$_.Name } -Descending |
    Select-Object -First 1
if (-not $sdkBin) {
    throw "Windows SDK MakeAppx.exe was not found"
}
$makeAppx = Join-Path $sdkBin.FullName "x64\makeappx.exe"
$signTool = Join-Path $sdkBin.FullName "x64\signtool.exe"
$msixPath = Join-Path $bundleRoot "Spotify Now Playing Widget_${version}_x64.msix"
& $makeAppx pack /o /d $stage /p $msixPath
if ($LASTEXITCODE -ne 0) {
    throw "MakeAppx failed"
}

$subject = "CN=Keitaro Spotify Widget"
$friendlyName = "Spotify Now Playing Widget Development Signing"
$certificate = Get-ChildItem Cert:\CurrentUser\My |
    Where-Object { $_.Subject -eq $subject -and $_.FriendlyName -eq $friendlyName -and $_.NotAfter -gt (Get-Date) } |
    Select-Object -First 1
if (-not $certificate) {
    $certificate = New-SelfSignedCertificate `
        -Type Custom `
        -KeyUsage DigitalSignature `
        -KeyExportPolicy Exportable `
        -CertStoreLocation "Cert:\CurrentUser\My" `
        -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3", "2.5.29.19={text}") `
        -Subject $subject `
        -FriendlyName $friendlyName `
        -NotAfter (Get-Date).AddYears(3)
}

$certificatePath = Join-Path $bundleRoot "Spotify Now Playing Widget Development Signing.cer"
Export-Certificate -Cert $certificate -FilePath $certificatePath -Force | Out-Null
& $signTool sign /fd SHA256 /sha1 $certificate.Thumbprint $msixPath
if ($LASTEXITCODE -ne 0) {
    throw "SignTool failed"
}

Write-Output "MSIX=$msixPath"
Write-Output "CERTIFICATE=$certificatePath"
