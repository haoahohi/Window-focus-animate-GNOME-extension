// 窗口聚焦推移（KWin 风格"漏边框"效果）
//
// 行为：
//   - 焦点从窗口 A 切到窗口 B（均为 NORMAL）时，失焦窗口 A 被推到一边 *停留*，
//     露出它的边缘，看到下层窗口 / 桌面（"漏边框"感）。
//   - 回位三种方式（可叠加）：
//       (1) 焦点切回 A；
//       (2) 鼠标从窗口外进入 A 露出的那条边（hover-return）；
//       (3) 延时自动回位（auto-return-ms > 0）：等若干毫秒后自动平滑滑回，仍保持失焦。
//   - 新聚焦窗口 B 可选做一个轻微的 +4px 下落感，表示"被推到前面"。
//
// 实现说明：
//   - 用 Clutter actor 的 translation_x / translation_y 做 200ms 指数缓动；
//     缓动结束后用 Meta.Window.move_frame 提交真实几何，使偏移 *持久* 且输入命中正确。
//     （move_frame 在 Wayland 下扩展有权限，见下方 try/catch 兜底）
//   - 用 translation 而非直接改 actor.x/y：Mutter 会按窗口真实几何不断重写
//     actor.x/y，translation 是独立的变换层，不会被覆盖，所以动画稳定、不会崩 shell。
//   - 最大化 / 全屏窗口跳过；按窗口所在显示器的 work_area 做 clamp，不越屏。
//
// 适用范围：GNOME Shell 45+（ESM 扩展）。Wayland 与 X11 通用。

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// Clutter 在 GNOME 44 把 AnimationMode 改名成 EasingMode，两个都兜住。
const _EASING = Clutter.EasingMode || Clutter.AnimationMode;
const EASE_MODE = _EASING.EASE_OUT_EXPO;
const _LINEAR = 1; // Clutter.EasingMode.LINEAR，恒为 1，不依赖枚举暴露

// 新窗口被创建后多久内获得焦点算“自动聚焦（非用户操作）”，这段时间内不激活动画
const AUTO_FOCUS_MS = 500;

// 调试开关：开着会在 journal 里打印 [FocusSlide] 日志，定位“没效果”时很有用。
const DEBUG = true;
function dlog(...args) {
    if (DEBUG)
        log('[FocusSlide] ' + args.join(' '));
}

// 必须与 gschema.xml 中的 enum 取值一一对应
const DIR = {
    AUTO: 'auto',
    BOTTOM_RIGHT: 'bottom-right',
    BOTTOM_LEFT: 'bottom-left',
    TOP_RIGHT: 'top-right',
    TOP_LEFT: 'top-left',
};

class FocusWindowSlideExtension extends Extension {
    // focus_window 在不同版本可能是“属性值”或“方法”，都要兜住，且必须返回真正的窗口对象
    _focusWindow() {
        const d = global.display;
        const fw = d.focus_window;
        if (typeof fw === 'function')
            return fw.call(d);          // 某些版本 focus_window 本身是方法
        if (fw)
            return fw;                   // 属性值（窗口）
        if (typeof d.get_focus_window === 'function')
            return d.get_focus_window(); // 备用方法名
        return null;
    }

