# The tracker's window and tray icon in one process (Windows Forms, the page in WebView2), started by
# desktop/launcher.cjs. The window is built when it's opened and disposed when it's closed, so the tracker in the tray
# doesn't keep a browser engine running.
# To the launcher, one line each on standard output: "ready" (tray icon shown), "closed" (the user closed the window),
# "quit" (Quit the tracker), "shutdown" (Windows is signing out or shutting down), "game 1" / "game 0" (whether
# Warcraft Rumble runs; sent when it changes), "no-webview <reason>" (WebView2 can't run, so instead of the window and
# tray icon it shows how to install WebView2; for the log), "no-webview-closed" (that was closed: the tracker stops).
# From the launcher, one line each on standard input: "show" (open the window, or bring it to the front).
# With the page: the close button sends it "close?", and the window closes when it answers "close". It answers "asking"
# while it asks what closing should do, and "stay" when that was cancelled. A page that doesn't answer (still loading)
# lets the window close after CLOSE_WAIT. The page sends "rdmodule" to open the rdmodule (RT_RDMODULE) in a window of
# its own.
# Environment: RT_TITLE, RT_AUMID (app ID for the taskbar), RT_PAGE (the page's address), RT_DATA (data folder), RT_EXE
# (icon), RT_PARENT (tracker process id), RT_GAME (the game's process name), RT_LIB (folder with the WebView2
# libraries), RT_PROFILE (WebView2's data folder), RT_CACHE (where to keep the compiled helpers below), RT_SHOW
# ("1": open the window right away), RT_CHECK
# (build everything without showing it, for the tests), RT_RDMODULE (the game's address), RT_RDMODULE_PROFILE (the game
# window's WebView2 data folder).
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
function Say($m) { [Console]::Out.WriteLine($m); [Console]::Out.Flush() }

