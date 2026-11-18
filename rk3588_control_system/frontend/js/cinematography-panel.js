const endpoint = '/api/cinematography';
const unavailable = Object.freeze({
    schema_version: 1, available: false, state: 'unavailable', mode: null, modes: [],
    reason: '自主运镜服务不可用', can_start: false, can_stop: false, can_set_p: false,
    p_enabled: null, target_state: null, intent_mode: null, executed_mode: null, gimbal_source: null, uwb_distance_m: null
});
const states = { unavailable: '未就绪', idle: '待机', starting: '启动中', running: '运镜中', stopping: '停止中', stopped: '已停止', failed: '异常', fault: '已中止', error: '异常' };
const targets = {
    detected: '已检测到一名泳者', coasting: '视觉预测中，云台使用 UWB', uwb: '使用 UWB 信标',
    searching: '正在寻找泳者', lost: '已丢失目标', idle: '尚未跟踪'
};
const intents = { MOVE: '移动取景', RELATIVE_HOLD: '保持相对位置', WORLD_HOLD: '原地保持', STOP: '停机' };

export function normalizeCinematography(data) {
    if (data?.schema_version !== 1 || data.available !== true) {
        return { ...unavailable, reason: typeof data?.reason === 'string' && data.reason || unavailable.reason };
    }
    const modes = (Array.isArray(data.modes) ? data.modes : []).filter(mode => typeof mode === 'string' && mode.trim() !== '');
    return {
        ...unavailable, available: true, state: typeof data.state === 'string' ? data.state : 'unknown',
        mode: typeof data.mode === 'string' ? data.mode : null, reason: typeof data.reason === 'string' ? data.reason : '',
        modes: [...new Set(modes)], can_start: data.can_start === true, can_stop: data.can_stop === true,
        p_enabled: typeof data.p_enabled === 'boolean' ? data.p_enabled : null,
        can_set_p: data.can_set_p === true && typeof data.p_enabled === 'boolean',
        target_state: Object.hasOwn(targets, data.target_state) ? data.target_state : null,
        intent_mode: Object.hasOwn(intents, data.intent_mode) ? data.intent_mode : null,
        executed_mode: Object.hasOwn(intents, data.executed_mode) ? data.executed_mode : null,
        gimbal_source: ['uwb', 'yolo'].includes(data.gimbal_source) ? data.gimbal_source : null,
        uwb_distance_m: Number.isFinite(data.uwb_distance_m) && data.uwb_distance_m > 0 ? data.uwb_distance_m : null
    };
}

export function cinematographyTargetLabel(data) {
    const label = targets[data.target_state] || '—';
    return data.target_state === 'detected' && data.gimbal_source === 'uwb' ? label + '，云台使用 UWB' : label;
}

export function canRequestCinematography(data, transport, action) {
    const key = { start: 'can_start', stop: 'can_stop', vision: 'can_set_p' }[action];
    return Boolean(key && data?.available === true && data[key] === true
        && transport?.mode === 'live' && transport.connected && transport.canControl === true);
}