    enable() {
        this.initTranslations(); // 初始化翻译域（domain = 扩展 uuid），供 gettext 使用
        this._settings = this.getSettings();
        this._prevFocus = this._focusWindow(); // 从当前焦点开始跟踪，第一次真正切换才动画
        this._pushed = new Map(); // MetaWindow -> { actor, origX, origY, vecX, vecY, committed, timerId }
        this._disabling = false;
        this._lastPx = -1; // 上一帧指针坐标，用于区分“悬停进入”与“窗口滑走把指针落在空位”
        this._lastPy = -1;
        this._stacking = [];          // 缓存的窗口堆叠顺序，用于判断“谁在 current 之上”
        this._topIsLast = true;       // 排序方向：true=底->顶（尾=最顶），false=顶->底（首=最顶），运行时自动判定
        this._recentlyCreated = new Map(); // 新创建窗口 -> 创建时刻，用于识别“自动聚焦”
        dlog('enable(); initial focus =', this._prevFocus?.get_title?.() ?? this._prevFocus);

        this._refreshStacking();

        this._focusId = global.display.connect(
            'notify::focus-window', () => this._onFocusChanged());
        // 运行时关闭：停所有动画并还原
        this._enabledId = this._settings.connect('changed::enabled', () => {
            if (!this._settings.get_boolean('enabled'))
                this._restoreAll();
        });
        // 用户拖动 / 缩放被我们控制的窗口 -> 放弃控制，避免和真实几何打架
        this._grabId = global.display.connect(
            'grab-op-begin', (_d, win) => this._onGrabBegin(win));
        // 窗口被销毁时清理状态（ShellWM 的信号是 'destroy'，不是 'unmanaged'）
        this._destroyId = global.window_manager.connect(
            'destroy', (_wm, actor) => {
                const w = actor.get_meta_window?.();
                if (w)
                    this._forget(w);
            });
        // 悬停到露出边缘 -> 回位（加分项）
        this._hoverId = global.stage.connect(
            'motion-event', (_s, ev) => this._onPointerMove(ev));
        // 新窗口创建：记录时间（用于识别“自动聚焦”），并刷新堆叠缓存
        this._createdId = global.display.connect(
            'window-created', (_d, win) => this._onWindowCreated(win));
        // 堆叠变化（如实拖窗口）也刷新缓存，尽量保持“谁在之上”判断准确
        try {
            this._restackedId = global.display.connect('restacked', () => this._refreshStacking());
        } catch (e) { this._restackedId = 0; }
    }

    disable() {
        this._disabling = true;

        if (this._focusId) global.display.disconnect(this._focusId);
        if (this._enabledId) this._settings.disconnect(this._enabledId);
        if (this._grabId) global.display.disconnect(this._grabId);
        if (this._destroyId) global.window_manager.disconnect(this._destroyId);
        if (this._hoverId) global.stage.disconnect(this._hoverId);
        if (this._createdId) global.display.disconnect(this._createdId);
        if (this._restackedId) global.display.disconnect(this._restackedId);
        this._focusId = this._enabledId = this._grabId = this._destroyId = 0;
        this._hoverId = this._createdId = this._restackedId = 0;

        // 还原所有被推开的窗口，防止卡在偏移位
        for (const win of [...this._pushed.keys()])
            this._returnWindow(win, true);

        this._pushed.clear();
        this._recentlyCreated.clear();
        this._stacking = [];
        this._prevFocus = null;
        this._settings = null;
        this._disabling = false;
    }

    // ---- 工具 ----

    // 可动画的窗口类型：普通窗口 + 常见对话框 / 工具窗。
    // 排除 DOCK / DESKTOP / NOTIFICATION / TOOLTIP / MENU 等非交互窗口，
    // 这样“扩展设置窗口”等也能在窗口间切换时触发动画。
    _isAnimatable(win) {
        if (!win || typeof win.get_window_type !== 'function')
            return false;
        switch (win.get_window_type()) {
            case Meta.WindowType.NORMAL:
            case Meta.WindowType.DIALOG:
            case Meta.WindowType.MODAL_DIALOG:
            case Meta.WindowType.UTILITY:
                return true;
            default:
                return false;
        }
    }

    // 是否“全屏”：优先用 fullscreen 布尔；但聚焦信号触发时该布尔有时尚未就绪
    // （全屏状态/几何常晚于焦点事件设置），所以再用地形兜底——窗口几何已覆盖
    // 整块显示器即视为全屏。用 monitor 几何而非 work_area：全屏窗会盖住面板区，
    // 而最大化只填 work_area，二者不会混淆。
    _isFullscreen(win) {
        if (!win)
            return false;
        if (win.fullscreen)
            return true;
        try {
            const rect = win.get_frame_rect();
            const geom = global.display.get_monitor_geometry(win.get_monitor());
            if (geom && rect.x === geom.x && rect.y === geom.y &&
                rect.width === geom.width && rect.height === geom.height)
                return true;
        } catch (e) { /* 取不到几何就信任布尔值 */ }
        return false;
    }

