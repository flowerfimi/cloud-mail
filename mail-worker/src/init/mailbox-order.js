// Keep fork migrations separate from upstream version numbers.
export async function migrateMailboxOrder(db) {
	const accountColumns = new Set((await db.prepare('PRAGMA table_info(account)').all()).results.map(row => row.name));
	const userColumns = new Set((await db.prepare('PRAGMA table_info(user)').all()).results.map(row => row.name));
	const statements = [];
	if (!accountColumns.has('is_pinned')) {
		statements.push(db.prepare('ALTER TABLE account ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0'));
		statements.push(db.prepare(`UPDATE account SET is_pinned = 1
			WHERE sort > 0 AND EXISTS (
				SELECT 1 FROM user WHERE user.user_id = account.user_id
				AND user.email COLLATE NOCASE <> account.email
			)`));
	}
	if (!userColumns.has('mailbox_main_first')) {
		statements.push(db.prepare('ALTER TABLE user ADD COLUMN mailbox_main_first INTEGER NOT NULL DEFAULT 1'));
	}
	if (!userColumns.has('mailbox_order_version')) {
		statements.push(db.prepare('ALTER TABLE user ADD COLUMN mailbox_order_version INTEGER NOT NULL DEFAULT 0'));
	}
	statements.push(db.prepare(`CREATE INDEX IF NOT EXISTS idx_account_mailbox_order
		ON account(user_id, is_del, is_pinned DESC, sort DESC, account_id ASC)`));
	// Schema changes and the one-time legacy backfill commit together.
	await db.batch(statements);
}
