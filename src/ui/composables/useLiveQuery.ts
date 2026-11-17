import { liveQuery } from 'dexie';
import { onScopeDispose, shallowRef, watch, type Ref, type WatchSource } from 'vue';

/**
 * Exposes a Dexie query as a ref that updates whenever the underlying tables change.
 * Re-subscribes when any of `deps` changes (e.g. a route param). `loaded` turns true once the
 * query has answered (or failed), so an answer of undefined can be told from no answer yet.
 */
export function useLiveQuery<T>(
  query: () => Promise<T>,
  deps: WatchSource[] = [],
): { data: Ref<T | undefined>; error: Ref<unknown>; loaded: Ref<boolean> } {
  const data = shallowRef<T>();
  const error = shallowRef<unknown>();
  const loaded = shallowRef(false);
  let unsubscribe: (() => void) | undefined;

  const subscribe = () => {
    unsubscribe?.();
    const sub = liveQuery(query).subscribe({
      next: (value) => {
        data.value = value;
        error.value = undefined;
        loaded.value = true;
      },
      error: (e: unknown) => {
        error.value = e;
        loaded.value = true;
      },
    });
    unsubscribe = () => sub.unsubscribe();
  };

  subscribe();
  if (deps.length) watch(deps, subscribe);
  onScopeDispose(() => unsubscribe?.());
  return { data, error, loaded };
}
