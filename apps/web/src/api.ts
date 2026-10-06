import { useQuery } from '@tanstack/react-query';
import type { ContactType, EntryKind, FieldworkType, MonthResult, ProgramResult } from '@fieldtrack/rules';
import { authHeaders } from './auth';

export type { MonthResult, ProgramResult };

export interface Me {
  id: string; email: string; fullName: string; role: 'trainee' | 'supervisor' | 'admin';
  bacbId: string | null; fieldworkType: FieldworkType | null; inviteCode: string | null;
}
export interface EntryInput {
  supervisorId: string; workDate: string; startTime: string; endTime: string; kind: EntryKind;
  restrictedMinutes: number; isGroup: boolean; contact: ContactType | null; format: 'in_person' | 'online' | null; description: string;
}
export interface EntryDto extends EntryInput { id: string; createdAt: string; updatedAt: string }
export interface Person { id: string; fullName: string; email: string; startsOn: string; endsOn: string | null }
export interface Supervisor extends Person { bacbId: string | null }
export interface Trainee extends Person { fieldworkType: FieldworkType | null }
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

export const homeFor = (role: Me['role']) => (role === 'supervisor' ? '/supervise' : '/app');

const q = (traineeId?: string) => (traineeId ? `&traineeId=${traineeId}` : '');

export const useMe = () => useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/me'), retry: false });
export const useEntries = (month: string, traineeId?: string) =>
  useQuery({ queryKey: ['entries', month, traineeId], queryFn: () => api<EntryDto[]>(`/entries?month=${month}${q(traineeId)}`) });
export const useMonth = (month: string, traineeId?: string) =>
  useQuery({ queryKey: ['month', month, traineeId], queryFn: () => api<MonthResult>(`/months/${month}?${q(traineeId).slice(1)}`) });
export const useProgress = (traineeId?: string) =>
  useQuery({ queryKey: ['progress', traineeId], queryFn: () => api<ProgramResult>(`/progress?${q(traineeId).slice(1)}`) });
export const useVerifications = (month: string, traineeId?: string) =>
  useQuery({ queryKey: ['verifications', month, traineeId], queryFn: () => api<Verification[]>(`/verifications?month=${month}${q(traineeId)}`) });
export const useSupervisors = () => useQuery({ queryKey: ['supervisors'], queryFn: () => api<Supervisor[]>('/supervisors') });
export const useTrainees = () => useQuery({ queryKey: ['trainees'], queryFn: () => api<Trainee[]>('/trainees') });
