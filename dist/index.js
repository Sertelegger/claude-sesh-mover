"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
// sesh-mover core library exports
// NOTE: decodeProjectPath intentionally not provided — encoding is lossy for hyphenated paths.
// Use readProjectPathFromJsonl in discovery.ts or read cwd from JSONL entries instead.
__exportStar(require("./types.js"), exports);
__exportStar(require("./platform.js"), exports);
__exportStar(require("./config.js"), exports);
__exportStar(require("./manifest.js"), exports);
__exportStar(require("./discovery.js"), exports);
__exportStar(require("./summary.js"), exports);
__exportStar(require("./rewriter.js"), exports);
__exportStar(require("./archiver.js"), exports);
__exportStar(require("./version-adapters.js"), exports);
__exportStar(require("./exporter.js"), exports);
__exportStar(require("./importer.js"), exports);
__exportStar(require("./migrator.js"), exports);
//# sourceMappingURL=index.js.map