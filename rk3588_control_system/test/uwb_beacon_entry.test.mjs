import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(testDir, "..");
const dashboardHtml = fs.readFileSync(path.join(appRoot, "frontend", "index.html"), "utf8");
const gimbalScript = fs.readFileSync(path.join(appRoot, "frontend", "js", "page_gimbal.js"), "utf8");
const mobileHtml = fs.readFileSync(path.join(appRoot, "frontend", "mobile-preview-kimi-k26.html"), "utf8");
const transportScript = fs.readFileSync(path.join(appRoot, "frontend", "js", "manta-app-transport.js"), "utf8");
const serverScript = fs.readFileSync(path.join(appRoot, "backend", "server.js"), "utf8");

test("dashboard exposes a direct UWB Beacon entry", () => {
    assert.match(
        dashboardHtml,
        /id="btnUwbBeacon"[^>]*href="gimbal\.html\?mode=beacon"|href="gimbal\.html\?mode=beacon"[^>]*id="btnUwbBeacon"/,
    );
    assert.match(dashboardHtml, />进入 UWB Beacon<\/a>/);
});

test("gimbal entry query automatically starts beacon tracking", () => {
    assert.match(gimbalScript, /new URLSearchParams\(window\.location\.search\)/);
    assert.match(gimbalScript, /requestedTrackModeFromLocation\(\) === "beacon"/);
    assert.match(gimbalScript, /startTrackMode\("beacon"\)/);
});

test("live mobile frontend exposes and transports beacon mode", () => {
    assert.match(mobileHtml, /data-gimbal-mode="beacon">UWB 信标<\/button>/);
    assert.match(mobileHtml, /payload\.trackMode==="beacon"/);
    assert.match(transportScript, /action === "beacon"/);
});

test("beacon toolbar exposes configurable multipoint calibration", () => {
    assert.match(mobileHtml, /id="gimbalBeaconCalibration"/);
    assert.match(mobileHtml, /id="beaconCalibrationModal"/);
    assert.match(mobileHtml, /value="horizontal9"/);
    assert.match(transportScript, /\/api\/gimbal\/beacon\/calibration\/capture/);
    assert.match(transportScript, /\/api\/gimbal\/beacon\/calibration\/apply/);
    assert.match(serverScript, /fitPlanarCalibration\(session\.samples\)/);
    assert.match(serverScript, /generateBeaconCalibrationPoints\(Math\.random,/);
    assert.match(serverScript, /fitBeaconCalibration\(session\.samples\)/);
    assert.match(serverScript, /points\.length/);
    assert.match(mobileHtml, /id="beaconCalibrationCanvas"/);
    assert.match(mobileHtml, /25 点精细校准/);
    assert.doesNotMatch(mobileHtml, /八点校准/);
    assert.match(mobileHtml, /if\(state\.gimbalMode==="beacon"\)return/);
    assert.match(serverScript, /collectBeaconCalibrationReading\(\)/);
    assert.doesNotMatch(serverScript, /uwb_raw_distance_m|rawUwbControl/);
    assert.match(serverScript, /smoothedUwbOutput\.view/);
    assert.match(serverScript, /stabilizeBeaconUwb\(now,/);
});

test("boat auto-follow is controlled from the drive module, not the gimbal view", () => {
    assert.doesNotMatch(mobileHtml, /id="gimbalUwbFollow"/);
    assert.doesNotMatch(mobileHtml, /id="gimbalUwbFollowControl"/);
    assert.match(mobileHtml, /id="manualFollowButton"/);
    assert.match(mobileHtml, /id="autoFollowButton"/);
    assert.match(mobileHtml, /id="driveFollowControl"/);
    assert.match(mobileHtml, /id="driveFollowSwitch"/);
    assert.match(mobileHtml, /joystick\.hidden=automatic/);
    assert.doesNotMatch(mobileHtml, /GPS定位无效，自动跟随保持停止/);
    assert.doesNotMatch(mobileHtml, /EKF速度\/位置估计无效，自动跟随保持停止/);
    assert.doesNotMatch(mobileHtml, /目标距离需达到1\.2米后才允许启动/);
    assert.match(mobileHtml, /UWB 自动跟随已启动/);
    assert.match(mobileHtml, /follow\.relativeBodyM/);
    assert.match(mobileHtml, /follow\.requiredFlightMode/);
    assert.match(transportScript, /setDriveEnabled/);
    assert.match(transportScript, /\/api\/uwb-follow\/start/);
    assert.match(transportScript, /uwb_follow_update/);
    assert.match(serverScript, /sendMavlinkCommand\('SET_MODE', \{ mode: requiredFlightMode/);
    assert.match(serverScript, /initialPreflight\.controlMode/);
    assert.match(serverScript, /sendUwbRelativeDrive\(result\)/);
    assert.match(serverScript, /sendMavlinkCommand\('SET_MODE', \{ mode: 'MANUAL'/);
    assert.match(serverScript, /sendMavlinkCommand\('ARM'/);
    assert.match(serverScript, /waitForFollowTelemetry/);
});

test("gimbal calibration preserves the separate boat-follow bearing calibration", () => {
    const followConfig = serverScript.match(/const uwbControllerConfig = \{[\s\S]*?\n\};/)?.[0];
    assert.match(followConfig, /\.\.\.UWB_FOLLOW_CONFIG/);
    assert.doesNotMatch(followConfig, /GIMBAL_BEACON_CONFIG/);
    const start = serverScript.indexOf('function persistBeaconCalibration(result)');
    const end = serverScript.indexOf('function startBeaconCalibrationSession(', start);
    assert.ok(start >= 0 && end > start);
    const persistCalibration = serverScript.slice(start, end);
    assert.match(persistCalibration, /planar_yaw_calibration: result\.planar_yaw_calibration/);
    assert.match(persistCalibration, /extrinsic_3d: result\.extrinsic_3d/);
    assert.doesNotMatch(persistCalibration, /UWB_FOLLOW_CONFIG|setBearingCalibration/);
});
