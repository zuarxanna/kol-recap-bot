// adapter/index.ts — barrel for the platform adapters + the base contract.
// Import from here: `import { InstagramAdapter, TikTokAdapter } from './adapter/index.js'`.

export { PlatformAdapter } from './PlatformAdapter.js';
export { InstagramAdapter } from './instagram/index.js';
export { TikTokAdapter } from './tiktok/index.js';
export { YouTubeAdapter } from './youtube/index.js';
