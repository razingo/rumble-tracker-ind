# Windows integration of RumbleTracker.exe, run by desktop/launcher.cjs at each start (current user only):
# - a Start menu shortcut with the tracker's app ID, so its notifications show under its own name and icon;
# - the rumble-tracker: link type, which starts the exe: clicking a notification opens the tracker;
# - after an update (RT_REFRESH=1), asks Explorer to redraw the exe's icon (it caches icons by path).
# Writes "shortcut", "protocol" and "icon" lines for what succeeded; errors go to standard error.
# Environment: RT_EXE (the exe), RT_AUMID (app ID), RT_TITLE (shortcut name), RT_REFRESH.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

[ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IShellLinkW {
  void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder file, int size, IntPtr data, uint flags);
  void GetIDList(out IntPtr list);
  void SetIDList(IntPtr list);
  void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder name, int size);
  void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string name);
  void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder dir, int size);
  void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string dir);
  void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder args, int size);
  void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string args);
  void GetHotkey(out short key);
  void SetHotkey(short key);
  void GetShowCmd(out int cmd);
  void SetShowCmd(int cmd);
  void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int size, out int index);
  void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string path, int index);
  void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
  void Resolve(IntPtr window, uint flags);
  void SetPath([MarshalAs(UnmanagedType.LPWStr)] string file);
}

[ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPropertyStore {
  void GetCount(out uint count);
  void GetAt(uint index, out PropertyKey key);
  void GetValue(ref PropertyKey key, out PropVariant value);
  void SetValue(ref PropertyKey key, ref PropVariant value);
  void Commit();
}

[StructLayout(LayoutKind.Sequential, Pack = 4)]
public struct PropertyKey { public Guid fmtid; public uint pid; }

[StructLayout(LayoutKind.Explicit)]
public struct PropVariant { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr value; }

[ComImport, Guid("00021401-0000-0000-C000-000000000046")]
class CShellLink { }

public static class RtIntegration {
  // a shortcut to exe whose System.AppUserModel.ID is aumid
  public static void Shortcut(string lnk, string exe, string aumid, string description) {
    var link = (IShellLinkW)new CShellLink();
    link.SetPath(exe);
    link.SetWorkingDirectory(System.IO.Path.GetDirectoryName(exe));
    link.SetDescription(description);
    link.SetIconLocation(exe, 0);
    var store = (IPropertyStore)link;
    var key = new PropertyKey { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };
    var value = new PropVariant { vt = 31, value = Marshal.StringToCoTaskMemUni(aumid) }; // VT_LPWSTR
    try { store.SetValue(ref key, ref value); store.Commit(); } finally { Marshal.FreeCoTaskMem(value.value); }
    ((IPersistFile)link).Save(lnk, true);
  }

  [DllImport("shell32.dll")]
  static extern void SHChangeNotify(int eventId, uint flags, IntPtr item1, IntPtr item2);
  public static void RefreshIcon(string path) {
    var p = Marshal.StringToHGlobalUni(path);
    try { SHChangeNotify(0x00002000, 0x0005, p, IntPtr.Zero); } finally { Marshal.FreeHGlobal(p); } // SHCNE_UPDATEITEM, SHCNF_PATHW
    SHChangeNotify(0x08000000, 0, IntPtr.Zero, IntPtr.Zero); // SHCNE_ASSOCCHANGED
  }
}
'@

$exe = $env:RT_EXE
try {
  $lnk = Join-Path ([Environment]::GetFolderPath('Programs')) "$($env:RT_TITLE).lnk"
  [RtIntegration]::Shortcut($lnk, $exe, $env:RT_AUMID, $env:RT_TITLE)
  'shortcut'
} catch { [Console]::Error.WriteLine("shortcut: $_") }
try {
  $key = 'HKCU:\Software\Classes\rumble-tracker'
  New-Item -Path "$key\shell\open\command" -Force | Out-Null
  Set-Item -Path $key -Value 'URL:Rumble Collection Tracker'
  New-ItemProperty -Path $key -Name 'URL Protocol' -Value '' -Force | Out-Null
  Set-Item -Path "$key\shell\open\command" -Value ('"' + $exe + '" --open "%1"')
  'protocol'
} catch { [Console]::Error.WriteLine("protocol: $_") }
if ($env:RT_REFRESH -eq '1') {
  try { [RtIntegration]::RefreshIcon($exe); 'icon' } catch { [Console]::Error.WriteLine("icon: $_") }
}
