export function mergeU8A(u1, u2) {
    const merged = new Uint8Array(u1.length + u2.length);
    merged.set(u1);
    merged.set(u2, u1.length);

    return merged
};

export function getU8AFromHexString(s) {
    return new Uint8Array(s.replace(/(\[|\])/g, '')
        .split(',')
        .map(c => parseInt(c.trim(), 16))
    );
}

export function getHexFromU8A(u) {
    let hexString = '';
    for (let d of u) {
        hexString += d.toString(16).padStart(2, '0');
    }
    return hexString;
}

export function compareU8A(u1, u2) {
    if (u1.length !== u2.length) return false;

    for (let i = 0; i < u1.length; i++) {
        if (u1[i] !== u2[i]) return false;
    }

    return true;
}

export function getStringFromU8A(u) {
    return (new TextDecoder()).decode(u);
}

function downloadURL(data, fileName) {
    let a;
    a = document.createElement('a');
    a.href = data;
    a.download = fileName;
    document.body.appendChild(a);
    a.style = 'display: none';
    a.click();
    a.remove();
}

export function downloadBlob(data, fileName, mimeType = 'application/octet-stream') {
    let blob, url;
    blob = new Blob([data], {
        type: mimeType
    });
    url = window.URL.createObjectURL(blob);
    downloadURL(url, fileName);
    setTimeout(function () {
        return window.URL.revokeObjectURL(url);
    }, 1000);
}

function payloadStrHuman(s) {
    const stringAsUint8 = new Uint8Array(s.replace(/\[\]/g, '').split(',').map(c => parseInt(c.trim(), 16)));
    return (new TextDecoder()).decode(stringAsUint8);
}

// TODO: Optimize this
Uint8Array.prototype.indexOfMulti = function (queryU8a, fromIndex = 0) {
    let index = Array.prototype.indexOf.call(this, queryU8a[0], fromIndex);
    if (queryU8a.length === 1 || index === -1) {
        // Not found or no other elements to check
        return index;
    }

    let i, j, found;
    for (i = index; i < this.length; i++) {
        found = true;
        for (j = 0; j < queryU8a.length; j++) {
            if (i + j > this.length - 1 || queryU8a[j] !== this[i + j]) {
                found = false;
                break;
            }
        }

        if (found) break;
    }

    if (i === this.length) return -1;

    return i;
};

export const sleep = ms => new Promise((resolve) => setTimeout(resolve, ms));