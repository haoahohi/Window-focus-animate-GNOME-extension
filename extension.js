// 窗口聚焦推移 —— 模仿 KWin 那种“漏出边框”的聚焦效果
//
// 它是怎么工作的：
//   - 焦点从窗口 A 切到窗口 B（都是普通窗口）时，失焦的 A 会被推到一边并 *停住*，
//     露出它的一条边，让你能看到后面的窗口或桌面，就是那种“漏边框”的感觉。
//   - A 想回到原位有三种办法，可以叠加着用：
//       (1) 再把焦点切回 A；
//       (2) 鼠标从窗口外面探进 A 露出的那条边（hover-return）；
//       (3) 延时自动回位（auto-return-ms > 0）：过几毫秒自己滑回去，焦点仍然在别处。
//   - 新聚焦的窗口 B 还可以（可选）带一点 +4px 的“下沉”感，像是被推到了最前面。
//
// 实现上的一些取舍：
//   - 用 Clutter actor 的 translation_x / translation_y 做 200ms 的指数缓动；
//     缓动结束后用 Meta.Window.move_frame 把真实位置落定，这样偏移会 *留住*，
//     而且鼠标点哪都对。move_frame 在 Wayland 下扩展有权限，底下有 try/catch 兜底。
//   - 用 translation 而不直接改 actor.x/y，是因为 Mutter 会不停地用窗口真实位置
//     覆写 actor.x/y；translation 是独立的一层变换，不会被它盖掉，所以动画稳、不崩。
//   - 最大化 / 全屏的窗口就不动了；推的时候按窗口所在屏幕的 work_area 收着，不出界。
//
// 支持：GNOME Shell 45+（ESM 扩展），Wayland 和 X11 都能用。

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// GNOME 44 把 Clutter.AnimationMode 改名成了 Clutter.EasingMode，两个都试试，哪个存在用哪个。
const _EASING = Clutter.EasingMode || Clutter.AnimationMode;
const EASE_MODE = _EASING.EASE_OUT_EXPO;
const _LINEAR = 1; // Clutter.EasingMode.LINEAR，数值固定就是 1，不依赖它有没有把这个枚举暴露出来

// 窗口刚被创建后，这段时间内自动获得焦点就算“自动聚焦”（不是你亲手点的），期间不播动画
const AUTO_FOCUS_MS = 500;

// 调试开关：开着的话会在日志里打 [FocusSlide]，排查“怎么没反应”时特别好用。
const DEBUG = true;
function dlog(...args) {
    if (DEBUG)
        log('[FocusSlide] ' + args.join(' '));
}

class FocusWindowSlideExtension extends Extension {
    // 不同 GNOME 版本里 focus_window 有时是属性、有时是方法，两种都接住，并且一定要返回真正的窗口对象
    _focusWindow() {
        const d = global.display;
        const fw = d.focus_window;
        if (typeof fw === 'function')
            return fw.call(d);          // 某些版本 focus_window 本身就是方法
        if (fw)
            return fw;                   // 属性值（窗口）
        if (typeof d.get_focus_window === 'function')
            return d.get_focus_window(); // 备用方法名
        return null;
    }

