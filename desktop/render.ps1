# Loads one of the tracker's own pages in a WebView2 window nobody sees and waits until the page says it is done. The
# rdmodule's pictures are drawn this way (tools/rdmodule/extract.mjs): the page draws with WebGL and posts each
# picture back to the tracker.
# The window is real but off the screen and out of the taskbar, as a hidden one would not be drawn at all.
# To the caller, one line each on standard output: "title <text>" whenever the page's title changes (pages report
# their progress in it), and "failed <reason>" before exit code 1. It ends with exit code 0 when the title is DONE, and
# when its parent (RT_PARENT) is gone.
# Environment: RT_URL (the page), RT_LIB (folder with the WebView2 libraries), RT_PROFILE (WebView2's data folder),
# RT_PARENT (process id of the caller).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
function Say($m) { [Console]::Out.WriteLine($m); [Console]::Out.Flush() }

try {
  Add-Type -Path (Join-Path $env:RT_LIB 'Microsoft.Web.WebView2.Core.dll')
  Add-Type -Path (Join-Path $env:RT_LIB 'Microsoft.Web.WebView2.WinForms.dll')
} catch {
  Say "failed $($_.Exception.Message)"
  exit 1
}

$url = [Uri]$env:RT_URL
$f = New-Object System.Windows.Forms.Form
$f.FormBorderStyle = 'None'
$f.ShowInTaskbar = $false
$f.StartPosition = 'Manual'
$f.Location = New-Object System.Drawing.Point(-32000, -32000)
$f.ClientSize = New-Object System.Drawing.Size(1280, 800)
$view = New-Object Microsoft.Web.WebView2.WinForms.WebView2
$view.Dock = 'Fill'
$view.CreationProperties = New-Object Microsoft.Web.WebView2.WinForms.CoreWebView2CreationProperties
$view.CreationProperties.UserDataFolder = $env:RT_PROFILE
$f.Controls.Add($view)
$script:code = 0
$view.add_CoreWebView2InitializationCompleted({
  param($s, $e)
  if (-not $e.IsSuccess) { Say "failed $($e.InitializationException.Message)"; $script:code = 1; $f.Close(); return }
  $core = $s.CoreWebView2
  $core.Settings.AreDevToolsEnabled = $false
  # only the tracker's own pages
  $core.add_NavigationStarting({ param($c, $n) if (([Uri]$n.Uri).Authority -ne $url.Authority) { $n.Cancel = $true } })
  $core.add_NewWindowRequested({ param($c, $r) $r.Handled = $true })
  $core.add_DocumentTitleChanged({
    param($c, $x)
    Say "title $($c.DocumentTitle)"
    if ($c.DocumentTitle -eq 'DONE') { $f.Close() }
  })
  $core.add_ProcessFailed({ param($c, $x) Say "failed the page's process ended ($($x.ProcessFailedKind))"; $script:code = 1; $f.Close() })
})
$f.add_Shown({ param($s) $s.Controls[0].Source = $url })

# gone with its caller
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({ if (-not (Get-Process -Id ([int]$env:RT_PARENT) -ErrorAction SilentlyContinue)) { $f.Close() } })
$timer.Start()

[System.Windows.Forms.Application]::Run($f)
exit $script:code
