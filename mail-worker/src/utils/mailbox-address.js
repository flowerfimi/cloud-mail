import BizError from '../error/biz-error';
import verifyUtils from './verify-utils';
import emailUtils from './email-utils';
import { t } from '../i18n/i18n';

const labelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';

const addressUtils = {

	domains(config) {
		const list = typeof config === 'string' ? JSON.parse(config) : config;
		return [...new Set((list || []).map(domain => domain.replace(/^@/, '').toLowerCase()))];
	},

	roots(config) {
		const domains = this.domains(config);
		return domains.filter(domain => !domains.some(other => other !== domain && domain.endsWith('.' + other)));
	},

	isChild(domain, root) {
		return domain.endsWith('.' + root) && labelPattern.test(domain.slice(0, -root.length - 1));
	},

	isAllowed(domain, config) {
		domain = domain.toLowerCase();
		if (domain.length > 253 || !domain.split('.').every(label => labelPattern.test(label))) return false;
		return this.domains(config).includes(domain) || this.roots(config).some(root => this.isChild(domain, root));
	},

	hasPermission(availDomain, email, config) {
		const allowed = (availDomain || '').split(',').filter(Boolean).map(domain => domain.replace(/^@/, '').toLowerCase());
		if (!allowed.length) return true;
		const domain = emailUtils.getDomain(email).toLowerCase();
		const roots = this.roots(config);
		return allowed.some(grant => domain === grant || (roots.includes(grant) && this.isChild(domain, grant)));
	},

	randomSubdomain() {
		let label = '';
		while (label.length < 8) {
			// Rejection sampling avoids bias when mapping bytes onto 36 characters.
			for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
				if (byte < 252) label += alphabet[byte % alphabet.length];
				if (label.length === 8) break;
			}
		}
		return label;
	},

	build(params, config) {
		const { email, subdomainMode = 'normal', subdomain } = params;
		if (typeof email !== 'string' || !verifyUtils.isEmail(email)) throw new BizError(t('notEmail'));
		const name = emailUtils.getName(email);
		let domain = emailUtils.getDomain(email).toLowerCase();
		if (!['normal', 'random', 'manual'].includes(subdomainMode)) throw new BizError(t('invalidSubdomainMode'));
		if (!this.isAllowed(domain, config)) throw new BizError(t('notEmailDomain'));
		if (subdomainMode !== 'normal') {
			if (!this.roots(config).includes(domain)) throw new BizError(t('subdomainRootRequired'));
			const label = subdomainMode === 'random' ? this.randomSubdomain() : String(subdomain ?? '').toLowerCase();
			if (!labelPattern.test(label)) throw new BizError(t('invalidSubdomain'));
			domain = label + '.' + domain;
		}
		const address = name + '@' + domain;
		if (name.length > 64 || address.length > 254 || domain.length > 253) throw new BizError(t('emailLengthLimit'));
		return address;
	},

	conflict(message) {
		return Object.assign(new BizError(message), { addressConflict: true });
	},

	isConflict(error) {
		for (let cause = error; cause; cause = cause.cause) {
			if (cause.addressConflict || /UNIQUE constraint failed: (?:account|user)\.email(?:\b)/i.test(cause.message || '')) return true;
		}
		return false;
	},

	async create(params, config, operation, firstEmail = this.build(params, config)) {
		for (let retry = 0; ; retry++) {
			const email = retry === 0 ? firstEmail : this.build(params, config);
			try {
				return await operation(email);
			} catch (error) {
				if (!this.isConflict(error)) throw error;
				if (params.subdomainMode !== 'random') throw error instanceof BizError ? error : new BizError(t('isRegAccount'));
				if (retry === 5) throw new BizError(t('randomAddressUnavailable'));
			}
		}
	},
};

export default addressUtils;
