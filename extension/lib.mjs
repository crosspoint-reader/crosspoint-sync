/**
 * Shared, dependency-free helpers for the CrossPoint Kindle Link extension.
 * Runs in a Manifest V3 service worker (no DOM guaranteed) and in Node for tests.
 *
 * The extension is AUTH-ONLY: it registers the device credential (unsigned
 * calls) and uploads it. All signed Whispersync traffic (library of purchased
 * books, reading positions) is the SERVER's job — it holds the credential and
 * speaks Fiona/CDE itself. Sideloaded (Send-to-Kindle) docs are matched by
 * pasting their ASIN on the dashboard's match page. See docs/design/kindle-sync.md.
 */

export function escapeXml(v) {
  return String(v)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function registrationBody({ email, password, serial, deviceName, deviceType, softwareVersion }) {
  return (
    `<request><parameters>` +
    `<deviceType>${deviceType}</deviceType>` +
    `<deviceSerialNumber>${escapeXml(serial)}</deviceSerialNumber>` +
    `<email>${escapeXml(email)}</email>` +
    `<password>${escapeXml(password)}</password>` +
    `<deviceName>${escapeXml(deviceName)}</deviceName>` +
    `<pid>510FD7ED</pid>` +
    `<softwareVersion>${softwareVersion}</softwareVersion>` +
    `<os_version>5.0</os_version>` +
    `<device_model>Android Phone</device_model>` +
    `</parameters><softwareVersions>` +
    `<softwareVersion name="oem_vendor" value="Kindle"/>` +
    `<softwareVersion name="oem_platform" value="Redding"/>` +
    `<softwareVersion name="oem_version" value="kindle-android-20"/>` +
    `</softwareVersions></request>`
  );
}

/** One tag's text from flat Amazon XML (CDATA-tolerant). */
export function xmlField(xml, tag) {
  const m = new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`).exec(xml);
  return m?.[1]?.trim() ?? '';
}

export function parseRegisterResponseXml(xml) {
  const adpToken = xmlField(xml, 'adp_token');
  const privateKey = xmlField(xml, 'device_private_key');
  if (!adpToken || !privateKey) {
    const message = xmlField(xml, 'message') || xmlField(xml, 'error');
    throw new Error(message || 'Amazon did not return device credentials');
  }
  return { adpToken, privateKey, deviceName: xmlField(xml, 'user_device_name') };
}