    enable() {
        this.initTranslations(); // 先把翻译域准备好（domain = 扩展 uuid），这样下面的 gettext 才管用
        this._settings = this.getSettings();
        this._prevFocus = this._focusWindow(); // 从上次焦点开始记，第一次真正切换时才动
        this._pushed = new Map(); // 记录被推开的窗口：MetaWindow -> { actor, origX, origY, vecX, vecY, committed, timerId }
        this._disabling = false;
        this._lastPx = -1; // 上一帧鼠标坐标，用来区分“鼠标从外面探进来”和“窗口滑走、鼠标留在空位上”
        this._lastPy = -1;
        this._stacking = [];          // 缓存一份窗口堆叠顺序，判断“谁压在 current 上面”
        this._topIsLast = true;       // 堆叠是底->顶还是顶->底（不同版本不一样），运行时自己判断
        this._recentlyCreated = new Map(); // 新建的窗口 -> 创建时刻，用来识别“自动聚焦”
        this._recentlyUnminimized = new Map(); // 取消最小化的窗口 -> 时刻，用来识别“显示而非新建”
        this._recentlyMinimized = new Map(); // 最小化的窗口 -> 时刻，用来识别“隐藏而非删除”
        dlog('enable(); initial focus =', this._prevFocus?.get_title?.() ?? this._prevFocus);

        this._refreshStacking();

        this._focusId = global.display.connect(
            'notify::focus-window', () => this._onFocusChanged());
        // 运行时关掉开关：停掉所有动画并把窗口复位
        this._enabledId = this._settings.connect('changed::enabled', () => {
            if (!this._settings.get_boolean('enabled'))
                this._restoreAll();
        });
        // 你一旦开始拖 / 缩放我们管的窗口，就放手不管它，免得跟真实位置打架
        this._grabId = global.display.connect(
            'grab-op-begin', (_d, win) => this._onGrabBegin(win));
        // 窗口被销毁时清一下状态（ShellWM 用的是 'destroy' 信号，不是 'unmanaged'）
        this._destroyId = global.window_manager.connect(
            'destroy', (_wm, actor) => {
                const w = actor.get_meta_window?.();
                if (w)
                    this._forget(w);
            });
        // 鼠标移到露出的边上 -> 让窗口回去（锦上添花的小功能）
        this._hoverId = global.stage.connect(
            'motion-event', (_s, ev) => this._onPointerMove(ev));
        // 新建窗口：记下时间（用来识别“自动聚焦”），顺手刷新堆叠缓存
        this._createdId = global.display.connect(
            'window-created', (_d, win) => this._onWindowCreated(win));
        // 取消最小化（是“显示”不是“新建”）：记个时间，后面“聚焦到它”时就能认出来并跳过动画
        this._unminId = global.window_manager.connect(
            'unminimize', (_wm, actor) => this._onWindowUnminimized(actor));
        // 最小化（是“隐藏”不是“删除”）：记个时间，后面“焦点切走”时能认出来并跳过动画
        this._minId = global.window_manager.connect(
            'minimize', (_wm, actor) => this._onWindowMinimized(actor));
        // 堆叠顺序变了（比如你拖动窗口）也刷新缓存，尽量保证“谁在上面”判断得准
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
        if (this._unminId) global.window_manager.disconnect(this._unminId);
        if (this._minId) global.window_manager.disconnect(this._minId);
        if (this._restackedId) global.display.disconnect(this._restackedId);
        this._focusId = this._enabledId = this._grabId = this._destroyId = 0;
        this._hoverId = this._createdId = this._unminId = this._minId = this._restackedId = 0;

        // 把所有被推开的窗口复位，免得它们卡在偏移后的位置
        for (const win of [...this._pushed.keys()])
            this._returnWindow(win, true);

        this._pushed.clear();
        this._recentlyCreated.clear();
        this._recentlyUnminimized.clear();
        this._recentlyMinimized.clear();
        this._stacking = [];
        this._prevFocus = null;
        this._settings = null;
        this._disabling = false;
    }

    // ---- 小工具 ----

    // 哪些窗口值得做动画：普通窗口 + 常见的对话框 / 工具窗。
    // 把 DOCK / DESKTOP / 通知 / 提示气泡 / 菜单这类非交互窗口排除掉，
    // 这样连“扩展设置窗口”这种也能在切换时正常触发动画。
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

    // 判断是不是全屏：优先看 fullscreen 这个布尔。但聚焦信号来的时候它常常还没准备好
    // （全屏状态 / 几何往往比焦点事件晚半拍），所以再用几何兜底——窗口已经铺满整块屏幕就当全屏。
    // 用 monitor 几何而不是 work_area：全屏会盖住面板那一条，而最大化只填 work_area，两者不会搞混。
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

    // 两个窗口矩形相交吗（用来判断推开有没有意义）
    _overlaps(a, b) {
        if (!a || !b) return false;
        return a.x < b.x + b.width && a.x + a.width > b.x &&
               a.y < b.y + b.height && a.y + a.height > b.y;
    }

    // 这个窗口是不是跟“别的任何窗口”有重叠（包括没聚焦的）。
    // 孤零零一个、谁也不挨着的窗口，推开 / 上升都露不出啥东西，就别费劲了。
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

