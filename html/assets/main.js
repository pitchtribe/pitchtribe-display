(() => {
  "use strict";

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---- Labels set from script, in the page's language ---- */
  const lang = (document.documentElement.lang || "en").slice(0, 2);
  const L = {
    en: ["Copy", "Copied!", "Selected", "Install command copied to clipboard"],
    fr: ["Copier", "Copié !", "Sélectionné", "Commande d’installation copiée dans le presse-papiers"],
    es: ["Copiar", "¡Copiado!", "Seleccionado", "Comando de instalación copiado al portapapeles"],
    de: ["Kopieren", "Kopiert!", "Markiert", "Installationsbefehl in die Zwischenablage kopiert"],
    it: ["Copia", "Copiato!", "Selezionato", "Comando di installazione copiato negli appunti"],
    pt: ["Copiar", "Copiado!", "Selecionado", "Comando de instalação copiado para a área de transferência"],
    pl: ["Kopiuj", "Skopiowano!", "Zaznaczono", "Polecenie instalacji skopiowane do schowka"],
    ru: ["Копировать", "Скопировано!", "Выделено", "Команда установки скопирована в буфер обмена"],
    zh: ["复制", "已复制！", "已选中", "安装命令已复制到剪贴板"],
    ja: ["コピー", "コピーしました", "選択しました", "インストールコマンドをクリップボードにコピーしました"],
  }[lang] || ["Copy", "Copied!", "Selected", "Install command copied to clipboard"];
  const [COPY, COPIED, SELECTED, COPIED_STATUS] = L;
  const locale = { en: "en-GB", pt: "pt-PT", zh: "zh-CN" }[lang] || lang;

  /* ---- Mobile navigation ---- */
  const toggle = document.getElementById("nav-toggle");
  const nav = document.getElementById("primary-nav");
  if (toggle && nav) {
    const setOpen = (open) => {
      nav.classList.toggle("is-open", open);
      toggle.setAttribute("aria-expanded", String(open));
    };
    toggle.addEventListener("click", () => setOpen(!nav.classList.contains("is-open")));
    nav.addEventListener("click", (e) => {
      if (e.target.closest("a")) setOpen(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && nav.classList.contains("is-open")) {
        setOpen(false);
        toggle.focus();
      }
    });
  }

  /* ---- Live clock in the display mockup ---- */
  const clock = document.querySelector("[data-clock]");
  if (clock) {
    const tick = () => {
      clock.textContent = new Date().toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
    };
    tick();
    setInterval(tick, 10_000);
  }

  /* ---- Display mockup tabs (auto-rotating until the user interacts) ---- */
  const tabs = Array.from(document.querySelectorAll(".scr-tab"));
  let current = 0;
  const show = (i, focus = false) => {
    current = (i + tabs.length) % tabs.length;
    tabs.forEach((tab, n) => {
      const on = n === current;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      document.getElementById(tab.getAttribute("aria-controls"))?.classList.toggle("is-active", on);
    });
    if (focus) tabs[current].focus();
  };

  let rotator = null;
  const stopRotation = () => {
    if (rotator) clearInterval(rotator);
    rotator = null;
  };
  if (tabs.length && !reduceMotion) {
    rotator = setInterval(() => show(current + 1), 4000);
  }

  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => {
      stopRotation();
      show(i);
    });
    tab.addEventListener("keydown", (e) => {
      const moves = { ArrowRight: current + 1, ArrowLeft: current - 1, Home: 0, End: tabs.length - 1 };
      if (e.key in moves) {
        e.preventDefault();
        stopRotation();
        show(moves[e.key], true);
      }
    });
  });

  /* ---- Copy install command ---- */
  const copyBtn = document.getElementById("copy-btn");
  const cmd = document.getElementById("install-cmd");
  const status = document.getElementById("copy-status");
  if (copyBtn && cmd) {
    const flash = (label) => {
      copyBtn.textContent = label;
      if (status) status.textContent = label === COPIED ? COPIED_STATUS : "";
      setTimeout(() => { copyBtn.textContent = COPY; }, 2000);
    };
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(cmd.textContent.trim());
        flash(COPIED);
      } catch {
        const range = document.createRange();
        range.selectNodeContents(cmd);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        flash(SELECTED);
      }
    });
  }

  /* ---- Copy buttons on docs code blocks (<pre data-copy>) ---- */
  document.querySelectorAll("pre[data-copy]").forEach((pre) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy-btn";
    btn.textContent = COPY;
    pre.classList.add("has-copy");
    pre.append(btn);
    btn.addEventListener("click", async () => {
      const text = pre.querySelector("code")?.textContent ?? pre.firstChild?.textContent ?? "";
      try {
        await navigator.clipboard.writeText(text.trim());
        btn.textContent = COPIED;
      } catch {
        const range = document.createRange();
        range.selectNodeContents(pre.querySelector("code") || pre);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        btn.textContent = SELECTED;
      }
      setTimeout(() => { btn.textContent = COPY; }, 2000);
    });
  });

  /* ---- Amazon quick-buy basket (/buy) ----
     Rebuilds the basket link from whatever is ticked. The href in the HTML
     already covers the default five, so with JS off the button still sends a
     complete basket — this only makes the list adjustable. Prices come from
     data-price and feed the running total only; the link carries ASINs. */
  const basket = document.getElementById("basket");
  const basketLink = document.getElementById("basket-link");
  if (basket && basketLink) {
    const ticks = Array.from(basket.querySelectorAll(".basket-tick[data-asin]"));
    const totalEl = basket.querySelector("[data-basket-total]");
    const countEl = basket.querySelector("[data-basket-count]");
    const update = () => {
      const picked = ticks.filter((t) => t.checked);
      const total = picked.reduce((sum, t) => sum + Number(t.dataset.price || 0), 0);
      if (countEl) countEl.textContent = String(picked.length);
      if (totalEl) totalEl.textContent = `£${total.toFixed(2)}`;
      // Amazon numbers the pairs from 1, and skipped indices drop the item.
      const query = picked
        .flatMap((t, i) => [`ASIN.${i + 1}=${t.dataset.asin}`, `Quantity.${i + 1}=1`])
        .join("&");
      basketLink.href = `https://www.amazon.co.uk/gp/aws/cart/add.html?${query}`;
      basketLink.setAttribute("aria-disabled", String(picked.length === 0));
    };
    ticks.forEach((t) => t.addEventListener("change", update));
    // An empty basket link would land on an Amazon error page, so block it.
    basketLink.addEventListener("click", (e) => {
      if (!ticks.some((t) => t.checked)) e.preventDefault();
    });
    update();
  }

  /* ---- Scroll reveal ---- */
  const revealEls = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window && !reduceMotion) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-in");
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1, rootMargin: "0px 0px -40px 0px" });
    revealEls.forEach((el) => io.observe(el));
  } else {
    revealEls.forEach((el) => el.classList.add("is-in"));
  }

  /* ---- Footer year ---- */
  const year = document.querySelector("[data-year]");
  if (year) year.textContent = String(new Date().getFullYear());
})();
