// Windows programs the tracker runs. Full paths, so a program of the same name elsewhere on the PATH is never used.
import path from 'node:path';

// (desktop/launcher.cjs has its own copy of these two, as it runs before the app's files are unpacked)
const WINDOWS = process.env.SystemRoot || 'C:\\Windows';
const SYSTEM32 = path.join(WINDOWS, 'System32');

export const POWERSHELL = path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
export const REG = path.join(SYSTEM32, 'reg.exe');
export const TASKLIST = path.join(SYSTEM32, 'tasklist.exe');
export const EXPLORER = path.join(WINDOWS, 'explorer.exe');
export const TAR = path.join(SYSTEM32, 'tar.exe'); // (the tools unpack what they fetch with it)

/** PowerShell's arguments for running `script` without the user's profile or any prompt. */
export const powershellArgs = (script) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];
