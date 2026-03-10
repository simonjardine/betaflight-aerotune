import GUI, { TABS } from '../gui';
import { i18n } from '../localization';
import CONFIGURATOR from '../data_storage.js';
import $ from 'jquery';

// ─────────────────────────────────────────────
// AeroTune Calculator (ported from AeroTune_V5_4_PRODUCTION.py)
// ─────────────────────────────────────────────

const KV_BASELINE = {
    200: 20, 1300: 28, 1400: 32, 1600: 38, 1700: 39, 1800: 40,
    2000: 43, 2100: 46, 2400: 44, 3000: 40, 3800: 38,
    4200: 41, 5000: 35, 7000: 28, 11500: 55,
};

const FLYING_STYLES = {
    'Racing':     1.08,
    'Freestyle':  1.00,
    'Long Range': 0.65,
    'Cinematic':  0.75,
};

function interpolateKV(kv) {
    kv = parseFloat(kv);
    if (KV_BASELINE[kv] !== undefined) return KV_BASELINE[kv];

    const sorted = Object.keys(KV_BASELINE).map(Number).sort((a, b) => b - a);
    for (let i = 0; i < sorted.length - 1; i++) {
        const kv1 = sorted[i];
        const kv2 = sorted[i + 1];
        if (kv <= kv1 && kv >= kv2) {
            const p1 = KV_BASELINE[kv1];
            const p2 = KV_BASELINE[kv2];
            const ratio = kv1 !== kv2 ? (kv - kv2) / (kv1 - kv2) : 0;
            return p1 + (p2 - p1) * ratio;
        }
    }
    const last = Object.keys(KV_BASELINE).map(Number).sort((a, b) => a - b)[0];
    return KV_BASELINE[last];
}

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

function calculatePIDs(kv, voltage, prop, weight, style) {
    kv      = parseFloat(kv);
    voltage = parseFloat(voltage);
    prop    = parseFloat(prop);
    weight  = parseFloat(weight);
    if (isNaN(kv) || isNaN(voltage) || isNaN(prop) || isNaN(weight)) return null;

    let pBase = interpolateKV(kv);

    pBase *= FLYING_STYLES[style] || 1.0;
    pBase *= 1.0 - ((voltage - 22.2) / 22.2 * 0.20);   // voltage adj (6S baseline)
    pBase *= 1.0 + ((weight - 500)   / 2000 * 0.15);   // weight adj
    pBase *= 1.0 + ((prop - 5)       / 6    * 0.12);   // prop adj

    const rollP  = clamp(Math.round(pBase),       20, 90);
    const pitchP = clamp(Math.round(pBase + 2),   20, 90);
    const yawP   = clamp(Math.round(pBase * 0.92), 15, 70);

    const rollI  = Math.round(rollP  * 1.3);
    const pitchI = Math.round(pitchP * 1.3);
    const yawI   = Math.round(yawP   * 1.3);

    const rollD  = Math.round(rollP  * 0.65);
    const pitchD = Math.round(pitchP * 0.65);

    const dMinRoll  = Math.round(rollP  * 0.60);
    const dMinPitch = Math.round(pitchP * 0.60);

    const fBase  = pBase * 2.5;
    const rollF  = Math.round(fBase * 0.92);
    const pitchF = Math.round(fBase * 1.0);
    const yawF   = Math.round(fBase * 0.92);

    return {
        roll_p: rollP,  roll_i: rollI,  roll_d: rollD,  roll_f: rollF,
        pitch_p: pitchP, pitch_i: pitchI, pitch_d: pitchD, pitch_f: pitchF,
        yaw_p: yawP,   yaw_i: yawI,   yaw_d: 0,       yaw_f: yawF,
        d_min_roll: dMinRoll, d_min_pitch: dMinPitch,
    };
}

function filterRecommendation(prop) {
    prop = parseFloat(prop);
    if (prop <= 3)   return { hz: 450, low: 400, high: 500, note: 'Small / Micro' };
    if (prop <= 4)   return { hz: 380, low: 350, high: 420, note: '4-inch' };
    if (prop <= 5.5) return { hz: 300, low: 280, high: 350, note: '5-inch (most common)' };
    if (prop <= 7)   return { hz: 250, low: 220, high: 280, note: '6–7 inch' };
    if (prop <= 10)  return { hz: 180, low: 150, high: 220, note: '8–10 inch' };
    return            { hz: 120, low: 100, high: 150, note: '10"+ Large' };
}