    // 两个窗口矩形是否相交（用于判断推窗是否有意义）
    _overlaps(a, b) {
        if (!a || !b) return false;
        return a.x < b.x + b.width && a.x + a.width > b.x &&
               a.y < b.y + b.height && a.y + a.height > b.y;
    }

    // win 是否与“任何其它窗口”重叠（含非聚焦窗口）。孤立窗口（不重叠任何窗口）
    // 时推开 / 上升都露不出有意义内容，应跳过动画。
    _overlapsAnyWindow(win) {
        if (!win) return false;
        const r = win.get_frame_rect();
        let list = [];
        try {
            list = global.display.get_tab_list(Meta.TabList.NORMAL, null);
        } catch (e) { list = []; }
        for (const w of list) {
            if (w === win || w.minimized) continue;
            if (this._overlaps(r, w.get_frame_rect()))
                return true;
        }
        return false;
    }

    // 刷新窗口堆叠缓存（底 -> 顶）。注意：聚焦会把 current 提到顶层，
    // 刷新窗口堆叠缓存，并判定排序方向（底->顶 还是 顶->底，各版本不同）。
    // 此刻刚聚焦的窗口必在最顶层，用它判断排序后位于首还是尾即可确定方向。
    _refreshStacking() {
        let list = [];
        try {
            list = global.display.get_tab_list(Meta.TabList.NORMAL, null);
        } catch (e) { list = []; }
        try {
            global.display.sort_windows_by_stacking(list);
        } catch (e) { /* 排序不可用则保持原顺序（尽力而为） */ }
        this._stacking = list;
        // 判定排序方向：当前焦点窗口刚被提到最顶，看排序后它在首(顶->底)还是尾(底->顶)
        try {
            const fw = this._focusWindow();
            if (fw) {
                const fi = list.indexOf(fw);
                if (fi >= 0 && list.length > 1)
                    this._topIsLast = (fi === list.length - 1);
            }
        } catch (e) { /* 保留上次判定 */ }
    }

    // current 是否已在堆叠最顶层（已在最顶却没聚焦 -> 聚焦时不激活动画）
    _isTopmost(win) {
        if (!win || this._stacking.length === 0) return false;
        const i = this._stacking.indexOf(win);
        return this._topIsLast ? (i === this._stacking.length - 1) : (i === 0);
    }

    // 新窗口创建：记录创建时刻（用于识别“自动聚焦”），并刷新堆叠缓存
    _onWindowCreated(win) {
        const now = GLib.get_monotonic_time() / 1e6;
        this._recentlyCreated.set(win, now);
        // 清理过期条目，避免 Map 无限增长
        for (const [w, t] of this._recentlyCreated) {
            if (now - t > AUTO_FOCUS_MS / 1000)
                this._recentlyCreated.delete(w);
        }
        this._refreshStacking();
    }

    // 当前焦点窗口 current 的“所有遮挡者”：与 current 重叠、且堆叠在 current 之上
    // （盖住 current）的全部窗口。kwin 把这些窗口都推开以露出 current。
    // 例：A 在 B 上、B 在 C 上，焦点移到 B -> 返回 [A]（只有 A 在 B 之上）；
    //     若 A1、A2 都在 B 之上且都重叠 B -> 返回 [A1, A2]（多个都推动，规则3）。
    // 排序方向由 _refreshStacking 运行时判定并存入 _topIsLast，这里只取“上方”窗口。
    _occludersOf(current) {
        const result = [];
        if (!current) return result;
        const cache = this._stacking;
        const ci = cache.indexOf(current);
        if (ci < 0) return result;

        const cr = current.get_frame_rect();
        for (const w of cache) {
            if (w === current) continue;
            const above = this._topIsLast
                ? (cache.indexOf(w) > ci)   // 底->顶：索引更大 = 更靠上
                : (cache.indexOf(w) < ci);  // 顶->底：索引更小 = 更靠上
            if (!above) continue;
            if (!this._isAnimatable(w) || w.minimized) continue;
            if (this._overlaps(cr, w.get_frame_rect()))
                result.push(w);
        }
        return result;
    }

