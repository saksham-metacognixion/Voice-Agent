/*
 * The website widget loader (D17, §11.5). Customers paste:
 *
 *   <script src="https://app.oraly.ai/widget.js" data-key="wk_…" async></script>
 *
 * It adds one iframe in the bottom corner of the page, pointing at /embed/?key= on the
 * origin this script came from. Everything else — the button, the microphone, the call —
 * happens inside that frame, so the host page's styles and scripts cannot reach it and
 * it cannot reach them. The frame tells this script how big it needs to be; nothing else
 * crosses between the two. Hand-written and dependency-free on purpose: it runs on pages
 * we do not control, and it should be small enough to read.
 */
(function () {
  'use strict';
  var script = document.currentScript;
  if (!script) return;
  var key = script.getAttribute('data-key');
  if (!key || !/^wk_[0-9a-f]{32}$/.test(key)) return;
  if (document.querySelector('iframe[data-oraly-widget="' + key + '"]')) return;

  var origin = new URL(script.src).origin;
  var side = script.getAttribute('data-position') === 'left' ? 'left' : 'right';

  function mount() {
    var frame = document.createElement('iframe');
    frame.src = origin + '/embed/?key=' + encodeURIComponent(key);
    frame.title = script.getAttribute('data-title') || 'Talk to us';
    frame.setAttribute('data-oraly-widget', key);
    frame.setAttribute('allow', 'microphone; autoplay');
    frame.setAttribute('allowtransparency', 'true');
    var style = frame.style;
    style.position = 'fixed';
    style.bottom = '12px';
    style[side] = '12px';
    style.width = '0';
    style.height = '0';
    style.border = '0';
    style.background = 'transparent';
    style.colorScheme = 'normal';
    style.zIndex = '2147483000';
    style.maxWidth = 'calc(100vw - 24px)';

    window.addEventListener('message', function (event) {
      if (event.source !== frame.contentWindow || event.origin !== origin) return;
      var data = event.data;
      if (!data || data.type !== 'oraly-widget:size') return;
      var width = Math.max(0, Math.min(400, Number(data.width) || 0));
      var height = Math.max(0, Math.min(400, Number(data.height) || 0));
      style.width = width + 'px';
      style.height = height + 'px';
    });
    document.body.appendChild(frame);
  }

  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
