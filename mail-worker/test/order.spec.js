import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import mailboxOrderService from '../src/service/mailbox-order-service';
import { api, createUser, initialize, legacyPages, ok, orderPayload, rawOrderState, seedAccounts } from './helpers';

describe('Mailbox order API with isolated D1 and KV', () => {
	let admin;
	beforeAll(async () => {
		await initialize();
		admin = await createUser();
	});

	it('defaults to a fixed main mailbox and persists preferences across login sessions', async () => {
		const snapshot = await ok('/account/order', { token: admin.token });
		expect(snapshot.mainAccountId).toBe(admin.mainAccountId);
		expect(snapshot.mainFirst).toBe(true);
		expect(snapshot.pinnedIds).toEqual([]);
		expect(snapshot.normalIds).toEqual([admin.mainAccountId]);
		const saved = await ok('/account/order', {
			token: admin.token, method: 'PUT', body: orderPayload(snapshot, { mainFirst: false }),
		});
		expect(saved.version).toBeGreaterThan(snapshot.version);
		const { token } = await ok('/login', { method: 'POST', body: admin.credentials });
		const reloaded = await ok('/account/order', { token });
		expect(reloaded.mainFirst).toBe(false);
		expect(reloaded.version).toBe(saved.version);
	});

	it.each([1, 26, 30, 31, 61])('retains complete ordering and legacy pagination for %i mailboxes', async count => {
		const ids = await seedAccounts(admin.userId, count - 1);
		const snapshot = await ok('/account/order', { token: admin.token });
		expect(snapshot.accounts).toHaveLength(count);
		const pinnedIds = ids.filter((_, index) => index % 3 === 1).reverse();
		const normalIds = ids.filter(id => !pinnedIds.includes(id)).reverse();
		const saved = await ok('/account/order', {
			token: admin.token, method: 'PUT', body: orderPayload(snapshot, { pinnedIds, normalIds }),
		});
		expect(saved.pinnedIds).toEqual(pinnedIds);
		expect(saved.normalIds).toEqual(normalIds);
		const pages = await legacyPages(admin.token);
		const expected = [admin.mainAccountId, ...pinnedIds, ...normalIds.filter(id => id !== admin.mainAccountId)];
		expect(pages.map(row => row.accountId)).toEqual(expected);
		expect(new Set(pages.map(row => row.accountId)).size).toBe(count);
		expect(pages.every(row => Number(row.isPinned) === Number(pinnedIds.includes(row.accountId)))).toBe(true);
	});

	it('preserves the main mailbox underlying group and rank when its fixed position is toggled', async () => {
		const [main, first, second] = await seedAccounts(admin.userId, 2);
		const snapshot = await ok('/account/order', { token: admin.token });
		const moved = await ok('/account/order', {
			token: admin.token, method: 'PUT', body: orderPayload(snapshot, {
				mainFirst: false, pinnedIds: [first, main], normalIds: [second],
			}),
		});
		expect((await legacyPages(admin.token)).map(row => row.accountId)).toEqual([first, main, second]);
		const fixed = await ok('/account/order', {
			token: admin.token, method: 'PUT', body: orderPayload(moved, { mainFirst: true }),
		});
		expect(fixed.pinnedIds).toEqual([first, main]);
		expect((await legacyPages(admin.token)).map(row => row.accountId)).toEqual([main, first, second]);
		await ok('/account/order', {
			token: admin.token, method: 'PUT', body: orderPayload(fixed, { mainFirst: false }),
		});
		expect((await legacyPages(admin.token)).map(row => row.accountId)).toEqual([first, main, second]);
	});

	it('moves items across groups, supports empty groups, and leaves messages unchanged', async () => {
		const [main, first, second, third] = await seedAccounts(admin.userId, 3);
		await env.db.prepare('INSERT INTO email (account_id, user_id, subject, text, content) VALUES (?, ?, ?, ?, ?)')
			.bind(second, admin.userId, 'Keep this message', 'Original plain text', '<p>Original HTML</p>').run();
		const before = await env.db.prepare('SELECT * FROM email').all();
		let snapshot = await ok('/account/order', { token: admin.token });
		snapshot = await ok('/account/order', {
			token: admin.token, method: 'PUT', body: orderPayload(snapshot, {
				mainFirst: false, pinnedIds: [third, second, first, main], normalIds: [],
			}),
		});
		expect(snapshot.normalIds).toEqual([]);
		snapshot = await ok('/account/order', {
			token: admin.token, method: 'PUT', body: orderPayload(snapshot, {
				pinnedIds: [], normalIds: [second, main, third, first],
			}),
		});
		expect(snapshot.pinnedIds).toEqual([]);
		expect((await legacyPages(admin.token)).map(row => row.accountId)).toEqual([second, main, third, first]);
		expect((await env.db.prepare('SELECT * FROM email').all()).results).toEqual(before.results);
	});

	it('supports the existing setAsTop endpoint through the new ordering state', async () => {
		const [main, first, second] = await seedAccounts(admin.userId, 2);
		const snapshot = await ok('/account/order', { token: admin.token });
		await ok('/account/setAsTop', { token: admin.token, method: 'PUT', body: { accountId: first } });
		await ok('/account/setAsTop', { token: admin.token, method: 'PUT', body: { accountId: second } });
		const reloaded = await ok('/account/order', { token: admin.token });
		expect(reloaded.pinnedIds).toEqual([second, first]);
		expect(reloaded.version).toBeGreaterThan(snapshot.version);
		expect((await legacyPages(admin.token)).map(row => row.accountId)).toEqual([main, second, first]);
	});

	it('appends added mailboxes to the normal group and rejects an old incomplete snapshot', async () => {
		const [main, first, second] = await seedAccounts(admin.userId, 2);
		let snapshot = await ok('/account/order', { token: admin.token });
		snapshot = await ok('/account/order', {
			token: admin.token, method: 'PUT', body: orderPayload(snapshot, { normalIds: [second, first, main], mainFirst: false }),
		});
		const added = await ok('/account/add', { token: admin.token, method: 'POST', body: { email: 'new@example.com' } });
		const afterAdd = await ok('/account/order', { token: admin.token });
		expect(afterAdd.normalIds).toEqual([second, first, main, added.accountId]);
		const before = await rawOrderState(admin.userId);
		expect((await api('/account/order', { token: admin.token, method: 'PUT', body: orderPayload(snapshot) })).code).toBe(409);
		expect(await rawOrderState(admin.userId)).toEqual(before);
	});

	it('keeps soft-deleted mailbox messages and rejects a snapshot containing the deleted ID', async () => {
		await ok('/setting/set', { token: admin.token, method: 'PUT', body: { syncDelete: 1 } });
		const [, removed] = await seedAccounts(admin.userId, 1);
		await env.db.prepare('INSERT INTO email (account_id, user_id, subject, text) VALUES (?, ?, ?, ?)')
			.bind(removed, admin.userId, 'Retained message', 'Keep on soft delete').run();
		const snapshot = await ok('/account/order', { token: admin.token });
		await ok(`/account/delete?accountId=${removed}`, { token: admin.token, method: 'DELETE' });
		const before = await rawOrderState(admin.userId);
		expect([403, 409]).toContain((await api('/account/order', { token: admin.token, method: 'PUT', body: orderPayload(snapshot) })).code);
		expect(await rawOrderState(admin.userId)).toEqual(before);
		expect(await env.db.prepare('SELECT COUNT(*) AS count FROM email WHERE account_id = ?').bind(removed).first('count')).toBe(1);
		expect((await ok('/account/order', { token: admin.token })).accounts).toHaveLength(1);
	});

	it.each(['duplicate', 'missing', 'unknown', 'invalid type'])('rejects %s IDs without partial writes', async variant => {
		const [, first] = await seedAccounts(admin.userId, 1);
		const snapshot = await ok('/account/order', { token: admin.token });
		const payload = orderPayload(snapshot, { mainFirst: false });
		if (variant === 'duplicate') payload.pinnedIds.push(first);
		if (variant === 'missing') payload.normalIds.pop();
		if (variant === 'unknown') payload.normalIds[payload.normalIds.length - 1] = 999999;
		if (variant === 'invalid type') payload.normalIds[0] = String(payload.normalIds[0]);
		const before = await rawOrderState(admin.userId);
		const result = await api('/account/order', { token: admin.token, method: 'PUT', body: payload });
		expect([400, 403, 409]).toContain(result.code);
		expect(await rawOrderState(admin.userId)).toEqual(before);
	});

	it('rejects another user mailbox in snapshots and legacy pin requests', async () => {
		const other = await createUser('other@example.com');
		const snapshot = await ok('/account/order', { token: admin.token });
		const beforeAdmin = await rawOrderState(admin.userId);
		const beforeOther = await rawOrderState(other.userId);
		const result = await api('/account/order', {
			token: admin.token, method: 'PUT', body: orderPayload(snapshot, { pinnedIds: [other.mainAccountId] }),
		});
		expect([400, 403, 409]).toContain(result.code);
		expect((await api('/account/setAsTop', {
			token: admin.token, method: 'PUT', body: { accountId: other.mainAccountId },
		})).code).not.toBe(200);
		expect(await rawOrderState(admin.userId)).toEqual(beforeAdmin);
		expect(await rawOrderState(other.userId)).toEqual(beforeOther);
	});

	it('rejects stale updates and commits only one simultaneous save', async () => {
		const [main, first, second] = await seedAccounts(admin.userId, 2);
		const snapshot = await ok('/account/order', { token: admin.token });
		const proposals = [
			orderPayload(snapshot, { pinnedIds: [first], normalIds: [second, main], mainFirst: false }),
			orderPayload(snapshot, { pinnedIds: [second], normalIds: [main, first], mainFirst: true }),
		];
		const results = await Promise.all(proposals.map(body => api('/account/order', {
			token: admin.token, method: 'PUT', body,
		})));
		expect(results.map(result => result.code).sort()).toEqual([200, 409]);
		const winningIndex = results.findIndex(result => result.code === 200);
		const saved = await ok('/account/order', { token: admin.token });
		expect(saved.pinnedIds).toEqual(proposals[winningIndex].pinnedIds);
		expect(saved.normalIds).toEqual(proposals[winningIndex].normalIds);
		expect(saved.mainFirst).toBe(proposals[winningIndex].mainFirst);
		const before = await rawOrderState(admin.userId);
		expect((await api('/account/order', { token: admin.token, method: 'PUT', body: proposals[winningIndex] })).code).toBe(409);
		expect(await rawOrderState(admin.userId)).toEqual(before);
	});

	it('rolls back account changes when the final preference update fails', async () => {
		const [, first] = await seedAccounts(admin.userId, 1);
		const snapshot = await ok('/account/order', { token: admin.token });
		const before = await rawOrderState(admin.userId);
		await env.db.prepare("CREATE TRIGGER reject_order_update BEFORE UPDATE OF mailbox_order_version ON user BEGIN SELECT RAISE(ABORT, 'test forced write failure'); END").run();
		const result = await api('/account/order', {
			token: admin.token, method: 'PUT', body: orderPayload(snapshot, { pinnedIds: [first], normalIds: [admin.mainAccountId], mainFirst: false }),
		});
		expect(result.code).not.toBe(200);
		expect(await rawOrderState(admin.userId)).toEqual(before);
	});

	it('rejects a mailbox added after preflight validation but before the atomic write', async () => {
		const [, first] = await seedAccounts(admin.userId, 1);
		const snapshot = await ok('/account/order', { token: admin.token });
		const before = await rawOrderState(admin.userId);
		const db = {
			prepare: (...args) => env.db.prepare(...args),
			async batch(statements) {
				await env.db.prepare('INSERT INTO account (email, name, user_id) VALUES (?, ?, ?)')
					.bind('concurrent@example.com', 'Concurrent mailbox', admin.userId).run();
				return env.db.batch(statements);
			},
		};
		await expect(mailboxOrderService.save({ env: { ...env, db } }, orderPayload(snapshot, {
			pinnedIds: [first], normalIds: [admin.mainAccountId], mainFirst: false,
		}), admin.userId)).rejects.toMatchObject({ code: 409 });
		const after = await rawOrderState(admin.userId);
		expect(after.user).toEqual(before.user);
		expect(after.accounts.filter(row => before.accounts.some(old => old.account_id === row.account_id))).toEqual(before.accounts);
		expect(after.accounts).toHaveLength(before.accounts.length + 1);
	});

	it('grants ordering with account:query alone and denies access when that permission is removed', async () => {
		const member = await createUser('reader@example.com');
		await env.db.prepare('DELETE FROM role_perm WHERE role_id = 1 AND perm_id NOT IN (SELECT perm_id FROM perm WHERE perm_key = ?)')
			.bind('account:query').run();
		const snapshot = await ok('/account/order', { token: member.token });
		await ok('/account/order', { token: member.token, method: 'PUT', body: orderPayload(snapshot, { mainFirst: false }) });
		await env.db.prepare('DELETE FROM role_perm WHERE role_id = 1').run();
		expect((await api('/account/order', { token: member.token })).code).toBe(403);
		expect((await api('/account/order', { token: member.token, method: 'PUT', body: orderPayload(snapshot) })).code).toBe(403);
	});

	it('rejects unauthenticated ordering access', async () => {
		expect((await api('/account/order')).code).toBe(401);
		expect((await api('/account/order', { method: 'PUT', body: {} })).code).toBe(401);
	});
});