    // 最大化 / 全屏跳过
    _skippable(win) {
        if (!this._isAnimatable(win))
            return true;
        if (win.maximized_vertically && win.maximized_horizontally)
            return true;
        if (this._isFullscreen(win))
            return true;
        return false;
    }

    // ---- 焦点变化 ----

    _onFocusChanged() {
        if (!this._settings.get_boolean('enabled')) {
            this._prevFocus = this._focusWindow();
            return;
        }

        const current = this._focusWindow();
        const prev = this._prevFocus;
        dlog('focus-changed:', prev?.get_title?.() ?? prev, '->', current?.get_title?.() ?? current);
        if (current === prev)
            return;
        this._prevFocus = current;

        // 仅在“窗口之间”来回聚焦时才做动画：首次开窗（prev 为空 / 桌面）或
        // 关掉最后一个窗口（current 为空）都不算切换，跳过，避免首次开启就出动画。
        if (!this._isAnimatable(prev) || !this._isAnimatable(current))
            return;

        // 不激活动画的情况：
        //  - 窗口被关闭、焦点自动回退（prev 正在销毁，actor 已不存在）；
        //  - 焦点落在一个全屏窗口上（全屏窗口本身不应触发动画）；
        //  - 新窗口刚创建就被自动聚焦（非用户操作，如窗口 A 被开启焦点自动放上 A）。
        // 这些情况下被推开的窗口仍会落回原位，只是不再推上一个窗口、也不做上升。
        const now = GLib.get_monotonic_time() / 1e6;
        let autoFocus = false;
        if (current && this._recentlyCreated.has(current)) {
            const t = this._recentlyCreated.get(current);
            if (now - t < AUTO_FOCUS_MS / 1000)
                autoFocus = true;
            this._recentlyCreated.delete(current);
        }

        const suppress = !prev || !prev.get_compositor_private() ||
                         this._isFullscreen(current) || autoFocus;

        // 按聚焦动画风格分发：kwin = 仿 Kwin 主动画；rise = 线性上升
        const style = this._settings.get_string('focus-bump-style');

        if (style === 'kwin') {
            // kwin 风格：把“遮挡 current 的所有窗口”都推开，露出 current。
            // 用缓存的堆叠顺序判断谁在 current 之上——这样即便失焦窗口 prev 与 current
            // 不重叠，只要某非聚焦窗口（如 B）遮住 current（C），就推 B 而非 A；
            // current 已在最顶时谁都不在它之上 -> 不推（规则1）；多个遮挡者 -> 都推（规则3）；
            // 只推“在 current 之上”的窗口，例如 A 在 B 上、B 在 C 上，聚焦 B 时只有 A 动（规则4）。
            // 以上遮挡者逻辑仅 kwin 生效；rise 风格不推任何窗口，只让聚焦窗口自身上升。
            const occluders = suppress ? [] : this._occludersOf(current);
            dlog('kwin occluders =', occluders.map(w => w.get_title?.() ?? w).join(', '));

            // 焦点切走后，原先被推开、但已不再遮挡 current 的窗口滑回原位（回退时直接到位）
            for (const w of [...this._pushed.keys()]) {
                if (!occluders.includes(w))
                    this._returnWindow(w, suppress);
            }

            // 推开所有遮挡 current 的窗口。
            // 多个遮挡者（>=2）时，在 AUTO 方向上交替水平符号，使相邻窗口往相反方向
            // 分开（像拉开窗帘一样露出 current）；单窗口或用户指定了固定方向时维持原行为。
            const userDir = this._settings.get_string('direction');
            const multi = occluders.length >= 2 && userDir === DIR.AUTO;
            for (let i = 0; i < occluders.length; i++) {
                const w = occluders[i];
                if (this._skippable(w)) {
                    dlog('skip push (skippable):', w.get_title?.() ?? w);
                    continue;
                }
                let vec = null;
                if (multi) {
                    const auto = this._computeVec(w, current, this._settings.get_int('offset-px'));
                    vec = { dx: (i % 2 === 0 ? auto.dx : -auto.dx), dy: auto.dy };
                }
                this._pushWindow(w, current, vec);
            }
        }

        // (3) rise 风格：新聚焦窗口线性上升；
        //     规则1：current 已在最顶时不触发；current 与任何窗口都不重叠（孤立）时不触发；
        //     自动聚焦 / 全屏 / 回退时不触发。
        if (style === 'rise' && !suppress && this._isAnimatable(current) &&
            this._overlapsAnyWindow(current) && !this._isTopmost(current))
            this._bumpWindow(current);

        // (4) zoom 风格：新聚焦窗口瞬间缩小，再按所选曲线放大回原样；
        //     仅用于“窗口间切换”且有意义的聚焦（沿用 !suppress / _isAnimatable 门控）。
        if (style === 'zoom' && !suppress && this._isAnimatable(current))
            this._zoomWindow(current);

        // 处理完本次聚焦后，刷新堆叠缓存，作为“下一次”判断谁在之上的依据
        this._refreshStacking();
    }

