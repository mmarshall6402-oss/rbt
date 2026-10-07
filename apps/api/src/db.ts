import { CamelCasePlugin, Kysely, PostgresDialect, type Generated, type Selectable } from 'kysely';
import pg from 'pg';
import type { ContactType, Credential, Edition, EntryKind, FieldworkType } from '@fieldtrack/rules';

// Keep dates/times as strings so they match the rules package exactly (no timezone shifts).
pg.types.setTypeParser(1082, v => v); // date -> 'YYYY-MM-DD'
pg.types.setTypeParser(1083, v => v.slice(0, 5)); // time -> 'HH:MM'

export type Role = 'trainee' | 'supervisor' | 'admin';
export type SupervisionFormat = 'in_person' | 'online';

export interface DB {
  users: {
    id: Generated<string>;
    cognitoSub: string;
    email: string;
    fullName: string;
    role: Role;
    bacbId: string | null;
    fieldworkType: FieldworkType | null;
    credential: Credential | null;
    rulesEdition: Edition | null;
    fieldworkState: string | null;
    fieldworkCountry: string | null;
    emailReminders: Generated<boolean>;
    inviteCode: string | null;
    createdAt: Generated<Date>;
  };
  supervisions: {
    id: Generated<string>;
    traineeId: string;
    supervisorId: string;
    organizationId: string | null;
    startsOn: string;
    endsOn: string | null;
    createdAt: Generated<Date>;
  };
  entries: {
    id: Generated<string>;
    traineeId: string;
    supervisorId: string;
    organizationId: string | null;
    workDate: string;
    startTime: string;
    endTime: string;
    kind: EntryKind;
    restrictedMinutes: number;
    isGroup: boolean;
    contact: ContactType | null;
    format: SupervisionFormat | null;
    description: string;
    createdAt: Generated<Date>;
    updatedAt: Generated<Date>;
    deletedAt: Date | null;
  };
  monthVerifications: {
    id: Generated<string>;
    traineeId: string;
    supervisorId: string;
    month: string;
    fieldworkType: FieldworkType;
    rulesVersion: string;
    summary: unknown;
    traineeSignedAt: Date | null;
    supervisorSignedAt: Date | null;
    traineeSignature: string | null;
    supervisorSignature: string | null;
    attestation: string | null;
    pdfS3Key: string | null;
    createdAt: Generated<Date>;
  };
  remindersSent: {
    userId: string;
    kind: string;
    sentAt: Generated<Date>;
  };
  auditLog: {
    id: Generated<string>;
    tableName: string;
    rowId: string;
    action: string;
    actorId: string | null;
    oldRow: unknown;
    newRow: unknown;
    at: Generated<Date>;
  };
}

export type User = Selectable<DB['users']>;

export const createDb = (conn: string | pg.PoolConfig) =>
  new Kysely<DB>({ dialect: new PostgresDialect({ pool: new pg.Pool({ ...(typeof conn === 'string' ? { connectionString: conn } : conn), max: 10 }) }), plugins: [new CamelCasePlugin()] });
