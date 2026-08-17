/**
 * VID, PID AND DRIVER ARE DEVELOPER FACTS.
 *
 * An operator picks a flight controller by its name. Four hex fields
 * under every device row turned the connection surface into a hardware
 * inventory, which is the opposite of what someone wants when they have
 * just pressed "فتح إعدادات متحكم الطيران".
 *
 * They are not deleted - a developer diagnosing a driver problem needs
 * exactly these - they are one tap away behind a disclosure, and the
 * primary surface stays compact.
 */

import * as fs from 'fs';
import * as path from 'path';

import ar from '../../../i18n/locales/ar.json';

const ROW = fs.readFileSync(path.join(__dirname, 'UsbDeviceRow.tsx'), 'utf8');
const EXECUTABLE = ROW.replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('technical identity is disclosed, not displayed', () => {
  it('is collapsed unless the row is selected AND the operator asked', () => {
    expect(EXECUTABLE).toContain('(!selected || !technicalOpen) && styles.detailsCollapsed');
    expect(EXECUTABLE).toContain("detailsCollapsed: {\n    display: 'none',");
  });

  it('starts closed', () => {
    expect(EXECUTABLE).toContain('useState(false)');
  });

  it('offers a real control to open it', () => {
    expect(EXECUTABLE).toContain('device-technical-toggle');
    expect(EXECUTABLE).toContain('setTechnicalOpen(open => !open)');
    // Announced to assistive technology as an expander, not a mystery.
    expect(EXECUTABLE).toContain('accessibilityState={{expanded: technicalOpen}}');
  });

  it('names both states in Arabic', () => {
    expect(ar.devices.showTechnical).toContain('التفاصيل التقنية');
    expect(ar.devices.hideTechnical).toContain('التفاصيل التقنية');
  });
});

describe('nothing was removed, only relocated', () => {
  it('still renders driver, VID, PID and port count', () => {
    for (const key of ['devices.driverType', 'devices.vid', 'devices.pid', 'devices.portCount']) {
      expect(EXECUTABLE).toContain(key);
    }
    expect(EXECUTABLE).toContain('formatHex(device.vendorId)');
    expect(EXECUTABLE).toContain('formatHex(device.productId)');
  });

  it('keeps the product name as the primary identifier', () => {
    // What the operator actually chooses by.
    expect(EXECUTABLE).toContain('usbProductLabel');
    expect(EXECUTABLE).toContain('styles.productName');
  });

  it('keeps the supported/unsupported verdict on the primary surface', () => {
    // That one DOES change what the operator can do, so it stays visible.
    expect(EXECUTABLE).toContain("t('devices.supported')");
    expect(EXECUTABLE).toContain("t('devices.unsupported')");
  });
});
