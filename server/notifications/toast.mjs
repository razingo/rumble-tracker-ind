// Windows toast notifications via PowerShell and Windows.UI.Notifications. Title and text are passed as environment
// variables (never interpolated into the script) and XML-escaped.
// In the exe they are sent under the tracker's own app ID, and clicking one opens the tracker (host.mjs).
import { execFile } from 'node:child_process';
import { POWERSHELL, powershellArgs } from '../system.mjs';
import { host } from '../host.mjs';
import { APP_NAME, SECOND } from '../../web/scripts/lib/constants.js';

// Toasts need a registered app identity; PowerShell's is there on Windows 10 and 11 when the tracker's isn't.
const POWERSHELL_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';
const SCRIPT = `
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$t = [Security.SecurityElement]::Escape($env:RT_TITLE)
$b = [Security.SecurityElement]::Escape($env:RT_BODY)
$a = [Security.SecurityElement]::Escape($env:RT_ATTR)
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$l = if ($env:RT_LAUNCH) { " activationType='protocol' launch='" + [Security.SecurityElement]::Escape($env:RT_LAUNCH) + "'" } else { '' }
$text = "<text>$t</text><text>$b</text><text placement='attribution'>$a</text>"
$xml.LoadXml("<toast$l><visual><binding template='ToastGeneric'>$text</binding></visual></toast>")
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:RT_APP).Show($toast)
`;

/** Shows a notification. Resolves to true if Windows accepted it. */
export function showToast(title, body) {
  if (process.platform !== 'win32') return Promise.resolve(false);
  const id = host.notificationIdentity();
  return new Promise((resolve) => {
    execFile(POWERSHELL, powershellArgs(SCRIPT), {
      windowsHide: true,
      timeout: 15 * SECOND,
      env: { ...process.env, RT_TITLE: String(title).slice(0, 120), RT_BODY: String(body).slice(0, 400),
        RT_ATTR: APP_NAME, RT_APP: id.appId || POWERSHELL_APP_ID, RT_LAUNCH: id.launch || '' },
    }, (err) => resolve(!err));
  });
}