    // 刷新窗口堆叠缓存（底 -> 顶）。
    // 聚焦会把 current 提到最上面，所以此刻刚聚焦的窗口一定在最顶；
    // 看它排在最前还是最后，就能反推出排序方向（底->顶 还是 顶->底，各版本不一样）。
    _refreshStacking() {
        let list = [];
        try {
            list = global.display.get_tab_list(Meta.TabList.NORMAL, null);
        } catch (e) { list = []; }
        try {
            global.display.sort_windows_by_stacking(list);
        } catch (e) { /* 排序不可用就保持原顺序（尽力而为） */ }
        this._stacking = list;
        // 推断排序方向：刚聚焦的窗口被提到了最顶，看它排最前(顶->底)还是最后(底->顶)就知道了
        try {
            const fw = this._focusWindow();
            if (fw) {
                const fi = list.indexOf(fw);
                if (fi >= 0 && list.length > 1)
                    this._topIsLast = (fi === list.length - 1);
            }
        } catch (e) { /* 保留上次判定 */ }
    }

    // current 是不是已经压在最顶了？（已经在顶却还没聚焦 -> 这次聚焦就不播动画）
    _isTopmost(win) {
        if (!win || this._stacking.length === 0) return false;
        const i = this._stacking.indexOf(win);
        return this._topIsLast ? (i === this._stacking.length - 1) : (i === 0);
    }

    // 新建窗口：记下创建时刻（用来识别“自动聚焦”），顺便刷新堆叠缓存
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

    // 取消最小化（是“显示”不是“新建”）：记个时刻（用来跳过动画），顺手刷新堆叠缓存。
    // 注意：“最小化（隐藏）”不在这里记——聚焦切到别的窗口时由 _onFocusChanged 通过
    // prev.minimized 直接判断；这里只管“显示”这头。
    _onWindowUnminimized(actor) {
        const win = actor?.get_meta_window?.();
        if (!win)
            return;
        const now = GLib.get_monotonic_time() / 1e6;
        this._recentlyUnminimized.set(win, now);
        // 清理过期条目，避免 Map 无限增长
        for (const [w, t] of this._recentlyUnminimized) {
            if (now - t > AUTO_FOCUS_MS / 1000)
                this._recentlyUnminimized.delete(w);
        }
        this._refreshStacking();
    }

    // 最小化（是“隐藏”不是“删除”）：记个时刻（用来跳过动画），顺手刷新堆叠缓存。
    // 光靠 prev.minimized 不太稳：焦点有时比 minimized 标志置位还早切走，
    // 所以这里用 minimize 信号再记一笔，不管信号谁先谁后都能稳稳跳过。
    _onWindowMinimized(actor) {
        const win = actor?.get_meta_window?.();
        if (!win)
            return;
        const now = GLib.get_monotonic_time() / 1e6;
        this._recentlyMinimized.set(win, now);
        for (const [w, t] of this._recentlyMinimized) {
            if (now - t > AUTO_FOCUS_MS / 1000)
                this._recentlyMinimized.delete(w);
        }
        this._refreshStacking();
    }

    // 找出当前焦点窗口 current 的“所有遮挡者”：跟 current 重叠、而且压在它上面（挡住它）的窗口。
    // kwin 风格会把它们全推开，好把 current 露出来。
    // 例子：A 压在 B 上、B 压在 C 上，焦点移到 B -> 返回 [A]（只有 A 在 B 上面）；
    //       要是 A1、A2 都在 B 上面、又都跟 B 重叠 -> 返回 [A1, A2]（两个一起推）。
    // 排序方向由 _refreshStacking 运行时判定、存在 _topIsLast 里，这里只负责挑“上面”的窗口。
    _occludersOf(current) {
        const result = [];
        if (!current) return result;
        const cache = this._stacking;
        const ci = cache.indexOf(current);
        if (ci < 0) return result;

        const cr = current.get_frame_rect();
        // 挑“压在 current 上面”的窗口：底->顶时索引更大，顶->底时索引更小。
        const collect = (abovePred) => {
            const out = [];
            for (const w of cache) {
                if (w === current) continue;
                if (!abovePred(w)) continue;
                if (!this._isAnimatable(w) || w.minimized) continue;
                if (this._overlaps(cr, w.get_frame_rect()))
                    out.push(w);
            }
            return out;
        };
        const abovePred = (w) => this._topIsLast
            ? (cache.indexOf(w) > ci)
            : (cache.indexOf(w) < ci);

        let res = collect(abovePred);
        if (res.length === 0) {
            // 兜底一下：聚焦“最底下的窗口”时，Mutter 通常会把它提到最顶并触发 restacked，
            // 缓存里 current 可能已经被甩到最前/最后，按正向就一个遮挡者都找不到了 -> 整个没动画，
            // 表现就是“时灵时不灵”。这时候反过来再找一次（假设这次 raise 把排序方向翻了），
            // 就能把“原本压在 current 上面”的窗口找回来。
            const flipped = (w) => this._topIsLast
                ? (cache.indexOf(w) < ci)
                : (cache.indexOf(w) > ci);
            res = collect(flipped);
        }
        return res;
    }

