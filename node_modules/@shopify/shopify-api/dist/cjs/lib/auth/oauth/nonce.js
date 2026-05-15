'use strict';

function nonce() {
    const length = 15;
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    const nonce = bytes
        .map((byte) => {
        return byte % 10;
    })
        .join('');
    return nonce;
}

exports.nonce = nonce;
//# sourceMappingURL=nonce.js.map
