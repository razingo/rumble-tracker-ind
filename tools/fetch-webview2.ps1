# Fetches the three WebView2 libraries the window needs (desktop/window.ps1), with their license, into
# desktop/webview2/ from Microsoft's NuGet package. The package version and its SHA-256 are pinned, and each library
# must carry a valid Microsoft signature. Usage: npm run fetch-webview2
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Started from PowerShell 7 (as on GitHub's runners), this Windows PowerShell inherits 7's module path and can't load
# its own modules (Get-FileHash, Get-AuthenticodeSignature), so it uses its own path.
$env:PSModulePath = [Environment]::GetEnvironmentVariable('PSModulePath', 'Machine')

$version = '1.0.4370.26'
$sha256 = '1C0DACAC84B70109B3FD42F90C53A0BA942ABC3A87590D7A4E0CCD86E4A06CF4'
$files = @{
  'lib/net462/Microsoft.Web.WebView2.Core.dll' = 'Microsoft.Web.WebView2.Core.dll'
  'lib/net462/Microsoft.Web.WebView2.WinForms.dll' = 'Microsoft.Web.WebView2.WinForms.dll'
  'runtimes/win-x64/native/WebView2Loader.dll' = 'WebView2Loader.dll'
  # the license the libraries ship under (BSD-style), which the release zip carries
  'LICENSE.txt' = 'LICENSE.txt'
  'NOTICE.txt' = 'NOTICE.txt'
}

$lib = Join-Path (Split-Path -Parent $PSScriptRoot) 'desktop\webview2'
$package = Join-Path $env:TEMP "microsoft.web.webview2.$version.nupkg"
$url = "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$version/microsoft.web.webview2.$version.nupkg"

if (-not (Test-Path $package) -or (Get-FileHash $package -Algorithm SHA256).Hash -ne $sha256) {
  "Downloading Microsoft.Web.WebView2 $version"
  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $package
}
if ((Get-FileHash $package -Algorithm SHA256).Hash -ne $sha256) {
  Remove-Item $package
  throw "The downloaded package doesn't match its pinned checksum, so nothing was installed."
}

New-Item -ItemType Directory -Force $lib | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($package)
try {
  foreach ($entry in $files.Keys) {
    $target = Join-Path $lib $files[$entry]
    [IO.Compression.ZipFileExtensions]::ExtractToFile($zip.GetEntry($entry), $target, $true)
    if ($target -notlike '*.dll') { continue }
    $signature = Get-AuthenticodeSignature $target
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {
      Remove-Item $target
      throw "$($files[$entry]) isn't signed by Microsoft ($($signature.Status)), so it was removed."
    }
  }
} finally {
  $zip.Dispose()
}
"WebView2 $version is in $lib"
