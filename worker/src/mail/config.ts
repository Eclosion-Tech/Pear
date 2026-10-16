/** Per-connection settings come from the active Pear workspace, not env defaults. */
export interface MailConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  inboxFolder: string;
  sentFolder?: string;
  backfill: number;
  batchSize: number;
  maxMessageBytes: number;
  accountKey: string;
}
export interface Cursor { uidValidity: string; lastUid: number }
