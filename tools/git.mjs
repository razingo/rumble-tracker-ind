// Git for the tools: GIT when set, else Git for Windows' usual place (it is often not on the PATH), else git.
export const GIT = process.env.GIT || (process.platform === 'win32' ? 'C:\\Program Files\\Git\\cmd\\git.exe' : 'git');
