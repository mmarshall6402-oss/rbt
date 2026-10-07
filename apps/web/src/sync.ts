import { useSyncExternalStore } from 'react';
import { createStore, del, get, set } from 'idb-keyval';
import { api, ApiError, type EntryDto, type EntryInput } from './api';

/**
 * Offline-first outbox. Every change is saved to IndexedDB first, shown immediately, and uploaded in order.
 * Uploads use the idempotent PUT /entries/:id (client UUID), so a retry after a dropped connection
 * can never duplicate hours.
 */
export type Op =
  | { kind: 'put'; id: string; body: EntryInput; queuedAt: number }
  | { kind: 'delete'; id: string; queuedAt: number };
export interface Rejected { id: string; message: string; at: number }
export interface SyncState { status: 'synced' | 'syncing' | 'offline' | 'error'; pending: number; rejected: Rejected[]; version: number }

const store = createStore('fieldtrack-sync', 'outbox');
let queue: Op[] = [];
let state: SyncState = { status: 'synced', pending: 0, rejected: [], version: 0 };
const listeners = new Set<() => void>();
const changeHandlers = new Set<() => void>();
let retryTimer: ReturnType<typeof setTimeout> | undefined, retryDelay = 2000, flushing = false;

const emit = (patch: Partial<SyncState>) => { state = { ...state, ...patch, pending: queue.length, version: state.version + 1 }; listeners.forEach(l => l()) };
const persist = () => set('queue', queue, store);
const ready = get<Op[]>('queue', store).then(q => { queue = q ?? []; emit({}); void flush() }).catch(() => { /* IndexedDB blocked: memory only */ });

export const useSyncState = () => useSyncExternalStore(cb => (listeners.add(cb), () => listeners.delete(cb)), () => state);
/** Called after the queue drains or an op is rejected, so callers can refetch server truth. */
export const onServerChange = (fn: () => void) => (changeHandlers.add(fn), () => changeHandlers.delete(fn));
/** Called the moment the server confirms an op, so cached lists hold the entry before it leaves the outbox. */
type Confirmed = { kind: 'put'; entry: EntryDto } | { kind: 'delete'; id: string };
const confirmHandlers = new Set<(c: Confirmed) => void>();
export const onConfirmed = (fn: (c: Confirmed) => void) => (confirmHandlers.add(fn), () => confirmHandlers.delete(fn));
export const pendingOps = () => queue;

export async function enqueue(op: Op) {
  await ready;
  // Coalesce: a newer save of the same entry replaces an older one that hasn't uploaded yet.
  const i = op.kind === 'put' ? queue.findIndex((q, idx) => idx > 0 && q.kind === 'put' && q.id === op.id) : -1;
  if (i > 0) queue[i] = op; else queue.push(op);
  await persist();
  emit({});
  void flush();
}

export async function flush() {
  if (flushing) return;
  await ready;
  if (!queue.length) return emit({ status: 'synced' });
  flushing = true;
  clearTimeout(retryTimer);
  emit({ status: 'syncing' });
  try {
    while (queue.length) {
      const op = queue[0]!;
      try {
        if (op.kind === 'put') {
          const { entry } = await api<{ entry: EntryDto }>(`/entries/${op.id}`, 'PUT', op.body);
          confirmHandlers.forEach(fn => fn({ kind: 'put', entry }));
        } else {
          await api(`/entries/${op.id}`, 'DELETE');
          confirmHandlers.forEach(fn => fn({ kind: 'delete', id: op.id }));
        }
      } catch (err) {
        const permanent = err instanceof ApiError && err.status >= 400 && err.status < 500 && ![401, 408, 429].includes(err.status);
        if (!permanent) {
          // Network down or server hiccup: keep the op, back off, try again.
          emit({ status: navigator.onLine ? 'error' : 'offline' });
          retryTimer = setTimeout(() => void flush(), retryDelay);
          retryDelay = Math.min(retryDelay * 2, 60_000);
          return;
        }
        // The server refused this change (e.g. the month is locked): drop it and tell the user.
        emit({ rejected: [...state.rejected, { id: op.id, message: (err as Error).message, at: Date.now() }] });
      }
      queue.shift();
      await persist();
      emit({});
    }
    retryDelay = 2000;
    emit({ status: 'synced' });
    changeHandlers.forEach(fn => fn());
  } finally {
    flushing = false;
  }
}

export const dismissRejected = (id: string) => emit({ rejected: state.rejected.filter(r => r.id !== id) });

/** Server list + this device's unsent changes, so pending work never disappears on refetch or reload. */
export function withPending(list: EntryDto[], month: string): EntryDto[] {
  let out = list;
  for (const op of queue) {
    out = out.filter(e => e.id !== op.id);
    if (op.kind === 'put' && op.body.workDate.startsWith(month)) {
      const prev = list.find(e => e.id === op.id);
      out = [...out, { ...op.body, id: op.id, createdAt: prev?.createdAt ?? new Date(op.queuedAt).toISOString(), updatedAt: new Date(op.queuedAt).toISOString(), pending: true }];
    }
  }
  return out.sort((a, b) => (b.workDate + b.startTime).localeCompare(a.workDate + a.startTime));
}

/** Wipes on-device data at sign-out (it can include client notes). */
export async function clearDeviceData() {
  queue = [];
  await del('queue', store).catch(() => {});
  emit({ status: 'synced', rejected: [] });
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { retryDelay = 2000; void flush() });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void flush() });
}
