/** @type {import('next').NextConfig} */
const nextConfig = {
	output: 'standalone',
	poweredByHeader: false,
	// separate build dirs let several dev servers run side by side
	distDir: process.env.NEXT_DIST_DIR || '.next',
	// legacy pages and assets use root-relative urls without trailing slashes
	trailingSlash: false,
	skipTrailingSlashRedirect: true,
	// mongoose must not be bundled into the server build
	serverExternalPackages: ['mongoose'],
	async headers() {
		return [{
			source: '/:path*',
			// middleware.ts resolves legacy root-relative urls by the page that requested them
			headers: [{ key: 'Referrer-Policy', value: 'same-origin' }]
		}];
	}
};

export default nextConfig;