function mount(preview, request) {
    const panel = document.getElementById('cinematographyPanel');
    panel.innerHTML = `
      <header class="cinema-heading">
        <h2 id="cinematographyTitle" tabindex="-1">自主运镜</h2>
        <span id="cinematographyStatus" role="status"></span>
      </header>
      <div class="cinema-controls">
        <label class="cinema-vision" for="cinematographyVision">
          <span><strong>泳者视觉识别（P）</strong><small id="cinematographyVisionDetail">等待设备反馈</small></span>
          <input id="cinematographyVision" type="checkbox" role="switch" aria-label="泳者视觉识别（P）" aria-describedby="cinematographyVisionDetail" disabled>
        </label>
        <dl class="cinema-readings">
          <div><dt>当前目标</dt><dd id="cinematographyTarget">—</dd></div>
          <div><dt>信标距离</dt><dd id="cinematographyDistance">—</dd></div>
          <div><dt>PPO 策略意图</dt><dd id="cinematographyIntent">—</dd></div>
        </dl>
        <div class="cinema-commands">
          <label id="cinematographyModeLabel" hidden>运镜模式 <select id="cinematographyMode"></select></label>
          <div class="cinema-actions">
            <button type="button" class="experiment-secondary" data-cinema-action="start" disabled>启动运镜</button>
            <button type="button" class="experiment-secondary" data-cinema-action="stop" disabled>停止运镜</button>
          </div>
          <p id="cinematographyReason" class="experiment-status"></p>
          <p id="cinematographyActionStatus" role="status" class="experiment-status"></p>
        </div>
        <footer class="cinema-device">
          <button type="button" class="experiment-secondary" data-cinema-device>设备控制</button>
          <button type="button" class="experiment-secondary" data-cinema-disarm hidden>解除武装</button>
        </footer>
      </div>`;
    const find = selector => panel.querySelector(selector);
    const status = find('#cinematographyStatus');
    const reason = find('#cinematographyReason');
    const mode = find('#cinematographyMode');
    const vision = find('#cinematographyVision');
    const actionStatus = find('#cinematographyActionStatus');
    const disarm = find('[data-cinema-disarm]');
    const actions = [...panel.querySelectorAll('[data-cinema-action]')];
    let authority, data = unavailable, busy = false, pending, timer, generation = 0, subscriptions = [];

    function render() {
        const simulated = preview.state.transportMode === 'mock';
        status.textContent = (simulated ? '演示 · ' : '') + (states[data.state] || '状态未知');
        status.dataset.state = data.state;
        reason.textContent = [data.reason, (!simulated && authority?.connected && !authority.canControl) ? '当前页面只读' : ''].filter(Boolean).join(' · ');
        vision.checked = data.p_enabled === true;
        vision.disabled = busy || !canRequestCinematography(data, authority, 'vision');
        find('#cinematographyVisionDetail').textContent = data.p_enabled === true ? '开启 · YOLO 单目标识别'
            : data.p_enabled === false ? '关闭 · 云台跟随信标，PPO 继续读取画面' : '等待设备反馈';
        find('#cinematographyTarget').textContent = cinematographyTargetLabel(data);
        find('#cinematographyIntent').textContent = data.intent_mode === 'WORLD_HOLD' && data.executed_mode === 'STOP'
            ? '原地停机（策略请求原地保持）' : intents[data.intent_mode] || '—';
        find('#cinematographyDistance').textContent = data.uwb_distance_m === null ? '—' : data.uwb_distance_m.toFixed(2) + ' m';
        const signature = JSON.stringify(data.modes);
        if (mode.dataset.signature !== signature) {
            mode.dataset.signature = signature;
            const previous = mode.value;
            mode.replaceChildren(...data.modes.map(name => new Option(name, name)));
            if (data.modes.includes(previous)) mode.value = previous;
            else if (data.modes.includes(data.mode)) mode.value = data.mode;
        }
        find('#cinematographyModeLabel').hidden = data.modes.length <= 1;
        mode.disabled = busy || !canRequestCinematography(data, authority, 'start');
        for (const button of actions) button.disabled = busy || !canRequestCinematography(data, authority, button.dataset.cinemaAction);
        disarm.hidden = !preview.state.armed;
        disarm.disabled = !authority?.canControl || !authority.connected || preview.state.disarmPending;
    }

    async function refresh() {
        if (panel.hidden || pending || busy) return;
        if (!authority?.connected || preview.state.transportMode === 'mock') {
            data = { ...unavailable, reason: preview.state.transportMode === 'mock' ? '连接板端后可查看策略与目标。' : '请连接并配对设备。' };
            render();
            return;
        }
        const token = new AbortController();
        pending = token;
        const deadline = setTimeout(() => token.abort(), 3500);
        try {
            const response = await request(endpoint + '/state', { cache: 'no-store', signal: token.signal });
            const wire = await response.json().catch(() => ({}));
            if (pending !== token || panel.hidden) return;
            if (!response.ok || wire.success !== true) throw new Error(wire.message || '暂时无法读取自主运镜状态');
            data = normalizeCinematography(wire.data);
        } catch (error) {
            if (pending !== token || panel.hidden) return;
            data = { ...unavailable, reason: error.name === 'AbortError' ? '读取自主运镜状态超时' : error.message };
        } finally {
            clearTimeout(deadline);
            if (pending === token) { pending = null; render(); }
        }
    }

    async function command(name, parameters) {
        if (busy || !canRequestCinematography(data, authority, name)) { render(); return; }
        const version = generation;
        busy = true;
        pending?.abort();
        pending = null;
        actionStatus.textContent = '正在等待板端确认…';
        render();
        try {
            const response = await request(endpoint + '/' + name, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parameters)
            });
            const wire = await response.json().catch(() => ({}));
            if (version !== generation) return;
            if (!response.ok || wire.success !== true) throw new Error(wire.message || '操作未完成');
            data = normalizeCinematography(wire.data);
            actionStatus.textContent = '';
        } catch (error) {
            if (version === generation) actionStatus.textContent = error.message;
        } finally {
            if (version === generation) { busy = false; render(); refresh(); }
        }
    }

    vision.addEventListener('change', () => command('vision', { p_enabled: vision.checked }));
    for (const button of actions) button.addEventListener('click', () => command(button.dataset.cinemaAction,
        button.dataset.cinemaAction === 'start' && data.modes.includes(mode.value) ? { mode: mode.value } : {}));
    find('[data-cinema-device]').addEventListener('click', () => preview.showView('device'));
    disarm.addEventListener('click', () => {
        if (!disarm.disabled && authority?.canControl && preview.state.armed) document.getElementById('disarmButton').click();
    });
    function close() {
        generation++;
        clearInterval(timer);
        for (const unsubscribe of subscriptions) unsubscribe();
        subscriptions = [];
        pending?.abort();
        pending = null;
        busy = false;
    }
    function open() {
        close();
        authority = preview.getTransport();
        data = { ...unavailable, reason: '正在获取板端状态…' };
        actionStatus.textContent = '';
        render();
        if (authority) subscriptions = [
            authority.on('controlSession', render),
            authority.on('connection', () => { pending?.abort(); pending = null; refresh(); })
        ];
        find('h2').focus({ preventScroll: true });
        refresh();
        timer = setInterval(refresh, 1000);
    }
    document.addEventListener('manta:cinematography-view', event => event.detail ? open() : close());
    document.addEventListener('click', event => {
        const button = event.target.closest?.('[data-cinematography-open]');
        if (!button || !preview.state.connected) return;
        button.closest('dialog')?.close();
        preview.showView('cinematography');
    });
    window.addEventListener('pagehide', close);
    window.addEventListener('pageshow', event => { if (event.persisted && !panel.hidden) open(); });
}

if (typeof window !== 'undefined' && window.MantaPreview && window.MantaAppTransport) {
    mount(window.MantaPreview, window.MantaAppTransport.request);
}
