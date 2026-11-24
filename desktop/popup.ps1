# The launcher's own pop-ups (desktop/launcher.cjs), shown before the tracker's page can be: the question of where the
# tracker keeps its files, the wait while they are moved, and messages. They look like the page's pop-ups: a dark box
# without Windows' frame, a gold title, the text in a lighter card, a gold button. The title drags the window.
# Environment: RT_KIND (ask, wait or message), RT_TITLE (the taskbar's name), RT_HEAD (the title), RT_TEXT, RT_FONT
# (the title's font file; Segoe UI without it), and for ask RT_FOLDER (the folder filled in) and RT_PROBLEM (why the
# last answer would not do). Prints "ok <folder>" for ask and "ok" for message when OK was pressed.
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
Add-Type -Namespace RtPopup -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
[DllImport("user32.dll")] public static extern bool ReleaseCapture();
[DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hwnd, int message, IntPtr w, IntPtr l);
'@

$color = { param($hex) [System.Drawing.ColorTranslator]::FromHtml($hex) }
$dark = & $color '#1b2036'; $card = & $color '#232842'; $line = & $color '#3d4363'; $ink = & $color '#f3efe6'
$gold = & $color '#f2b33d'; $goldLine = & $color '#6b5632'; $warn = & $color '#ff9a62'; $field = & $color '#14182b'
$text = New-Object System.Drawing.Font('Segoe UI', 9.75)
$bold = New-Object System.Drawing.Font('Segoe UI', 9.75, [System.Drawing.FontStyle]::Bold)
$title = New-Object System.Drawing.Font('Segoe UI', 13, [System.Drawing.FontStyle]::Bold)
try {
  if ($env:RT_FONT -and (Test-Path -LiteralPath $env:RT_FONT)) {
    $fonts = New-Object System.Drawing.Text.PrivateFontCollection
    $fonts.AddFontFile($env:RT_FONT)
    $title = New-Object System.Drawing.Font($fonts.Families[0], 14)
  }
} catch {
  # Segoe UI
}

