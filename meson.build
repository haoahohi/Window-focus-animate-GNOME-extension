project('window-focus-slide', 'c')

uuid = 'window-focus-slide@sky_is_calling'
extdir = get_option('prefix') / get_option('datadir') / 'gnome-shell' / 'extensions' / uuid

install_data(
  'metadata.json',
  'extension.js',
  'prefs.js',
  'API_COMPAT.md',
  install_dir: extdir,
)

install_data(
  'schemas/org.gnome.shell.extensions.window-focus-slide.gschema.xml',
  install_dir: extdir / 'schemas',
)

install_data(
  'po/window-focus-slide@sky_is_calling.pot',
  'po/zh_CN.po',
  install_dir: extdir / 'po',
)

# 把 .po 编译成扩展自带 locale 的 .mo（domain = uuid），这样装完翻译马上就能用。
# 提醒：EGO 不允许把 gschemas.compiled 打进包里，所以这里只装 schema 的源码 xml，
#       交给 GNOME 在安装时自己编译；.mo 则跟着扩展一起走，没网也能翻译。
langs = ['zh_CN']
foreach lang : langs
  custom_target(
    uuid + '_' + lang + '_mo',
    input: 'po/' + lang + '.po',
    output: uuid + '.mo',
    command: [find_program('msgfmt'), '-c', '--check-format', '-o', '@OUTPUT@', '@INPUT@'],
    install: true,
    install_dir: extdir / 'locale' / lang / 'LC_MESSAGES',
  )
endforeach
