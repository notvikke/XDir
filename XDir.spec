# -*- mode: python ; coding: utf-8 -*-

hiddenimports = [
    'webview.platforms.winforms',
    'webview.platforms.win32',
    'webview.platforms.edgechromium',
    'webview.platforms.mshtml',
    'clr',
    'pythonnet',
]

datas = [
    ('frontend', 'frontend'),
    ('extension', 'extension'),
]

a = Analysis(
    ['app.py'],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'webview.platforms.android',
        'webview.platforms.cocoa',
        'webview.platforms.gtk',
        'webview.platforms.qt',
        'webview.platforms.cef',
        'PySide6',
        'PyQt5',
        'PyQt6',
        'qtpy',
        'tkinter',
        'IPython',
        'jedi',
        'pytest',
        '_pytest',
        'numpy',
        'PIL',
        'psycopg2',
        'MySQLdb',
    ],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='XDir',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon='XDir.ico',
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='XDir',
)
