/**
 * Windows desktop notifications.
 *
 * The watchdog has to reach the user *outside* the Mini App process, because the board is
 * on-demand: when the app is closed there is no screen showing "the boss went quiet".
 *
 * The mechanism is the WinRT toast API, which ships with Windows 10 and 11 — no extra
 * package, no account, no credential. A toast is addressed to an AppUserModelID; we borrow
 * the PowerShell console's, which is registered on every Windows install, so nothing has to
 * be registered or installed.
 *
 * The PowerShell is inlined rather than kept in a `.ps1` file on purpose: the Windows
 * scheduled task that runs the watchdog points at one file, and a second file would be one
 * more thing that can be missing or moved.
 */

import { execFile } from 'node:child_process';

/**
 * The AppUserModelID of the PowerShell console shortcut.
 *
 * It exists on every Windows install, so it is a valid toast target without installing
 * or registering anything.
 */
const POWERSHELL_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\Windows\\PowerShell\\v1.0\\powershell.exe';

/**
 * Escape text for inclusion in an XML text node.
 *
 * @param {string} value
 * @returns {string}
 */
function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Build the toast XML for a title and body.
 *
 * @param {{title:string, body:string}} message
 * @returns {string}
 */
export function buildToastXml(message) {
  return [
    '<toast activationType="foreground" duration="long">',
    '<visual>',
    '<binding template="ToastGeneric">',
    `<text>${escapeXml(message?.title)}</text>`,
    `<text>${escapeXml(message?.body)}</text>`,
    '</binding>',
    '</visual>',
    '</toast>',
  ].join('');
}

/**
 * The PowerShell that shows a toast.
 *
 * It reads the XML from a temp file rather than through the command line: command-line
 * quoting for XML with Chinese text and angle brackets is a reliable source of silent
 * breakage, and a file has no quoting rules at all.
 *
 * @param {string} xmlPath
 * @returns {string}
 */
function buildPowerShellScript(xmlPath) {
  const appId = POWERSHELL_APP_ID.replace(/\\/g, '\\\\');
  return `$ErrorActionPreference = 'Stop'
$xml = [System.IO.File]::ReadAllText('${xmlPath.replace(/'/g, "''")}', [System.Text.Encoding]::UTF8)
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null
$doc = New-Object Windows.Data.Xml.Dom.XmlDocument
$doc.LoadXml($xml)
$toast = New-Object Windows.UI.Notifications.ToastNotification $doc
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${appId}').Show($toast)
Write-Output 'TOAST_SENT'`;
}

/**
 * Show a desktop notification.
 *
 * @param {{title:string, body:string}} message
 * @param {{timeoutMs?:number}} [options]
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export function sendToast(message, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15_000;

  return new Promise((resolve) => {
    const script = buildPowerShellScript('__XML_PATH__');
    const runner = (xmlPath) => new Promise((inner) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script.replace('__XML_PATH__', xmlPath)],
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            inner({ ok: false, error: String(error.message || stderr || error).slice(0, 400) });
            return;
          }
          if (!String(stdout).includes('TOAST_SENT')) {
            inner({ ok: false, error: `toast 未确认投递: ${String(stdout || stderr).slice(0, 300)}` });
            return;
          }
          inner({ ok: true });
        },
      );
    });

    // The XML goes through a temp file so no shell ever has to quote it.
    import('node:fs/promises')
      .then(async (fs) => {
        const os = await import('node:os');
        const path = await import('node:path');
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mimic-toast-'));
        const file = path.join(dir, 'toast.xml');
        await fs.writeFile(file, buildToastXml(message), 'utf8');
        try {
          resolve(await runner(file));
        } finally {
          await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
        }
      })
      .catch((error) => resolve({ ok: false, error: String(error?.message ?? error).slice(0, 400) }));
  });
}
