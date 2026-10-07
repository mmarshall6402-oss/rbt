import { useQuery } from '@tanstack/react-query';
import type { ContactType, Credential, Edition, EntryKind, FieldworkType, MonthResult, Profile, ProgramResult } from '@fieldtrack/rules';
import { authHeaders } from './auth';
import { useSyncState, withPending } from './sync';

export type { MonthResult, ProgramResult };

export interface Me {
  id: string; email: string; fullName: string; role: 'trainee' | 'supervisor' | 'admin';
  bacbId: string | null; fieldworkType: FieldworkType | null; inviteCode: string | null;
  credential: Credential | null; rulesEdition: Edition | null; fieldworkState: string | null; fieldworkCountry: string | null; emailReminders: boolean;
}
export interface EntryInput {
  supervisorId: string; workDate: string; startTime: string; endTime: string; kind: EntryKind;
  restrictedMinutes: number; isGroup: boolean; contact: ContactType | null; format: 'in_person' | 'online' | null; description: string;
}
export interface EntryDto extends EntryInput { id: string; createdAt: string; updatedAt: string; pending?: boolean }
export interface Person { id: string; fullName: string; email: string; startsOn: string; endsOn: string | null }
export interface Supervisor extends Person { bacbId: string | null }
export interface Trainee extends Person { fieldworkType: FieldworkType | null; credential: Credential | null; rulesEdition: Edition | null }
export interface Verification { id: string; traineeId: string; supervisorId: string; month: string; rulesVersion: string; traineeSignedAt: string | null; supervisorSignedAt: string | null }

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const headers: Record<string, string> = { ...(await authHeaders()) };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText);
  return data as T;
}

/** Downloads an authenticated file (e.g. a PDF) without exposing tokens in a URL. */
export async function download(path: string, filename: string) {
  const res = await fetch(`/api${path}`, { headers: await authHeaders() });
  if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({}))).error ?? res.statusText);
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(await res.blob()), download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** The rules standard for a trainee record (null if incomplete). */
export const profileOf = (u: { fieldworkType: FieldworkType | null; credential: Credential | null; rulesEdition: Edition | null }): Profile | null =>
  u.fieldworkType && u.credential && u.rulesEdition ? { type: u.fieldworkType, credential: u.credential, edition: u.rulesEdition } : null;

export const homeFor = (role: Me['role']) => (role === 'supervisor' ? '/supervise' : '/app');

const q = (traineeId?: string) => (traineeId ? `&traineeId=${traineeId}` : '');

export const useMe = () => useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/me'), retry: false });
export function useEntries(month: string, traineeId?: string) {
  useSyncState(); // re-render when the outbox changes
  return useQuery({
    queryKey: ['entries', month, traineeId],
    queryFn: () => api<EntryDto[]>(`/entries?month=${month}${q(traineeId)}`),
    // Applied on every read (cached, offline or fresh), so a trainee's unsent changes never vanish.
    select: traineeId ? undefined : list => withPending(list, month),
  });
}
export interface Change {
  auditId: string; entryId: string; at: string; action: 'CREATE' | 'UPDATE' | 'DELETE'; workDate: string; minutesDelta: number;
  actor: { id: string; name: string } | null; changes: { field: string; from: unknown; to: unknown }[];
}
export const useChanges = (month: string, traineeId?: string) =>
  useQuery({ queryKey: ['changes', month, traineeId], queryFn: () => api<Change[]>(`/changes?month=${month}${q(traineeId)}`) });
export const useHistory = (entryId: string | null) =>
  useQuery({ queryKey: ['history', entryId], queryFn: () => api<Change[]>(`/entries/${entryId}/history`), enabled: !!entryId });
export const useMonth = (month: string, traineeId?: string) =>
  useQuery({ queryKey: ['month', month, traineeId], queryFn: () => api<MonthResult>(`/months/${month}?${q(traineeId).slice(1)}`) });
export const useProgress = (traineeId?: string) =>
  useQuery({ queryKey: ['progress', traineeId], queryFn: () => api<ProgramResult>(`/progress?${q(traineeId).slice(1)}`) });
export const useVerifications = (month: string, traineeId?: string) =>
  useQuery({ queryKey: ['verifications', month, traineeId], queryFn: () => api<Verification[]>(`/verifications?month=${month}${q(traineeId)}`) });
export const useSupervisors = () => useQuery({ queryKey: ['supervisors'], queryFn: () => api<Supervisor[]>('/supervisors') });
export const useTrainees = () => useQuery({ queryKey: ['trainees'], queryFn: () => api<Trainee[]>('/trainees') });
