import fs from 'fs';
import { execSync } from 'child_process';

const [_NODEBIN, _SCRIPT, dngPath] = process.argv;

const ABOUT_MSG = `
---
USAGE: node ${_SCRIPT} <path to DNG directory>

Resizes and converts DNGs to JPGs without modifying the image's colorspace.
Onboard DXO One firmware alters this colorspace during conversion from DNG to JPG!
---
`.trim();

const FACTOR = 0.25;
const RESIZED_H = 3688 * FACTOR;
const RESIZED_W = 5540 * FACTOR;
const RESIZED_DIR = 'resized';

function batchResize() {
    if (!dngPath) {
        console.log(ABOUT_MSG);
        return;
    }

    const files = fs.readdirSync(dngPath);
    fs.mkdirSync(RESIZED_DIR, { recursive: true });

    try {
        for (let f of files) {
            if (f.indexOf('.DNG') === -1) continue;

            execSync(`sips -s format jpeg ${dngPath}/${f} --resampleHeightWidth ${RESIZED_H} ${RESIZED_W} --out ${dngPath}/${RESIZED_DIR}/${f.replace('.DNG', '.jpg')}`);
        }
    } catch (e) {
        console.error(e.stderr.toString('utf8'));
    }
}

batchResize();