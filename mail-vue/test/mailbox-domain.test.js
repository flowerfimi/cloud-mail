import {test} from 'node:test';
import assert from 'node:assert/strict';
import {rootDomainSuffixes, completeEmail, completeLoginEmail, normalizeSubdomain, subdomainRequest, validSubdomain} from '../src/utils/mailbox-domain.js';

test('creation choices contain configured roots once in configuration order', () => {
  assert.deepEqual(rootDomainSuffixes([
    '@mail.example.com', '@EXAMPLE.com', 'example.org', '@example.com',
    '@mail.example.org', '@nested.mail.example.com', '@notexample.com',
  ]), ['@example.com', '@example.org', '@notexample.com']);
});

test('root extraction keeps independent configured domains and handles hidden domains', () => {
  assert.deepEqual(rootDomainSuffixes(['@team.example.com', ' other.example.com ']), ['@team.example.com', '@other.example.com']);
  assert.deepEqual(rootDomainSuffixes([]), []);
  assert.deepEqual(rootDomainSuffixes(), []);
});

test('complete login addresses never receive another suffix', () => {
  assert.equal(completeEmail('person@mail.example.com', '@example.org'), 'person@mail.example.com');
  assert.equal(completeEmail('person+tag@Ab12cd34.example.com', '@example.org'), 'person+tag@Ab12cd34.example.com');
  assert.equal(completeEmail(' person@example.com ', ''), 'person@example.com');
  assert.equal(completeEmail('person', '@example.com'), 'person@example.com');
  assert.equal(completeEmail('person'), 'person');
});

test('login selects root or child domains and keeps pasted full addresses intact', () => {
  assert.equal(completeLoginEmail('admin', '@xoocc.com'), 'admin@xoocc.com');
  assert.equal(completeLoginEmail('admin', '@xoocc.com', 'mail'), 'admin@mail.xoocc.com');
  assert.equal(completeLoginEmail(' test ', '@askyo.de', ' Team-7 '), 'test@team-7.askyo.de');
  assert.equal(completeLoginEmail('test', '@018800.xyz', 'a7k9m2x4'), 'test@a7k9m2x4.018800.xyz');
  assert.equal(completeLoginEmail('test@mail.978800.xyz', '@xoocc.com', 'unused'), 'test@mail.978800.xyz');
  assert.equal(completeLoginEmail(' test@mail.978800.xyz ', ''), 'test@mail.978800.xyz');
});

test('manual labels normalize uppercase and accept supported DNS label boundaries', () => {
  assert.equal(normalizeSubdomain('Team-42'), 'team-42');
  for (const value of ['a', '7', 'Team', 'a-7', 'a'.repeat(63)]) {
    assert.equal(validSubdomain(value), true, value);
  }
});

test('manual labels reject missing values, multiple levels and invalid boundaries', () => {
  for (const value of ['', '-team', 'team-', 'a.b', 'a_b', 'team ', ' team', '中文', 'a'.repeat(64)]) {
    assert.equal(validSubdomain(value), false, value);
  }
});

test('creation submits the visible candidate including edits after random generation', () => {
  assert.deepEqual(subdomainRequest('random', 'a7k9m2x4'), {subdomainMode: 'manual', subdomain: 'a7k9m2x4'});
  assert.deepEqual(subdomainRequest('random', 'Edited-team'), {subdomainMode: 'manual', subdomain: 'edited-team'});
  assert.deepEqual(subdomainRequest('manual', 'Team'), {subdomainMode: 'manual', subdomain: 'team'});
  assert.equal(subdomainRequest('normal', 'previous').subdomainMode, 'normal');
});
