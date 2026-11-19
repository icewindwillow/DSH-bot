// Standalone snippets normally receive these functions from the installed gateway.
import * as documents from '../../qqbot-patches/profile-document-reader.js';
export * from '../../qqbot-patches/profile-document-reader.js';
Object.assign(globalThis, documents);