# Rounded corners, for the window and what is in it
function Round($control, $radius) {
  $d = $radius * 2; $w = $control.Width; $h = $control.Height
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddArc(0, 0, $d, $d, 180, 90); $p.AddArc($w - $d, 0, $d, $d, 270, 90)
  $p.AddArc($w - $d, $h - $d, $d, $d, 0, 90); $p.AddArc(0, $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  $control.Region = New-Object System.Drawing.Region($p)
}
function Button($label, $main) {
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $label; $b.FlatStyle = 'Flat'; $b.Font = $bold; $b.Size = New-Object System.Drawing.Size(96, 32)
  $b.Cursor = [System.Windows.Forms.Cursors]::Hand
  if ($main) { $b.BackColor = $gold; $b.ForeColor = & $color '#3a2408'; $b.FlatAppearance.BorderSize = 0 }
  else { $b.BackColor = & $color '#2c3256'; $b.ForeColor = $ink; $b.FlatAppearance.BorderColor = & $color '#5a6190' }
  Round $b 10
  $b
}

$kind = $env:RT_KIND
$width = 540; $pad = 20; $inner = $width - 2 * $pad
$f = New-Object System.Windows.Forms.Form
$f.Text = $env:RT_TITLE; $f.FormBorderStyle = 'None'; $f.StartPosition = 'CenterScreen'; $f.BackColor = $dark
$f.ForeColor = $ink; $f.Font = $text; $f.TopMost = $true; $f.KeyPreview = $true
try { $f.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon($env:RT_EXE) } catch {}

$head = New-Object System.Windows.Forms.Label
$head.Text = $env:RT_HEAD; $head.Font = $title; $head.ForeColor = & $color '#ffd76a'; $head.UseCompatibleTextRendering = $true
$head.SetBounds($pad, 12, $inner, 32); $head.TextAlign = 'MiddleLeft'
$under = New-Object System.Windows.Forms.Panel
$under.BackColor = $goldLine; $under.SetBounds(0, 54, $width, 1)
# the title drags the window (WM_NCLBUTTONDOWN on the caption)
$drag = { param($s, $e) if ($e.Button -eq 'Left') { [void][RtPopup.Win]::ReleaseCapture()
  [void][RtPopup.Win]::SendMessage($f.Handle, 0xA1, [IntPtr]2, [IntPtr]::Zero) } }
$head.Add_MouseDown($drag); $f.Add_MouseDown($drag)

# the card with the text, as tall as the text needs
$box = New-Object System.Windows.Forms.Panel
$box.BackColor = $card
$body = New-Object System.Windows.Forms.Label
$body.Text = $env:RT_TEXT; $body.ForeColor = $ink
$flags = [System.Windows.Forms.TextFormatFlags]::WordBreak
$need = [System.Windows.Forms.TextRenderer]::MeasureText($body.Text, $text, (New-Object System.Drawing.Size(($inner - 32), 0)), $flags)
$body.SetBounds(16, 14, $inner - 32, $need.Height + 4)
$box.Controls.Add($body)
$y = $body.Bottom + 12

if ($kind -eq 'ask') {
  $t = New-Object System.Windows.Forms.TextBox
  $t.BorderStyle = 'FixedSingle'; $t.BackColor = $field; $t.ForeColor = $ink; $t.Text = $env:RT_FOLDER
  $t.SetBounds(16, $y + 3, $inner - 32 - 104, 26)
  $browse = Button 'Browse...' $false
  $browse.Location = New-Object System.Drawing.Point(($inner - 16 - 96), $y)
  Round $browse 10
  $browse.Add_Click({
    $d = New-Object System.Windows.Forms.FolderBrowserDialog
    $d.Description = 'The tracker makes a folder named RumbleTracker in the folder you pick.'
    if (Test-Path -LiteralPath $t.Text) { $d.SelectedPath = $t.Text }
    if ($d.ShowDialog($f) -eq 'OK') { $t.Text = $d.SelectedPath }
  })
  $box.Controls.AddRange(@($t, $browse))
  $y += 44
  if ($env:RT_PROBLEM) {
    $e = New-Object System.Windows.Forms.Label
    $e.Text = $env:RT_PROBLEM; $e.ForeColor = $warn
    $e.SetBounds(16, $y, $inner - 32, 38)
    $box.Controls.Add($e)
    $y += 42
  }
} elseif ($kind -eq 'wait') {
  # a gold block that runs along a dark track
  $track = New-Object System.Windows.Forms.Panel
  $track.BackColor = $field; $track.SetBounds(16, $y, $inner - 32, 10)
  $run = New-Object System.Windows.Forms.Panel
  $run.BackColor = $gold; $run.SetBounds(0, 0, 110, 10)
  $track.Controls.Add($run)
  $box.Controls.Add($track)
  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = 30
  $timer.Add_Tick({ $run.Left = if ($run.Left -gt $track.Width) { -$run.Width } else { $run.Left + 6 } })
  $timer.Start()
  $y += 22
}
$box.SetBounds($pad, 70, $inner, $y + 4)
Round $box 12
$bottom = $box.Bottom + 16
$f.Controls.AddRange(@($head, $under, $box))

if ($kind -ne 'wait') {
  $ok = Button 'OK' $true
  $ok.DialogResult = 'OK'
  $ok.Location = New-Object System.Drawing.Point(($width - $pad - 96), $bottom)
  $f.Controls.Add($ok); $f.AcceptButton = $ok
  if ($kind -eq 'ask') {
    $no = Button 'Cancel' $false
    $no.DialogResult = 'Cancel'
    $no.Location = New-Object System.Drawing.Point(($width - $pad - 96 - 104), $bottom)
    $f.Controls.Add($no); $f.CancelButton = $no
  } else { $f.CancelButton = $ok }
  $bottom += 32 + 18
}
$f.ClientSize = New-Object System.Drawing.Size($width, $bottom)
Round $f 14
# the window's own edge
$f.Add_Paint({ param($s, $e)
  $pen = New-Object System.Drawing.Pen($line, 2)
  $e.Graphics.SmoothingMode = 'AntiAlias'
  $d = 28; $w = $f.Width - 1; $h = $f.Height - 1
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddArc(0, 0, $d, $d, 180, 90); $p.AddArc($w - $d, 0, $d, $d, 270, 90)
  $p.AddArc($w - $d, $h - $d, $d, $d, 0, 90); $p.AddArc(0, $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  $e.Graphics.DrawPath($pen, $p)
})
$f.Add_Shown({ $f.Activate(); if ($kind -eq 'ask') { $t.Select(); $t.SelectionStart = $t.Text.Length } })
# PowerShell is started hidden, and Windows applies that to the first window shown. Showing it hidden once uses that
# up, so the window appears (as in desktop/window.ps1).
[void][RtPopup.Win]::ShowWindow($f.Handle, 0)
if ($f.ShowDialog() -eq 'OK') { [Console]::Out.Write($(if ($kind -eq 'ask') { 'ok ' + $t.Text.Trim() } else { 'ok' })) }
