import { QueryClient } from '@tanstack/react-query';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { createStore, del, get, set } from 'idb-keyval';
import { ApiError } from './api';
import { clearDeviceData, onServerChange } from './sync';

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

// After the outbox drains (or the server rejects a change), refetch server truth.
onServerChange(() => void queryClient.invalidateQueries());

/** Removes everything this app stored on the device (cache and unsent changes). */
export async function wipeDevice() {
  queryClient.clear();
  await Promise.all([persister.removeClient(), clearDeviceData()]);
}