    // 最大化 / 全屏的一律不动
    _skippable(win) {
        if (!this._isAnimatable(win))
            return true;
        if (win.maximized_vertically && win.maximized_horizontally)
            return true;
        if (this._isFullscreen(win))
            return true;
        return false;
    }

    // ---- 焦点切换 ----

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

        // 只在“窗口和窗口之间”来回切时才播动画：第一次开窗口（prev 是空 / 桌面）、
        // 或者关掉最后一个窗口（current 是空）都不算切换，跳过，省得刚开机就动一下。
        if (!this._isAnimatable(prev) || !this._isAnimatable(current))
            return;

        // 这些情况下不播动画：
        //  - 窗口被关掉、焦点自动退回（prev 正在销毁，actor 都没了）；
        //  - 焦点落到了全屏窗口上（全屏窗口自己就不该动）；
        //  - 刚新建的窗口一冒出来就被自动聚焦（不是你点的，比如开了个窗口 A 焦点自动跳上去）。
        // 这种情况下被推开的窗口还是会归位，只是不再去推别的窗口、也不做上升。
        const now = GLib.get_monotonic_time() / 1e6;
        let autoFocus = false;
        if (current && this._recentlyCreated.has(current)) {
            const t = this._recentlyCreated.get(current);
            if (now - t < AUTO_FOCUS_MS / 1000)
                autoFocus = true;
            this._recentlyCreated.delete(current);
        }

        // 是“显示”（取消最小化）而不是“新建”：刚被取消最小化又自动获焦的窗口，不播动画。
        let shown = false;
        if (current && this._recentlyUnminimized.has(current)) {
            const t = this._recentlyUnminimized.get(current);
            if (now - t < AUTO_FOCUS_MS / 1000)
                shown = true;
            this._recentlyUnminimized.delete(current);
        }

        // 因为“隐藏 / 显示”（最小化 / 取消最小化）导致的焦点切换，一律不播动画：
        //  - 我们刚离开一个被最小化的窗口（prev.minimized，或者刚收到 minimize 信号）；
        //  - 焦点落到了一个被最小化的窗口上（current.minimized，少见）；
        //  - 刚被取消最小化又自动获焦（shown）。
        const hidden = (prev && (prev.minimized || this._recentlyMinimized.has(prev))) ||
                       (current && current.minimized) || shown;

        const suppress = !prev || !prev.get_compositor_private() ||
                         this._isFullscreen(current) || autoFocus || hidden;

        // 按选中的风格分头处理：kwin = 仿 Kwin 主效果；rise = 线性上升
        const style = this._settings.get_string('focus-bump-style');

