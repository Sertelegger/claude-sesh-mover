import { once } from "node:events";
import { finished } from "node:stream/promises";
export function latchedWriteStream(stream) {
    // Guards (1) and (2) from the header: the listener, and the promise that
    // stays rejected.
    const errored = new Promise((_, reject) => stream.once("error", reject));
    // Guard (3): handled from this moment, still rejected for every race below.
    errored.catch(() => { });
    return {
        write: (chunk) => stream.write(chunk),
        async drain() {
            await Promise.race([once(stream, "drain"), errored]);
        },
        async finish() {
            stream.end();
            await Promise.race([finished(stream), errored]);
        },
        destroy() {
            stream.destroy();
        },
    };
}
//# sourceMappingURL=latched-write.js.map