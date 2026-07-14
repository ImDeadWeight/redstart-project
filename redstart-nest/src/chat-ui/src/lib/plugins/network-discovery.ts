import { registerPlugin } from '@capacitor/core';

export interface DiscoveredServer {
	url: string;
	ip: string;
	port: number;
}

export interface LocalNetworkInfo {
	ip: string;
	subnet: string;
	gateway: string;
}

export interface ScanOptions {
	subnet: string;
	ports?: number[];
	/** TCP connect timeout in ms (default 300) */
	timeout?: number;
}

export interface ScanResult {
	servers: DiscoveredServer[];
}

export interface NetworkDiscoveryPlugin {
	getLocalNetworkInfo(): Promise<LocalNetworkInfo>;
	scanForServers(options: ScanOptions): Promise<ScanResult>;
}

export const NetworkDiscovery = registerPlugin<NetworkDiscoveryPlugin>('NetworkDiscovery');
