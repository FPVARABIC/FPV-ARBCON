/**
 * THE INTENTIONAL DISCONNECT, and where session authority is allowed to
 * live.
 *
 * SETUP P1 (setupPresentationBoundary.test.ts) fences SetupScreen and
 * everything under src/ui/components/setup away from the coordinator,
 * clients and transports: they read session truth through the
 * setupPresentation facade and command through fcToolsController.
 * CLOSING a session was never Setup's capability, so it lives here - one
 * file over, in the same screens layer - and Setup consumes it as a
 * plain callback, exactly as it receives navigation callbacks from the
 * shell without importing the navigator.
 *
 * THE FAILURE ASYMMETRY IS THE POINT: close the transport session first,
 * and only a CONFIRMED close deactivates MSP ownership. Ownership
 * flipping INACTIVE is what the session-loss rule watches, so returning
 * to Home happens through that one shared safety rule rather than
 * through a second copy of it here. On failure nothing is deactivated -
 * native cleanup is unconfirmed - and the operator gets the same
 * localized Arabic error every transport failure uses.
 *
 * This file used to also host the connection workspace. It does not any
 * more: there is no connection screen in this application, and
 * connecting is a service Home drives (ui/session/useDirectConnect).
 */

import { useCallback } from 'react';
import { Alert } from 'react-native';
import { useTranslation } from 'react-i18next';

import { mspSessionCoordinator } from '../../platforms/react-native/protocol';
import {
  localizeTransportError,
  usbSerialTransportClient,
} from '../../platforms/react-native/transport';
import type { TransportError } from '../../platforms/react-native/transport';

export function useSetupSessionDisconnect(sessionId: string): () => void {
  const { t } = useTranslation();
  return useCallback(() => {
    (async () => {
      try {
        await usbSerialTransportClient.closeSession(sessionId);
        mspSessionCoordinator.deactivateMspSession(sessionId);
      } catch (error) {
        Alert.alert(
          t('setupTopBar.disconnectFailedTitle'),
          localizeTransportError(t, error as TransportError),
        );
      }
    })();
  }, [sessionId, t]);
}
