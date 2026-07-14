import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
	appId: 'com.beaver.app',
	appName: 'Redstart',
	webDir: 'dist',
	server: {
		androidScheme: 'https'
	}
};

export default config;
