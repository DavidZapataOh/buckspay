// index.js
import './polyfill'
import { AppRegistry } from 'react-native'
import 'expo-router/entry'
import { meshTask } from './src/features/mesh/task'

// The mesh service starts this task with the frames it scanned, also when the app has no screen open.
AppRegistry.registerHeadlessTask('mesh', () => meshTask({}))
