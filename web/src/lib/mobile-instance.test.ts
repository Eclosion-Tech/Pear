import { describe, expect, it } from 'vitest';
import { mobileInstanceConfig } from './mobile-instance';

describe('mobile instance auth configuration', () => {
  it('uses native auth when the instance has no OIDC configuration', () => {
    expect(mobileInstanceConfig('https://pear.example.test', { NEXT_PUBLIC_SPACETIMEDB_DB_NAME: 'my-pear' })).toMatchObject({ version: 1, uri: 'wss://pear.example.test', databaseName: 'my-pear', auth: { mode: 'native' } });
  });
  it('requires a mobile client for OIDC and never silently falls back to passwords', () => {
    const env = { NEXT_PUBLIC_SPACETIMEAUTH_AUTHORITY: 'https://login.example.test', NEXT_PUBLIC_SPACETIMEAUTH_CLIENT_ID: 'web' };
    expect(() => mobileInstanceConfig('https://pear.example.test', env)).toThrow('PEAR_MOBILE_OIDC_CLIENT_ID');
    const config = mobileInstanceConfig('https://pear.example.test', { ...env, PEAR_MOBILE_OIDC_CLIENT_ID: 'native', PEAR_MOBILE_OIDC_SCOPES: 'openid profile email offline_access' });
    expect(config.auth).toEqual({ mode: 'oidc', issuer: env.NEXT_PUBLIC_SPACETIMEAUTH_AUTHORITY, clientId: 'native', scopes: ['openid','profile','email','offline_access'] });
  });
  it('rejects insecure OIDC and WebSocket endpoints', () => {
    expect(() => mobileInstanceConfig('http://pear.example.test', {})).toThrow('WSS');
    expect(() => mobileInstanceConfig('https://pear.example.test', { NEXT_PUBLIC_SPACETIMEDB_URI: 'ws://pear.example.test' })).toThrow('WSS');
    expect(() => mobileInstanceConfig('https://pear.example.test', { NEXT_PUBLIC_SPACETIMEAUTH_AUTHORITY: 'http://login.example.test', NEXT_PUBLIC_SPACETIMEAUTH_CLIENT_ID: 'web', PEAR_MOBILE_OIDC_CLIENT_ID: 'native' })).toThrow('HTTPS');
  });
});