// ─────────────────────────────────────────────
// Log Analyzer (ported from Python CSVLogParser)
// ─────────────────────────────────────────────

function parseBlackboxCSV(text) {
    const lines = text.split(/\r?\n/);
    let headerIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('loopIteration')) { headerIdx = i; break; }
    }
    if (headerIdx === -1) return null;

    const headers = lines[headerIdx].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
    const rows = [];
    for (let i = headerIdx + 1; i < lines.length; i++) {
        const parts = lines[i].split(',');
        if (parts.length < 2) continue;
        const row = {};
        headers.forEach((h, idx) => {
            const raw = (parts[idx] || '').trim();
            const n = Number(raw);
            row[h] = isNaN(n) ? raw : n;
        });
        rows.push(row);
    }
    return rows;
}

function analyzeLog(rows) {
    if (!rows || rows.length === 0) {
        return { error: 'No valid data found in log.' };
    }

    // ── FILTER ANALYSIS ──────────────────────────────────────────────────────
    const rawVals      = [];
    const filteredVals = [];
    let   highThrottleCount = 0;

    // Detect eRPM columns → RPM filter active
    const hasRpmFilter = Object.keys(rows[0]).some(
        k => /erpm/i.test(k) || /rpm\[/i.test(k),
    );

    for (const row of rows) {
        const throttle = Number(row['rcCommand[3]'] ?? 1000);
        if (throttle > 1400) {
            highThrottleCount++;
            rawVals.push(
                Math.abs(Number(row['gyroUnfilt[0]'] ?? 0)) +
                Math.abs(Number(row['gyroUnfilt[1]'] ?? 0)),
            );
            filteredVals.push(
                Math.abs(Number(row['gyroADC[0]'] ?? 0)) +
                Math.abs(Number(row['gyroADC[1]'] ?? 0)),
            );
        }
    }

    if (highThrottleCount === 0) {
        return { error: 'No high-throttle frames found (rcCommand[3] > 1400). Ensure you flew at high throttle and that unfiltered gyro logging was enabled.' };
    }

    const avgRaw        = rawVals.reduce((a, b) => a + b, 0) / rawVals.length;
    const avgFiltered   = filteredVals.reduce((a, b) => a + b, 0) / filteredVals.length;
    const effectiveness = avgRaw > 0 ? clamp((avgRaw - avgFiltered) / avgRaw * 100, 0, 100) : 0;
    const throttlePct   = (highThrottleCount / rows.length) * 100;

    let vibLevel, filterAction;
    if (avgRaw < 15) {
        vibLevel     = 'CLEAN ✓';
        filterAction = 'Your filters are well-tuned. No changes needed.';
    } else if (avgRaw < 20) {
        vibLevel     = 'GOOD ✓';
        filterAction = 'Gyro Lowpass 2: keep current setting.\nD-term Lowpass: consider slight increase (less aggressive).';
    } else if (avgRaw < 30) {
        vibLevel     = 'FAIR';
        filterAction = 'Gyro Lowpass 2: lower by ~30 Hz.\nD-term Lowpass: lower by ~20 Hz.\nRe-fly and re-analyze.';
    } else if (avgRaw < 50) {
        vibLevel     = 'WEAK ⚠';
        filterAction = 'Gyro Lowpass 2: lower by ~50 Hz.\nD-term Lowpass: lower by ~30 Hz.\nConsider enabling a Notch filter.';
    } else {
        vibLevel     = 'VERY WEAK 🔴';
        filterAction = 'Gyro Lowpass 2: reduce aggressively (~100 Hz).\nD-term: lower significantly.\nEnable all available filters.\nCheck for mechanical vibration sources.';
    }

    if (effectiveness < 30 && avgRaw >= 30) {
        filterAction += '\nConsider enabling Dynamic Notch Filter or increasing notch count.';
    }
    if (hasRpmFilter) {
        filterAction += '\nRPM filter detected (eRPM data present) — it is active and helping suppress motor harmonics.';
    }

    // ── P GAIN ANALYSIS ──────────────────────────────────────────────────────
    function analyzePGain(axis) {
        const spKey   = `setpoint[${axis}]`;
        const gyroKey = `gyroADC[${axis}]`;
        const overshootPcts = [];
        const lagFrames     = [];

        for (let i = 1; i + 30 < rows.length; i++) {
            const spPrev = Number(rows[i - 1][spKey] ?? 0);
            const spCurr = Number(rows[i][spKey]     ?? 0);
            if (Math.abs(spCurr - spPrev) <= 20) continue;

            const absSP = Math.abs(spCurr);
            if (absSP < 5) continue;

            // Peak absolute gyro in next 30 frames
            let peakGyro = Math.abs(Number(rows[i][gyroKey] ?? 0));
            for (let j = 1; j <= 30 && i + j < rows.length; j++) {
                const g = Math.abs(Number(rows[i + j][gyroKey] ?? 0));
                if (g > peakGyro) peakGyro = g;
            }

            overshootPcts.push((peakGyro - absSP) / absSP * 100);

            // Lag: frames until |gyro| reaches 90 % of |setpoint|
            let lagFound = false;
            for (let j = 1; j <= 30 && i + j < rows.length; j++) {
                if (Math.abs(Number(rows[i + j][gyroKey] ?? 0)) >= absSP * 0.9) {
                    lagFrames.push(j);
                    lagFound = true;
                    break;
                }
            }
            if (!lagFound) lagFrames.push(30);
        }

        return { overshootPcts, lagFrames };
    }

    const rollP  = analyzePGain(0);
    const pitchP = analyzePGain(1);

    const allOvershoots = [...rollP.overshootPcts, ...pitchP.overshootPcts];
    const allLags       = [...rollP.lagFrames,     ...pitchP.lagFrames];

    let pVerdict, pAction;
    if (allOvershoots.length === 0) {
        pVerdict = 'NO STEP INPUTS DETECTED';
        pAction  = 'No rapid stick inputs found. Fly with sharp, deliberate inputs to enable P analysis.';
    } else {
        const avgOvershoot = allOvershoots.reduce((a, b) => a + b, 0) / allOvershoots.length;
        const avgLag       = allLags.reduce((a, b) => a + b, 0)       / allLags.length;

        if (avgOvershoot > 15) {
            pVerdict = 'P TOO HIGH ⚠';
            pAction  = `Average overshoot: ${avgOvershoot.toFixed(1)}%.\nRoll/Pitch P too high — reduce by 5–10.`;
        } else if (avgLag > 3 && avgOvershoot < 5) {
            pVerdict = 'P TOO LOW';
            pAction  = `Average response lag: ${avgLag.toFixed(1)} frames.\nRoll/Pitch P too low — increase by 5–10.`;
        } else {
            pVerdict = 'P GAINS LOOK GOOD ✓';
            pAction  = `Average overshoot: ${avgOvershoot.toFixed(1)}%, lag: ${avgLag.toFixed(1)} frames. P gains look good.`;
        }
    }

    // ── D GAIN ANALYSIS ──────────────────────────────────────────────────────
    function analyzeDGain(axis) {
        const spKey      = `setpoint[${axis}]`;
        const gyroKey    = `gyroADC[${axis}]`;
        const gyroUnfKey = `gyroUnfilt[${axis}]`;
        const axisDKey   = `axisD[${axis}]`;
        const axisPKey   = `axisP[${axis}]`;

        const zeroCrossingCounts = [];
        const dToPRatios         = [];
        let hiThrDOscCount = 0;
        let hiThrCount     = 0;

        for (let i = 1; i + 21 < rows.length; i++) {
            const spPrev = Number(rows[i - 1][spKey] ?? 0);
            const spCurr = Number(rows[i][spKey]     ?? 0);
            if (Math.abs(spCurr - spPrev) <= 20) continue;
            if (Math.abs(spCurr) < 5) continue;

            // Find peak gyro in next 30 frames
            let peakFrame = i;
            let peakGyro  = Math.abs(Number(rows[i][gyroKey] ?? 0));
            for (let j = 1; j <= 30 && i + j < rows.length; j++) {
                const g = Math.abs(Number(rows[i + j][gyroKey] ?? 0));
                if (g > peakGyro) { peakGyro = g; peakFrame = i + j; }
            }

            // Zero crossings of (gyroADC − setpoint) in 20 frames after peak
            let crossings = 0;
            for (let j = 1; j <= 20 && peakFrame + j < rows.length; j++) {
                const e1 = Number(rows[peakFrame + j - 1][gyroKey] ?? 0) - Number(rows[peakFrame + j - 1][spKey] ?? 0);
                const e2 = Number(rows[peakFrame + j][gyroKey]     ?? 0) - Number(rows[peakFrame + j][spKey]     ?? 0);
                if (e1 * e2 < 0) crossings++;
            }
            zeroCrossingCounts.push(crossings);

            // D/P ratio at peak frame
            const dVal = Math.abs(Number(rows[peakFrame][axisDKey] ?? 0));
            const pVal = Math.abs(Number(rows[peakFrame][axisPKey] ?? 0));
            if (pVal > 1) dToPRatios.push(dVal / pVal);
        }

        // High-throttle filter-noise check: gyroUnfilt >> gyroADC but D still active
        for (const row of rows) {
            if (Number(row['rcCommand[3]'] ?? 1000) > 1400) {
                hiThrCount++;
                const unfilt = Math.abs(Number(row[gyroUnfKey] ?? 0));
                const filt   = Math.abs(Number(row[gyroKey]    ?? 0));
                if (unfilt > filt * 2 && Math.abs(Number(row[axisDKey] ?? 0)) > 20) hiThrDOscCount++;
            }
        }

        return {
            avgCrossings:    zeroCrossingCounts.length > 0 ? zeroCrossingCounts.reduce((a, b) => a + b, 0) / zeroCrossingCounts.length : 0,
            avgDtoP:         dToPRatios.length > 0         ? dToPRatios.reduce((a, b) => a + b, 0)         / dToPRatios.length         : 0,
            filterNoiseDOsc: hiThrCount > 0 && (hiThrDOscCount / hiThrCount) > 0.3,
            stepCount:       zeroCrossingCounts.length,
        };
    }

    const rollD  = analyzeDGain(0);
    const pitchD = analyzeDGain(1);

    const avgCrossings    = (rollD.avgCrossings + pitchD.avgCrossings) / 2;
    const avgDtoP         = (rollD.avgDtoP      + pitchD.avgDtoP)      / 2;
    const filterNoiseDOsc = rollD.filterNoiseDOsc || pitchD.filterNoiseDOsc;
    const hasSteps        = rollD.stepCount > 0   || pitchD.stepCount > 0;

    let dVerdict, dAction;
    if (!hasSteps) {
        dVerdict = 'NO STEP INPUTS DETECTED';
        dAction  = 'No rapid stick inputs found. Fly with sharp, deliberate inputs to enable D analysis.';
    } else if (filterNoiseDOsc) {
        dVerdict = 'FILTER NOISE LIMITING D ⚠';
        dAction  = 'Unfiltered gyro is much noisier than filtered at high throttle, and D is still active.\nFix filters before increasing D — see FILTERS section.';
    } else if (avgCrossings > 3) {
        dVerdict = 'D TOO LOW ⚠';
        dAction  = `Average zero-crossings after peak: ${avgCrossings.toFixed(1)}.\nD too low — increase by 3–5.`;
    } else if (avgDtoP > 1.5) {
        dVerdict = 'D MAY BE TOO HIGH ⚠';
        dAction  = `D/P ratio is ${avgDtoP.toFixed(2)} — D may be too high.\nCheck motor temps and consider reducing D by 3–5.`;
    } else {
        dVerdict = 'D GAINS LOOK GOOD ✓';
        dAction  = `Average zero-crossings: ${avgCrossings.toFixed(1)}, D/P ratio: ${avgDtoP.toFixed(2)}. D gains look good.`;
    }

    return {
        totalFrames:      rows.length,
        highThrottleCount,
        throttlePct:      throttlePct.toFixed(1),
        avgRaw:           avgRaw.toFixed(2),
        avgFiltered:      avgFiltered.toFixed(2),
        effectiveness:    effectiveness.toFixed(1),
        vibLevel,
        filterAction,
        pVerdict,
        pAction,
        dVerdict,
        dAction,
    };
}

function formatAnalysisResult(r) {
    if (r.error) return `ERROR: ${r.error}`;
    const SEP = '════════════════════════════════════════════════════';
    return [
        `Frames analysed : ${r.totalFrames}  |  High-throttle: ${r.highThrottleCount} (${r.throttlePct}%)`,
        ``,
        SEP,
        `  ROLL/PITCH P : ${r.pVerdict}`,
        SEP,
        r.pAction,
        ``,
        SEP,
        `  ROLL/PITCH D : ${r.dVerdict}`,
        SEP,
        r.dAction,
        ``,
        SEP,
        `  FILTERS : ${r.vibLevel}  |  Effectiveness: ${r.effectiveness}%`,
        SEP,
        `Avg raw gyro (hi-thr): ${r.avgRaw}  |  Avg filtered: ${r.avgFiltered}`,
        r.filterAction,
    ].join('\n');
}

// ─────────────────────────────────────────────
// Apply PIDs to PID Tuning tab
// ─────────────────────────────────────────────

function applyPIDsToFC(pids) {
    // Store so they survive the tab transition
    window._aeroTunePendingPIDs = pids;

    const pidTabLink = document.querySelector('li.tab_pid_tuning a');
    if (!pidTabLink) {
        alert('PID Tuning tab not available. Make sure a flight controller is connected.');
        delete window._aeroTunePendingPIDs;
        return;
    }

    // Watch for #pid_main to appear in #content after the tab loads
    const content = document.getElementById('content');
    const observer = new MutationObserver(() => {
        const pidMain = document.getElementById('pid_main');
        if (pidMain && window._aeroTunePendingPIDs) {
            observer.disconnect();
            const p = window._aeroTunePendingPIDs;
            delete window._aeroTunePendingPIDs;

            const $m = $(pidMain);
            const set = (selector, value) => $m.find(selector).val(value).trigger('input').trigger('change');

            set('.ROLL .pid_data  input[name="p"]',        p.roll_p);
            set('.ROLL .pid_data  input[name="i"]',        p.roll_i);
            set('.ROLL .pid_data  input[name="d"]',        p.roll_d);
            set('.ROLL .pid_data  input[name="f"]',        p.roll_f);
            set('.ROLL .pid_data  input[name="dMaxRoll"]', p.d_min_roll);

            set('.PITCH .pid_data input[name="p"]',         p.pitch_p);
            set('.PITCH .pid_data input[name="i"]',         p.pitch_i);
            set('.PITCH .pid_data input[name="d"]',         p.pitch_d);
            set('.PITCH .pid_data input[name="f"]',         p.pitch_f);
            set('.PITCH .pid_data input[name="dMaxPitch"]', p.d_min_pitch);

            set('.YAW .pid_data   input[name="p"]', p.yaw_p);
            set('.YAW .pid_data   input[name="i"]', p.yaw_i);
            set('.YAW .pid_data   input[name="d"]', p.yaw_d);
            set('.YAW .pid_data   input[name="f"]', p.yaw_f);
        }
    });

    observer.observe(content, { childList: true, subtree: true });
    pidTabLink.click();
}

// ─────────────────────────────────────────────
// Tab module
// ─────────────────────────────────────────────

const aerotune = {};

aerotune.initialize = function (callback) {
    if (GUI.active_tab !== 'aerotune') {
        GUI.active_tab = 'aerotune';
    }

    $('#content').load('./tabs/aerotune.html', function () {
        i18n.localizePage();
        aerotune._setup();
        GUI.content_ready(callback);
    });
};

aerotune._setup = function () {
    let lastPIDs = null;

    // ── Sub-tab switching ──
    $('.at-tab-btn').on('click', function () {
        $('.at-tab-btn').removeClass('active');
        $(this).addClass('active');
        $('.at-view').hide();
        $(`#${$(this).data('target')}`).show();
    });

    // ── Voltage preset buttons ──
    $('#at-voltage-presets button').on('click', function () {
        const v = $(this).data('v');
        $('#at-voltage').val(v);
        $('#at-voltage-presets button').removeClass('selected');
        $(this).addClass('selected');
    });

    $('#at-voltage').on('input', function () {
        $('#at-voltage-presets button').removeClass('selected');
    });

    // ── Calculate ──
    $('#at-calculate').on('click', function () {
        const kv      = $('#at-kv').val();
        const voltage = $('#at-voltage').val();
        const prop    = $('#at-prop').val();
        const weight  = $('#at-weight').val();
        const style   = $('#at-style').val();

        const pids = calculatePIDs(kv, voltage, prop, weight, style);
        if (!pids) {
            alert('Invalid input values. Please check all fields.');
            return;
        }

        lastPIDs = pids;

        // Fill output values
        $('#rv-roll-p').text(pids.roll_p);
        $('#rv-roll-i').text(pids.roll_i);
        $('#rv-roll-d').text(pids.roll_d);
        $('#rv-roll-f').text(pids.roll_f);

        $('#rv-pitch-p').text(pids.pitch_p);
        $('#rv-pitch-i').text(pids.pitch_i);
        $('#rv-pitch-d').text(pids.pitch_d);
        $('#rv-pitch-f').text(pids.pitch_f);

        $('#rv-yaw-p').text(pids.yaw_p);
        $('#rv-yaw-i').text(pids.yaw_i);
        $('#rv-yaw-d').text(pids.yaw_d);
        $('#rv-yaw-f').text(pids.yaw_f);

        $('#rv-dmin-roll').text(pids.d_min_roll);
        $('#rv-dmin-pitch').text(pids.d_min_pitch);

        const fr = filterRecommendation(prop);
        $('#rv-filter-hz').text(fr.hz);
        $('#rv-filter-note').text(fr.note);
        $('#rv-filter-range').text(`${fr.low} – ${fr.high}`);

        $('#at-placeholder').hide();
        $('#at-results').show();

        // Enable Apply only when connected
        if (CONFIGURATOR.connectionValid) {
            $('#at-apply-btn').prop('disabled', false);
        }
    });

    // ── Apply to FC ──
    $('#at-apply-btn').on('click', function () {
        if (!lastPIDs) return;
        if (!CONFIGURATOR.connectionValid) {
            alert('No flight controller connected. Connect to FC before applying PIDs.');
            return;
        }
        applyPIDsToFC(lastPIDs);
    });

    // Disable Apply btn if not connected
    if (!CONFIGURATOR.connectionValid) {
        $('#at-apply-btn').prop('disabled', true).attr('title', 'Connect to FC first');
    }

    // ── Copy all values ──
    $('#at-copy-btn').on('click', function () {
        if (!lastPIDs) return;
        const p = lastPIDs;
        const prop = $('#at-prop').val();
        const fr   = filterRecommendation(prop);
        const text = [
            `# AeroTune PID Values`,
            `Roll   P=${p.roll_p}  I=${p.roll_i}  D=${p.roll_d}  F=${p.roll_f}  D_min=${p.d_min_roll}`,
            `Pitch  P=${p.pitch_p}  I=${p.pitch_i}  D=${p.pitch_d}  F=${p.pitch_f}  D_min=${p.d_min_pitch}`,
            `Yaw    P=${p.yaw_p}  I=${p.yaw_i}  D=${p.yaw_d}  F=${p.yaw_f}`,
            `Gyro Lowpass 2 recommendation: ${fr.hz} Hz (${fr.low}–${fr.high} Hz) – ${fr.note}`,
        ].join('\n');

        navigator.clipboard.writeText(text).then(() => {
            const btn = $('#at-copy-btn');
            const orig = btn.text();
            btn.text('✔ Copied!');
            setTimeout(() => btn.text(orig), 2000);
        });
    });

    // ── Log file input ──
    $('#at-file-input').on('change', function () {
        const file = this.files[0];
        if (!file) return;
        $('#at-file-name').text(file.name);
        $('#at-analyze-btn').prop('disabled', false);
    });

    // ── Analyze ──
    $('#at-analyze-btn').on('click', function () {
        const file = document.getElementById('at-file-input').files[0];
        if (!file) return;

        $('#at-results-box').text('Parsing file…');

        const reader = new FileReader();
        reader.onload = function (e) {
            const text = e.target.result;
            const rows = parseBlackboxCSV(text);
            if (!rows) {
                $('#at-results-box').text('ERROR: Could not find a valid Betaflight blackbox header.\nMake sure you exported a CSV from Blackbox Explorer (not the raw .BBL file).');
                return;
            }
            const result = analyzeLog(rows);
            $('#at-results-box').text(formatAnalysisResult(result));
        };
        reader.onerror = function () {
            $('#at-results-box').text('ERROR: Could not read file.');
        };
        reader.readAsText(file);
    });
};

aerotune.cleanup = function (callback) {
    if (callback) callback();
};

TABS.aerotune = aerotune;

export { aerotune };
