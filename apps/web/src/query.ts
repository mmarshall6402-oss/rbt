import { QueryClient } from '@tanstack/react-query';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { createStore, del, get, set } from 'idb-keyval';
import { ApiError, type EntryDto } from './api';
import { clearDeviceData, onConfirmed, onServerChange } from './sync';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 0, // show cached data instantly, then always refresh it (restored cache must never pass as fresh)
      gcTime: 7 * 24 * 3600_000, // keep cached data long enough to open the app offline
      networkMode: 'offlineFirst',
      retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
    },
  },
});

// Cached server data lives in IndexedDB so the app opens with data even with no connection.
const idb = createStore('fieldtrack-cache', 'queries');
export const persister = createAsyncStoragePersister({
  storage: { getItem: k => get(k, idb), setItem: (k, v) => set(k, v, idb), removeItem: k => del(k, idb) },
  throttleTime: 250,
});

// Write each confirmed change into the cached lists right away. Otherwise an entry would vanish from
// the screen between leaving the outbox and the refetch landing (and stay gone if the connection drops then).
onConfirmed(c => {
  for (const [key, list] of queryClient.getQueriesData<EntryDto[]>({ queryKey: ['entries'] })) {
    if (!list || key[2]) continue; // trainee's own lists only
    const id = c.kind === 'put' ? c.entry.id : c.id;
    const rest = list.filter(e => e.id !== id);
    queryClient.setQueryData(key, c.kind === 'put' && c.entry.workDate.startsWith(String(key[1])) ? [...rest, c.entry] : rest);
  }
});

// After the outbox drains (or the server rejects a change), refetch server truth.
onServerChange(() => void queryClient.invalidateQueries());

export const persistOptions = {
  persister,
  maxAge: 7 * 24 * 3600_000,
  buster: 'v1',
  dehydrateOptions: {
    // Keep any query that has data, even if its latest refresh failed (e.g. the connection dropped right
    // after a sync). The default keeps only successful queries, so an offline reload lost the account.
    shouldDehydrateQuery: (q: { state: { data: unknown } }) => q.state.data !== undefined,
  },
};

/** Removes everything this app stored on the device (cache and unsent changes). */
export async function wipeDevice() {
  queryClient.clear();
  await Promise.all([persister.removeClient(), clearDeviceData()]);
}