    // ---- 推开 / 回位 ----

    _computeVec(win, focusWin, offset) {
        const rect = win.get_frame_rect();
        let dx = 0, dy = 0;
        const dir = this._settings.get_string('direction');

        if (dir === DIR.AUTO && focusWin && this._isAnimatable(focusWin)) {
            // 远离焦点窗口 B 的方向
            const f = focusWin.get_frame_rect();
            const wc = rect.x + rect.width / 2;
            const hc = rect.y + rect.height / 2;
            const fc = f.x + f.width / 2;
            const fcy = f.y + f.height / 2;
            dx = (fc > wc) ? -offset : offset;
            dy = (fcy > hc) ? -offset : offset;
        } else if (dir === DIR.BOTTOM_RIGHT) { dx = offset; dy = offset; }
        else if (dir === DIR.BOTTOM_LEFT) { dx = -offset; dy = offset; }
        else if (dir === DIR.TOP_RIGHT) { dx = offset; dy = -offset; }
        else if (dir === DIR.TOP_LEFT) { dx = -offset; dy = -offset; }
        else { dx = offset; dy = offset; } // 未知值兜底

        return {dx, dy, rect};
    }

    // 按窗口所在显示器的 work_area 限制目标位，绝不越屏
    _clampVec(win, rect, dx, dy) {
        let wa;
        try {
            wa = win.get_work_area_current();
        } catch (e) {
            wa = null;
        }
        if (!wa) {
            // work area 取不到时不再清零，直接用原偏移（允许临时越一点边）
            dlog('clamp: no work_area, use raw offset', dx, dy);
            return {dx, dy};
        }
        const maxX = wa.x + wa.width - rect.width;
        const maxY = wa.y + wa.height - rect.height;
        const tx = Math.max(wa.x, Math.min(maxX, rect.x + dx));
        const ty = Math.max(wa.y, Math.min(maxY, rect.y + dy));
        const ox = tx - rect.x, oy = ty - rect.y;
        if (ox === 0 && oy === 0)
            dlog('clamp: offset fully clamped to 0 (window stuck at edge)');
        return {dx: ox, dy: oy};
    }

