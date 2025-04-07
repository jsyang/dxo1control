/*
    dxo1usb.js - Programmatic control of your DXO One camera over USB
    https://github.com/jsyang/dxo1control
    <jsyang@gmail.com>
*/
import { getU8AFromHexString, compareU8A, mergeU8A, getStringFromU8A, } from './u8a.js';

const PARAMS_DEVICE_REQUEST = { filters: [{ vendorId: 0x2b8f }] };

const METADATA_INIT_SIGNATURE = getU8AFromHexString('A3, BA, D1, 10, AB, CD, AB, CD, 00, 00, 00, 00, 02, 00, 00, 00, 00, 00, 00, 00, 00, 00, 00, 00, 00, 00, 00, 00, 00, 00, 00, 00');
const METADATA_INIT_RESPONSE_SIGNATURE = getU8AFromHexString('A3, BA, D1, 10, DC, BA, DC, BA, 00, 00, 00, 00, 00, 00, 00, 00, 00, 00, 00, 00, 00, 00, 00, 00, 00, 00, 00, 00, 00, 00, 00, 00');

const RPC_HEADER = getU8AFromHexString('A3, BA, D1, 10, 17, 08, 00, 0C');
const RPC_HEADER_TRAILER = getU8AFromHexString('00, 00, 03, 00, 00, 00, 00, 00, 00, 00, 00, 00, 00, 00, 00, 00, 00, 00, 00, 00, 00, 00');

const JPG_METADATA_HEADER = getU8AFromHexString('A3, BA, D1, 10');
const JPG_HEADER = getU8AFromHexString('FF, D8, FF');
const JPG_TRAILER = getU8AFromHexString('FF, D9');

const MAX_PACKETSIZE = 512;

const ERROR_WEBUSB_API_NOT_SUPPORTED = 'Sorry, your browser / JS environment does not support WebUSB!\nTry running this in Chrome.';

