import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import addressUtils from '../src/utils/mailbox-address';
import accountService from '../src/service/account-service';
import emailService from '../src/service/email-service';
import loginService from '../src/service/login-service';
import userService from '../src/service/user-service';
import settingService from '../src/service/setting-service';
import turnstileService from '../src/service/turnstile-service';
import regKeyService from '../src/service/reg-key-service';
import { initialize } from './helpers';

const roots = ['example.com', 'second.net', 'third.org', 'fourth.xyz'];
const domains = [...roots, ...roots.map(root => `mail.${root}`)];
const password = 'Local-subdomain-test-2026';
const modes = ['normal', 'random', 'manual'];
const entries = ['/account/add', '/register', '/user/add'];

function context(overrides = {}) {
	const state = new Map();
	return {
		env: { ...env, domain: domains, ...overrides },
		req: { header: name => name.toLowerCase() === 'cf-connecting-ip' ? '192.0.2.1' : '' },
		get: key => state.get(key),
		set: (key, value) => state.set(key, value),
	};
}

async function request(path, { token, body, method = 'POST', domain = domains } = {}) {
	const execution = createExecutionContext();
	const response = await worker.fetch(new Request(`http://local.test/api${path}`, {
		method,
		headers: {
			'Content-Type': 'application/json', 'Accept-Language': 'en', 'CF-Connecting-IP': '192.0.2.1',
			...(token ? { Authorization: token } : {}),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	}), { ...env, domain }, execution);
	await waitOnExecutionContext(execution);
	return response.json();
}

async function success(path, options) {
	const result = await request(path, options);
	expect(result.code, `${path}: ${result.message}`).toBe(200);
	return result.data;
}

async function totals() {
	return env.db.prepare('SELECT (SELECT COUNT(*) FROM user) AS users, (SELECT COUNT(*) FROM account) AS accounts').first();
}

async function accountCount(email) {
	return env.db.prepare('SELECT COUNT(*) AS count FROM account WHERE email = ? COLLATE NOCASE').bind(email).first('count');
}

async function configure(values) {
	await settingService.set(context(), values);
}

describe('Subdomain creation using isolated D1 and KV', () => {
	let admin;
	beforeAll(async () => {
		await initialize();
		await success('/register', { body: { email: 'admin@example.com', password } });
		const { token } = await success('/login', { body: { email: 'admin@example.com', password } });
		const { user_id: userId } = await env.db.prepare('SELECT user_id FROM user WHERE email = ?').bind('admin@example.com').first();
		admin = { token, userId };
	});

	afterEach(() => vi.restoreAllMocks());

	const create = (entry, body) => success(entry, { token: entry === '/register' ? undefined : admin.token, body: { password, ...body } });
	const attempt = (entry, body) => request(entry, { token: entry === '/register' ? undefined : admin.token, body: { password, ...body } });
	const direct = (entry, c, body) => entry === '/account/add'
		? accountService.add(c, body, admin.userId)
		: entry === '/register' ? loginService.register(c, { password, ...body }) : userService.add(c, { password, ...body });

	it('previews a random subdomain anonymously without caching or creating records', async () => {
		const before = await totals();
		const execution = createExecutionContext();
		const response = await worker.fetch(new Request('http://local.test/api/register/subdomain'), { ...env, domain: domains }, execution);
		await waitOnExecutionContext(execution);
		expect(response.status).toBe(200);
		expect(response.headers.get('Cache-Control')).toBe('no-store');
		const result = await response.json();
		expect(result.code).toBe(200);
		expect(result.data.subdomain).toMatch(/^[a-z0-9]{8}$/);
		expect(await totals()).toEqual(before);
	});

	it.each(entries.flatMap(entry => modes.map(mode => [entry, mode])))('%s creates and returns the actual %s address', async (entry, mode) => {
		const result = await create(entry, { email: 'Person@EXAMPLE.COM', subdomainMode: mode, subdomain: 'TeAm-7' });
		const expected = mode === 'normal' ? 'Person@example.com' : mode === 'manual' ? 'Person@team-7.example.com' : /^Person@[a-z0-9]{8}\.example\.com$/;
		if (typeof expected === 'string') expect(result.email).toBe(expected);
		else expect(result.email).toMatch(expected);
		const account = await env.db.prepare('SELECT * FROM account WHERE email = ?').bind(result.email).first();
		expect(account).not.toBeNull();
		if (entry === '/account/add') {
			expect(result.accountId).toBe(account.account_id);
			expect(account.user_id).toBe(admin.userId);
			expect(result.addVerifyOpen).toBe(false);
		} else {
			const user = await env.db.prepare('SELECT user_id FROM user WHERE email = ?').bind(result.email).first();
			expect(account.user_id).toBe(user.user_id);
			if (entry === '/user/add') expect(result.userId).toBe(user.user_id);
			else expect(result.regVerifyOpen).toBe(false);
			expect((await success('/login', { body: { email: result.email, password } })).token).toBeTypeOf('string');
		}
	});

	it.each(roots)('supports both creation modes on configured root %s', async root => {
		const manual = await create('/account/add', { email: `manual@${root}`, subdomainMode: 'manual', subdomain: 'a' });
		expect(manual.email).toBe(`manual@a.${root}`);
		const random = await create('/account/add', { email: `random@${root}`, subdomainMode: 'random' });
		expect(random.email.split('@')[1]).toMatch(new RegExp(`^[a-z0-9]{8}\\.${root.replaceAll('.', '\\.')}$`));
	});

	it.each(entries)('%s preserves old full root and fixed mail addresses without new fields', async entry => {
		for (const domain of ['example.com', 'mail.example.com']) {
			const result = await create(entry, { email: `legacy@${domain}` });
			expect(result.email).toBe(`legacy@${domain}`);
		}
	});

	it('uses the configured JSON domain list and normalizes its case', async () => {
		const result = await success('/register', {
			domain: JSON.stringify(['EXAMPLE.COM', 'mail.example.com']),
			body: { email: 'json@Example.Com', password, subdomainMode: 'manual', subdomain: 'TEAM' },
		});
		expect(result.email).toBe('json@team.example.com');
	});

	it.each(['', '-team', 'team-', 'one.two', 'a'.repeat(64), 'téam', 'a_b', 'team name'])('rejects invalid manual label %j at every creation entry', async subdomain => {
		const before = await totals();
		for (const entry of entries) {
			expect((await attempt(entry, { email: 'invalid@example.com', subdomainMode: 'manual', subdomain })).code).not.toBe(200);
		}
		expect(await totals()).toEqual(before);
	});

	it('accepts manual labels at both length boundaries', async () => {
		for (const subdomain of ['0', `a${'-'.repeat(61)}z`]) {
			const result = await create('/register', { email: 'boundary@example.com', subdomainMode: 'manual', subdomain });
			expect(result.email).toBe(`boundary@${subdomain}.example.com`);
		}
	});

	it.each(entries)('%s rejects unknown roots, deceptive suffixes, nested domains and invalid modes', async entry => {
		const before = await totals();
		for (const body of [
			{ email: 'bad@outside.test' }, { email: 'bad@notexample.com' }, { email: 'bad@example.com.evil.test' },
			{ email: 'bad@a.b.example.com' }, { email: 'bad@-x.example.com' },
			{ email: 'bad@mail.example.com', subdomainMode: 'manual', subdomain: 'team' },
			{ email: 'bad@example.com', subdomainMode: 'unexpected' },
		]) expect((await attempt(entry, body)).code).not.toBe(200);
		expect(await totals()).toEqual(before);
	});

	it('keeps identical local parts independent across complete domains', async () => {
		const root = await create('/account/add', { email: 'separate@example.com' });
		const child = await create('/register', { email: 'separate@example.com', subdomainMode: 'manual', subdomain: 'team' });
		const owner = await env.db.prepare('SELECT user_id FROM user WHERE email = ?').bind(child.email).first('user_id');
		expect(root.userId).toBe(admin.userId);
		expect(owner).not.toBe(admin.userId);
		expect(await accountCount(root.email)).toBe(1);
		expect(await accountCount(child.email)).toBe(1);
	});

	it('keeps plus-tag ownership checks on the complete domain', async () => {
		await create('/account/add', { email: 'alias@example.com' });
		expect((await attempt('/account/add', { email: 'alias+tag@example.com', subdomainMode: 'manual', subdomain: 'team' })).code).not.toBe(200);
		await create('/account/add', { email: 'alias@example.com', subdomainMode: 'manual', subdomain: 'team' });
		expect((await create('/account/add', { email: 'alias+tag@example.com', subdomainMode: 'manual', subdomain: 'team' })).email).toBe('alias+tag@team.example.com');
		expect((await create('/account/add', { email: 'alias+root@example.com' })).email).toBe('alias+root@example.com');
		expect((await attempt('/account/add', { email: 'alias+random@example.com', subdomainMode: 'random' })).code).not.toBe(200);
	});

	it('extends a root role grant to one child level and enforces it at all three entries', async () => {
		await create('/register', { email: 'member@example.com' });
		const { token } = await success('/login', { body: { email: 'member@example.com', password } });
		await env.db.prepare("UPDATE role SET avail_domain = 'example.com' WHERE role_id = 1").run();
		for (const entry of entries) {
			const tokenOption = entry === '/account/add' ? token : entry === '/user/add' ? admin.token : undefined;
			const accepted = await success(entry, { token: tokenOption, body: { email: `permitted${entries.indexOf(entry)}@example.com`, password, subdomainMode: 'manual', subdomain: 'team' } });
			expect(accepted.email).toContain('@team.example.com');
			const rejected = await request(entry, { token: tokenOption, body: { email: 'denied@second.net', password, subdomainMode: 'manual', subdomain: 'team' } });
			expect(rejected.code).toBe(403);
		}
	});

	it('keeps explicitly granted child domains exact and preserves the administrator exemption', async () => {
		await create('/register', { email: 'member@example.com' });
		const { token } = await success('/login', { body: { email: 'member@example.com', password } });
		await env.db.prepare("UPDATE role SET avail_domain = 'mail.example.com' WHERE role_id = 1").run();
		for (const entry of entries) {
			const tokenOption = entry === '/account/add' ? token : entry === '/user/add' ? admin.token : undefined;
			await success(entry, { token: tokenOption, body: { email: `exact${entries.indexOf(entry)}@mail.example.com`, password } });
			for (const domain of ['example.com', 'team.example.com', 'child.mail.example.com']) {
				expect((await request(entry, { token: tokenOption, body: { email: 'denied@' + domain, password } })).code).not.toBe(200);
			}
		}
		expect((await create('/account/add', { email: 'admin-own@second.net', subdomainMode: 'manual', subdomain: 'team' })).email).toBe('admin-own@team.second.net');
	});

	it.each(entries)('%s retries address collisions and consumes successful-request counters only once', async entry => {
		await configure({ registerVerify: 2, regVerifyCount: 10, addEmailVerify: 2, addVerifyCount: 10 });
		await env.db.prepare('INSERT INTO account (email, user_id, name) VALUES (?, ?, ?)').bind('retry@aaaaaaaa.example.com', admin.userId, 'Existing mailbox').run();
		const random = vi.spyOn(addressUtils, 'randomSubdomain').mockReturnValueOnce('aaaaaaaa').mockReturnValue('b7b7b7b7');
		const result = await create(entry, { email: 'retry@example.com', subdomainMode: 'random' });
		expect(result.email).toBe('retry@b7b7b7b7.example.com');
		expect(random).toHaveBeenCalledTimes(2);
		const counts = (await env.db.prepare('SELECT type, count FROM verify_record ORDER BY type').all()).results;
		expect(counts).toEqual(entry === '/user/add' ? [] : [{ type: entry === '/register' ? 0 : 1, count: 1 }]);
	});

	it.each(['/register', '/account/add'])('%s verifies CAPTCHA once even when allocation retries', async entry => {
		await configure({ registerVerify: 0, addEmailVerify: 0 });
		await env.db.prepare('INSERT INTO account (email, user_id) VALUES (?, ?)').bind('verified@aaaaaaaa.example.com', admin.userId).run();
		vi.spyOn(addressUtils, 'randomSubdomain').mockReturnValueOnce('aaaaaaaa').mockReturnValue('b7b7b7b7');
		const verify = vi.spyOn(turnstileService, 'verify').mockResolvedValue(undefined);
		await create(entry, { email: 'verified@example.com', subdomainMode: 'random', token: 'local-test-verification' });
		expect(verify).toHaveBeenCalledTimes(1);
	});

	it('returns the verification threshold reached on the first registration', async () => {
		await configure({ registerVerify: 2, regVerifyCount: 1 });
		const result = await create('/register', { email: 'counted@example.com', subdomainMode: 'random' });
		expect(result.regVerifyOpen).toBe(true);
		expect(result.email).toMatch(/^counted@[a-z0-9]{8}\.example\.com$/);
		expect(await env.db.prepare('SELECT count FROM verify_record WHERE type = 0').first('count')).toBe(1);
	});

	it.each(entries)('%s stops after five collision retries without writing partial records or counters', async entry => {
		await configure({ registerVerify: 2, regVerifyCount: 10, addEmailVerify: 2, addVerifyCount: 10 });
		await env.db.prepare('INSERT INTO account (email, user_id, name) VALUES (?, ?, ?)').bind('retry@aaaaaaaa.example.com', admin.userId, 'Existing mailbox').run();
		const before = await totals();
		const random = vi.spyOn(addressUtils, 'randomSubdomain').mockReturnValue('aaaaaaaa');
		expect((await attempt(entry, { email: 'retry@example.com', subdomainMode: 'random' })).code).not.toBe(200);
		expect(random).toHaveBeenCalledTimes(6);
		expect(await totals()).toEqual(before);
		expect(await env.db.prepare('SELECT COUNT(*) AS count FROM verify_record').first('count')).toBe(0);
	});

	it.each(entries)('%s does not retry non-collision database failures', async entry => {
		await env.db.prepare("CREATE TRIGGER reject_subdomain_insert BEFORE INSERT ON account WHEN NEW.email LIKE 'failed@%' BEGIN SELECT RAISE(ABORT, 'test write failure'); END").run();
		const before = await totals();
		const random = vi.spyOn(addressUtils, 'randomSubdomain').mockReturnValue('a1b2c3d4');
		expect((await attempt(entry, { email: 'failed@example.com', subdomainMode: 'random' })).code).not.toBe(200);
		expect(random).toHaveBeenCalledTimes(1);
		expect(await totals()).toEqual(before);
	});

	it.each(['/register', '/user/add'])('%s rolls back a user insert when the primary account insert fails', async entry => {
		await env.db.prepare("CREATE TRIGGER reject_primary BEFORE INSERT ON account WHEN NEW.email = 'atomic@team.example.com' BEGIN SELECT RAISE(ABORT, 'test primary failure'); END").run();
		const before = await totals();
		expect((await attempt(entry, { email: 'atomic@example.com', subdomainMode: 'manual', subdomain: 'team' })).code).not.toBe(200);
		expect(await totals()).toEqual(before);
		expect(await env.db.prepare('SELECT COUNT(*) AS count FROM user WHERE email = ?').bind('atomic@team.example.com').first('count')).toBe(0);
	});

	it.each(['/register', '/user/add'])('%s retries a real unique-index race and leaves no orphan user', async entry => {
		let raced = false;
		const db = {
			prepare: (...args) => env.db.prepare(...args),
			async batch(statements) {
				if (!raced) {
					raced = true;
					await env.db.prepare('INSERT INTO account (email, user_id, name) VALUES (?, ?, ?)').bind('race@aaaaaaaa.example.com', admin.userId, 'Concurrent mailbox').run();
				}
				return env.db.batch(statements);
			},
		};
		const random = vi.spyOn(addressUtils, 'randomSubdomain').mockReturnValueOnce('aaaaaaaa').mockReturnValue('b7b7b7b7');
		const result = await direct(entry, context({ db }), { email: 'race@example.com', subdomainMode: 'random' });
		expect(result.email).toBe('race@b7b7b7b7.example.com');
		expect(random).toHaveBeenCalledTimes(2);
		expect(await env.db.prepare('SELECT COUNT(*) AS count FROM user WHERE email = ?').bind('race@aaaaaaaa.example.com').first('count')).toBe(0);
		expect(await accountCount(result.email)).toBe(1);
	});

	it('consumes an invitation once across retries and restores it after terminal creation failure', async () => {
		await configure({ regKey: 0, registerVerify: 2, regVerifyCount: 10 });
		await env.db.prepare("INSERT INTO reg_key (code, count, role_id, user_id, expire_time) VALUES ('local-invitation', 3, 1, ?, '2099-01-01 00:00:00')").bind(admin.userId).run();
		await env.db.prepare('INSERT INTO account (email, user_id) VALUES (?, ?)').bind('invite@aaaaaaaa.example.com', admin.userId).run();
		vi.spyOn(addressUtils, 'randomSubdomain').mockReturnValueOnce('aaaaaaaa').mockReturnValue('b7b7b7b7');
		await create('/register', { email: 'invite@example.com', subdomainMode: 'random', code: 'local-invitation' });
		expect(await env.db.prepare("SELECT count FROM reg_key WHERE code = 'local-invitation'").first('count')).toBe(2);
		expect(await env.db.prepare('SELECT count FROM verify_record WHERE type = 0').first('count')).toBe(1);
		await env.db.prepare("CREATE TRIGGER reject_invited_primary BEFORE INSERT ON account WHEN NEW.email LIKE 'failure@%' BEGIN SELECT RAISE(ABORT, 'test invited primary failure'); END").run();
		const before = await totals();
		expect((await attempt('/register', { email: 'failure@example.com', subdomainMode: 'random', code: 'local-invitation' })).code).not.toBe(200);
		expect(await totals()).toEqual(before);
		expect(await env.db.prepare("SELECT count FROM reg_key WHERE code = 'local-invitation'").first('count')).toBe(2);
		expect(await env.db.prepare('SELECT count FROM verify_record WHERE type = 0').first('count')).toBe(1);
	});

	it.each([true, false])('rechecks default-role permissions when an optional invitation is concurrently exhausted (allowed=%s)', async allowed => {
		await configure({ regKey: 2 });
		await env.db.prepare("UPDATE role SET avail_domain = 'example.com' WHERE role_id = 1").run();
		await env.db.prepare("INSERT INTO role (role_id, name, key, avail_domain, is_default) VALUES (2, 'Invitation role', 'invited', 'example.com,second.net', 0)").run();
		await env.db.prepare("INSERT INTO reg_key (code, count, role_id, user_id, expire_time) VALUES ('exhausted-during-request', 1, 2, ?, '2099-01-01 00:00:00')").bind(admin.userId).run();
		const consume = vi.spyOn(regKeyService, 'consumeCount').mockResolvedValue(false);
		const random = vi.spyOn(addressUtils, 'randomSubdomain').mockReturnValue('a1b2c3d4');
		const before = await totals();
		const result = await attempt('/register', { email: `fallback@${allowed ? 'example.com' : 'second.net'}`, subdomainMode: 'random', code: 'exhausted-during-request' });
		expect(consume).toHaveBeenCalledTimes(1);
		expect(random).toHaveBeenCalledTimes(1);
		if (allowed) {
			expect(result.code).toBe(200);
			expect(result.data.email).toBe('fallback@a1b2c3d4.example.com');
			expect(await env.db.prepare('SELECT type, reg_key_id FROM user WHERE email = ?').bind(result.data.email).first()).toEqual({ type: 1, reg_key_id: 0 });
		} else {
			expect(result.code).toBe(403);
			expect(await totals()).toEqual(before);
		}
	});

	it('keeps generated addresses fixed after login and subsequent mailbox reads', async () => {
		const { email } = await create('/register', { email: 'persistent@example.com', subdomainMode: 'random' });
		for (let index = 0; index < 2; index++) {
			const { token } = await success('/login', { body: { email, password } });
			const order = await success('/account/order', { token, method: 'GET' });
			expect(order.accounts.map(account => account.email)).toEqual([email]);
		}
	});

	it('receives raw mail for a child-domain account and resolves plus tags only on that domain', async () => {
		const created = await create('/register', { email: 'receiver@example.com', subdomainMode: 'manual', subdomain: 'team' });
		await create('/account/add', { email: 'receiver@example.com' });
		await env.db.prepare("UPDATE role SET avail_domain = 'example.com' WHERE role_id = 1").run();
		const child = await env.db.prepare('SELECT account_id, user_id FROM account WHERE email = ?').bind(created.email).first();
		const deliver = async to => {
			const message = {
				from: 'outside@sender.test', to,
				raw: new Response(`From: outside@sender.test\r\nTo: ${to}\r\nSubject: Local receipt test\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nPreserve the complete recipient domain.`).body,
				setReject: vi.fn(), forward: vi.fn(),
			};
			await worker.email(message, { ...env, domain: domains }, createExecutionContext());
			return message;
		};
		for (const to of [created.email, 'receiver+tag@team.example.com']) {
			expect((await deliver(to)).setReject).not.toHaveBeenCalled();
			const stored = await env.db.prepare('SELECT account_id, user_id, to_email, status FROM email WHERE to_email = ?').bind(to).first();
			expect(stored).toEqual({ ...child, to_email: to, status: 0 });
		}
		expect((await deliver('receiver@unknown.example.com')).setReject).toHaveBeenCalledWith('Recipient not found');
		expect(await env.db.prepare('SELECT COUNT(*) AS count FROM email').first('count')).toBe(2);
		await env.db.prepare("UPDATE role SET avail_domain = 'mail.example.com' WHERE role_id = 1").run();
		expect((await deliver(created.email)).setReject).toHaveBeenCalledWith('The recipient is not authorized to use this domain.');
		expect(await env.db.prepare('SELECT COUNT(*) AS count FROM email').first('count')).toBe(2);
	});

	it('delivers internal mail to child domains without requiring external sender credentials', async () => {
		const receiver = await create('/register', { email: 'inside@example.com', subdomainMode: 'manual', subdomain: 'team' });
		await env.db.prepare("UPDATE role SET avail_domain = 'example.com' WHERE role_id = 1").run();
		await configure({ send: 0 });
		const accountId = await env.db.prepare('SELECT account_id FROM account WHERE email = ?').bind('admin@example.com').first('account_id');
		await success('/email/send', {
			token: admin.token,
			body: { accountId, receiveEmail: [receiver.email, 'inside+tag@team.example.com'], subject: 'Internal subdomains', text: 'Internal body', content: '<p>Internal body</p>', attachments: [] },
		});
		const child = await env.db.prepare('SELECT account_id, user_id FROM account WHERE email = ?').bind(receiver.email).first();
		const received = (await env.db.prepare('SELECT account_id, user_id, to_email, status FROM email WHERE type = 0 ORDER BY to_email').all()).results;
		expect(received).toHaveLength(2);
		expect(received.every(row => row.account_id === child.account_id && row.user_id === child.user_id && row.status === 0)).toBe(true);
		expect(received.map(row => row.to_email).sort()).toEqual([receiver.email, 'inside+tag@team.example.com'].sort());
	});

	it('requires external sender credentials for the full child domain', async () => {
		const sender = await create('/account/add', { email: 'sender@example.com', subdomainMode: 'manual', subdomain: 'team' });
		await configure({ send: 0, resendTokens: { 'example.com': 'local-test-root-token' } });
		const resend = vi.spyOn(emailService, 'sendResend').mockImplementation(async function* () { yield { emails: [] }; });
		const result = await request('/email/send', {
			token: admin.token,
			body: { accountId: sender.accountId, receiveEmail: ['outside@sender.test'], subject: 'Provider boundary', text: 'Local test', content: '<p>Local test</p>', attachments: [] },
		});
		expect(result.code).not.toBe(200);
		expect(resend).not.toHaveBeenCalled();
		expect(await env.db.prepare('SELECT COUNT(*) AS count FROM email').first('count')).toBe(0);
	});
});

describe('Configured domain boundaries', () => {
	it('derives root choices without treating fixed mail suffixes as roots', () => {
		expect(addressUtils.roots(domains)).toEqual(roots);
		expect(addressUtils.roots(JSON.stringify(['@EXAMPLE.COM', 'mail.example.com', 'example.com']))).toEqual(['example.com']);
	});

	it('accepts only configured roots and legal single-level children for internal mail', () => {
		for (const root of roots) {
			expect(addressUtils.isAllowed(root, domains)).toBe(true);
			expect(addressUtils.isAllowed(`team.${root}`, domains)).toBe(true);
			expect(addressUtils.isAllowed(`mail.${root}`, domains)).toBe(true);
			expect(addressUtils.isAllowed(`a.b.${root}`, domains)).toBe(false);
		}
		for (const domain of ['outside.test', 'badexample.com', 'example.com.evil.test', '-bad.example.com', 'bad-.example.com']) {
			expect(addressUtils.isAllowed(domain, domains)).toBe(false);
		}
	});

	it('produces eight secure-random lowercase alphanumeric characters', () => {
		const values = Array.from({ length: 128 }, () => addressUtils.randomSubdomain());
		expect(values.every(value => /^[a-z0-9]{8}$/.test(value))).toBe(true);
		expect(new Set(values).size).toBeGreaterThan(1);
	});
});
