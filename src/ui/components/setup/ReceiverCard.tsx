/**
 * Pass 7.6c - Region 3 Receiver summary card. Shows EXACTLY the one
 * receiver quantity MSP_ANALOG proves: RSSI as a percentage of the
 * verified 0..1023 wire range (auxTelemetrySemantics.ts). Latin "RSSI"
 * per the approved copy; never dBm (the wire value is not dBm), never
 * link quality (RSSI is not LQ), and a wire zero renders the approved
 * unavailable copy rather than a misleading "0%" - an unconfigured RSSI
 * source is indistinguishable from zero signal on this command alone.
 */

import React from 'react';
import {Text} from 'react-native';
import {useTranslation} from 'react-i18next';

import type {MspAnalog} from '../../../core';
import {deriveReceiverRssi} from '../../../core';
import type {TelemetryValue} from '../../../core';
import type {AuxTelemetryChannelState} from '../../../platforms/react-native/protocol';
import TelemetryCardFrame, {resolveAuxCardGate, telemetryCardContentStyles} from './TelemetryCardFrame';

export interface ReceiverCardProps {
  connected: boolean;
  channelState: AuxTelemetryChannelState;
  telemetry: TelemetryValue<MspAnalog>;
}

export default function ReceiverCard({connected, channelState, telemetry}: ReceiverCardProps): React.JSX.Element {
  const {t} = useTranslation();
  const title = t('telemetryCards.receiver.title');
  const gate = resolveAuxCardGate(connected, channelState, telemetry.status);

  if (gate !== undefined || (telemetry.status !== 'FRESH' && telemetry.status !== 'STALE')) {
    return (
      <TelemetryCardFrame
        title={title}
        testIDPrefix="receiver-card"
        gate={gate ?? 'unavailable'}
        stale={false}
        contentAccessibilityLabel=""
      />
    );
  }

  const rssi = deriveReceiverRssi(telemetry.value);
  const stale = telemetry.status === 'STALE';
  const bodyText =
    rssi.kind === 'PERCENT' ? t('telemetryCards.receiver.rssi', {percent: rssi.percent}) : t('telemetryCards.state.unavailable');
  /* SETUP P2: the live/stale distinction becomes its own SENTENCE rather
   * than only a dimmed opacity. P0 measured this card carrying 23
   * characters in the same footprint the Battery card fills with 96 -
   * it had room to say what it means, and "the number you are looking at
   * stopped updating" is exactly the thing an operator must not have to
   * infer from a shade of grey. */
  const linkText = t(stale ? 'telemetryCards.receiver.linkStale' : 'telemetryCards.receiver.linkLive');

  return (
    <TelemetryCardFrame
      title={title}
      testIDPrefix="receiver-card"
      gate={undefined}
      stale={stale}
      contentAccessibilityLabel={`${title}، ${linkText}، ${bodyText}`}>
      <Text style={telemetryCardContentStyles.captionText} testID="receiver-card-link-state">
        {linkText}
      </Text>
      {rssi.kind === 'PERCENT' ? (
        <Text style={telemetryCardContentStyles.primaryValueText} testID="receiver-card-rssi">
          {bodyText}
        </Text>
      ) : (
        <Text style={telemetryCardContentStyles.bodyText} testID="receiver-card-rssi-unavailable">
          {bodyText}
        </Text>
      )}
    </TelemetryCardFrame>
  );
}
