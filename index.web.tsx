/**
 * THE BROWSER ENTRY POINT.
 *
 * Uses AppRegistry rather than react-dom's createRoot directly. That is
 * not ceremony: react-native-web's AppRegistry.runApplication() is what
 * installs the style sheet its StyleSheet API compiles into, sets up the
 * root container's own layout defaults, and mounts under the same
 * AppContainer the rest of the library expects. Mounting <App/> with
 * ReactDOM alone renders unstyled boxes.
 *
 * The `App` specifier below resolves to App.web.tsx - vite.config.ts puts
 * `.web.tsx` ahead of `.tsx` in resolve.extensions, the same precedence
 * Metro applies in reverse for the Android build. Neither entry imports
 * the other.
 */

import {AppRegistry} from 'react-native';

import App from './App';
import {name as appName} from './app.json';

const rootTag = document.getElementById('root');
if (!rootTag) {
  // Fail loudly. A silent no-op here looks exactly like a blank page
  // caused by a JavaScript error, and would send anyone debugging it to
  // the wrong place entirely.
  throw new Error('index.web.tsx: no #root element in the document.');
}

AppRegistry.registerComponent(appName, () => App);
AppRegistry.runApplication(appName, {rootTag});