        if (style === 'kwin') {
            // kwin 风格：把“挡住 current 的所有窗口”都推开，把 current 露出来。
            // 用缓存的堆叠顺序判断谁在 current 上面——这样哪怕失焦的窗口 prev 跟 current 不重叠，
            // 只要有个没聚焦的窗口（比如 B）挡住了 current（C），推的就是 B 而不是 A；
            // current 已经最顶、没谁在它上面 -> 不推；多个遮挡者 -> 全推；
            // 只推“在 current 之上”的，比如 A 在 B 上、B 在 C 上，聚焦 B 时只有 A 动。
            // 这套遮挡逻辑只在 kwin 里生效；rise 风格不推任何窗口，只让聚焦的窗口自己升上去。
            const occluders = suppress ? [] : this._occludersOf(current);
            dlog('kwin occluders =', occluders.map(w => w.get_title?.() ?? w).join(', '));

            // 焦点切走后，原来被推开、现在不再挡 current 的窗口，自己滑回原位（回退时直接到位）
            for (const w of [...this._pushed.keys()]) {
                if (!occluders.includes(w))
                    this._returnWindow(w, suppress);
            }

            // 把挡住 current 的窗口全推开。方向写死 auto：永远朝“远离 current”的方向推，
            // 保证 current 露出来，不再提供“固定推到某个角”的选项。
            // 当遮挡者有多个（>=2）时再额外“散开”：相邻窗口朝左右分开，像拉窗帘一样展开，
            // 而不是整排朝同一个方向平移（那样就“粘成一坨”了）。特别是多个遮挡窗口跟 current 几乎
            // 水平对齐（上下叠着）时，远离向量的水平分量几乎是 0，会退化成整块同方向移动——
            // 这时候强制左右分叉，保证它们朝相反方向散开。
            const multi = occluders.length >= 2;
            for (let i = 0; i < occluders.length; i++) {
                const w = occluders[i];
                if (this._skippable(w)) {
                    dlog('skip push (skippable):', w.get_title?.() ?? w);
                    continue;
                }
                const rect = w.get_frame_rect();
                const f = current.get_frame_rect();
                const wc = rect.x + rect.width / 2, hc = rect.y + rect.height / 2;
                const fc = f.x + f.width / 2, fcy = f.y + f.height / 2;
                const off = this._settings.get_int('offset-px');
                // 远离 current 的基础向量（auto 的语义）
                const awayX = (fc > wc) ? -off : off;
                const awayY = (fcy > hc) ? -off : off;
                // 跟 current 水平基本对齐（中心水平差不到半窗宽）就当成“上下叠着”
                const aligned = Math.abs(fc - wc) < rect.width * 0.5;
                let dx, dy;
                if (multi) {
                    const vFactor = Math.min(i + 1, 3); // 越靠上的遮挡者推得越远，最多 3 倍
                    if (aligned) {
                        // 上下叠着：强制左右分叉 + 上下按次序拉开，保证朝相反方向散开、不粘连
                        dx = (i % 2 === 0 ? -off : off);
                        dy = awayY * vFactor;
                    } else {
                        // 一般情况：左右相邻的反向、上下远离，像拉窗帘一样散开
                        dx = (i % 2 === 0 ? awayX : -awayX);
                        dy = awayY * vFactor;
                    }
                } else {
                    // 只有一个遮挡者：直接沿远离 current 的方向走
                    dx = awayX;
                    dy = awayY;
                }
                this._pushWindow(w, current, {dx, dy});
            }
        }

        // rise 风格：新聚焦的窗口沿曲线线性升上来；
        // current 已经在最顶、或者跟谁都不挨着（孤零零）、或者自动聚焦 / 全屏 / 回退时，都不升。
        if (style === 'rise' && !suppress && this._isAnimatable(current) &&
            this._overlapsAnyWindow(current) && !this._isTopmost(current))
            this._bumpWindow(current);

        // zoom 风格：新聚焦的窗口瞬间缩一下，再按你选的曲线放大回原样；
        // 只在“窗口间切换”这种有意义的聚焦时生效（沿用上面的 !suppress / _isAnimatable 把关）。
        if (style === 'zoom' && !suppress && this._isAnimatable(current))
            this._zoomWindow(current);

