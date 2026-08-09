/**
 * @jest-environment jsdom
 *
 * THE BROWSER MAP LINK.
 *
 * Two things are worth testing here and neither is cosmetic:
 *
 *  1. The URL is HTTPS OpenStreetMap, not `geo:`. Nothing in a browser
 *     handles `geo:`, so shipping the Android URL to the web would give
 *     the operator a button that does nothing at all.
 *  2. The new tab is opened with `noopener,noreferrer`. Without the
 *     first, the opened page gets a live handle back into a
 *     flight-controller configurator; without the second, the aircraft's
 *     position leaves in a Referer header. Both are one-word mistakes
 *     that no visual check would catch.
 */

import {buildMapUrl, openMapLocation} from './mapLink.web';

const RIYADH = {latitudeDegrees: 24.7136, longitudeDegrees: 46.6753};

describe('mapLink.web', () => {
  it('builds an HTTPS OpenStreetMap URL, never a geo: URI', () => {
    const url = buildMapUrl(RIYADH);

    expect(url.startsWith('https://www.openstreetmap.org/')).toBe(true);
    expect(url).not.toContain('geo:');
  });

  it('marks the exact coordinate and centres on it', () => {
    const url = buildMapUrl(RIYADH);

    // mlat/mlon place the marker; the #map fragment centres the view.
    // Supplying only the fragment centres without marking anything.
    expect(url).toContain('mlat=24.7136');
    expect(url).toContain('mlon=46.6753');
    expect(url).toContain('#map=16/24.7136/46.6753');
  });

  it('carries negative (southern/western) coordinates through intact', () => {
    const url = buildMapUrl({latitudeDegrees: -33.8688, longitudeDegrees: -70.6693});

    expect(url).toContain('mlat=-33.8688');
    expect(url).toContain('mlon=-70.6693');
  });

  it('opens a new tab with BOTH noopener and noreferrer', () => {
    const open = jest.spyOn(window, 'open').mockReturnValue(null);

    openMapLocation(RIYADH);

    expect(open).toHaveBeenCalledTimes(1);
    const [url, target, features] = open.mock.calls[0];
    expect(String(url)).toContain('openstreetmap.org');
    expect(target).toBe('_blank');
    expect(features).toContain('noopener');
    expect(features).toContain('noreferrer');

    open.mockRestore();
  });

  it('swallows a blocked pop-up instead of surfacing an error', () => {
    // A blocked pop-up is not an error about the GPS fix. Throwing here
    // would interrupt an operator mid-configuration over a convenience
    // link that failed for reasons the app cannot influence.
    const open = jest.spyOn(window, 'open').mockReturnValue(null);

    expect(() => openMapLocation(RIYADH)).not.toThrow();

    open.mockRestore();
  });
});
