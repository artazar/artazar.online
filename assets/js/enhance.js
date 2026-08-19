/* Progressive enhancements for post content:
   - copy-to-clipboard buttons on code blocks
   - language labels derived from Chroma's generated classes
   - horizontal scroll containers around wide tables
   Everything degrades to plain content if JS is unavailable. */
(function () {
  "use strict";

  var COPY_RESET_MS = 1600;

  function languageOf(highlight) {
    // Chroma emits `language-yaml` on the inner <code> when
    // pygmentsCodeFences is on; fall back to scanning class names.
    var code = highlight.querySelector("code");
    if (!code) return "";

    var match = /(?:^|\s)language-([\w+#-]+)/.exec(code.className || "");
    if (match) return match[1];

    var dataLang = code.getAttribute("data-lang");
    return dataLang || "";
  }

  function copyText(highlight) {
    var code = highlight.querySelector("code");
    return code ? code.innerText.replace(/\n$/, "") : "";
  }

  function addCopyButton(highlight) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "copy-code";
    button.textContent = "copy";
    button.setAttribute("aria-label", "Copy code to clipboard");

    button.addEventListener("click", function () {
      var text = copyText(highlight);
      if (!text) return;

      var done = function () {
        button.textContent = "copied";
        button.setAttribute("data-copied", "true");
        window.setTimeout(function () {
          button.textContent = "copy";
          button.removeAttribute("data-copied");
        }, COPY_RESET_MS);
      };

      var fail = function () {
        button.textContent = "failed";
        window.setTimeout(function () {
          button.textContent = "copy";
        }, COPY_RESET_MS);
      };

      // navigator.clipboard needs a secure context; fall back for plain HTTP.
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(done, fail);
        return;
      }

      var scratch = document.createElement("textarea");
      scratch.value = text;
      scratch.setAttribute("readonly", "");
      scratch.style.position = "absolute";
      scratch.style.left = "-9999px";
      document.body.appendChild(scratch);
      scratch.select();

      try {
        document.execCommand("copy") ? done() : fail();
      } catch (e) {
        fail();
      } finally {
        document.body.removeChild(scratch);
      }
    });

    highlight.appendChild(button);
  }

  function wrapTable(table) {
    if (table.parentNode.classList.contains("table-wrap")) return;
    var wrap = document.createElement("div");
    wrap.className = "table-wrap";
    table.parentNode.insertBefore(wrap, table);
    wrap.appendChild(table);
  }

  document.addEventListener("DOMContentLoaded", function () {
    var content = document.querySelector(".post-content");
    if (!content) return;

    var blocks = content.querySelectorAll(".highlight");
    for (var i = 0; i < blocks.length; i++) {
      blocks[i].setAttribute("data-lang", languageOf(blocks[i]));
      addCopyButton(blocks[i]);
    }

    var tables = content.querySelectorAll("table");
    for (var j = 0; j < tables.length; j++) {
      wrapTable(tables[j]);
    }
  });
})();