$helpers = @'
using System; using System.Collections.Concurrent; using System.Diagnostics; using System.Runtime.InteropServices;
using System.Threading; using System.Windows.Forms;
// Lines from the launcher, read on their own thread; the window's timer takes them.
public static class RtInput {
  public static readonly ConcurrentQueue<string> Lines = new ConcurrentQueue<string>();
  public static void Start() {
    var t = new Thread(() => { string line; while ((line = Console.In.ReadLine()) != null) Lines.Enqueue(line.Trim()); });
    t.IsBackground = true;
    t.Start();
  }
}
public static class RtWin {
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
  // DWMWA_USE_IMMERSIVE_DARK_MODE, as the page is dark; older Windows ignores it
  public static void DarkTitle(IntPtr hwnd) { int on = 1; DwmSetWindowAttribute(hwnd, 20, ref on, 4); }
  // Started hidden (the launcher starts PowerShell that way), Windows applies that to the first window shown. Showing
  // one hidden once uses that up, so the window itself appears.
  public static void UseUpHiddenStart(IntPtr hwnd) { ShowWindow(hwnd, 0); }
  // Windows lets a program take the foreground only right after the user clicked it; otherwise restoring the window
  // from minimized still brings it up.
  public static void Front(IntPtr hwnd) {
    if (SetForegroundWindow(hwnd)) return;
    ShowWindow(hwnd, 6); // SW_MINIMIZE
    ShowWindow(hwnd, 9); // SW_RESTORE
  }
}
// The window runs in powershell.exe, so the taskbar would show it as PowerShell. Giving it the tracker's app ID groups
// it with the Start menu shortcut, which has the tracker's name and icon; the icon and the command to start it again
// (for pinning) come along for when the shortcut isn't there yet.
public static class RtTaskbar {
  [StructLayout(LayoutKind.Sequential)] struct PropertyKey { public Guid Format; public int Id; }
  [StructLayout(LayoutKind.Sequential)] struct PropVariant { public ushort Type; ushort r1, r2, r3; public IntPtr Value; IntPtr Value2; }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    void GetCount(out uint count);
    void GetAt(uint index, out PropertyKey key);
    void GetValue(ref PropertyKey key, out PropVariant value);
    void SetValue(ref PropertyKey key, ref PropVariant value);
    void Commit();
  }
  [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr hwnd, ref Guid iid, out IPropertyStore store);
  [DllImport("ole32.dll")] static extern int PropVariantClear(ref PropVariant value);
  static readonly Guid AppUserModel = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
  const int ID = 5, RELAUNCH_COMMAND = 2, RELAUNCH_ICON = 3, RELAUNCH_NAME = 4;

  static void Set(IPropertyStore store, int id, string text) {
    var key = new PropertyKey { Format = AppUserModel, Id = id };
    var value = new PropVariant();
    if (text != null) { value.Type = 31; value.Value = Marshal.StringToCoTaskMemUni(text); } // VT_LPWSTR
    try { store.SetValue(ref key, ref value); } finally { PropVariantClear(ref value); }
  }
  static void SetAll(IntPtr hwnd, string id, string command, string icon, string name) {
    var iid = typeof(IPropertyStore).GUID;
    IPropertyStore store;
    Marshal.ThrowExceptionForHR(SHGetPropertyStoreForWindow(hwnd, ref iid, out store));
    try {
      // the ID last when setting and first when clearing, so it never stands without the others
      if (id == null) Set(store, ID, null);
      Set(store, RELAUNCH_COMMAND, command);
      Set(store, RELAUNCH_ICON, icon);
      Set(store, RELAUNCH_NAME, name);
      if (id != null) Set(store, ID, id);
    } finally { Marshal.ReleaseComObject(store); }
  }
  public static void Identify(IntPtr hwnd, string id, string exe, string name) {
    SetAll(hwnd, id, "\"" + exe + "\"", exe + ",0", name);
  }
  // Windows asks for these to be removed before the window goes
  public static void Forget(IntPtr hwnd) { SetAll(hwnd, null, null, null, null); }
}
// When Windows signs out or shuts down, the tracker is told so it can write its backup and stop, and it gets a few
// seconds for that. A hidden top-level window receives WM_ENDSESSION.
public class RtEndSession : NativeWindow {
  int parent;
  public RtEndSession(int parent) { this.parent = parent; CreateHandle(new CreateParams()); }
  protected override void WndProc(ref Message m) {
    if (m.Msg == 0x16 && m.WParam != IntPtr.Zero) {
      Console.Out.WriteLine("shutdown"); Console.Out.Flush();
      var sw = Stopwatch.StartNew();
      while (sw.ElapsedMilliseconds < 4000) { try { Process.GetProcessById(parent); } catch { break; } Thread.Sleep(100); }
    }
    base.WndProc(ref m);
  }
}
'@
# Compiling the helpers takes a moment, so they are compiled once per version into RT_CACHE (in the unpacked app)
$cache = $env:RT_CACHE
if ($cache -and -not (Test-Path $cache)) {
  try {
    Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition $helpers -OutputAssembly "$cache.tmp" -OutputType Library
    Move-Item -Force "$cache.tmp" $cache
  } catch {
    Remove-Item -ErrorAction SilentlyContinue "$cache.tmp"
  }
}
if ($cache -and (Test-Path $cache)) { Add-Type -Path $cache }
else { Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition $helpers }

$lib = $env:RT_LIB
$script:webview = $null # why WebView2 can't run, once that's known; $null while it may
$script:webviewLoaded = $false
try {
  Add-Type -Path (Join-Path $lib 'Microsoft.Web.WebView2.Core.dll')
  Add-Type -Path (Join-Path $lib 'Microsoft.Web.WebView2.WinForms.dll')
  # WebView2Loader.dll is next to them, not next to powershell.exe where Windows would look for it
  [Microsoft.Web.WebView2.Core.CoreWebView2Environment]::SetLoaderDllFolderPath($lib)
  $script:webviewLoaded = $true
} catch {
  $script:webview = $_.Exception.Message
}

# Whether WebView2 is installed and can run; checked at start and again each time the window is to open.
function Test-WebView {
  if (-not $script:webviewLoaded) { return $false }
  try {
    [void][Microsoft.Web.WebView2.Core.CoreWebView2Environment]::GetAvailableBrowserVersionString()
    $script:webview = $null
    return $true
  } catch {
    $script:webview = $_.Exception.Message
    return $false
  }
}
[System.Windows.Forms.Application]::EnableVisualStyles()

