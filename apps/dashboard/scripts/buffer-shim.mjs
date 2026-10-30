// The wallet SDK dependency tree uses the Node global `Buffer`; esbuild injects this wherever it is referenced.
import { Buffer } from "buffer/";
export { Buffer };
