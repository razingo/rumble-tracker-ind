// Windows programs the tracker runs. Full paths, so a program of the same name elsewhere on the PATH is never used.
import path from 'node:path';

const SYSTEM32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');

export const POWERSHELL = path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
export const REG = path.join(SYSTEM32, 'reg.exe');
export const TASKLIST = path.join(SYSTEM32, 'tasklist.exe');

/** PowerShell's arguments for running `script` without the user's profile or any prompt. */
export const powershellArgs = (script) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];