# The exe's icon, or a drawn one when it can't be read (running from source)
try {
  $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($env:RT_EXE)
} catch {
  $bmp = New-Object System.Drawing.Bitmap 32, 32
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'
  $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 240, 180, 50))), 1, 1, 30, 30)
  $g.DrawEllipse((New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 110, 60, 10)), 2), 2, 2, 28, 28)
  $font = New-Object System.Drawing.Font('Segoe UI', 17, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $sf = New-Object System.Drawing.StringFormat; $sf.Alignment = 'Center'; $sf.LineAlignment = 'Center'
  $ink = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 70, 35, 5))
  $g.DrawString('R', $font, $ink, (New-Object System.Drawing.RectangleF 0, 1, 32, 32), $sf)
  $g.Dispose()
  $icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}
$background = [System.Drawing.ColorTranslator]::FromHtml('#161a2e')

# The window
$script:form = $null
$script:firstShow = $true
$script:closeAsked = $null # when the page was asked whether the window may close, while it hasn't answered
$script:closeAgreed = $false # the page agreed (or didn't answer in time), so the next close goes ahead
$script:closeNow = $false # the page answered "close"
$CLOSE_WAIT = 1500 # ms

function Test-TrackerPage($uri) {
  try { return ([Uri]$uri).GetLeftPart('Authority') -eq ([Uri]$env:RT_PAGE).GetLeftPart('Authority') } catch { return $false }
}

function Open-WebLink($uri) {
  try {
    $u = [Uri]$uri
    if ($u.Scheme -eq 'https' -or $u.Scheme -eq 'http') { Start-Process $u.AbsoluteUri }
  } catch {
    # not a link
  }
}

function Close-TrackerWindow {
  $script:closeAsked = $null
  $script:closeNow = $false
  $script:closeAgreed = $true
  if ($script:form) { $script:form.Close() }
}

function New-TrackerWindow {
  $f = New-Object System.Windows.Forms.Form
  $f.Text = $env:RT_TITLE
  $f.Icon = $icon
  $f.ClientSize = New-Object System.Drawing.Size(1440, 900)
  # room for the page's minimum width (1280 px, style.css) and its scrollbar inside the frame
  $frame = $f.Size.Width - $f.ClientSize.Width
  $f.MinimumSize = New-Object System.Drawing.Size((1280 + [System.Windows.Forms.SystemInformation]::VerticalScrollBarWidth + $frame), 600)
  $f.StartPosition = 'CenterScreen'
  $f.BackColor = $background
  $view = New-Object Microsoft.Web.WebView2.WinForms.WebView2
  $view.Dock = 'Fill'
  $view.DefaultBackgroundColor = $background
  $view.CreationProperties = New-Object Microsoft.Web.WebView2.WinForms.CoreWebView2CreationProperties
  $view.CreationProperties.UserDataFolder = $env:RT_PROFILE
  $f.Controls.Add($view)
  $view.add_CoreWebView2InitializationCompleted({
    param($s, $e)
    if (-not $e.IsSuccess) {
      $script:webview = $e.InitializationException.Message
      $script:form.Close()
      Show-WebViewHelp
      return
    }
    $core = $s.CoreWebView2
    $core.Settings.IsStatusBarEnabled = $false
    $core.add_DocumentTitleChanged({ param($c) $script:form.Text = $c.DocumentTitle })
    # The window shows only the tracker's page. Links meant for a new window (window.open, target=_blank) and any other
    # site open in the default browser, and only when they're web links.
    $core.add_NewWindowRequested({ param($c, $r) $r.Handled = $true; Open-WebLink $r.Uri })
    $core.add_NavigationStarting({
      param($c, $n)
      if (-not (Test-TrackerPage $n.Uri)) { $n.Cancel = $true; Open-WebLink $n.Uri }
    })
    # the page closes itself after Quit
    $core.add_WindowCloseRequested({ $script:closeNow = $true })
    $core.add_WebMessageReceived({
      param($c, $m)
      if (-not (Test-TrackerPage $m.Source)) { return }
      switch ($m.TryGetWebMessageAsString()) {
        # closed by the timer, not inside WebView2's own event
        'close' { $script:closeNow = $true }
        'asking' { $script:closeAsked = $null }
        'stay' { $script:closeAsked = $null }
        # opened by the timer, not inside WebView2's own event
        'rdmodule' { $script:rdmoduleAsked = $true }
      }
    })
  })
  $f.add_HandleCreated({ param($s) [RtWin]::DarkTitle($s.Handle) })
  $f.add_Shown({ param($s) $s.Controls[0].Source = [Uri]$env:RT_PAGE })
  # The close button asks the page first, which may ask what closing should do (web/scripts/closing.js)
  $f.add_FormClosing({
    param($s, $e)
    if ($e.CloseReason -ne 'UserClosing' -or $script:closeAgreed) { return }
    $core = $s.Controls[0].CoreWebView2
    if (-not $core) { return }
    $e.Cancel = $true
    if (-not $script:closeAsked) { $script:closeAsked = [DateTime]::UtcNow }
    $core.PostWebMessageAsString('close?')
  })
  $f.add_FormClosed({
    param($s, $e)
    $script:form = $null
    $script:closeAsked = $null
    $script:closeAgreed = $false
    $s.Dispose()
    # closed by the user (not by Windows or a quit): the tracker decides whether to keep running
    if ($e.CloseReason -eq 'UserClosing' -and -not $script:webview) { Say 'closed' }
  })
  $f
}