// Can use any library that implements the WebUSB API
// e.g. node-usb
async function open(usbBackend = navigator.usb) {
    if (!usbBackend) {
        if (alert) alert(ERROR_WEBUSB_API_NOT_SUPPORTED);
        throw ERROR_WEBUSB_API_NOT_SUPPORTED;
    }

    const device = await usbBackend.requestDevice(PARAMS_DEVICE_REQUEST);

    await device.open();

    let inEndpoint;
    let outEndpoint;

    await device.selectConfiguration(1);
    await device.claimInterface(device.configuration.interfaces[0].interfaceNumber);
    await device.claimInterface(device.configuration.interfaces[1].interfaceNumber);
    await device.selectAlternateInterface(1, 1);

    inEndpoint = device.configuration.interfaces[0].alternate.endpoints[1].endpointNumber;
    outEndpoint = device.configuration.interfaces[0].alternate.endpoints[0].endpointNumber;

    let seq = 0; // sequence id used for  JSON-RPC commands

    await device.transferOut(outEndpoint, METADATA_INIT_RESPONSE_SIGNATURE);

    // Drain any pre-existing data from the device's outbound buffer then send ACK from our app
    // This prevents any unflushed messages from contaminating our expected messages
    let initDrainRXBuffer = [];
    do {
        initDrainRXBuffer = await getRX(MAX_PACKETSIZE);

        if (compareU8A(initDrainRXBuffer, METADATA_INIT_SIGNATURE)) {
            await device.transferOut(outEndpoint, METADATA_INIT_RESPONSE_SIGNATURE);
            break;
        }
    } while (initDrainRXBuffer.length > 0);


    function getRX(byteLength = 32) {
        return device.transferIn(inEndpoint, byteLength).then(res => new Uint8Array(res.data.buffer));
    }

    async function transferInJPEG() {
        let metadata = await getRX(MAX_PACKETSIZE);

        if (compareU8A(metadata, METADATA_INIT_SIGNATURE)) {
            await device.transferOut(outEndpoint, METADATA_INIT_RESPONSE_SIGNATURE);
            metadata = await getRX(MAX_PACKETSIZE);
        }

        let jpgResponse = new Uint8Array(metadata.length);

        let offset = 0;
        if (jpgResponse.indexOfMulti(JPG_METADATA_HEADER) >= 0) {
            offset = metadata.length - 32;
            jpgResponse.set(metadata.slice(32));
        } else {
            offset = 0;
            jpgResponse.set(metadata);
        }

        let payload;
        do {
            payload = await getRX(MAX_PACKETSIZE);

            // Might be clobbered with other USB messages
            // Drop any bad frames due to msg collision
            // Keep resizing to fit the JPEG frame
            const diffLength = jpgResponse.length - (offset + payload.length);
            if (diffLength < 0) {
                let newJpgResponse = new Uint8Array(offset + payload.length);
                newJpgResponse.set(jpgResponse);
                jpgResponse = newJpgResponse;
            }

            jpgResponse.set(payload, offset);

            offset += payload.length;
        } while (payload.indexOfMulti(JPG_TRAILER) < 0);

        return jpgResponse;
    }

    async function transferInRPC() {
        let metadata = await getRX(MAX_PACKETSIZE);

        if (compareU8A(metadata, METADATA_INIT_SIGNATURE)) {
            await device.transferOut(outEndpoint, METADATA_INIT_RESPONSE_SIGNATURE);
            metadata = await getRX(MAX_PACKETSIZE);
        }

        const rpcResponseSize = metadata[8] + (metadata[9] << 8); // little-endian json-rpc response message size

        if (rpcResponseSize === 0) return;

        let rpcResponse = new Uint8Array(rpcResponseSize);
        rpcResponse.set(metadata.slice(32));
        let offset = metadata.length - 32;

        let payload;
        do {
            if (offset === rpcResponseSize) break;

            payload = await getRX(MAX_PACKETSIZE);
            if (compareU8A(payload, METADATA_INIT_SIGNATURE)) {
                await device.transferOut(outEndpoint, METADATA_INIT_RESPONSE_SIGNATURE);
                break;
            }

            // Drop all bad frames
            try {
                rpcResponse.set(payload, offset);
            } catch (e) {
                return null;
            }

            offset += payload.length;
        } while (offset < rpcResponseSize);

        const decodedString = getStringFromU8A(rpcResponse).replace(/\x00/g, '').trim();

        try {
            // Check if the device forced a USB buffer flush!
            // If so, re-run the transferIn!
            const res = JSON.parse(decodedString);
            if (res.method === 'dxo_usb_flush_forced') {
                return await transferInRPC();
            } else {
                return res;
            }
        } catch (e) {
            console.log('Failed to parse:');
            console.log(decodedString);
            return null;
        }
    }

    async function transferOutRPC(method, params) {
        await device.transferOut(outEndpoint, METADATA_INIT_RESPONSE_SIGNATURE);

        const payload = new TextEncoder().encode(JSON.stringify({
            "jsonrpc": "2.0",
            "id": seq,
            method,
            ...(params ? { params } : {}),
        }) + '\x00');

        seq++;

        const msgDetails = mergeU8A([
            // Little endian message size
            payload.length % (1 << 8),
            Math.floor(payload.length / (1 << 8))
        ], RPC_HEADER_TRAILER);

        const msgHeader = mergeU8A(RPC_HEADER, msgDetails);
        const msgWhole = mergeU8A(msgHeader, payload);

        await device.transferOut(outEndpoint, msgWhole);

        return await transferInRPC();
    }

    const bindApplySetting = params => (async data => {
        const commandSeq = seq;

        if (params.type === 'copyright' || params.type === 'artist') {
            params.param = data;
        } else if (params.type === 'mf_inv_distance') {
            // 0 - 5, with 6 digits of precision
            const dist = Math.min(Math.max(data, 0), 5).toFixed(6);
            params.param = dist;
        }

        const immediateResponse = await transferOutRPC('dxo_setting_set', params);
        if (immediateResponse.method === 'dxo_setting_applied') {
            const response = await transferInRPC();
            const hasSucceeded = result.id === commandSeq && response.result.type === params.type;

            return hasSucceeded;
        }

        return false;
    });

    let lastJPEGFrame = new Uint8Array(0);
    let shouldStopLiveView = false;

    async function startLiveView(callback) {
        shouldStopLiveView = false;
        await transferOutRPC('dxo_camera_mode_switch', { "param": 'view' });
        do {

            if (shouldStopLiveView) break;

            let frame = await transferInJPEG() || new Uint8Array(0);
            // Need 1 more condition to stop empty frames from getting through
            if (!frame || frame.length === 0) {
                // console.log(frame);
                continue;
            }

            let foundHeaderIndex = lastJPEGFrame.indexOfMulti(JPG_HEADER);
            let foundTrailerIndex = lastJPEGFrame.indexOfMulti(JPG_TRAILER, foundHeaderIndex + 1);

            if (foundHeaderIndex > 0 && foundTrailerIndex > 0) {
                lastJPEGFrame = lastJPEGFrame.slice(foundHeaderIndex, foundTrailerIndex + 2);
                let blob = new Blob([lastJPEGFrame], { 'type': 'image/jpeg' });
                let url = URL.createObjectURL(blob);
                lastJPEGFrame = new Uint8Array(0);
                callback(url);
            } else {
                let accumulatedJPEGFrame = lastJPEGFrame.slice();
                const lastLength = lastJPEGFrame.length;

                if (foundHeaderIndex > 0) {
                    lastJPEGFrame = new Uint8Array(lastLength - foundHeaderIndex + frame.length);
                    lastJPEGFrame.set(accumulatedJPEGFrame);
                    lastJPEGFrame.set(frame, lastLength - foundHeaderIndex);
                } else {
                    lastJPEGFrame = new Uint8Array(lastLength + frame.length);
                    lastJPEGFrame.set(accumulatedJPEGFrame);
                    lastJPEGFrame.set(frame, lastLength);
                }

                foundHeaderIndex = lastJPEGFrame.indexOfMulti(JPG_HEADER);
                foundTrailerIndex = lastJPEGFrame.indexOfMulti(JPG_TRAILER, foundHeaderIndex + 1);

                if (foundHeaderIndex > 0 && foundTrailerIndex > 0) {
                    lastJPEGFrame = lastJPEGFrame.slice(foundHeaderIndex, foundTrailerIndex + 2);
                    let blob = new Blob([lastJPEGFrame], { 'type': 'image/jpeg' });
                    let url = URL.createObjectURL(blob);
                    lastJPEGFrame = new Uint8Array(0);
                    callback(url);
                }
            }
        } while (1);
    }

    async function stopLiveView() {
        // TODO: turn this off from the camera side too
        shouldStopLiveView = true;
    }

    return {
        command: {
            getAllSettings: () => transferOutRPC('dxo_all_settings_get'),
            getStatus: () => transferOutRPC('dxo_camera_status_get'),

            // TODO: figure out the last 3 parts of the param
            // 3rd last one might be heading
            // 2nd last one might be speed
            // last one might be local time
            setGPSData: () => transferOutRPC('dxo_gps_data_set', { "param": "##d##m##.####s,N,##d##m##.####s,W,138,0,05h34m40s" }),

            setSettings: {
                imageFormat: {
                    rawOff: bindApplySetting({ "type": "raw", "param": "off" }),
                    rawOn: bindApplySetting({ "type": "raw", "param": "on" }),

                    // Temporal Noise Reduction (TNR) to combine the four RAW files into one new SuperRAW Plus file
                    tnrOff: bindApplySetting({ "type": "tnr", "param": "on" }),
                    tnrOn: bindApplySetting({ "type": "tnr", "param": "on" }),
                },

                stillFocusingMode: {
                    MF: bindApplySetting({ "type": "still_focusing_mode", "param": "mf" }),
                    AF: bindApplySetting({ "type": "still_focusing_mode", "param": "af" }),
                },

                afMode: {
                    AF_OD: /* On Demand  */ bindApplySetting({ "type": "af_mode", "param": "af-od" }),
                    AF_C: /* Continuous  */ bindApplySetting({ "type": "af_mode", "param": "af-c" }),
                    AF_S: /* Single Shot */ bindApplySetting({ "type": "af_mode", "param": "af-s" }),
                },

                mfInvDistance: bindApplySetting({ "type": "mf_inv_distance", "param": "0.000000" }),

                iso: {
                    auto: bindApplySetting({ "type": "iso", "param": "auto" }),
                    iso100: bindApplySetting({ "type": "iso", "param": "iso100" }),
                    iso200: bindApplySetting({ "type": "iso", "param": "iso200" }),
                    iso400: bindApplySetting({ "type": "iso", "param": "iso400" }),
                    iso800: bindApplySetting({ "type": "iso", "param": "iso800" }),
                    iso1600: bindApplySetting({ "type": "iso", "param": "iso1600" }),
                    iso3200: bindApplySetting({ "type": "iso", "param": "iso3200" }),
                    iso6400: bindApplySetting({ "type": "iso", "param": "iso6400" }),
                    iso12800: bindApplySetting({ "type": "iso", "param": "iso12800" }),
                    iso25600: bindApplySetting({ "type": "iso", "param": "iso25600" }),
                    iso51200: bindApplySetting({ "type": "iso", "param": "iso51200" }),
                },

                evBias: {
                    m3_0: bindApplySetting({ "type": "ev_bias", "param": "-3.0" }),
                    m2_7: bindApplySetting({ "type": "ev_bias", "param": "-2.7" }),
                    m2_3: bindApplySetting({ "type": "ev_bias", "param": "-2.3" }),
                    m2_0: bindApplySetting({ "type": "ev_bias", "param": "-2.0" }),
                    m1_7: bindApplySetting({ "type": "ev_bias", "param": "-1.7" }),
                    m1_3: bindApplySetting({ "type": "ev_bias", "param": "-1.3" }),
                    m1_0: bindApplySetting({ "type": "ev_bias", "param": "-1.0" }),
                    m0_7: bindApplySetting({ "type": "ev_bias", "param": "-0.7" }),
                    m0_3: bindApplySetting({ "type": "ev_bias", "param": "-0.3" }),
                    zero: bindApplySetting({ "type": "ev_bias", "param": "0" }),
                    p0_3: bindApplySetting({ "type": "ev_bias", "param": "+0.3" }),
                    p0_7: bindApplySetting({ "type": "ev_bias", "param": "+0.7" }),
                    p1_0: bindApplySetting({ "type": "ev_bias", "param": "+1.0" }),
                    p1_3: bindApplySetting({ "type": "ev_bias", "param": "+1.3" }),
                    p1_7: bindApplySetting({ "type": "ev_bias", "param": "+1.7" }),
                    p2_0: bindApplySetting({ "type": "ev_bias", "param": "+2.0" }),
                    p2_3: bindApplySetting({ "type": "ev_bias", "param": "+2.3" }),
                    p2_7: bindApplySetting({ "type": "ev_bias", "param": "+2.7" }),
                    p3_0: bindApplySetting({ "type": "ev_bias", "param": "+3.0" }),
                },

                aperture: {
                    f1_8: bindApplySetting({ "type": "aperture", "param": "1.8" }),
                    f2: bindApplySetting({ "type": "aperture", "param": "2" }),
                    f2_2: bindApplySetting({ "type": "aperture", "param": "2.2" }),
                    f2_5: bindApplySetting({ "type": "aperture", "param": "2.5" }),
                    f2_8: bindApplySetting({ "type": "aperture", "param": "2.8" }),
                    f3_2: bindApplySetting({ "type": "aperture", "param": "3.2" }),
                    f3_5: bindApplySetting({ "type": "aperture", "param": "3.5" }),
                    f4: bindApplySetting({ "type": "aperture", "param": "4" }),
                    f4_5: bindApplySetting({ "type": "aperture", "param": "4.5" }),
                    f5: bindApplySetting({ "type": "aperture", "param": "5" }),
                    f5_6: bindApplySetting({ "type": "aperture", "param": "5.6" }),
                    f6_3: bindApplySetting({ "type": "aperture", "param": "6.3" }),
                    f7_1: bindApplySetting({ "type": "aperture", "param": "7.1" }),
                    f8: bindApplySetting({ "type": "aperture", "param": "8" }),
                    f9: bindApplySetting({ "type": "aperture", "param": "9" }),
                    f10: bindApplySetting({ "type": "aperture", "param": "10" }),
                    f11: bindApplySetting({ "type": "aperture", "param": "11" }),
                },

                exposureTime: {
                    t1_20000: bindApplySetting({ "type": "exposure_time", "param": "1/20000" }),
                    t1_16000: bindApplySetting({ "type": "exposure_time", "param": "1/16000" }),
                    t1_8000: bindApplySetting({ "type": "exposure_time", "param": "1/8000" }),
                    t1_4000: bindApplySetting({ "type": "exposure_time", "param": "1/4000" }),
                    t1_2000: bindApplySetting({ "type": "exposure_time", "param": "1/2000" }),
                    t1_1600: bindApplySetting({ "type": "exposure_time", "param": "1/1600" }),
                    t1_1250: bindApplySetting({ "type": "exposure_time", "param": "1/1250" }),
                    t1_1000: bindApplySetting({ "type": "exposure_time", "param": "1/1000" }),
                    t1_800: bindApplySetting({ "type": "exposure_time", "param": "1/800" }),
                    t1_640: bindApplySetting({ "type": "exposure_time", "param": "1/640" }),
                    t1_500: bindApplySetting({ "type": "exposure_time", "param": "1/500" }),
                    t1_400: bindApplySetting({ "type": "exposure_time", "param": "1/400" }),
                    t1_320: bindApplySetting({ "type": "exposure_time", "param": "1/320" }),
                    t1_250: bindApplySetting({ "type": "exposure_time", "param": "1/250" }),
                    t1_200: bindApplySetting({ "type": "exposure_time", "param": "1/200" }),
                    t1_160: bindApplySetting({ "type": "exposure_time", "param": "1/160" }),
                    t1_125: bindApplySetting({ "type": "exposure_time", "param": "1/125" }),
                    t1_100: bindApplySetting({ "type": "exposure_time", "param": "1/100" }),
                    t1_80: bindApplySetting({ "type": "exposure_time", "param": "1/80" }),
                    t1_60: bindApplySetting({ "type": "exposure_time", "param": "1/60" }),
                    t1_50: bindApplySetting({ "type": "exposure_time", "param": "1/50" }),
                    t1_40: bindApplySetting({ "type": "exposure_time", "param": "1/40" }),
                    t1_30: bindApplySetting({ "type": "exposure_time", "param": "1/30" }),
                    t1_25: bindApplySetting({ "type": "exposure_time", "param": "1/25" }),
                    t1_20: bindApplySetting({ "type": "exposure_time", "param": "1/20" }),
                    t1_15: bindApplySetting({ "type": "exposure_time", "param": "1/15" }),
                    t1_13: bindApplySetting({ "type": "exposure_time", "param": "1/13" }),
                    t1_10: bindApplySetting({ "type": "exposure_time", "param": "1/10" }),
                    t1_8: bindApplySetting({ "type": "exposure_time", "param": "1/8" }),
                    t1_6: bindApplySetting({ "type": "exposure_time", "param": "1/6" }),
                    t1_5: bindApplySetting({ "type": "exposure_time", "param": "1/5" }),
                    t1_4: bindApplySetting({ "type": "exposure_time", "param": "1/4" }),
                    t1_3: bindApplySetting({ "type": "exposure_time", "param": "1/3" }),
                    t1_2: bindApplySetting({ "type": "exposure_time", "param": "1/2" }),
                    t1_1: bindApplySetting({ "type": "exposure_time", "param": "1/1" }),
                    t2_1: bindApplySetting({ "type": "exposure_time", "param": "2/1" }),
                    t4_1: bindApplySetting({ "type": "exposure_time", "param": "4/1" }),
                    t8_1: bindApplySetting({ "type": "exposure_time", "param": "8/1" }),
                    t15_1: bindApplySetting({ "type": "exposure_time", "param": "15/1" }),
                    t30_1: bindApplySetting({ "type": "exposure_time", "param": "30/1" }),
                },

                shootingMode: {
                    sport: bindApplySetting({ "type": "shooting_mode", "param": "sport" }),
                    portrait: bindApplySetting({ "type": "shooting_mode", "param": "portrait" }),
                    landscape: bindApplySetting({ "type": "shooting_mode", "param": "landscape" }),
                    night: bindApplySetting({ "type": "shooting_mode", "param": " night" }),

                    // Priority shooting modes
                    program: bindApplySetting({ "type": "shooting_mode", "param": "program" }),
                    aperture: bindApplySetting({ "type": "shooting_mode", "param": "aperture" }),
                    shutter: bindApplySetting({ "type": "shooting_mode", "param": "shutter" }),
                    manual: bindApplySetting({ "type": "shooting_mode", "param": "manual" }),
                },

                shutterMode: {
                    single: bindApplySetting({ "type": "drive", "param": "single" }),
                    timelapse: bindApplySetting({ "type": "drive", "param": "timelapse" }),
                    timer0s: bindApplySetting({ "type": "selftimer", "param": "0" }),
                    timer2s: bindApplySetting({ "type": "selftimer", "param": "2" }),
                    timer10s: bindApplySetting({ "type": "selftimer", "param": "10" }),
                },

                autoWhiteBalance: {
                    off: bindApplySetting({ "type": "lighting_intensity", "param": "off" }),
                    slight: bindApplySetting({ "type": "lighting_intensity", "param": "slight" }),
                    medium: bindApplySetting({ "type": "lighting_intensity", "param": "medium" }),
                    strong: bindApplySetting({ "type": "lighting_intensity", "param": "strong" }),
                },
                imageQuality: {
                    fine: bindApplySetting({ "type": "photo_quality", "param": "100" }),
                    normal: bindApplySetting({ "type": "photo_quality", "param": "95" }),
                    basic: bindApplySetting({ "type": "photo_quality", "param": "70" }),
                },
                maxIso: {
                    auto: bindApplySetting({ "type": "iso_boundaries", "param": "no_limit" }),
                    iso100: bindApplySetting({ "type": "iso_boundaries", "param": "iso100" }),
                    iso200: bindApplySetting({ "type": "iso_boundaries", "param": "iso200" }),
                    iso400: bindApplySetting({ "type": "iso_boundaries", "param": "iso400" }),
                    iso800: bindApplySetting({ "type": "iso_boundaries", "param": "iso800" }),
                    iso1600: bindApplySetting({ "type": "iso_boundaries", "param": "iso1600" }),
                    iso3200: bindApplySetting({ "type": "iso_boundaries", "param": "iso3200" }),
                    iso6400: bindApplySetting({ "type": "iso_boundaries", "param": "iso6400" }),
                    iso12800: bindApplySetting({ "type": "iso_boundaries", "param": "iso12800" }),
                    iso25600: bindApplySetting({ "type": "iso_boundaries", "param": "iso25600" }),
                    iso51200: bindApplySetting({ "type": "iso_boundaries", "param": "iso51200" }),
                },
                maxShutter: {
                    auto: bindApplySetting({ "type": "max_exposure", "param": "0/1" }),
                    t15_1: bindApplySetting({ "type": "max_exposure", "param": "15/1" }),
                    t2_1: bindApplySetting({ "type": "max_exposure", "param": "2/1" }),
                    t1_3: bindApplySetting({ "type": "max_exposure", "param": "1/3" }),
                    t1_6: bindApplySetting({ "type": "max_exposure", "param": "1/6" }),
                    t1_13: bindApplySetting({ "type": "max_exposure", "param": "1/13" }),
                    t1_25: bindApplySetting({ "type": "max_exposure", "param": "1/25" }),
                    t1_50: bindApplySetting({ "type": "max_exposure", "param": "1/50" }),
                    t1_100: bindApplySetting({ "type": "max_exposure", "param": "1/100" }),
                    t1_200: bindApplySetting({ "type": "max_exposure", "param": "1/200" }),
                    t1_400: bindApplySetting({ "type": "max_exposure", "param": "1/400" }),

                },
                metadata: {
                    copyright: bindApplySetting({ "type": "copyright", "param": "COPYRIGHT" }),
                    artist: bindApplySetting({ "type": "artist", "param": "ARTIST" }),
                },
                videoQuality: {
                    standard: bindApplySetting({ "type": "video_quality", "param": "16000000" }),
                    better: bindApplySetting({ "type": "video_quality", "param": "22000000" }),
                    highest: bindApplySetting({ "type": "video_quality", "param": "30000000" }),
                },
            },

            getDigitalZoom: transferOutRPC('dxo_digital_zoom_get', { "type": 'current' }),

            // Origin is bottom left corner
            focus: (x, y) => transferOutRPC('dxo_tap_to_focus', { "param": `[${x},${y},256,256]` }),
            // Not 100% sure what this command does- likely flushes focus value?
            flushFocus: () => transferOutRPC('dxo_tap_to_focus', { "param": '[0,0,0,0]' }),

            takePhoto: () => transferOutRPC('dxo_photo_take'),

            sleep: () => transferOutRPC('dxo_idle'),

            fs: {
                // TODO: File retrieval not tested at all!
                fetchFile: (path, offset, fetch_size) => transferOutRPC('dxo_fs_last_file_get', { "param": path, offset, fetch_size }),

                getLastFilePath: () => transferOutRPC('dxo_fs_last_file_get'),

                cancelGet: () => transferOutRPC('dxo_fs_cancel_get'),
            },

            liveView: {
                start: startLiveView,
                stop: stopLiveView,
            },
        },

        // Disconnect
        close: () => {
            shouldStopLiveView = true;
            return device.close();
        },
    };
}

export default {
    open,
}
