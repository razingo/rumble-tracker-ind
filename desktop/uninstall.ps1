# Removes the tracker from this PC, started by desktop/launcher.cjs for Uninstall in Settings. It waits for the tracker
# to stop (it writes its last backup and saves first), then removes the Start menu shortcut, the rumble-tracker: link,
# Start with Windows, the notification settings Windows kept for the tracker, the data folder, the unpacked program
# files with the window's WebView2 data, and the files of the release zip next to the exe; that folder too, once
# nothing else is left in it. A data folder set with RUMBLE_DATA_DIR may hold other files, so it's left as it is.
# Environment: RT_PARENT (the tracker's process id), RT_EXE, RT_DATA (data folder), RT_HOME (unpacked program files and
# WebView2 data), RT_TITLE (the shortcut's name), RT_FILES_ONLY (leave the shortcut, link, Start with Windows and
# notification settings, for the tests).
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

try { [void](Get-Process -Id ([int]$env:RT_PARENT)).WaitForExit(30000) } catch {}

if (-not $env:RT_FILES_ONLY) {
  Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('Programs')) "$($env:RT_TITLE).lnk") -Force
  Remove-Item -LiteralPath 'HKCU:\Software\Classes\rumble-tracker' -Recurse -Force
  Remove-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'RumbleCollectionTracker' -Force
  # under the tracker's app ID (AUMID in desktop/launcher.cjs)
  Remove-Item -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\razingo.RumbleCollectionTracker' `
    -Recurse -Force
}

$exe = $env:RT_EXE
$folder = Split-Path -Parent $exe
$notices = Join-Path $folder 'THIRD-PARTY-NOTICES'
$data = $env:RT_DATA
$defaultData = Join-Path $env:APPDATA 'RumbleTracker'
if ([IO.Path]::GetFullPath($data).TrimEnd('\') -ne [IO.Path]::GetFullPath($defaultData).TrimEnd('\')) { $data = $null }
$targets = @($data, $env:RT_HOME, $exe, "$exe.old", "$exe.failed") +
  @('README.md', 'LICENSE.txt', 'NOTICE.md' | ForEach-Object { Join-Path $folder $_ }) +
  @('Node.js-LICENSE.txt', 'WebView2-LICENSE.txt', 'WebView2-NOTICE.txt', 'Font-LilitaOne-OFL.txt', 'Font-Nunito-OFL.txt',
    'Python-LICENSE.txt', 'UnityPy-LICENSE.txt', 'Pillow-LICENSE.txt', 'lz4-LICENSE.txt', 'Brotli-LICENSE.txt',
    'texture2ddecoder-LICENSE.txt', 'etcpak-LICENSE.txt', 'astc-encoder-py-LICENSE.txt', 'archspec-LICENSE-APACHE.txt',
    'archspec-LICENSE-MIT.txt', 'archspec-NOTICE.txt', 'fsspec-LICENSE.txt', 'attrs-LICENSE.txt', 'tpk_ar-LICENSE.txt',
    'three.js-LICENSE.txt', 'vgmstream-COPYING.txt' |
    ForEach-Object { Join-Path $notices $_ })
# never a drive's root, whatever the environment says
$targets = $targets | Where-Object { $_ -and ([IO.Path]::GetFullPath($_)).Length -gt 3 }

# The window's WebView2 processes can take a moment to let go of their files, so locked ones are tried again.
for ($i = 0; $i -lt 30; $i++) {
  foreach ($t in $targets) { if (Test-Path -LiteralPath $t) { Remove-Item -LiteralPath $t -Recurse -Force } }
  if (-not ($targets | Where-Object { Test-Path -LiteralPath $_ })) { break }
  Start-Sleep -Seconds 1
}
foreach ($dir in @($notices, $folder)) {
  if ((Test-Path -LiteralPath $dir) -and -not (Get-ChildItem -LiteralPath $dir -Force)) { Remove-Item -LiteralPath $dir -Force }
}
