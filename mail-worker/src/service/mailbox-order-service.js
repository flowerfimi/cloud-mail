import BizError from '../error/biz-error';
import { t } from '../i18n/i18n';

const incomingSql = `WITH incoming AS (
	SELECT json_extract(value, '$.id') AS id,
		json_extract(value, '$.pinned') AS pinned,
		json_extract(value, '$.sort') AS sort
	FROM json_each(?3)
)`;

// Evaluate this guard inside each statement of the same D1 transaction. A
// preflight read alone cannot protect against a concurrent add/delete/reorder.
const membershipGuard = `
	(SELECT COUNT(*) FROM account WHERE user_id = ?1 AND is_del = 0) = (SELECT COUNT(*) FROM incoming)
	AND NOT EXISTS (
		SELECT 1 FROM account WHERE user_id = ?1 AND is_del = 0
		AND account_id NOT IN (SELECT id FROM incoming)
	)`;

function invalidOrder() {
	return new BizError(t('invalidMailboxOrder'), 400);
}

function conflict() {
	return new BizError(t('mailboxOrderConflict'), 409);
}

const mailboxOrderService = {
	async get(c, userId) {
		// Read metadata and preference/version in one statement so the snapshot
		// never combines an old version with a newly committed arrangement.
		const { results } = await c.env.db.prepare(`SELECT
			u.email AS mainEmail, u.mailbox_main_first AS mainFirst,
			u.mailbox_order_version AS version,
			a.account_id AS accountId, a.email, a.name, a.status,
			a.latest_email_time AS latestEmailTime, a.create_time AS createTime,
			a.user_id AS userId, a.all_receive AS allReceive, a.sort,
			a.is_pinned AS isPinned, a.is_del AS isDel
			FROM user u LEFT JOIN account a ON a.user_id = u.user_id AND a.is_del = 0
			WHERE u.user_id = ? AND u.is_del = 0
			ORDER BY a.is_pinned DESC, a.sort DESC, a.account_id ASC`).bind(userId).all();
		if (!results.length) throw new BizError(t('authExpired'), 401);
		const { mainEmail, mainFirst, version } = results[0];
		const accounts = results.filter(row => row.accountId !== null).map(({ mainEmail, mainFirst, version, ...account }) => account);
		const mainAccountId = accounts.find(row => row.email.toLowerCase() === mainEmail.toLowerCase())?.accountId ?? null;
		const pinnedIds = accounts.filter(row => row.isPinned).map(row => row.accountId);
		const normalIds = accounts.filter(row => !row.isPinned).map(row => row.accountId);
		if (mainFirst && mainAccountId !== null) {
			const index = accounts.findIndex(row => row.accountId === mainAccountId);
			accounts.unshift(...accounts.splice(index, 1));
		}
		return { accounts, mainAccountId, mainFirst: Boolean(mainFirst), version, pinnedIds, normalIds };
	},

	async save(c, params, userId) {
		if (!params || typeof params !== 'object') throw invalidOrder();
		const { pinnedIds, normalIds, mainFirst, version } = params;
		if (!Array.isArray(pinnedIds) || !Array.isArray(normalIds)
			|| typeof mainFirst !== 'boolean' || !Number.isSafeInteger(version) || version < 0) throw invalidOrder();
		const ids = [...pinnedIds, ...normalIds];
		if (ids.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length) throw invalidOrder();
		const current = await this.get(c, userId);
		if (version !== current.version) throw conflict();
		const ownedIds = new Set(current.accounts.map(row => row.accountId));
		if (ids.some(id => !ownedIds.has(id))) throw new BizError(t('noUserAccount'), 403);
		if (ids.length !== ownedIds.size) throw conflict();
		const rows = [
			...pinnedIds.map((id, index) => ({ id, pinned: 1, sort: pinnedIds.length - index })),
			...normalIds.map((id, index) => ({ id, pinned: 0, sort: normalIds.length - index })),
		];
		const serialized = JSON.stringify(rows);
		const statements = [
			c.env.db.prepare(`${incomingSql}
				UPDATE account SET
					is_pinned = (SELECT pinned FROM incoming WHERE id = account.account_id),
					sort = (SELECT sort FROM incoming WHERE id = account.account_id)
				WHERE user_id = ?1 AND is_del = 0 AND ${membershipGuard}
				AND EXISTS (SELECT 1 FROM user WHERE user_id = ?1 AND is_del = 0 AND mailbox_order_version = ?2)`)
				.bind(userId, version, serialized),
			c.env.db.prepare(`${incomingSql}
				UPDATE user SET mailbox_main_first = ?4, mailbox_order_version = mailbox_order_version + 1
				WHERE user_id = ?1 AND is_del = 0 AND mailbox_order_version = ?2 AND ${membershipGuard}
				RETURNING mailbox_order_version`)
				.bind(userId, version, serialized, Number(mainFirst)),
		];
		const results = await c.env.db.batch(statements);
		if (!results[1].results.length) throw conflict();
		return this.get(c, userId);
	},

	async list(c, params, userId) {
		const accountId = Number(params.accountId ?? 0);
		const size = Math.min(Number(params.size ?? 30), 30);
		if (!Number.isSafeInteger(accountId) || accountId < 0 || !Number.isSafeInteger(size) || size < 1) throw invalidOrder();
		const { accounts } = await this.get(c, userId);
		// The anchor is resolved within the current user's complete display
		// order. This also supports old callers that only send lastSort + ID.
		const anchor = accountId === 0 ? -1 : accounts.findIndex(row => row.accountId === accountId);
		if (accountId !== 0 && anchor === -1) throw conflict();
		return accounts.slice(anchor + 1, anchor + 1 + size);
	},

	async setAsTop(c, params, userId) {
		const accountId = Number(params.accountId);
		if (!Number.isSafeInteger(accountId) || accountId <= 0) throw invalidOrder();
		const current = await this.get(c, userId);
		if (!current.accounts.some(row => row.accountId === accountId)) throw new BizError(t('noUserAccount'), 403);
		return this.save(c, {
			version: current.version,
			mainFirst: current.mainFirst,
			pinnedIds: [accountId, ...current.pinnedIds.filter(id => id !== accountId)],
			normalIds: current.normalIds.filter(id => id !== accountId),
		}, userId);
	},
};

export default mailboxOrderService;