function Show-Form($f) {
  if ($env:RT_AUMID) {
    try {
      [RtTaskbar]::Identify($f.Handle, $env:RT_AUMID, $env:RT_EXE, $env:RT_TITLE)
      $f.add_HandleDestroyed({ param($s) try { [RtTaskbar]::Forget($s.Handle) } catch {} })
    } catch {
      # the window still works, shown as PowerShell's
    }
  }
  if ($script:firstShow) {
    $script:firstShow = $false
    [RtWin]::UseUpHiddenStart($f.Handle)
  }
  $f.Show()
  $f.Activate()
}

function Show-Front($f) {
  if ($f.WindowState -eq 'Minimized') { $f.WindowState = 'Normal' }
  $f.Activate()
  [RtWin]::Front($f.Handle)
}

# The game window: the page's hidden key sequence opens it (web/scripts/rdmodule.js). It shows only the game's site,
# with a WebView2 data folder of its own, and takes no messages from it. Closing it leaves the tracker as it is.
$script:rdmodule = $null
$script:rdmoduleAsked = $false
$rdmoduleBackground = [System.Drawing.ColorTranslator]::FromHtml('#1b1f2e')

function Test-RdmodulePage($uri) {
  try { return ([Uri]$uri).AbsoluteUri.StartsWith(([Uri]$env:RT_RDMODULE).AbsoluteUri) } catch { return $false }
}

# shown instead of WebView2's own error page, e.g. when offline
$RDMODULE_ERROR = @'
<!doctype html><meta charset="utf-8"><title>Rumble Dash</title>
<body style="margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;
background:#1b1f2e;color:#f3ead6;font:16px 'Segoe UI',sans-serif">
<p>Couldn't load the game.</p>
<a href="{0}" style="padding:6px 18px;border-radius:6px;background:#f2b33d;color:#3a2208;font-weight:600;
text-decoration:none">Retry</a></body>
'@

function New-RdmoduleWindow {
  $f = New-Object System.Windows.Forms.Form
  $f.Text = 'Rumble Dash'
  $f.Icon = $icon
  $f.ClientSize = New-Object System.Drawing.Size(1280, 620)
  $f.MinimumSize = New-Object System.Drawing.Size(640, 400)
  $f.StartPosition = 'CenterScreen'
  $f.BackColor = $rdmoduleBackground
  $view = New-Object Microsoft.Web.WebView2.WinForms.WebView2
  $view.Dock = 'Fill'
  $view.DefaultBackgroundColor = $rdmoduleBackground
  $view.CreationProperties = New-Object Microsoft.Web.WebView2.WinForms.CoreWebView2CreationProperties
  $view.CreationProperties.UserDataFolder = $env:RT_RDMODULE_PROFILE
  $f.Controls.Add($view)
  $view.add_CoreWebView2InitializationCompleted({
    param($s, $e)
    if (-not $e.IsSuccess) { $script:rdmodule.Close(); return }
    $core = $s.CoreWebView2
    $core.Settings.IsStatusBarEnabled = $false
    $core.Settings.AreDevToolsEnabled = $false
    $core.Settings.IsWebMessageEnabled = $false
    $core.add_NewWindowRequested({ param($c, $r) $r.Handled = $true; Open-WebLink $r.Uri })
    $core.add_NavigationStarting({
      param($c, $n)
      if (-not (Test-RdmodulePage $n.Uri) -and -not $n.Uri.StartsWith('data:')) { $n.Cancel = $true; Open-WebLink $n.Uri }
    })
    $core.add_NavigationCompleted({
      param($c, $n)
      if (-not $n.IsSuccess -and $n.WebErrorStatus -ne 'OperationCanceled') {
        $c.NavigateToString(($RDMODULE_ERROR -f [System.Net.WebUtility]::HtmlEncode($env:RT_RDMODULE)))
      }
    })
  })
  $f.add_HandleCreated({ param($s) [RtWin]::DarkTitle($s.Handle) })
  $f.add_Shown({ param($s) $s.Controls[0].Source = [Uri]$env:RT_RDMODULE })
  $f.add_FormClosed({ param($s) $script:rdmodule = $null; $s.Dispose() })
  $f
}