    _pushWindow(win, focusWin, overrideVec) {
        if (this._pushed.has(win))
            return; // 已经推开了，不重复推

        const actor = win.get_compositor_private();
        if (!actor) {
            dlog('push skipped: get_compositor_private() is null for', win.get_title?.() ?? win);
            return;
        }

        const offset = this._settings.get_int('offset-px');
        const duration = this._settings.get_int('duration-ms');

        let dx, dy, rect;
        if (overrideVec) {
            // 多窗口推开时由调用方指定方向（相邻窗口往相反方向分开）
            rect = win.get_frame_rect();
            dx = overrideVec.dx;
            dy = overrideVec.dy;
        } else {
            const v = this._computeVec(win, focusWin, offset);
            dx = v.dx; dy = v.dy; rect = v.rect;
        }
        const c = this._clampVec(win, rect, dx, dy);
        if (c.dx === 0 && c.dy === 0) {
            dlog('push skipped: zero effective offset for', win.get_title?.() ?? win);
            return; // 贴边、推不出去，就不动
        }

        dlog('PUSH', win.get_title?.() ?? win, '-> translation', c.dx, c.dy, 'duration', duration);

        const state = {
            actor,
            origX: rect.x, origY: rect.y,
            vecX: c.dx, vecY: c.dy,
            committed: false,
            timerId: 0,
        };
        this._pushed.set(win, state);

        // 延时自动回位（peek 模式）：>0 时，等这么多毫秒后自动平滑滑回，仍保持失焦
        const autoMs = this._settings.get_int('auto-return-ms');
        if (autoMs > 0) {
            state.timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, autoMs, () => {
                if (!this._pushed.has(win)) // 期间已被焦点切回 / 悬停 / 拖拽处理掉了
                    return GLib.SOURCE_REMOVE;
                dlog('auto-return (still unfocused):', win.get_title?.() ?? win);
                this._returnWindow(win);
                return GLib.SOURCE_REMOVE;
            });
        }

        actor.remove_all_transitions();
        actor.translation_x = 0;
        actor.translation_y = 0;

