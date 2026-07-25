/**
 * Pass 7.6c - Region 3 GPS summary card. Shows the generic fix flag and
 * satellite count ONLY - coordinates never reach this component (the
 * compact decoded model cannot carry them; decodeRawGps.ts). The
 * "no fix yet" wording appears only when GPS presence is PROVEN by the
 * shared MSP_STATUS_EX sensor bit (a fix itself is also presence proof);
 * without proof the card shows the honest unavailable copy - zero
 * satellites alone never proves hardware absence, and no-fix is not an
 * error.
 */

import React from 'react';
import {Text} from 'react-native';
import {useTranslation} from 'react-i18next';

import type {MspRawGpsCompact} from '../../../core';
import {deriveGpsCard} from '../../../core';
import type {TelemetryValue} from '../../../core';
import type {AuxTelemetryChannelState} from '../../../platforms/react-native/protocol';
import TelemetryCardFrame, {resolveAuxCardGate, telemetryCardContentStyles} from './TelemetryCardFrame';

export interface GpsCardProps {
  connected: boolean;
  channelState: AuxTelemetryChannelState;
  telemetry: TelemetryValue<MspRawGpsCompact>;
  /** From the SHARED MSP_STATUS_EX decode (no duplicate command);
   * undefined = presence not provable right now. */
  gpsPresent: boolean | undefined;
}

export default function GpsCard({connected, channelState, telemetry, gpsPresent}: GpsCardProps): React.JSX.Element {
  const {t} = useTranslation();
  const title = t('telemetryCards.gps.title');
  const gate = resolveAuxCardGate(connected, channelState, telemetry.status);

  if (gate !== undefined || (telemetry.status !== 'FRESH' && telemetry.status !== 'STALE')) {
    return (
      <TelemetryCardFrame
        title={title}
        testIDPrefix="gps-card"
        gate={gate ?? 'unavailable'}
        stale={false}
        contentAccessibilityLabel=""
      />
    );
  }

  const card = deriveGpsCard(telemetry.value, gpsPresent);
  const stale = telemetry.status === 'STALE';

  if (card.kind === 'NO_PRESENCE_PROOF') {
    const unavailable = t('telemetryCards.state.unavailable');
    return (
      <TelemetryCardFrame
        title={title}
        testIDPrefix="gps-card"
        gate={undefined}
        stale={stale}
        contentAccessibilityLabel={`${title}، ${unavailable}`}>
        <Text style={telemetryCardContentStyles.bodyText} testID="gps-card-no-presence">
          {unavailable}
        </Text>
      </TelemetryCardFrame>
    );
  }

  const fixText = card.kind === 'FIX' ? t('telemetryCards.gps.fix') : t('telemetryCards.gps.noFix');
  const satellitesText = t('telemetryCards.gps.satellites', {value: card.satelliteCount});

  return (
    <TelemetryCardFrame
      title={title}
      testIDPrefix="gps-card"
      gate={undefined}
      stale={stale}
      contentAccessibilityLabel={`${title}، ${fixText}، ${satellitesText}`}>
      <Text style={telemetryCardContentStyles.bodyText} testID={card.kind === 'FIX' ? 'gps-card-fix' : 'gps-card-no-fix'}>
        {fixText}
      </Text>
      <Text style={telemetryCardContentStyles.captionText} testID="gps-card-satellites">
        {satellitesText}
      </Text>
    </TelemetryCardFrame>
  );
}