function Show-RdmoduleWindow {
  if ($script:rdmodule) { Show-Front $script:rdmodule; return }
  if (-not $env:RT_RDMODULE -or -not (Test-WebView)) { return }
  $script:rdmodule = New-RdmoduleWindow
  Show-Form $script:rdmodule
}

# Without WebView2 there's no window, and the tracker doesn't open the page in a browser or stay in the tray: this
# pop-up says how to install WebView2, and closing it stops the tracker.
$WEBVIEW2_PAGE = 'https://developer.microsoft.com/microsoft-edge/webview2/'
$script:help = $null
function New-WebViewHelp {
  $ink = [System.Drawing.ColorTranslator]::FromHtml('#f3ead6')
  $f = New-Object System.Windows.Forms.Form
  $f.Text = $env:RT_TITLE
  $f.Icon = $icon
  $f.FormBorderStyle = 'FixedDialog'
  $f.MaximizeBox = $false
  $f.MinimizeBox = $false
  $f.StartPosition = 'CenterScreen'
  $f.BackColor = $background
  $f.ForeColor = $ink
  $f.Font = New-Object System.Drawing.Font('Segoe UI', 10)
  $f.AutoSize = $true
  $f.AutoSizeMode = 'GrowAndShrink'
  $panel = New-Object System.Windows.Forms.FlowLayoutPanel
  $panel.FlowDirection = 'TopDown'
  $panel.WrapContents = $false
  $panel.AutoSize = $true
  $panel.Padding = New-Object System.Windows.Forms.Padding(20, 16, 20, 16)
  $f.Controls.Add($panel)
  $text = {
    param($t, $color = $ink, $style = 'Regular', $size = 10)
    $l = New-Object System.Windows.Forms.Label
    $l.Text = $t
    $l.AutoSize = $true
    $l.MaximumSize = New-Object System.Drawing.Size(520, 0)
    $l.ForeColor = $color
    $l.Font = New-Object System.Drawing.Font('Segoe UI', $size, [System.Drawing.FontStyle]$style)
    $l.Margin = New-Object System.Windows.Forms.Padding(0, 0, 0, 10)
    $panel.Controls.Add($l)
  }
  & $text 'The window needs Microsoft Edge WebView2' ([System.Drawing.ColorTranslator]::FromHtml('#ffe08a')) 'Bold' 13
  & $text ("The tracker shows its window with Microsoft Edge WebView2, which isn't installed on this PC or isn't " +
    "working, so the tracker can't open. Install WebView2, then start the tracker again.")
  & $text '1. Open this address in your browser:'
  $row = New-Object System.Windows.Forms.FlowLayoutPanel
  $row.AutoSize = $true
  $row.WrapContents = $false
  $row.Margin = New-Object System.Windows.Forms.Padding(0, 0, 0, 10)
  $link = New-Object System.Windows.Forms.TextBox
  $link.Text = $WEBVIEW2_PAGE
  $link.ReadOnly = $true
  $link.Width = 400
  # buttons in the page's colors: gold for the main one, dark blue for the other
  $button = {
    param($label, $back, $fore, $border)
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $label
    $b.AutoSize = $true
    $b.FlatStyle = 'Flat'
    $b.BackColor = [System.Drawing.ColorTranslator]::FromHtml($back)
    $b.ForeColor = [System.Drawing.ColorTranslator]::FromHtml($fore)
    $b.FlatAppearance.BorderColor = [System.Drawing.ColorTranslator]::FromHtml($border)
    $b.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 10)
    $b.Padding = New-Object System.Windows.Forms.Padding(10, 2, 10, 2)
    $b.Cursor = 'Hand'
    $b
  }
  $copy = & $button 'Copy' '#2c3252' '#f3ead6' '#4a5280'
  $copy.add_Click({ [System.Windows.Forms.Clipboard]::SetText($WEBVIEW2_PAGE); $this.Text = 'Copied' })
  $row.Controls.AddRange(@($link, $copy))
  $panel.Controls.Add($row)
  & $text '2. Under Evergreen Bootstrapper, click Download, then run the downloaded file.'
  & $text '3. Start the tracker again.'
  $ok = & $button 'OK' '#f2b33d' '#3a2208' '#b9721a'
  $ok.add_Click({ $this.FindForm().Close() })
  $panel.Controls.Add($ok)
  $f.AcceptButton = $ok
  $f.ActiveControl = $ok
  $f.add_HandleCreated({ param($s) [RtWin]::DarkTitle($s.Handle) })
  $f.add_FormClosed({
    param($s)
    $script:help = $null
    $s.Dispose()
    Say 'no-webview-closed'
    [System.Windows.Forms.Application]::Exit()
  })
  $f
}

