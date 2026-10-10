import { useState, useSyncExternalStore } from 'react'

/**
 * `useReducer` whose state can also be read at any moment, including between a dispatch and the render that
 * follows it. A ref copied from the state in an effect is stale for the effects of child components in the same
 * commit, which run first. The reducer runs when `dispatch` is called, and the state is held outside React.
 */
export function useSyncReducer<State, Action>(
  reducer: (state: State, action: Action) => State,
  initial: State,
): readonly [state: State, dispatch: (action: Action) => void, read: () => State] {
  const [store] = useState(() => createStore(reducer, initial))
  return [useSyncExternalStore(store.subscribe, store.read), store.dispatch, store.read]
}

function createStore<State, Action>(reducer: (state: State, action: Action) => State, initial: State) {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    read: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    dispatch(action: Action) {
      const next = reducer(state, action)
      if (Object.is(next, state)) return
      state = next
      for (const listener of [...listeners]) listener()
    },
  }
}
