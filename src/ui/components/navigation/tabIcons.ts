import type {IconName} from '../../icons';
import type {MainTabKey} from '../../../navigation/tabs';

/**
 * The ONE tab→icon mapping, shared by BottomTabBar (phone) and
 * SideNavigationRail (desktop) so a destination is the same symbol on
 * every navigation surface.
 *
 * Chosen by MEANING, not decoration — the old unicode glyph map rendered
 * '⌁' for four different tabs (Setup, Receiver, VTX, Sensors), which is
 * the definition of an icon that communicates nothing:
 *
 *   compass            Setup — orientation/attitude is the screen's hero
 *   fan                Motors — rotor
 *   cable              Ports — physical UART wiring
 *   satellite          GPS
 *   settings-2         Configurations
 *   radio              Receiver — the RC link
 *   sliders-horizontal PID — tuning faders
 *   toggle-right       Modes — aux switches
 *   shield             Failsafe
 *   battery-charging   Power & battery
 *   monitor            OSD — the pilot's screen
 *   antenna            VTX — video transmitter
 *   zap                LED strip — the only glyph in the registry that
 *                      denotes light being emitted, and unused elsewhere
 *   activity           Sensors — live waveforms
 *   hard-drive         Blackbox — the storage the flight is written to
 *   package            Presets
 *   square-terminal    CLI
 */
export const TAB_ICONS: Record<MainTabKey, IconName> = {
  SETUP: 'compass',
  MOTORS: 'fan',
  PORTS: 'cable',
  GPS: 'satellite',
  CONFIGURATIONS: 'settings-2',
  RECEIVER: 'radio',
  PID: 'sliders-horizontal',
  MODES: 'toggle-right',
  FAILSAFE: 'shield',
  POWER: 'battery-charging',
  OSD: 'monitor',
  VTX: 'antenna',
  LED: 'zap',
  SENSORS: 'activity',
  BLACKBOX: 'hard-drive',
  PRESETS: 'package',
  CLI: 'square-terminal',
};
