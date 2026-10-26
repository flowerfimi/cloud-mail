import { env, SELF } from 'cloudflare:test';
import { expect } from 'vitest';

export async function api(path, { token, method = 'GET', body } = {}) {
	const response = await SELF.fetch(`http://local.test/api${path}`, {
		method,
		headers: { 'Content-Type': 'application/json', 'Accept-Language': 'en', ...(token ? { Authorization: token } : {}) },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	try { return JSON.parse(text); } catch {
		throw new Error(`${method} ${path} returned ${response.status}: ${text.slice(0, 200)}`);
	}
}

export async function ok(path, options) {
	const result = await api(path, options);
	expect(result.code, `${path}: ${result.message}`).toBe(200);
	return result.data;
}

export async function initialize() {
	const response = await SELF.fetch(`http://local.test/api/init/${env.jwt_secret}`);
	expect(await response.text()).toBe('success');
}

export async function createUser(email = 'admin@example.com') {
	const credentials = { email, password: 'Local-test-password-2026' };
	await ok('/register', { method: 'POST', body: credentials });
	const { token } = await ok('/login', { method: 'POST', body: credentials });
	const user = await env.db.prepare('SELECT user_id FROM user WHERE email = ?').bind(email).first();
	const main = await env.db.prepare('SELECT account_id FROM account WHERE email = ?').bind(email).first();
	return { token, userId: user.user_id, mainAccountId: main.account_id, credentials };
}

export async function seedAccounts(userId, count, prefix = 'box') {
	if (count > 0) await env.db.batch(Array.from({ length: count }, (_, index) => env.db.prepare(
		'INSERT INTO account (email, name, user_id) VALUES (?, ?, ?)'
	).bind(`${prefix}${index}@example.com`, `${prefix}${index}`, userId)));
	const { results } = await env.db.prepare(
		'SELECT account_id FROM account WHERE user_id = ? AND is_del = 0 ORDER BY account_id'
	).bind(userId).all();
	return results.map(row => row.account_id);
}

export function orderPayload(snapshot, changes = {}) {
	return { version: snapshot.version, mainFirst: snapshot.mainFirst, pinnedIds: [...snapshot.pinnedIds], normalIds: [...snapshot.normalIds], ...changes };
}

export async function rawOrderState(userId) {
	const { results: accounts } = await env.db.prepare(
		'SELECT account_id, user_id, sort, is_pinned, is_del FROM account WHERE user_id = ? ORDER BY account_id'
	).bind(userId).all();
	const user = await env.db.prepare(
		'SELECT mailbox_main_first, mailbox_order_version FROM user WHERE user_id = ?'
	).bind(userId).first();
	return { accounts, user };
}

export async function legacyPages(token, size = 30) {
	const pages = [];
	let last;
	for (let guard = 0; guard < 10; guard++) {
		const params = new URLSearchParams({ size: String(size), accountId: String(last?.accountId ?? 0) });
		if (last) params.set('lastSort', String(last.sort));
		const page = await ok(`/account/list?${params}`, { token });
		expect(Array.isArray(page)).toBe(true);
		expect(page.length).toBeLessThanOrEqual(30);
		pages.push(...page);
		if (page.length < Math.min(size, 30)) return pages;
		last = page.at(-1);
	}
	throw new Error('Legacy pagination did not terminate after ten pages.');
}
