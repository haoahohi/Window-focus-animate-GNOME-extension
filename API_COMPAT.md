# GNOME Shell 版本 API 风险分析（45 / 46 / 47 / 48 / 49 / 50）

本扩展用到的核心 API 及在各版本下的变动风险。结论先行：

- **45 / 46 / 47**：基本无风险，按当前写法可直接跑。
- **48**：低风险，矩形类型命名空间可能微调（`Meta.Rectangle` → `Mtk.Rectangle`），本扩展只读取 `x/y/width/height` 字段，已天然免疫。
- **49 / 50**：我无法核实这两个版本的真实 API（知识截止于 47/48 附近），以下为**基于已知演化趋势的推测 + 兜底策略**，请在上机实测。

---

## 用到的 API 清单

| API | 用途 | 风险 |
|-----|------|------|
| `extension.js` 的 ESM `Extension` 基类 | 生命周期 | 中（<45 不支持） |
| `this.getSettings()` + `settings-schema` | 读配置 | 低 |
| `global.display` `notify::focus-window` 信号 | 监听焦点变化 | 中（未来可能改名） |
| `global.display.focus_window`（或 `get_focus_window()`） | 取当前焦点窗口 | 中（可能变方法） |
| `Meta.WindowType.NORMAL` | 过滤普通窗口 | 低 |
| `win.maximized_vertically/horizontally`、`win.fullscreen` | 跳过最大化/全屏 | 低 |
| `win.get_frame_rect()` | 取窗口几何 | 低 |
| `win.get_work_area_current()` | 多显示器 work_area | 低（可能有别名） |
| `win.get_compositor_private()` → `MetaWindowActor` | 拿到 Clutter actor | 低 |
| `actor.translation_x/translation_y` + `actor.ease()` | 缓动平移 | 中（Clutter 重构风险） |
| `Clutter.EasingMode.EASE_OUT_EXPO` | 指数缓动 | 中（曾叫 `AnimationMode`） |
| `win.move_frame(user_action, x, y)` | 提交真实几何 | 低（Wayland 下扩展有权限） |
| `global.window_manager` `destroy` 信号 | 窗口销毁清理 | 低 |
| `global.stage` `motion-event` | hover 回位 | 低 |

---

## 各版本详情

### GNOME 45
- ESM 扩展体系成型：`import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js'` 生效。`init/enable/disable` 函数式写法也仍可用，但本扩展用类式。
- `Clutter.AnimationMode` 在 44 已改名为 `Clutter.EasingMode`。本扩展用 `Clutter.EasingMode || Clutter.AnimationMode` 兜底，两个版本都安全。
- `actor.ease({...})`、`remove_all_transitions()` 均存在。
- `global.display` 的 `notify::focus-window` 与 `focus_window` 属性稳定。
- `this.getSettings()` 依赖 metadata.json 里的 `settings-schema`（已配置）。**注意**：schema 必须编译安装到系统 gschema 目录，或放在扩展 `schemas/` 下由 GNOME 41+ 自动加载（已这样做并 `glib-compile-schemas` 通过）。

### GNOME 46
- libmutter 15，主要是修复版。上述 API 无已知破坏性改动。

### GNOME 47
- libmutter 16。窗口 / 显示相关 API 稳定。`notify::focus-window`、`Meta.Window` 方法均可用。
- 无需要改动的信号或方法。

### GNOME 48
- libmutter 17。较明显的发布，但本扩展所用窗口 API 未变。
- **矩形命名空间**：较新 mutter 把 `Meta.Rectangle` 迁到 `Mtk.Rectangle`（`get_frame_rect()` / `get_work_area_current()` 的返回值类型可能变）。**本扩展只读取 `x/y/width/height` 字段，不依赖具体类名，因此不受影响。**
- `global.display`、`MetaWindowActor` 的 `translation_*`、`ease()` 仍可用。

### GNOME 49 / 50（推测，未经验证）
> 这两个版本超出我的可靠知识范围，下面是基于 GNOME 长期演化方向的判断，请实测确认。

潜在风险点（按可能性排序）：

1. **`global.display.focus_window` 变成方法 `get_focus_window()`**
   - 本扩展已用 `_focusWindow()` 兜底（`focus_window ?? get_focus_window?.()`）。
   - 但仍监听 `notify::focus-window` 信号——若属性被改名，信号名也会变（如 `notify::focus-window` → 别的）。届时需要同步改信号名。

2. **Clutter `ease()` / `EasingMode` 被重构或移除**
   - 长期有"替换 Clutter"的讨论，但在 48 仍是 `Clutter`。若 49/50 动了 `ease()` 或 `EasingMode` 命名，平移动画会失败。
   - 兜底：捕获 `actor.ease` 调用异常，并降级为直接 `actor.translation_x = v`（瞬时无动画）；或改用新的动画 API。

3. **`Meta` / `Mtk` 矩形、窗口方法重命名**
   - `get_frame_rect()`、`get_work_area_current()` 若改名，需更新调用。当前只读取字段，类型迁移已免疫，但方法名迁移不免疫。

4. **`Shell.WindowManager`（`global.window_manager`）的 `unmanaged` 信号**
   - 目前稳定；若改成别的清理钩子，窗口销毁时状态清理会失效（不至于崩 shell，但可能残留 `_pushed` 条目）。影响很小。

5. **ESM 加载机制变化**
   - `resource:///...` 路径或 `import` 语义若调整，需要同步更新 import 路径。45+ 一直稳定，可能性低。

---

## 已写入代码的兜底

- `Clutter.EasingMode || Clutter.AnimationMode`：兼容 44 改名。
- `_focusWindow()`：兼容 `focus_window` 属性 / `get_focus_window()` 方法。
- `move_frame` 包 `try/catch`：Wayland/X11 偶发受限时退化为纯视觉 `translation` 偏移（输入命中仍在原几何位，但不会崩）。
- `disable()` 里 `_disabling` 标志 + `remove_all_transitions()` + 立即 `move_frame` 还原：防止窗口卡在偏移位、防止动画 `onComplete` 在禁用后把窗口又推回去。
- 所有 `get_compositor_private()` / `get_frame_rect()` 都假定可能返回 null 或抛出异常，已做 null 守卫。

## 上线前建议的自测

1. 在目标 GNOME 版本上 `glib-compile-schemas schemas/` 后安装扩展，开 `Looking Glass`（`Alt+F2` → `lg`）看有没有报错。
2. 重点测：最大化/全屏不触发；双显示器不越屏；关扩展后所有窗口归位；扩展开着时关闭一个被推开的窗口不崩。
3. 49/50 上若 `notify::focus-window` 不触发，先用 `lg` 里 `global.display.connect('notify::focus-window', ...)` 验证信号是否还在，再决定要不要改信号名。