function Show-WebViewHelp {
  Say "no-webview $script:webview"
  $tray.Visible = $false
  if ($script:help) { Show-Front $script:help; return }
  $script:help = New-WebViewHelp
  Show-Form $script:help
}

function Show-TrackerWindow {
  if ($script:form) { Show-Front $script:form; return }
  if (-not (Test-WebView)) { Show-WebViewHelp; return }
  $script:form = New-TrackerWindow
  Show-Form $script:form
}

# The tray icon
$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $icon
$tray.Text = $env:RT_TITLE
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$open = $menu.Items.Add('Open tracker')
$open.Font = New-Object System.Drawing.Font($open.Font, [System.Drawing.FontStyle]::Bold)
$folder = $menu.Items.Add('Open data folder')
[void]$menu.Items.Add('-')
$quit = $menu.Items.Add('Quit the tracker')
$open.add_Click({ Show-TrackerWindow })
$folder.add_Click({ Start-Process explorer.exe -ArgumentList ('"' + $env:RT_DATA + '"') })
$quit.add_Click({ $tray.Visible = $false; Say 'quit'; [System.Windows.Forms.Application]::Exit() })
$tray.add_MouseClick({ param($s, $e) if ($e.Button -eq 'Left') { Show-TrackerWindow } })
$tray.ContextMenuStrip = $menu

$parent = [int]$env:RT_PARENT
$endSession = New-Object RtEndSession $parent

if ($env:RT_CHECK) {
  if (-not (Test-WebView)) {
    "webview: $script:webview"
    (New-WebViewHelp).Dispose()
    'help built'
  } else { 'built' }
  $tray.Dispose()
  exit 0
}

# Commands from the launcher and the page's answer, often; and every 2 seconds: exit when the tracker has ended, and
# report a change in whether Warcraft Rumble runs.
[RtInput]::Start()
$script:lastGame = ''
$script:ticks = 0
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 100
$timer.add_Tick({
  $line = $null
  while ([RtInput]::Lines.TryDequeue([ref]$line)) { if ($line -eq 'show') { Show-TrackerWindow } }
  if ($script:rdmoduleAsked) { $script:rdmoduleAsked = $false; Show-RdmoduleWindow }
  if ($script:closeNow -or ($script:closeAsked -and ([DateTime]::UtcNow - $script:closeAsked).TotalMilliseconds -gt $CLOSE_WAIT)) {
    Close-TrackerWindow
  }
  if (++$script:ticks % 20) { return }
  try { [void][System.Diagnostics.Process]::GetProcessById($parent) }
  catch { $tray.Visible = $false; [System.Windows.Forms.Application]::Exit(); return }
  $game = if ([System.Diagnostics.Process]::GetProcessesByName($env:RT_GAME).Length) { 'game 1' } else { 'game 0' }
  if ($game -ne $script:lastGame) { $script:lastGame = $game; Say $game }
})
$timer.Start()
if (Test-WebView) {
  $tray.Visible = $true
  Say 'ready'
  if ($env:RT_SHOW -eq '1') { Show-TrackerWindow }
} else {
  Show-WebViewHelp
}
[System.Windows.Forms.Application]::Run()
$tray.Dispose()