        actor.ease({
            translation_x: c.dx,
            translation_y: c.dy,
            duration,
            mode: EASE_MODE,
            onComplete: () => {
                if (this._disabling)
                    return;
                // 提交真实几何，使偏移持久且输入命中正确
                try {
                    win.move_frame(false, rect.x + c.dx, rect.y + c.dy);
                    actor.translation_x = 0;
                    actor.translation_y = 0;
                    state.committed = true;
                    dlog('pushed+committed', win.get_title?.() ?? win);
                } catch (e) {
                    // Wayland / X11 偶发限制：退化为纯视觉偏移（输入仍在原位）
                    state.committed = false;
                    dlog('pushed (visual-only, move_frame failed):', String(e));
                }
            },
        });
    }

    _returnWindow(win, immediate = false) {
        const state = this._pushed.get(win);
        if (!state)
            return;
        this._pushed.delete(win);
        if (state.timerId) {
            GLib.source_remove(state.timerId);
            state.timerId = 0;
        }

        const actor = state.actor;
        const duration = immediate ? 0 : this._settings.get_int('duration-ms');

        const finish = () => {
            try {
                if (state.committed)
                    win.move_frame(false, state.origX, state.origY);
            } catch (e) { /* 窗口可能已销毁，忽略 */ }
            if (actor) {
                actor.remove_all_transitions();
                actor.translation_x = 0;
                actor.translation_y = 0;
            }
        };

        if (immediate || duration === 0 || !actor) {
            finish();
            return;
        }

        actor.remove_all_transitions();
        if (state.committed) {
            // 真实几何在偏移位：先把视觉缓动回原位，再提交几何
            actor.ease({
                translation_x: -state.vecX,
                translation_y: -state.vecY,
                duration,
                mode: EASE_MODE,
                onComplete: finish,
            });
        } else {
            // 纯视觉偏移：直接缓动 translation 回 0
            actor.ease({
                translation_x: 0,
                translation_y: 0,
                duration,
                mode: EASE_MODE,
                onComplete: finish,
            });
        }
    }

    _bumpWindow(win) {
        const actor = win.get_compositor_private();
        if (!actor)
            return;
        const dist = this._settings.get_int('focus-bump-distance');
        const duration = this._settings.get_int('focus-bump-duration');
        const em = { 'ease-in': 2, 'ease-out': 3 }; // EASE_IN_QUAD / EASE_OUT_QUAD
        const mode = em[this._settings.get_string('focus-bump-easing')] || _LINEAR;
        actor.remove_all_transitions();
        actor.translation_y = dist; // 起点：略低，按所选曲线上升到位
        actor.ease({
            translation_y: 0,
            duration,
            mode,
            onComplete: () => { actor.translation_y = 0; },
        });
    }

    // 缩放风格：窗口被聚焦时瞬间缩小到指定比例，再按所选缓动放大回原样。
    // 缩小是瞬间的（不设 duration），放大用 focus-zoom-duration / focus-zoom-easing；
    // 缓动曲线仅作用于“放大”过程。绕窗口中心缩放，避免缩向某个角落。
    _zoomWindow(win) {
        const actor = win.get_compositor_private();
        if (!actor)
            return;
        const shrink = this._settings.get_double('focus-zoom-shrink');
        const duration = this._settings.get_int('focus-zoom-duration');
        const em = { 'ease-in': 2, 'ease-out': 3 }; // EASE_IN_QUAD / EASE_OUT_QUAD
        const mode = em[this._settings.get_string('focus-zoom-easing')] || _LINEAR;

        // 绕中心缩放：把 pivot 设到窗口几何中心。set_pivot_point 在某些版本不可用，
        // 用 try 兜底——退化为默认（左上角）缩放仍可工作，只是略偏。
        try { actor.set_pivot_point(0.5, 0.5); } catch (e) { /* 用默认 pivot */ }

        actor.remove_all_transitions();
        // 瞬间缩小
        actor.scale_x = shrink;
        actor.scale_y = shrink;
        // 再放大回原样（仅这一步有动画 + 缓动）
        actor.ease({
            scale_x: 1,
            scale_y: 1,
            duration,
            mode,
            onComplete: () => {
                actor.scale_x = 1;
                actor.scale_y = 1;
            },
        });
        dlog('ZOOM', win.get_title?.() ?? win, 'shrink', shrink, 'duration', duration);
    }

    // ---- 清理 / 悬停 ----

    _onGrabBegin(win) {
        // 用户开始拖动 / 缩放 -> 放弃对该窗口的控制
        this._forget(win);
    }

    _forget(win) {
        const state = this._pushed.get(win);
        if (!state)
            return;
        this._pushed.delete(win);
        if (state.timerId) {
            GLib.source_remove(state.timerId);
            state.timerId = 0;
        }
        const actor = state.actor;
        if (actor) {
            try {
                actor.remove_all_transitions();
                actor.translation_x = 0;
                actor.translation_y = 0;
            } catch (e) {
                // 窗口正在销毁，actor 可能已半释放，忽略
            }
        }
    }

    _onPointerMove(event) {
        const [px, py] = event.get_coords();

        // 没有需要处理的窗口时，仅记录指针位置后返回
        if (this._pushed.size === 0) {
            this._lastPx = px;
            this._lastPy = py;
            return;
        }

        // 悬停回位开关
        const hoverOn = this._settings.get_boolean('hover-return');

        for (const win of [...this._pushed.keys()]) {
            const s = this._pushed.get(win);
            if (!s)
                continue;

            // 用“存储的原始位置”算露出区域，提交真实几何前后都正确
            const rect = win.get_frame_rect();
            const w = rect.width, h = rect.height;
            const ox = s.origX, oy = s.origY;
            const sx = ox + s.vecX, sy = oy + s.vecY; // 平移后窗口所在位置

            const inOrig = px >= ox && px <= ox + w && py >= oy && py <= oy + h;
            const inShifted = px >= sx && px <= sx + w && py >= sy && py <= sy + h;

            if (!hoverOn) {
                this._lastPx = px;
                this._lastPy = py;
                continue;
            }

            // 关键：只有当指针是从窗口“外面”进入露出区域，才算悬停回位。
            // 否则只是窗口从指针下方滑走、把指针“遗留”在露出的空位里，
            // 轻微动一下鼠标就会误触发回位（表现为“推开后自己滑回去但仍失焦”）。
            const prevOutside = this._lastPx < ox || this._lastPx > ox + w ||
                                this._lastPy < oy || this._lastPy > oy + h;

            if (inOrig && !inShifted && prevOutside)
                this._returnWindow(win);
        }

        this._lastPx = px;
        this._lastPy = py;
    }

    _restoreAll() {
        for (const win of [...this._pushed.keys()])
            this._returnWindow(win, true);
    }
}

export default FocusWindowSlideExtension;
