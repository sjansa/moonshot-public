// haptic.js -- one short tick for slider stops. Best effort, never throws.
// Native shell: the Capacitor Haptics plugin. Android browsers: navigator.vibrate.
// iOS Safari has no vibrate; toggling a hidden "switch" checkbox gives the system tick (iOS 17.4+).

let sw = null, last = 0;

function iosSwitch() {
  if (sw) return sw;
  const label = document.createElement('label');
  label.setAttribute('aria-hidden', 'true');
  label.style.cssText = 'position:fixed;left:-99px;top:-99px;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none';
  const input = document.createElement('input');
  input.type = 'checkbox'; input.setAttribute('switch', ''); input.tabIndex = -1;
  label.appendChild(input);
  document.body.appendChild(label);
  return (sw = label);
}

/** A light tick. Calls closer together than 25 ms are dropped. */
export function tick() {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (now - last < 25) return;
  last = now;
  try {
    const H = window.Capacitor?.Plugins?.Haptics;
    if (H) { (H.selectionChanged ? H.selectionChanged() : H.impact({ style: 'LIGHT' }))?.catch?.(() => {}); return; }
    if (navigator.vibrate) { navigator.vibrate(8); return; }
    iosSwitch().click();
  } catch { /* no haptics here */ }
}
