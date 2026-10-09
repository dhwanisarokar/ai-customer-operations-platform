/*
 * Embeddable chat loader. Usage:
 *   <script src="https://YOUR-APP/widget.js" data-key="wk_..." async></script>
 *
 * It only draws a launcher button and an iframe that loads the chat from YOUR-APP. The chat itself
 * (and the visitor session) lives inside the iframe on the app's origin, so this script never sees
 * visitor tokens and the host page cannot read them. The key is public.
 */
(function () {
  var script = document.currentScript;
  if (!script || window.__aiOpsChatLoaded) return;
  var key = script.getAttribute("data-key");
  if (!key) return;
  window.__aiOpsChatLoaded = true;

  var appOrigin = new URL(script.src, location.href).origin;
  var color = script.getAttribute("data-color") || "#0f766e";
  var iframe = null;
  var open = false;

  var button = document.createElement("button");
  button.type = "button";
  button.setAttribute("aria-label", "Open chat");
  button.setAttribute("aria-expanded", "false");
  button.textContent = "💬";
  button.style.cssText =
    "position:fixed;right:20px;bottom:20px;z-index:2147483646;width:56px;height:56px;" +
    "border-radius:50%;border:0;cursor:pointer;font-size:24px;color:#fff;" +
    "box-shadow:0 4px 16px rgba(0,0,0,.25);background:" +
    color +
    ";";

  function layout() {
    if (!iframe) return;
    var narrow = window.innerWidth < 480;
    iframe.style.cssText =
      "position:fixed;z-index:2147483647;border:0;background:#fff;display:" +
      (open ? "block" : "none") +
      ";" +
      (narrow
        ? "inset:0;width:100%;height:100%;"
        : "right:20px;bottom:90px;width:380px;height:min(640px,calc(100vh - 110px));" +
          "border-radius:14px;box-shadow:0 8px 32px rgba(0,0,0,.3);");
  }

  function setOpen(next) {
    open = next;
    if (open && !iframe) {
      // The session starts only when the visitor opens the chat, not on every page view.
      iframe = document.createElement("iframe");
      iframe.title = "Chat";
      iframe.src =
        appOrigin +
        "/widget/" +
        encodeURIComponent(key) +
        "?embed=" +
        encodeURIComponent(location.origin);
      document.body.appendChild(iframe);
    }
    layout();
    button.setAttribute("aria-expanded", String(open));
    button.setAttribute("aria-label", open ? "Close chat" : "Open chat");
    // One control at a time: while the chat is open its own header has the close button.
    button.style.display = open ? "none" : "block";
  }

  button.addEventListener("click", function () {
    setOpen(!open);
  });
  window.addEventListener("resize", function () {
    layout();
    setOpen(open);
  });
  window.addEventListener("message", function (event) {
    // Only the chat iframe of our app may ask to close.
    if (event.origin !== appOrigin || !iframe || event.source !== iframe.contentWindow) return;
    if (event.data && event.data.type === "cw:close") setOpen(false);
  });

  function mount() {
    document.body.appendChild(button);
  }
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);
})();
