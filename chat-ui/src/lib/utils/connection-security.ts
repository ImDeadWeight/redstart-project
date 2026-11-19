/**
 * Is the connection to Nest encrypted? (TLS plan Q3: the not-encrypted banner.)
 *
 * In a browser served by Nest, the page and the API share an origin, so the
 * browser's own judgement decides: `window.isSecureContext` is true for https
 * and for localhost (which never crosses the network), false for plain HTTP to
 * a LAN address.
 *
 * In a native shell (Twig, the Android app) the page is local and always a
 * secure context, so that test says nothing; what crosses the network is the
 * configured server URL. Encrypted when it is https, or when it points at this
 * machine's loopback.
 */
export function isConnectionEncrypted({
	secureContext,
	serverBaseUrl
}: {
	secureContext: boolean;
	/** '' in a browser served by Nest; the configured server URL in a native shell. */
	serverBaseUrl: string;
}): boolean {
	if (!serverBaseUrl) return secureContext;
	let url: URL;
	try {
		url = new URL(serverBaseUrl);
	} catch {
		return false;
	}
	if (url.protocol === 'https:') return true;
	const host = url.hostname.replace(/^\[|\]$/g, '');
	return host === 'localhost' || host === '::1' || /^127\./.test(host);
}

/** sessionStorage key: dismissed for this tab's session only, back on the next visit. */
export const NOT_ENCRYPTED_DISMISS_KEY = 'redstart.notEncryptedDismissed';
