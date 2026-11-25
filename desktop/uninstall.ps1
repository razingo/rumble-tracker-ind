# Removes the tracker from this PC, started by desktop/launcher.cjs for Uninstall in Settings. It waits for the tracker
# to stop (it writes its last backup and saves first), then removes the Start menu shortcut, the rumble-tracker: link,
# Start with Windows, the notification settings Windows kept for the tracker, the tracker's folder (the data, the
# unpacked program files and the window's WebView2 data), the note of where that folder is with what the note lists
# as left behind by a move, and the files of the release zip next to the exe; that folder too, once nothing else is
# left in it. Only folders named RumbleTracker are removed whole. A data folder set with RUMBLE_DATA_DIR is outside
# the tracker's folder and may hold other files, so it's left as it is.
# Environment: RT_PARENT (the tracker's process id), RT_EXE, RT_HOME (the tracker's folder), RT_NOTE (the folder of
# the note in %APPDATA%) and RT_LOCAL (the usual place of the tracker's folder, in %LOCALAPPDATA%), which go whether
# the tracker's folder is there or elsewhere, as an earlier version may have left files in them (both empty when the
# data folder was set with RUMBLE_DATA_DIR), RT_TITLE (the shortcut's name), RT_FILES_ONLY (leave the shortcut, link,
# Start with Windows and notification settings, for the tests).
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
$own = @($env:RT_HOME, $env:RT_NOTE, $env:RT_LOCAL) | Where-Object { $_ -and (Split-Path -Leaf $_) -eq 'RumbleTracker' }
# What a move of the tracker's folder could not remove yet, as it was in use (the note's list): it goes too, where it
# is in a folder named RumbleTracker.
$left = @()
if ($env:RT_NOTE) {
  try { $left = @((Get-Content -LiteralPath (Join-Path $env:RT_NOTE 'location.json') -Raw | ConvertFrom-Json).clear) } catch {}
}
$left = @($left | Where-Object { $_ -is [string] -and ((Split-Path -Parent $_) -split '[\\/]') -contains 'RumbleTracker' })
# (RumbleTracker-launcher: the launcher's pop-up script and font, written to the temporary folder to be run)
$targets = @($own) + $left + @($exe, "$exe.old", "$exe.failed", (Join-Path $env:TEMP 'RumbleTracker-launcher')) +
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
# (the folders that list's files were in: the old data folder and the old RumbleTracker folder, once empty)
$shells = foreach ($t in $left) {
  $d = Split-Path -Parent $t
  $d
  if ((Split-Path -Leaf $d) -ne 'RumbleTracker') { Split-Path -Parent $d }
}
$shells = @($shells | Where-Object { $_ -and (Split-Path -Leaf $_) -in 'data', 'RumbleTracker' } | Sort-Object Length -Descending)
foreach ($dir in $shells + @($notices, $folder)) {
  if ((Test-Path -LiteralPath $dir) -and -not (Get-ChildItem -LiteralPath $dir -Force)) { Remove-Item -LiteralPath $dir -Force }
}
