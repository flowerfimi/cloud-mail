import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { dbInit } from '../src/init/init';
import { initialize } from './helpers';

describe('Mailbox order migration preserves existing records', () => {
	beforeAll(async () => {
		const context = { env };
		const upstreamSteps = [
			'intDB', 'v1_1DB', 'v1_2DB', 'v1_3DB', 'v1_3_1DB', 'v1_4DB', 'v1_5DB',
			'v1_6DB', 'v1_7DB', 'v2DB', 'v2_3DB', 'v2_4DB', 'v2_5DB', 'v2_6DB',
			'v2_7DB', 'v2_8DB', 'v2_9DB', 'v3_0DB', 'v3_1DB', 'v3_2DB', 'v3_3DB', 'v3_4DB',
		];
		for (const step of upstreamSteps) await dbInit[step](context);
		await env.db.batch([
			env.db.prepare("INSERT INTO user (user_id, email, password, salt) VALUES (1, 'admin@example.com', 'legacy-password-hash', 'legacy-salt')"),
			env.db.prepare("INSERT INTO account (account_id, email, user_id, sort) VALUES (1, 'admin@example.com', 1, 9), (2, 'old-pin@example.com', 1, 8), (3, 'normal@example.com', 1, 0), (4, 'older-pin@example.com', 1, 3)"),
			env.db.prepare("INSERT INTO email (email_id, account_id, user_id, subject, text, content) VALUES (1, 2, 1, 'Existing message', 'Keep this body', '<p>Keep this HTML</p>')"),
		]);
	});

	it('backfills positive-sort secondary mailboxes and preserves accounts and messages', async () => {
		const beforeMail = (await env.db.prepare('SELECT * FROM email').all()).results;
		const beforeAccounts = (await env.db.prepare('SELECT account_id, email, user_id, sort FROM account ORDER BY account_id').all()).results;
		await initialize();
		expect((await env.db.prepare('SELECT account_id, email, user_id, sort FROM account ORDER BY account_id').all()).results).toEqual(beforeAccounts);
		expect((await env.db.prepare('SELECT * FROM email').all()).results).toEqual(beforeMail);
		expect((await env.db.prepare('SELECT is_pinned FROM account ORDER BY account_id').all()).results.map(row => row.is_pinned)).toEqual([0, 1, 0, 1]);
		expect(await env.db.prepare('SELECT mailbox_main_first FROM user WHERE user_id = 1').first('mailbox_main_first')).toBe(1);
		expect(await env.db.prepare('SELECT mailbox_order_version FROM user WHERE user_id = 1').first('mailbox_order_version')).toBe(0);
		expect(await env.db.prepare('SELECT sync_delete FROM setting').first('sync_delete')).toBe(0);
		expect(await env.db.prepare('SELECT auto_clean_days FROM setting').first('auto_clean_days')).toBe(0);
		expect(await env.db.prepare('PRAGMA quick_check').first('quick_check')).toBe('ok');
	});

	it('preserves customized groups, ranks and preferences across repeated initialization', async () => {
		await initialize();
		await env.db.batch([
			env.db.prepare('UPDATE account SET is_pinned = 0, sort = -7 WHERE account_id = 2'),
			env.db.prepare('UPDATE account SET is_pinned = 1, sort = 11 WHERE account_id = 3'),
			env.db.prepare('UPDATE user SET mailbox_main_first = 0, mailbox_order_version = 4 WHERE user_id = 1'),
			env.db.prepare('UPDATE setting SET sync_delete = 1'),
		]);
		const before = (await env.db.prepare('SELECT * FROM account ORDER BY account_id').all()).results;
		const beforeUser = await env.db.prepare('SELECT * FROM user WHERE user_id = 1').first();
		const beforeMail = (await env.db.prepare('SELECT * FROM email').all()).results;
		await initialize();
		expect((await env.db.prepare('SELECT * FROM account ORDER BY account_id').all()).results).toEqual(before);
		expect(await env.db.prepare('SELECT * FROM user WHERE user_id = 1').first()).toEqual(beforeUser);
		expect(await env.db.prepare('SELECT sync_delete FROM setting').first('sync_delete')).toBe(1);
		expect((await env.db.prepare('SELECT * FROM email').all()).results).toEqual(beforeMail);
	});
});
