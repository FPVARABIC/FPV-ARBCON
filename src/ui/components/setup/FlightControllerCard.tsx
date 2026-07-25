/**
 * Pass 7.6c - Region 3 Flight-controller summary card. Shows EXACTLY the
 * quantities MSP_STATUS_EX's fixed prefix proves: average CPU load
 * (firmware-constrained 0..100%) as the primary value and the PID-task
 * cycle time in microseconds as support. The cumulative-since-boot i2c
 * error counter appears ONLY when nonzero, labeled with its real meaning
 * ("since startup") - never as a live fault indicator. Never "healthy" or
 * any other invented health category: a sensor-presence bit means
 * DETECTED, and nothing on this wire proves health.
 */

import React from 'react';
import {Text} from 'react-native';
import {useTranslation} from 'react-i18next';

import type {MspStatusExCompact} from '../../../core';
import type {TelemetryValue} from '../../../core';
import type {AuxTelemetryChannelState} from '../../../platforms/react-native/protocol';
import TelemetryCardFrame, {resolveAuxCardGate, telemetryCardContentStyles} from './TelemetryCardFrame';

export interface FlightControllerCardProps {
  connected: boolean;
  channelState: AuxTelemetryChannelState;
  telemetry: TelemetryValue<MspStatusExCompact>;
}

export default function FlightControllerCard({
  connected,
  channelState,
  telemetry,
}: FlightControllerCardProps): React.JSX.Element {
  const {t} = useTranslation();
  const title = t('telemetryCards.fc.title');
  const gate = resolveAuxCardGate(connected, channelState, telemetry.status);

  if (gate !== undefined || (telemetry.status !== 'FRESH' && telemetry.status !== 'STALE')) {
    return (
      <TelemetryCardFrame
        title={title}
        testIDPrefix="fc-card"
        gate={gate ?? 'unavailable'}
        stale={false}
        contentAccessibilityLabel=""
      />
    );
  }

  const status = telemetry.value;
  const cpuText = t('telemetryCards.fc.cpuLoad', {value: status.cpuLoadPercent});
  const cycleText = t('telemetryCards.fc.cycleTime', {value: status.cycleTimeUs});
  const i2cText = status.i2cErrorCount > 0 ? t('telemetryCards.fc.i2cErrors', {value: status.i2cErrorCount}) : undefined;

  return (
    <TelemetryCardFrame
      title={title}
      testIDPrefix="fc-card"
      gate={undefined}
      stale={telemetry.status === 'STALE'}
      contentAccessibilityLabel={`${title}، ${cpuText}، ${cycleText}${i2cText !== undefined ? `، ${i2cText}` : ''}`}>
      <Text style={telemetryCardContentStyles.primaryValueArabicText} testID="fc-card-cpu">
        {cpuText}
      </Text>
      <Text style={telemetryCardContentStyles.captionText} testID="fc-card-cycle">
        {cycleText}
      </Text>
      {i2cText !== undefined && (
        <Text style={telemetryCardContentStyles.captionText} testID="fc-card-i2c">
          {i2cText}
        </Text>
      )}
    </TelemetryCardFrame>
  );
}
