/**
 * Otedama v2.1.0 - Unified Mining Application
 * 設計思想: John Carmack (実用的), Robert C. Martin (クリーン), Rob Pike (シンプル)
 * 
 * 古いファイルの統合・置き換え用エントリーポイント
 * このファイルは後方互換性のため保持されます
 */

// 統合されたメインアプリケーションを呼び出し
export { OtedamaMainApplication as default, createOtedamaApp, startOtedama } from './main-unified';
export type { OtedamaConfig, OtedamaSystemStatus } from './main-unified';

// 古いインポート名との互換性
export { OtedamaMainApplication as OtedamaApp } from './main-unified';
export { createOtedamaApp as createApp } from './main-unified';

console.log('⚠️  このファイルは非推奨です。代わりに ./main-unified.ts または ./index.ts を使用してください。');
console.log('🔄 Redirecting to unified application...');