import { describe, expect, it } from 'vitest';
import { isConnectionEncrypted } from '../../src/lib/utils/connection-security';

// TLS plan Q3: the "This connection isn't encrypted" banner.
describe('isConnectionEncrypted', () => {
	it('in a browser served by Nest, follows the browser (isSecureContext)', () => {
		expect(isConnectionEncrypted({ secureContext: true, serverBaseUrl: '' })).toBe(true);
		expect(isConnectionEncrypted({ secureContext: false, serverBaseUrl: '' })).toBe(false);
	});

	it('in a native shell, an https server URL is encrypted', () => {
		expect(isConnectionEncrypted({ secureContext: true, serverBaseUrl: 'https://myhouse.duckdns.org' })).toBe(true);
	});

	it('in a native shell, plain HTTP to a LAN address is NOT, even though the page is a secure context', () => {
		expect(isConnectionEncrypted({ secureContext: true, serverBaseUrl: 'http://192.168.0.213:19080' })).toBe(false);
		expect(isConnectionEncrypted({ secureContext: true, serverBaseUrl: 'http://myhouse.duckdns.org' })).toBe(false);
	});

	it('loopback never crosses the network', () => {
		for (const u of ['http://127.0.0.1:19080', 'http://localhost:19080', 'http://[::1]:19080']) {
			expect(isConnectionEncrypted({ secureContext: true, serverBaseUrl: u })).toBe(true);
		}
	});

	it('an unparseable server URL is not called encrypted', () => {
		expect(isConnectionEncrypted({ secureContext: true, serverBaseUrl: 'not a url' })).toBe(false);
	});
});