        // 这次聚焦处理完了，刷新一下堆叠缓存，作为“下一次”判断谁在上面的依据
        this._refreshStacking();
    }

    // ---- 推开 / 回位 ----

    // 算“远离焦点窗口”的推开向量（auto 语义，方向选项已经删了，这里就写死这个行为）。
    // 只有调用方没指定方向时才当兜底用。
    _computeVec(win, focusWin, offset) {
        const rect = win.get_frame_rect();
        let dx = 0, dy = 0;
        if (focusWin && this._isAnimatable(focusWin)) {
            const f = focusWin.get_frame_rect();
            const wc = rect.x + rect.width / 2;
            const hc = rect.y + rect.height / 2;
            const fc = f.x + f.width / 2;
            const fcy = f.y + f.height / 2;
            dx = (fc > wc) ? -offset : offset;
            dy = (fcy > hc) ? -offset : offset;
        }
        return {dx, dy, rect};
    }

    // 按窗口所在屏幕的 work_area 把目标位置收住，绝不冲出屏幕
    _clampVec(win, rect, dx, dy) {
        let wa;
        try {
            wa = win.get_work_area_current();
        } catch (e) {
            wa = null;
        }
        if (!wa) {
            // 取不到 work_area 也不强行归零，直接用原始偏移（允许暂时越出去一点点）
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
            return; // 已经推过了，别重复推

        const actor = win.get_compositor_private();
        if (!actor) {
            dlog('push skipped: get_compositor_private() is null for', win.get_title?.() ?? win);
            return;
        }

        const offset = this._settings.get_int('offset-px');
        const duration = this._settings.get_int('duration-ms');

        let dx, dy, rect;
        if (overrideVec) {
            // 多个窗口一起推时，方向由调用方指定（相邻窗口往相反方向分开）
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
            return; // 贴边了、推不出去，那就别动了
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

        // 延时自动回位（peek 模式）：>0 时，过这么多毫秒自己平滑滑回去，焦点仍然在别处
        const autoMs = this._settings.get_int('auto-return-ms');
        if (autoMs > 0) {
            state.timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, autoMs, () => {
                if (!this._pushed.has(win)) // 这期间要是已经被切回焦点 / 悬停 / 拖走了，就别回了
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
                // 把真实位置落定，这样偏移留得住、点哪都对
                try {
                    win.move_frame(false, rect.x + c.dx, rect.y + c.dy);
                    actor.translation_x = 0;
                    actor.translation_y = 0;
                    state.committed = true;
                    dlog('pushed+committed', win.get_title?.() ?? win);
                } catch (e) {
                    // Wayland / X11 偶尔会有权限限制：那就退化为纯视觉偏移（点的还是原位置）
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
            } catch (e) { /* 窗口可能已经没了，忽略 */ }
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
            // 真实位置停在偏移处：先把视觉缓动回原位，再把几何落定
            actor.ease({
                translation_x: -state.vecX,
                translation_y: -state.vecY,
                duration,
                mode: EASE_MODE,
                onComplete: finish,
            });
        } else {
            // 纯视觉偏移：直接把 translation 缓动回 0
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
        actor.translation_y = dist; // 起点：稍微低一点，再沿曲线升到位
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

        // 绕中心缩放：把 pivot 放到窗口几何中心。set_pivot_point 某些版本没有，
        // 用 try 兜一下——退化成默认（左上角）缩放也照样能用，只是稍微偏一点。
        try { actor.set_pivot_point(0.5, 0.5); } catch (e) { /* 用默认 pivot */ }

        actor.remove_all_transitions();
        // 瞬间缩小
        actor.scale_x = shrink;
        actor.scale_y = shrink;
        // 再放大回原样（只有这一步有动画 + 缓动）
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
        // 你一开始拖 / 缩放 -> 就不管这个窗口了
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
                // 窗口正在销毁，actor 可能都半释放了，忽略
            }
        }
    }

    _onPointerMove(event) {
        const [px, py] = event.get_coords();

        // 没有要处理的窗口时，记下鼠标位置就走
        if (this._pushed.size === 0) {
            this._lastPx = px;
            this._lastPy = py;
            return;
        }

        // 悬停回位的总开关
        const hoverOn = this._settings.get_boolean('hover-return');

        for (const win of [...this._pushed.keys()]) {
            const s = this._pushed.get(win);
            if (!s)
                continue;

            // 用“存下来的原始位置”算露出区域，真实几何提交前后都准
            const rect = win.get_frame_rect();
            const w = rect.width, h = rect.height;
            const ox = s.origX, oy = s.origY;
            const sx = ox + s.vecX, sy = oy + s.vecY; // 平移后窗口实际停的位置

            const inOrig = px >= ox && px <= ox + w && py >= oy && py <= oy + h;
            const inShifted = px >= sx && px <= sx + w && py >= sy && py <= sy + h;

            if (!hoverOn) {
                this._lastPx = px;
                this._lastPy = py;
                continue;
            }

            // 关键：鼠标必须是从窗口“外面”探进露出区域的，才算悬停回位。
            // 不然只是窗口从鼠标底下溜走、把鼠标“留”在了露出的空位里，
            // 轻轻一动鼠标就误触发回位（表现成“推开后自己滑回去、但焦点还在别处”）。
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
