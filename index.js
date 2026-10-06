// index.js
import './polyfill'
import { AppRegistry } from 'react-native'
import 'expo-router/entry'
import { meshHandlers, serveInbound, syncRelay } from './src/features/mesh/headless'
import { meshTask } from './src/features/mesh/task'

// The mesh service starts this task with the frames it scanned and the phones that connected to it, also when the
// app has no screen open.
AppRegistry.registerHeadlessTask('mesh', () =>
  meshTask(meshHandlers(), { onUnlock: syncRelay, onChannel: serveInbound }),
)
