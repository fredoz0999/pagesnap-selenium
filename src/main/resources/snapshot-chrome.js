/**
 * Injected into every tab: toolbar, toast, hardened note, end-name UI, hotkeys.
 * Communicates via window flags polled by Java:
 *   __snapshotCapture, __snapshotEnd, __snapshotNote, __snapshotSessionName
 *
 * Visual language: shadcn/ui–inspired (zinc, rounded cards, outline buttons).
 * Ref: https://ui.shadcn.com/ — vanilla CSS tokens only (no React/Tailwind runtime).
 * Icons: Phosphor Icons fill weight (MIT) — path data from
 * https://phosphoricons.com/?weight=fill  /  @phosphor-icons/core assets/fill
 * (camera, note-pencil, stop-circle, arrows-out-cardinal). Inlined SVGs so the
 * page needs no network access under strict CSP.
 */
(function installSnapshotChrome() {
  var w = window;
  // Must be a Map keyed by the element itself. A plain object stringifies every
  // key to "[object HTMLButtonElement]", so all buttons shared one slot: after a
  // capture only the first one got its display back and the toolbar collapsed.
  if (!w.__snapshotDisplayBackup || typeof w.__snapshotDisplayBackup.get !== 'function') {
    w.__snapshotDisplayBackup = new Map();
  }

  // shadcn/ui zinc DARK theme tokens (floating chrome) + light dialogs
  // https://ui.shadcn.com/themes
  var C = {
    font: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    // dark card / popover (zinc-950 / zinc-900)
    bg: '#09090b',
    layer01: '#18181b',
    layer02: '#27272a',
    layerHover: '#3f3f46',
    borderSubtle: '#27272a',
    borderStrong: '#3f3f46',
    textPrimary: '#fafafa',
    textSecondary: '#a1a1aa',
    textHelper: '#71717a',
    // primary = near-white on dark chrome (shadcn dark primary)
    interactive: '#fafafa',
    interactiveHover: '#e4e4e7',
    interactiveActive: '#d4d4d8',
    interactiveFg: '#18181b',
    danger: '#ef4444',
    dangerHover: '#dc2626',
    supportSuccess: '#22c55e',
    supportError: '#ef4444',
    // light dialogs (readable forms)
    modalBg: '#ffffff',
    modalText: '#09090b',
    modalSecondary: '#71717a',
    field: '#ffffff',
    fieldBorder: '#e4e4e7',
    fieldFocus: '#18181b',
    overlay: 'rgba(0, 0, 0, 0.8)',
    // rounded-md / rounded-lg
    radius: '0.5rem',
    radiusLg: '0.75rem',
    shadow: '0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)',
    shadowLg: '0 20px 25px -5px rgba(0,0,0,0.1), 0 8px 10px -6px rgba(0,0,0,0.1)'
  };

  function phosphorFill(pathD, size) {
    var s = size || 18;
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="' +
      s +
      '" height="' +
      s +
      '" fill="currentColor" aria-hidden="true" focusable="false"><path d="' +
      pathD +
      '"/></svg>'
    );
  }

  // Phosphor fill paths (verbatim from phosphoricons.com fill set)
  var ICONS = {
    // camera-fill — Capture
    capture: phosphorFill(
      'M208,56H180.28L166.65,35.56A8,8,0,0,0,160,32H96a8,8,0,0,0-6.65,3.56L75.71,56H48A24,24,0,0,0,24,80V192a24,24,0,0,0,24,24H208a24,24,0,0,0,24-24V80A24,24,0,0,0,208,56Zm-44,76a36,36,0,1,1-36-36A36,36,0,0,1,164,132Z'
    ),
    // note-pencil-fill — Note
    note: phosphorFill(
      'M224,128v80a16,16,0,0,1-16,16H48a16,16,0,0,1-16-16V48A16,16,0,0,1,48,32h80a8,8,0,0,1,0,16H48V208H208V128a8,8,0,0,1,16,0Zm5.66-58.34-96,96A8,8,0,0,1,128,168H96a8,8,0,0,1-8-8V128a8,8,0,0,1,2.34-5.66l96-96a8,8,0,0,1,11.32,0l32,32A8,8,0,0,1,229.66,69.66Zm-17-5.66L192,43.31,179.31,56,200,76.69Z'
    ),
    // stop-circle-fill — End
    end: phosphorFill(
      'M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm32,132a4,4,0,0,1-4,4H100a4,4,0,0,1-4-4V100a4,4,0,0,1,4-4h56a4,4,0,0,1,4,4Z'
    ),
    // arrows-out-cardinal-fill — dock / move toolbar
    dock: phosphorFill(
      'M96,136H64v24a8,8,0,0,1-13.66,5.66l-32-32a8,8,0,0,1,0-11.32l32-32A8,8,0,0,1,64,96v24H96a8,8,0,0,1,0,16Zm0-72h24V96a8,8,0,0,0,16,0V64h24a8,8,0,0,0,5.66-13.66l-32-32a8,8,0,0,0-11.32,0l-32,32A8,8,0,0,0,96,64Zm141.66,58.34-32-32A8,8,0,0,0,192,96v24H160a8,8,0,0,0,0,16h32v24a8,8,0,0,0,13.66,5.66l32-32A8,8,0,0,0,237.66,122.34ZM160,192H136V160a8,8,0,0,0-16,0v32H96a8,8,0,0,0-5.66,13.66l32,32a8,8,0,0,0,11.32,0l32-32A8,8,0,0,0,160,192Z',
      16
    ),
    // minus-circle-fill — minimize / reduce toolbar
    minimize: phosphorFill(
      'M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm40,112H88a8,8,0,0,1,0-16h80a8,8,0,0,1,0,16Z',
      16
    ),
    // plus-circle-fill — expand toolbar when minimized
    expand: phosphorFill(
      'M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm40,112H136v32a8,8,0,0,1-16,0V136H88a8,8,0,0,1,0-16h32V88a8,8,0,0,1,16,0v32h32a8,8,0,0,1,0,16Z',
      16
    )
  };

  function headerIconBtn(html, title) {
    var b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('data-snapshot-tool', 'toolbar');
    b.title = title;
    b.setAttribute('aria-label', title);
    b.innerHTML = html;
    // shadcn ghost icon button
    b.style.cssText = [
      'all: initial',
      'box-sizing: border-box',
      'font-family: ' + C.font,
      'line-height: 1',
      'width: 36px',
      'height: 36px',
      'display: inline-flex',
      'align-items: center',
      'justify-content: center',
      'border-radius: ' + C.radius,
      'border: 1px solid transparent',
      'background: transparent',
      'color: ' + C.textPrimary,
      'cursor: pointer',
      'flex-shrink: 0',
      'transition: background 0.15s ease, color 0.15s ease'
    ].join(';');
    b.addEventListener('mouseenter', function () {
      b.style.background = C.layer02;
    });
    b.addEventListener('mouseleave', function () {
      b.style.background = 'transparent';
    });
    b.addEventListener('focus', function () {
      b.style.outline = '2px solid ' + C.textPrimary;
      b.style.outlineOffset = '2px';
    });
    b.addEventListener('blur', function () {
      b.style.outline = 'none';
    });
    return b;
  }

  /** shadcn-style button: default | secondary | outline | ghost | destructive */
  function modalBtn(label, kind) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    // light dialog buttons (shadcn default theme)
    var bg = '#f4f4f5'; // secondary
    var fg = '#18181b';
    var border = 'transparent';
    var hover = '#e4e4e7';
    if (kind === 'primary') {
      bg = '#18181b';
      fg = '#fafafa';
      hover = '#27272a';
    } else if (kind === 'danger') {
      bg = C.danger;
      fg = '#fafafa';
      hover = C.dangerHover;
    } else if (kind === 'tertiary' || kind === 'outline') {
      bg = 'transparent';
      fg = '#18181b';
      border = '#e4e4e7';
      hover = '#f4f4f5';
    } else if (kind === 'ghost') {
      bg = 'transparent';
      fg = '#18181b';
      border = 'transparent';
      hover = '#f4f4f5';
    } else {
      // secondary
      bg = '#f4f4f5';
      fg = '#18181b';
      hover = '#e4e4e7';
    }
    b.style.cssText = [
      'box-sizing: border-box',
      'display: inline-flex',
      'align-items: center',
      'justify-content: center',
      'margin: 0',
      'min-height: 36px',
      'padding: 0 16px',
      'border-radius: ' + C.radius,
      'border: 1px solid ' + border,
      'background: ' + bg,
      'color: ' + fg,
      'font-size: 14px',
      'font-weight: 500',
      'line-height: 1.25',
      'font-family: ' + C.font,
      'cursor: pointer',
      'white-space: nowrap',
      'appearance: none',
      'transition: background 0.15s ease, color 0.15s ease, opacity 0.15s ease'
    ].join(';');
    b.addEventListener('mouseenter', function () {
      b.style.background = hover;
    });
    b.addEventListener('mouseleave', function () {
      b.style.background = bg;
    });
    return b;
  }

  function fireCapture(note) {
    w.__snapshotNote = note == null ? '' : String(note);
    w.__snapshotCapture = true;
  }

  function finalizeEnd(folderName) {
    w.__snapshotSessionName = folderName == null ? '' : String(folderName).trim();
    w.__snapshotEnd = true;
  }

  w.__snapshotToast = function (msg, ok) {
    try {
      var t = document.createElement('div');
      t.setAttribute('data-snapshot-tool', 'toast');
      t.setAttribute('role', 'status');
      t.textContent = msg;
      // shadcn toast-like dark card
      t.style.cssText = [
        'all: initial',
        'position: fixed',
        'top: 16px',
        'right: 16px',
        'left: auto',
        'bottom: auto',
        'z-index: 2147483647',
        'font-family: ' + C.font,
        'font-size: 14px',
        'font-weight: 500',
        'padding: 12px 16px',
        'border-radius: ' + C.radius,
        'box-shadow: ' + C.shadowLg,
        'border: 1px solid ' + (ok ? 'rgba(34,197,94,0.35)' : 'rgba(239,68,68,0.35)'),
        'background: ' + C.layer01,
        'color: ' + C.textPrimary,
        'max-width: 320px',
        'pointer-events: none'
      ].join(';');
      (document.documentElement || document.body).appendChild(t);
      setTimeout(function () {
        try { t.remove(); } catch (e) {}
      }, 2200);
    } catch (e) {}
  };

  w.__snapshotSetChromeHidden = function (hidden) {
    var backup = w.__snapshotDisplayBackup;
    var nodes = document.querySelectorAll('[data-snapshot-tool]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (hidden) {
        if (!backup.has(el)) {
          backup.set(el, el.style.display);
        }
        el.style.display = 'none';
      } else {
        var prev = backup.get(el);
        el.style.display = prev !== undefined ? prev : '';
        backup.delete(el);
      }
    }
  };

  /* ---------- Hardened note modal ---------- */
  w.__snapshotShowNoteUi = function () {
    if (w.__snapshotNoteUiOpen) return;
    w.__snapshotNoteUiOpen = true;

    var existing = document.getElementById('__snapshot_note_root');
    if (existing) existing.remove();

    var supportsDialog =
      typeof HTMLDialogElement !== 'undefined' &&
      typeof HTMLDialogElement.prototype.showModal === 'function';

    var root = supportsDialog
      ? document.createElement('dialog')
      : document.createElement('div');
    root.id = '__snapshot_note_root';
    root.setAttribute('data-snapshot-tool', 'note-ui');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');

    if (supportsDialog) {
      root.style.cssText =
        'all: initial; border: none; padding: 0; margin: 0; background: transparent; font-family: ' +
        C.font +
        ';';
    } else {
      root.style.cssText = [
        'all: initial',
        'position: fixed',
        'inset: 0',
        'z-index: 2147483647',
        'display: flex',
        'align-items: center',
        'justify-content: center',
        'background: ' + C.overlay,
        'font-family: ' + C.font
      ].join(';');
    }

    var styleEl = null;
    if (supportsDialog) {
      styleEl = document.createElement('style');
      styleEl.setAttribute('data-snapshot-tool', 'note-ui');
      styleEl.textContent =
        '#__snapshot_note_root[data-snapshot-tool="note-ui"]{border:none;padding:0;background:transparent;}' +
        '#__snapshot_note_root[data-snapshot-tool="note-ui"]::backdrop{background:' +
        C.overlay +
        ';}';
      (document.head || document.documentElement).appendChild(styleEl);
    }

    var shell = document.createElement('div');
    shell.setAttribute('data-snapshot-tool', 'note-ui');
    shell.style.cssText = supportsDialog
      ? 'display:flex;align-items:center;justify-content:center;min-width:100vw;min-height:100vh;padding:24px;box-sizing:border-box;'
      : 'display:contents;';

    var panel = document.createElement('div');
    panel.setAttribute('data-snapshot-tool', 'note-ui');
    panel.style.cssText = [
      'box-sizing:border-box',
      'background:' + C.modalBg,
      'color:' + C.modalText,
      'padding:24px',
      'border-radius:' + C.radiusLg,
      'min-width:min(360px,92vw)',
      'max-width:560px',
      'width:min(560px,92vw)',
      'box-shadow:' + C.shadowLg,
      'border:1px solid ' + C.fieldBorder,
      'font-family:' + C.font,
      'display:flex',
      'flex-direction:column',
      'gap:16px'
    ].join(';');

    var body = document.createElement('div');
    body.setAttribute('data-snapshot-tool', 'note-ui');
    body.style.cssText = 'display:flex;flex-direction:column;gap:8px;';

    var title = document.createElement('div');
    title.setAttribute('data-snapshot-tool', 'note-ui');
    title.textContent = 'Snapshot note';
    title.style.cssText =
      'box-sizing:border-box;font-size:18px;font-weight:600;line-height:1;letter-spacing:-0.025em;margin:0;color:' +
      C.modalText +
      ';font-family:' +
      C.font +
      ';';

    var hint = document.createElement('div');
    hint.setAttribute('data-snapshot-tool', 'note-ui');
    hint.textContent =
      'Optional context for the AI — what changed, what to test. Drag the corner to resize.';
    hint.style.cssText =
      'box-sizing:border-box;font-size:14px;line-height:1.4;color:' +
      C.modalSecondary +
      ';margin:0;font-family:' +
      C.font +
      ';';

    // Multi-line note: larger default + vertical resize for longer context.
    var input = document.createElement('textarea');
    input.setAttribute('data-snapshot-tool', 'note-ui');
    input.rows = 5;
    input.placeholder =
      'e.g. Opened board menu after invite failed.\nExpected: error toast and retry CTA visible.\nBackground: free-plan workspace, 3 members.';
    input.autocomplete = 'off';
    input.spellcheck = true;
    input.style.cssText = [
      'box-sizing: border-box',
      'display: block',
      'width: 100%',
      'min-height: 120px',
      'max-height: min(50vh, 360px)',
      'margin: 8px 0 0',
      'padding: 8px 12px',
      'border-radius: ' + C.radius,
      'border: 1px solid ' + C.fieldBorder,
      'background: ' + C.field,
      'color: ' + C.modalText,
      'font-size: 14px',
      'line-height: 1.4',
      'font-family: ' + C.font,
      'resize: vertical',
      'outline: none',
      'box-shadow: 0 1px 2px 0 rgba(0,0,0,0.05)'
    ].join(';');
    input.addEventListener('focus', function () {
      input.style.outline = '2px solid ' + C.fieldFocus;
      input.style.outlineOffset = '2px';
      input.style.borderColor = C.fieldFocus;
    });
    input.addEventListener('blur', function () {
      input.style.outline = 'none';
      input.style.borderColor = C.fieldBorder;
    });

    // shadcn DialogFooter: right-aligned actions with gap
    var row = document.createElement('div');
    row.setAttribute('data-snapshot-tool', 'note-ui');
    row.style.cssText = [
      'box-sizing: border-box',
      'display: flex',
      'flex-direction: row',
      'flex-wrap: wrap',
      'align-items: center',
      'justify-content: flex-end',
      'gap: 8px',
      'width: 100%',
      'margin-top: 8px'
    ].join(';');

    // Cancel: close without capturing (accidental Note open).
    var cancelBtn = modalBtn('Cancel', 'outline');
    cancelBtn.setAttribute('data-snapshot-tool', 'note-ui');
    cancelBtn.title = 'Close without capturing';

    // Skip note: capture now with an empty note.
    var skipBtn = modalBtn('Skip note', 'secondary');
    skipBtn.setAttribute('data-snapshot-tool', 'note-ui');
    skipBtn.title = 'Capture this page without a note';

    var okBtn = modalBtn('Capture', 'primary');
    okBtn.setAttribute('data-snapshot-tool', 'note-ui');
    okBtn.title = 'Capture with this note';

    function focusInput() {
      try {
        input.focus();
      } catch (e) {}
    }

    function onFocusIn(ev) {
      if (!w.__snapshotNoteUiOpen) return;
      if (ev.target && root.contains(ev.target)) return;
      ev.preventDefault();
      ev.stopPropagation();
      focusInput();
    }

    function onKeyDownCapture(ev) {
      if (!w.__snapshotNoteUiOpen) return;
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        dismiss();
        return;
      }
      // Multi-line: plain Enter inserts newline; Ctrl/Cmd+Enter captures.
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey) && root.contains(ev.target)) {
        ev.preventDefault();
        ev.stopPropagation();
        finish(input.value.trim());
        return;
      }
      if (root.contains(ev.target)) ev.stopPropagation();
    }

    var focusPoll;
    var inertTargets = [];

    function applyInert() {
      inertTargets = [];
      try {
        var body = document.body;
        if (!body) return;
        Array.prototype.forEach.call(body.children, function (child) {
          if (child === root) return;
          if (child.id === '__snapshot_toolbar_root') return;
          if (child.getAttribute && child.getAttribute('data-snapshot-tool')) return;
          try {
            if (!child.inert) {
              child.inert = true;
              inertTargets.push(child);
            }
          } catch (e) {}
        });
      } catch (e) {}
    }

    function clearInert() {
      for (var i = 0; i < inertTargets.length; i++) {
        try {
          inertTargets[i].inert = false;
        } catch (e) {}
      }
      inertTargets = [];
    }

    function teardownUi() {
      if (!w.__snapshotNoteUiOpen) return false;
      w.__snapshotNoteUiOpen = false;
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('keydown', onKeyDownCapture, true);
      if (focusPoll) clearInterval(focusPoll);
      clearInert();
      try {
        if (supportsDialog && root.close) root.close();
      } catch (e) {}
      try {
        root.remove();
      } catch (e) {}
      try {
        if (styleEl) styleEl.remove();
      } catch (e) {}
      return true;
    }

    /** Close note UI without capturing (accidental open / change mind). */
    function dismiss() {
      teardownUi();
    }

    /** Capture with optional note text. */
    function finish(note) {
      if (!teardownUi()) return;
      fireCapture(note);
    }

    okBtn.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      finish(input.value.trim());
    });
    skipBtn.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      finish('');
    });
    cancelBtn.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      dismiss();
    });
    root.addEventListener('cancel', function (ev) {
      // dialog Esc / backdrop cancel → do not capture
      ev.preventDefault();
      dismiss();
    });

    row.appendChild(cancelBtn);
    row.appendChild(skipBtn);
    row.appendChild(okBtn);
    body.appendChild(title);
    body.appendChild(hint);
    body.appendChild(input);
    panel.appendChild(body);
    panel.appendChild(row);
    shell.appendChild(panel);
    root.appendChild(shell);
    (document.documentElement || document.body).appendChild(root);

    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('keydown', onKeyDownCapture, true);
    applyInert();

    try {
      if (supportsDialog) root.showModal();
    } catch (e) {
      root.style.cssText = [
        'all:initial',
        'position:fixed',
        'inset:0',
        'z-index:2147483647',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'background:rgba(15,23,42,0.45)',
        'font-family:system-ui,Segoe UI,sans-serif'
      ].join(';');
    }
    focusInput();
    setTimeout(focusInput, 50);
    setTimeout(focusInput, 150);
    setTimeout(focusInput, 300);
    focusPoll = setInterval(function () {
      if (!w.__snapshotNoteUiOpen) {
        clearInterval(focusPoll);
        return;
      }
      if (!document.activeElement || !root.contains(document.activeElement)) {
        focusInput();
      }
    }, 200);
  };

  /* ---------- End session name UI ---------- */
  w.__snapshotShowEndNameUi = function () {
    if (w.__snapshotNoteUiOpen) return;
    w.__snapshotNoteUiOpen = true;
    var existing = document.getElementById('__snapshot_end_root');
    if (existing) existing.remove();

    var root = document.createElement('div');
    root.id = '__snapshot_end_root';
    root.setAttribute('data-snapshot-tool', 'end-ui');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Name this session');
    root.style.cssText = [
      'position: fixed',
      'inset: 0',
      'width: 100vw',
      'height: 100vh',
      'max-width: none',
      'max-height: none',
      'margin: 0',
      'padding: 24px',
      'border: none',
      'z-index: 2147483647',
      'display: flex',
      'align-items: center',
      'justify-content: center',
      'box-sizing: border-box',
      'background: ' + C.overlay,
      'font-family: ' + C.font,
      'color: ' + C.modalText
    ].join(';');

    var panel = document.createElement('div');
    panel.setAttribute('data-snapshot-tool', 'end-ui');
    panel.style.cssText = [
      'box-sizing: border-box',
      'background: ' + C.modalBg,
      'color: ' + C.modalText,
      'padding: 24px',
      'border-radius: ' + C.radiusLg,
      'width: min(440px, 92vw)',
      'max-width: 440px',
      'box-shadow: ' + C.shadowLg,
      'border: 1px solid ' + C.fieldBorder,
      'font-family: ' + C.font,
      'display: flex',
      'flex-direction: column',
      'gap: 16px'
    ].join(';');

    var body = document.createElement('div');
    body.setAttribute('data-snapshot-tool', 'end-ui');
    body.style.cssText = 'display:flex;flex-direction:column;gap:8px;';

    var title = document.createElement('div');
    title.setAttribute('data-snapshot-tool', 'end-ui');
    title.textContent = 'Name this session';
    title.style.cssText =
      'box-sizing:border-box;font-size:18px;font-weight:600;line-height:1;letter-spacing:-0.025em;margin:0;color:' +
      C.modalText +
      ';font-family:' +
      C.font +
      ';';

    var hint = document.createElement('div');
    hint.setAttribute('data-snapshot-tool', 'end-ui');
    hint.textContent =
      'Optional. Leave blank to keep the default timestamp folder (session-<name>-<timestamp>).';
    hint.style.cssText =
      'box-sizing:border-box;font-size:14px;line-height:1.4;color:' +
      C.modalSecondary +
      ';margin:0;font-family:' +
      C.font +
      ';';

    var input = document.createElement('input');
    input.setAttribute('data-snapshot-tool', 'end-ui');
    input.type = 'text';
    input.placeholder = 'optional-folder-name';
    input.style.cssText = [
      'box-sizing: border-box',
      'display: block',
      'width: 100%',
      'margin: 8px 0 0',
      'padding: 8px 12px',
      'border-radius: ' + C.radius,
      'border: 1px solid ' + C.fieldBorder,
      'background: ' + C.field,
      'color: ' + C.modalText,
      'font-size: 14px',
      'line-height: 1.4',
      'font-family: ' + C.font,
      'outline: none',
      'height: 36px',
      'box-shadow: 0 1px 2px 0 rgba(0,0,0,0.05)'
    ].join(';');
    input.addEventListener('focus', function () {
      input.style.outline = '2px solid ' + C.fieldFocus;
      input.style.outlineOffset = '2px';
      input.style.borderColor = C.fieldFocus;
    });
    input.addEventListener('blur', function () {
      input.style.outline = 'none';
      input.style.borderColor = C.fieldBorder;
    });

    var row = document.createElement('div');
    row.setAttribute('data-snapshot-tool', 'end-ui');
    row.style.cssText = [
      'box-sizing: border-box',
      'display: flex',
      'flex-direction: row',
      'flex-wrap: wrap',
      'align-items: center',
      'justify-content: flex-end',
      'gap: 8px',
      'width: 100%',
      'margin-top: 8px'
    ].join(';');

    var cancelBtn = modalBtn('Cancel', 'outline');
    cancelBtn.setAttribute('data-snapshot-tool', 'end-ui');
    cancelBtn.title = 'Keep recording - do not end the session';

    var skipBtn = modalBtn('Skip & End', 'secondary');
    skipBtn.setAttribute('data-snapshot-tool', 'end-ui');

    var okBtn = modalBtn('Save & End', 'primary');
    okBtn.setAttribute('data-snapshot-tool', 'end-ui');

    function dismiss() {
      w.__snapshotNoteUiOpen = false;
      if (root && root.parentNode) root.parentNode.removeChild(root);
    }

    function finish(name) {
      dismiss();
      finalizeEnd(name);
    }

    cancelBtn.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      dismiss();
    });
    skipBtn.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      finish('');
    });
    okBtn.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      finish(input.value.trim());
    });
    input.addEventListener('keydown', function (ev) {
      ev.stopPropagation();
      if (ev.key === 'Enter') {
        ev.preventDefault();
        finish(input.value.trim());
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        dismiss();
      }
    });

    row.appendChild(cancelBtn);
    row.appendChild(skipBtn);
    row.appendChild(okBtn);
    body.appendChild(title);
    body.appendChild(hint);
    body.appendChild(input);
    panel.appendChild(body);
    panel.appendChild(row);
    root.appendChild(panel);
    (document.documentElement || document.body).appendChild(root);
    setTimeout(function () {
      try {
        input.focus();
      } catch (e) {}
    }, 30);
  };

  /* ---------- Toolbar ---------- */
  w.__snapshotEnsureToolbar = function () {
    if (document.getElementById('__snapshot_toolbar_root')) return;
    if (w.__snapshotNoteUiOpen) return;
    var host = document.documentElement || document.body;
    if (!host) return;

    var pos = 'right';
    try {
      var saved = sessionStorage.getItem('__ps_toolbar_pos');
      if (saved === 'left' || saved === 'middle' || saved === 'right') pos = saved;
      else if (
        w.__snapshotToolbarPosition === 'left' ||
        w.__snapshotToolbarPosition === 'middle' ||
        w.__snapshotToolbarPosition === 'right'
      ) {
        pos = w.__snapshotToolbarPosition;
      }
    } catch (e) {
      if (
        w.__snapshotToolbarPosition === 'left' ||
        w.__snapshotToolbarPosition === 'middle' ||
        w.__snapshotToolbarPosition === 'right'
      ) {
        pos = w.__snapshotToolbarPosition;
      }
    }
    w.__snapshotToolbarPosition = pos;

    // Restore minimize state (session-scoped)
    var collapsed = !!w.__snapshotToolbarCollapsed;
    try {
      if (sessionStorage.getItem('__ps_toolbar_collapsed') === '1') collapsed = true;
      if (sessionStorage.getItem('__ps_toolbar_collapsed') === '0') collapsed = false;
    } catch (e) {}
    w.__snapshotToolbarCollapsed = collapsed;

    var dockCss =
      pos === 'left'
        ? 'left:16px;right:auto;bottom:16px;transform:none;'
        : pos === 'middle'
          ? 'left:50%;right:auto;bottom:16px;transform:translateX(-50%);'
          : 'right:16px;left:auto;bottom:16px;transform:none;';

    // Minimized chrome: small pill with expand + dock (and quick capture)
    if (collapsed) {
      var mini = document.createElement('div');
      mini.id = '__snapshot_toolbar_root';
      mini.setAttribute('data-snapshot-tool', 'toolbar');
      mini.setAttribute('data-toolbar-position', pos);
      mini.setAttribute('data-toolbar-collapsed', '1');
      mini.style.cssText = [
        'all: initial',
        'position: fixed',
        dockCss,
        'z-index: 2147483646',
        'display: inline-flex',
        'flex-direction: row',
        'align-items: center',
        'gap: 2px',
        'padding: 6px',
        'border-radius: ' + C.radiusLg,
        'background: ' + C.bg,
        'border: 1px solid ' + C.borderSubtle,
        'box-shadow: ' + C.shadowLg,
        'font-family: ' + C.font,
        'color: ' + C.textPrimary,
        'box-sizing: border-box'
      ].join(';');

      var expandBtn = headerIconBtn(ICONS.expand, 'Expand toolbar');
      expandBtn.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        w.__snapshotToolbarCollapsed = false;
        try {
          sessionStorage.setItem('__ps_toolbar_collapsed', '0');
        } catch (e) {}
        mini.remove();
        w.__snapshotEnsureToolbar();
      });

      var miniCapture = headerIconBtn(ICONS.capture, 'Capture');
      miniCapture.style.background = C.interactive;
      miniCapture.style.color = C.interactiveFg;
      miniCapture.addEventListener('mouseenter', function () {
        miniCapture.style.background = C.interactiveHover;
        miniCapture.style.color = C.interactiveFg;
      });
      miniCapture.addEventListener('mouseleave', function () {
        miniCapture.style.background = C.interactive;
        miniCapture.style.color = C.interactiveFg;
      });
      miniCapture.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        w.__snapshotNote = '';
        fireCapture('');
      });

      var miniNote = headerIconBtn(ICONS.note, 'Note');
      miniNote.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        w.__snapshotShowNoteUi();
      });

      var miniEnd = headerIconBtn(ICONS.end, 'End');
      miniEnd.style.background = C.danger;
      miniEnd.style.color = '#fafafa';
      miniEnd.addEventListener('mouseenter', function () {
        miniEnd.style.background = C.dangerHover;
        miniEnd.style.color = '#fafafa';
      });
      miniEnd.addEventListener('mouseleave', function () {
        miniEnd.style.background = C.danger;
        miniEnd.style.color = '#fafafa';
      });
      miniEnd.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        w.__snapshotShowEndNameUi();
      });

      var miniMove = headerIconBtn(ICONS.dock, 'Move toolbar (left / middle / right)');
      miniMove.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        var order = ['left', 'middle', 'right'];
        var cur = w.__snapshotToolbarPosition || 'right';
        var idx = order.indexOf(cur);
        var next = order[(idx + 1) % order.length];
        w.__snapshotToolbarPosition = next;
        try {
          sessionStorage.setItem('__ps_toolbar_pos', next);
        } catch (e) {}
        mini.remove();
        w.__snapshotEnsureToolbar();
      });

      // Full action set while minimized: Capture · Note · End · Expand · Move
      mini.appendChild(miniCapture);
      mini.appendChild(miniNote);
      mini.appendChild(miniEnd);
      mini.appendChild(expandBtn);
      mini.appendChild(miniMove);
      host.appendChild(mini);
      return;
    }

    var bar = document.createElement('div');
    bar.id = '__snapshot_toolbar_root';
    bar.setAttribute('data-snapshot-tool', 'toolbar');
    bar.setAttribute('data-toolbar-position', pos);
    bar.style.cssText = [
      'all: initial',
      'position: fixed',
      dockCss,
      'z-index: 2147483646',
      'display: flex',
      'flex-direction: column',
      'gap: 4px',
      'padding: 12px',
      'border-radius: ' + C.radiusLg,
      'background: ' + C.bg,
      'border: 1px solid ' + C.borderSubtle,
      'box-shadow: ' + C.shadowLg,
      'font-family: ' + C.font,
      'color: ' + C.textPrimary,
      'width: 220px',
      'box-sizing: border-box',
      'overflow: hidden'
    ].join(';');

    var header = document.createElement('div');
    header.setAttribute('data-snapshot-tool', 'toolbar');
    header.style.cssText =
      'display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 2px 8px;';

    var brand = document.createElement('div');
    brand.setAttribute('data-snapshot-tool', 'toolbar');
    brand.style.cssText = 'display:flex;flex-direction:column;gap:2px;min-width:0;';

    var title = document.createElement('div');
    title.setAttribute('data-snapshot-tool', 'toolbar');
    title.textContent = 'Snapshot';
    title.style.cssText =
      'font-size:12px;font-weight:500;letter-spacing:0.02em;color:' +
      C.textSecondary +
      ';font-family:' +
      C.font +
      ';';

    var status = document.createElement('div');
    status.setAttribute('data-snapshot-tool', 'toolbar');
    status.innerHTML =
      '<span style="display:inline-block;width:8px;height:8px;border-radius:999px;background:' +
      C.supportSuccess +
      ';margin-right:6px;vertical-align:middle"></span>Ready';
    status.style.cssText =
      'font-size:14px;font-weight:500;color:' + C.textPrimary + ';line-height:1.25;font-family:' + C.font + ';';

    brand.appendChild(title);
    brand.appendChild(status);

    // Header utility cluster: minimize (reduce) + dock/move
    var headerBtns = document.createElement('div');
    headerBtns.setAttribute('data-snapshot-tool', 'toolbar');
    headerBtns.style.cssText = 'display:inline-flex;align-items:center;gap:6px;flex-shrink:0;';

    var minimizeBtn = headerIconBtn(ICONS.minimize, 'Minimize toolbar');
    minimizeBtn.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      w.__snapshotToolbarCollapsed = true;
      try {
        sessionStorage.setItem('__ps_toolbar_collapsed', '1');
      } catch (e) {}
      var ex = document.getElementById('__snapshot_toolbar_root');
      if (ex) ex.remove();
      w.__snapshotEnsureToolbar();
    });

    var moveBtn = headerIconBtn(ICONS.dock, 'Move toolbar (left / middle / right)');
    moveBtn.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      var order = ['left', 'middle', 'right'];
      var cur = w.__snapshotToolbarPosition || 'right';
      var idx = order.indexOf(cur);
      var next = order[(idx + 1) % order.length];
      w.__snapshotToolbarPosition = next;
      try {
        sessionStorage.setItem('__ps_toolbar_pos', next);
      } catch (e) {}
      var ex = document.getElementById('__snapshot_toolbar_root');
      if (ex) ex.remove();
      w.__snapshotEnsureToolbar();
    });

    headerBtns.appendChild(minimizeBtn);
    headerBtns.appendChild(moveBtn);
    header.appendChild(brand);
    header.appendChild(headerBtns);

    function mkAction(spec) {
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('data-snapshot-tool', 'toolbar');
      b.setAttribute('aria-label', spec.label);
      b.title = spec.label;

      var palette;
      if (spec.kind === 'primary') {
        // shadcn dark primary: light fill on dark card
        palette = {
          bg: C.interactive,
          color: C.interactiveFg,
          hoverBg: C.interactiveHover
        };
      } else if (spec.kind === 'danger') {
        palette = {
          bg: C.danger,
          color: '#fafafa',
          hoverBg: C.dangerHover
        };
      } else {
        // outline-ish secondary on dark
        palette = {
          bg: 'transparent',
          color: C.textPrimary,
          hoverBg: C.layer02,
          border: C.borderStrong
        };
      }

      b.style.cssText = [
        'all: initial',
        'box-sizing: border-box',
        'font-family: ' + C.font,
        'display: flex',
        'align-items: center',
        'gap: 10px',
        'width: 100%',
        'min-height: 40px',
        'padding: 8px 12px',
        'border-radius: ' + C.radius,
        'border: 1px solid ' + (palette.border || 'transparent'),
        'background: ' + palette.bg,
        'color: ' + palette.color,
        'cursor: pointer',
        'text-align: left',
        'transition: background 0.15s ease'
      ].join(';');

      var icon = document.createElement('span');
      icon.setAttribute('data-snapshot-tool', 'toolbar');
      icon.setAttribute('aria-hidden', 'true');
      // Phosphor fill SVG (string) or plain text fallback
      if (spec.icon && spec.icon.charAt(0) === '<') {
        icon.innerHTML = spec.icon;
      } else {
        icon.textContent = spec.icon || '';
      }
      icon.style.cssText =
        'display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;flex-shrink:0;line-height:0;color:inherit;';

      var textCol = document.createElement('span');
      textCol.setAttribute('data-snapshot-tool', 'toolbar');
      textCol.style.cssText =
        'display:flex;flex-direction:column;gap:0;min-width:0;flex:1;';

      var label = document.createElement('span');
      label.setAttribute('data-snapshot-tool', 'toolbar');
      label.textContent = spec.label;
      label.style.cssText =
        'font-size:14px;font-weight:500;line-height:1.25;';

      textCol.appendChild(label);
      // Shortcut hint text removed — hotkeys still work; keep chrome clean
      b.appendChild(icon);
      b.appendChild(textCol);

      b.addEventListener('mouseenter', function () {
        b.style.background = palette.hoverBg;
      });
      b.addEventListener('mouseleave', function () {
        b.style.background = palette.bg;
      });
      b.addEventListener('focus', function () {
        b.style.outline = '2px solid ' + C.textPrimary;
        b.style.outlineOffset = '2px';
      });
      b.addEventListener('blur', function () {
        b.style.outline = 'none';
      });
      b.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        if (spec.kind === 'primary') {
          status.innerHTML =
            '<span style="display:inline-block;width:8px;height:8px;border-radius:999px;background:' +
            C.interactive +
            ';margin-right:6px;vertical-align:middle"></span>Capturing…';
          setTimeout(function () {
            if (document.getElementById('__snapshot_toolbar_root')) {
              status.innerHTML =
                '<span style="display:inline-block;width:8px;height:8px;border-radius:999px;background:' +
                C.supportSuccess +
                ';margin-right:6px;vertical-align:middle"></span>Ready';
            }
          }, 900);
        }
        spec.onClick();
      });
      return b;
    }

    var actions = document.createElement('div');
    actions.setAttribute('data-snapshot-tool', 'toolbar');
    actions.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
    actions.appendChild(
      mkAction({
        label: 'Capture',
        icon: ICONS.capture,
        kind: 'primary',
        onClick: function () {
          w.__snapshotNote = '';
          fireCapture('');
        }
      })
    );
    actions.appendChild(
      mkAction({
        label: 'Note',
        icon: ICONS.note,
        kind: 'secondary',
        onClick: function () {
          w.__snapshotShowNoteUi();
        }
      })
    );
    actions.appendChild(
      mkAction({
        label: 'End',
        icon: ICONS.end,
        kind: 'danger',
        onClick: function () {
          w.__snapshotShowEndNameUi();
        }
      })
    );

    var tip = document.createElement('div');
    tip.setAttribute('data-snapshot-tool', 'toolbar');
    tip.textContent = 'Dock: ' + pos;
    tip.style.cssText =
      'font-size:12px;color:' +
      C.textHelper +
      ';text-align:left;padding:4px 4px 0;font-family:' +
      C.font +
      ';';

    bar.appendChild(header);
    bar.appendChild(actions);
    bar.appendChild(tip);
    host.appendChild(bar);
  };

  if (!w.__snapshotInit) {
    w.__snapshotInit = true;
    w.__snapshotCapture = false;
    w.__snapshotEnd = false;
    w.__snapshotNote = '';
    w.__snapshotSessionName = '';
    w.__snapshotNoteUiOpen = false;

    document.addEventListener(
      'keydown',
      function (e) {
        if (w.__snapshotNoteUiOpen) return;

        if ((e.ctrlKey || e.metaKey) && (e.key === 'q' || e.key === 'Q')) {
          e.preventDefault();
          e.stopPropagation();
          w.__snapshotShowEndNameUi();
          return;
        }

        if ((e.ctrlKey || e.metaKey) && (e.key === 'm' || e.key === 'M')) {
          e.preventDefault();
          e.stopPropagation();
          if (e.shiftKey) w.__snapshotShowNoteUi();
          else {
            w.__snapshotNote = '';
            fireCapture('');
          }
        }
      },
      true
    );
  }

  w.__snapshotEnsureToolbar();
  if (!w.__snapshotToolbarTimer) {
    w.__snapshotToolbarTimer = setInterval(function () {
      try {
        w.__snapshotEnsureToolbar();
      } catch (e) {}
    }, 1000);
  }
})();
