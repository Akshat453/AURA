// tooOpen reports whether a credential file can be read by other users.
// Windows has no Unix permission bits (access is controlled by NTFS ACLs), so
// the check applies only on Unix-like systems, where the files are created 0600.
export function tooOpen(stat) {
  if (process.platform === 'win32') return false
  return (stat.mode & 0o077) !== 0
}
