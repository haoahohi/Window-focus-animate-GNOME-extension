// 窗口聚焦推移的设置界面（GNOME Shell 45+ 的 ESM 首选项）。
// 多语言：英文是底本，下面这些菜单名 / 行标题 / 说明都套了 this.gettext()；
// 翻译文件在 locale/<lang>/LC_MESSAGES/<uuid>.mo（由 po/ 下的 .po 编译而来）。

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class WindowFocusSlidePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        // 准备好翻译域（domain = 扩展 uuid），这样下面才能用到翻译
        this.initTranslations();
        const settings = this.getSettings();

        // 聚焦动画风格（菜单标签随语言翻译；值保持英文枚举不变）
        const BUMP_STYLES = [
            [this.gettext('Kwin style'), 'kwin'],
            [this.gettext('Linear rise'), 'rise'],
            [this.gettext('Zoom'), 'zoom'],
        ];

        // 上升 / 放大缓动曲线
        const BUMP_EASINGS = [
            [this.gettext('Linear (constant speed)'), 'linear'],
            [this.gettext('Ease-in (slow then fast)'), 'ease-in'],
            [this.gettext('Ease-out (fast then slow)'), 'ease-out'],
        ];

        const page = new Adw.PreferencesPage({
            title: this.gettext('Focus push'),
            icon_name: 'preferences-system-symbolic',
        });

        // 通用
        const genGroup = new Adw.PreferencesGroup({ title: this.gettext('General') });
        page.add(genGroup);
        genGroup.add(this._comboRow(
            settings, 'focus-bump-style', this.gettext('Focus animation style'), BUMP_STYLES,
            (s, v) => { s.set_string('focus-bump-style', v); this._applyStyle(v); }));
        genGroup.add(this._switchRow(settings, 'enabled', this.gettext('Enable')));

        // Kwin 风格（仅 kwin 时可见）
        const kwinGroup = new Adw.PreferencesGroup({
            title: this.gettext('Kwin style'),
            description: this.gettext('The unfocused window is pushed aside and stays, revealing its edge; it returns on focus-back / hover over the revealed edge / timed auto-return.'),
        });
        page.add(kwinGroup);
        kwinGroup.add(this._spinRow(
            settings, 'offset-px', this.gettext('Offset distance'), this.gettext('pixels'), 0, 300, 1));
        kwinGroup.add(this._spinRow(
            settings, 'duration-ms', this.gettext('Animation duration'), this.gettext('milliseconds'), 50, 1500, 10));
        kwinGroup.add(this._spinRow(
            settings, 'auto-return-ms', this.gettext('Timed auto return'), this.gettext('milliseconds (0=off)'), 0, 5000, 50));
        kwinGroup.add(this._switchRow(
            settings, 'hover-return', this.gettext('Return on hover over revealed edge')));

        // 线性上升（仅 rise 时可见）
        const riseGroup = new Adw.PreferencesGroup({
            title: this.gettext('Linear rise'),
            description: this.gettext('The newly focused window rises into place along the chosen curve.'),
        });
        page.add(riseGroup);
        riseGroup.add(this._spinRow(
            settings, 'focus-bump-distance', this.gettext('Rise distance'), this.gettext('pixels (0=none)'), 0, 100, 1));
        riseGroup.add(this._spinRow(
            settings, 'focus-bump-duration', this.gettext('Rise animation duration'), this.gettext('milliseconds (0=instant)'), 0, 1500, 10));
        riseGroup.add(this._comboRow(
            settings, 'focus-bump-easing', this.gettext('Rise easing curve'), BUMP_EASINGS,
            (s, v) => s.set_string('focus-bump-easing', v)));

        // 缩放（仅 zoom 时可见）
        const zoomGroup = new Adw.PreferencesGroup({
            title: this.gettext('Zoom'),
            description: this.gettext('The newly focused window instantly shrinks, then grows back to original along the chosen curve.'),
        });
        page.add(zoomGroup);
        zoomGroup.add(this._doubleSpinRow(
            settings, 'focus-zoom-shrink', this.gettext('Shrink ratio'), this.gettext('(1.0=none, 0.9=90%)'), 0.1, 1.0, 0.01));
        zoomGroup.add(this._spinRow(
            settings, 'focus-zoom-duration', this.gettext('Zoom animation duration'), this.gettext('milliseconds (0=instant)'), 0, 1500, 10));
        zoomGroup.add(this._comboRow(
            settings, 'focus-zoom-easing', this.gettext('Zoom easing curve'), BUMP_EASINGS,
            (s, v) => s.set_string('focus-zoom-easing', v)));

        this._kwinGroup = kwinGroup;
        this._riseGroup = riseGroup;
        this._zoomGroup = zoomGroup;
        this._applyStyle(settings.get_string('focus-bump-style'));

        window.add(page);
    }

    // 按风格互斥锁定：只显示当前选中风格对应的设置组
    _applyStyle(style) {
        if (this._kwinGroup) this._kwinGroup.visible = (style === 'kwin');
        if (this._riseGroup) this._riseGroup.visible = (style === 'rise');
        if (this._zoomGroup) this._zoomGroup.visible = (style === 'zoom');
    }

    _spinRow(settings, key, title, unit, min, max, step) {
        const row = new Adw.SpinRow({
            title,
            subtitle: unit,
            adjustment: new Gtk.Adjustment({
                lower: min,
                upper: max,
                step_increment: step,
                page_increment: step * 10,
                value: settings.get_int(key),
            }),
        });
        settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    // 与 _spinRow 类似，但用于 double 类型键（如缩放比例）
    _doubleSpinRow(settings, key, title, unit, min, max, step) {
        const row = new Adw.SpinRow({
            title,
            subtitle: unit,
            digits: 2,
            adjustment: new Gtk.Adjustment({
                lower: min,
                upper: max,
                step_increment: step,
                page_increment: step * 10,
                value: settings.get_double(key),
            }),
        });
        settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _switchRow(settings, key, title) {
        const row = new Adw.SwitchRow({title});
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _comboRow(settings, key, title, items, onSet) {
        const model = new Gtk.StringList();
        for (const [label] of items)
            model.append(label); // 标签已在上文经 this.gettext() 包裹

        const current = settings.get_string(key);
        let selected = 0;
        for (let i = 0; i < items.length; i++) {
            if (items[i][1] === current) {
                selected = i;
                break;
            }
        }

        const row = new Adw.ComboRow({
            title,
            model,
            selected,
        });

        row.connect('notify::selected', () => {
            const value = items[row.selected][1];
            onSet(settings, value);
        });

        return row;
    }
}
