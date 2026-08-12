param(
    [string]$PackagePath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$bundleRoot = Join-Path $projectRoot "src-tauri\target\release\bundle\msix"
if ([string]::IsNullOrWhiteSpace($PackagePath)) {
    $PackagePath = Get-ChildItem -LiteralPath $bundleRoot -Filter "*.msix" |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1 -ExpandProperty FullName
}
if (-not $PackagePath -or -not (Test-Path -LiteralPath $PackagePath)) {
    throw "MSIX package was not found. Run npm.cmd run build:msix first."
}

$certificatePath = Join-Path $bundleRoot "Spotify Now Playing Widget Development Signing.cer"
if (-not (Test-Path -LiteralPath $certificatePath)) {
    throw "Signing certificate was not found: $certificatePath"
}

$isAdministrator = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $isAdministrator) {
    $arguments = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", "`"$PSCommandPath`"",
        "-PackagePath", "`"$PackagePath`""
    )
    $process = Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList $arguments -Wait -PassThru
    if ($process.ExitCode -ne 0) {
        throw "MSIX installation was cancelled or failed with exit code $($process.ExitCode)"
    }
    exit 0
}

Import-Certificate -FilePath $certificatePath -CertStoreLocation "Cert:\LocalMachine\TrustedPeople" | Out-Null
Add-AppxPackage -Path $PackagePath -ForceApplicationShutdown -ForceUpdateFromAnyVersion
Write-Output "Installed $PackagePath"
