// Claude Browser: "Fill this form" for the window mode toolbar.
// Fills the visible fields of a form with realistic test data that passes the
// usual checks (phone numbers, IBANs with a valid checksum, Luhn-valid test card
// numbers, postal codes…), or with long text to test overflow, or clears them.
// English data with international formats by default; Persian data with Iranian
// formats (mobile, national ID, Sheba) on Persian pages.
// Values are set the way React and other frameworks notice (native setter,
// then input/change events). Exposes window.__cbFill(mode, scopeEl).
(() => {
  if (!window.__cbWindowMode || window.__cbFill) return;
  try {
    if (window.top !== window) return;
  } catch {
    return;
  }

  const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  const pick = list => list[rnd(0, list.length - 1)];
  const digits = n => Array.from({ length: n }, () => rnd(0, 9)).join("");

  const FA = {
    first: ["علی", "محمد", "حسین", "رضا", "مهدی", "امیر", "سارا", "زهرا", "مریم", "فاطمه", "نگار", "پریسا"],
    last: ["محمدی", "حسینی", "رضایی", "احمدی", "کریمی", "موسوی", "جعفری", "صادقی", "کاظمی", "رحیمی"],
    city: ["تهران", "اصفهان", "شیراز", "مشهد", "تبریز", "کرج"],
    province: ["تهران", "اصفهان", "فارس", "خراسان رضوی", "آذربایجان شرقی", "البرز"],
    street: ["خیابان ولیعصر، کوچه بهار، پلاک ۱۲", "خیابان انقلاب، نبش کوچه نسترن، پلاک ۴", "بلوار کشاورز، خیابان فلسطین، پلاک ۷"],
    company: "شرکت نمونه آزما",
    text: "متن آزمایشی",
    sentence: "این یک متن آزمایشی برای بررسی فرم است.",
    long: "این یک متن خیلی طولانی برای آزمایش نمایش فیلدها و شکستن خطوط در طرح‌بندی صفحه است ",
    longName: ["عبدالرضا محمدحسین", "سیدمحمدجواد میرعبدالوهابی‌نژاد"],
  };
  const EN = {
    first: ["Alex", "Sam", "Taylor", "Jordan", "Maya", "Daniel", "Sara", "Priya", "Lucas", "Yuki"],
    last: ["Smith", "Johnson", "Garcia", "Brown", "Lee", "Müller", "Silva", "Kim"],
    city: ["Berlin", "Toronto", "Austin", "Lisbon", "Melbourne"],
    province: ["Ontario", "Texas", "Bavaria", "Victoria"],
    street: ["221B Baker Street", "742 Evergreen Terrace", "12 Grimmauld Place"],
    company: "Example Labs Inc.",
    text: "Test value",
    sentence: "This is test text to check the form.",
    long: "This is a very long piece of text to test how fields and layouts handle wrapping and overflow ",
    longName: ["Bartholomew Maximilian", "Wolfeschlegelsteinhausenbergerdorff"],
  };

  const luhn = body => {
    let sum = 0;
    [...body].reverse().forEach((c, i) => {
      let n = Number(c);
      if (i % 2 === 0) {
        n *= 2;
        if (n > 9) n -= 9;
      }
      sum += n;
    });
    return body + ((10 - (sum % 10)) % 10);
  };
  // IBAN check digits (ISO 13616, mod 97) for a country code and a numeric BBAN.
  const iban = (cc, bban) => {
    const num = bban + [...cc].map(c => c.charCodeAt(0) - 55).join("") + "00";
    let r = 0;
    for (const c of num) r = (r * 10 + Number(c)) % 97;
    return cc + String(98 - r).padStart(2, "0") + bban;
  };

  // Number formats per locale. "en" is the international default.
  const FORMATS = {
    en: {
      mobile: () => "+1" + pick(["202", "312", "415", "512", "617", "718"]) + "555" + digits(4),
      // A German IBAN (22 characters) with valid check digits.
      iban: () => iban("DE", "37040044" + digits(10)),
      // Published test card numbers (Stripe, Adyen, Braintree… test modes accept them).
      card: () => pick(["4242424242424242", "5555555555554444", "4000056655665556", "5200828282828210"]),
      nationalId: () => `${rnd(100, 665)}-${rnd(10, 99)}-${rnd(1000, 9999)}`, // US SSN shape, never a reserved block
      companyId: () => `${rnd(10, 99)}-${digits(7)}`,
      postal: () => String(rnd(10000, 99999)),
      birth: "1990-05-12",
    },
    fa: {
      mobile: () => "09" + pick(["12", "13", "19", "35", "36", "37", "38", "39", "01", "02", "10", "90", "91", "21"]) + digits(7),
      // Sheba: IR + 2 check digits + 22 digits.
      iban: () => iban("IR", "0170000000" + digits(12)),
      card: () => luhn(pick(["603799", "589210", "627412", "610433"]) + digits(9)),
      // Iranian national ID: 9 digits and a check digit.
      nationalId: () => {
        let d;
        do d = digits(9);
        while (/^(\d)\1+$/.test(d));
        const s = [...d].reduce((a, c, i) => a + Number(c) * (10 - i), 0) % 11;
        return d + (s < 2 ? s : 11 - s);
      },
      companyId: () => digits(11),
      postal: () => rnd(1, 9) + digits(9),
      birth: "1370/05/12",
    },
  };

  // What a field is for, from everything that describes it.
  function describe(el) {
    const bits = [el.getAttribute("autocomplete"), el.name, el.id, el.getAttribute("placeholder"), el.getAttribute("aria-label"), el.getAttribute("data-testid")];
    try {
      if (el.labels) for (const l of el.labels) bits.push(l.textContent);
    } catch {}
    const lb = el.getAttribute("aria-labelledby");
    if (lb) for (const id of lb.split(/\s+/)) bits.push((document.getElementById(id) || {}).textContent);
    // A label right before the field in the same wrapper (common in UI kits).
    const prev = el.closest("label, div, fieldset");
    if (prev && !bits.some(Boolean)) bits.push((prev.querySelector("label, legend") || {}).textContent);
    return bits.filter(Boolean).join(" ").toLowerCase().replace(/[_\-]+/g, " ");
  }

  const KINDS = [
    ["otp", /otp|one.?time|verif|کد تایید|کد تأیید|رمز یکبار|کد ارسال|code$/],
    ["email", /e.?mail|ایمیل|پست الکترونیک/],
    ["iban", /sheba|iban|شبا/],
    ["card", /card.?(num|no)|cc.?num|شماره کارت|کارت/],
    ["companyId", /شناسه ملی|company.?(id|number)|\bein\b|vat/],
    ["nationalId", /national.?(id|number|code)|ssn|social.?security|tax.?id|melli|nid\b|کد ?ملی|کدملی/],
    ["postal", /postal|zip|کد ?پستی/],
    ["mobile", /mobile|phone|tel\b|cell|موبایل|تلفن|همراه|شماره تماس/],
    ["password", /password|passwd|رمز/],
    ["username", /user.?name|login|نام کاربری/],
    ["company", /company|organi[sz]ation|شرکت|سازمان/],
    ["last", /last.?name|family|surname|lname|نام خانوادگی/],
    ["full", /full.?name|نام و نام خانوادگی|نام کامل/],
    ["first", /first.?name|given|fname|father|نام پدر|^name$|\bname\b|نام/],
    ["birth", /birth|تولد/],
    ["amount", /amount|price|cost|مبلغ|قیمت|هزینه/],
    ["province", /province|state|region|استان/],
    ["city", /city|town|شهر/],
    ["address", /address|street|آدرس|نشانی/],
    ["url", /url|website|site|وب ?سایت/],
    ["age", /\bage\b|سن\b/],
  ];

  // Persian data on pages in Persian: lang="fa", or right-to-left with Persian text.
  const fa = () => {
    const lang = document.documentElement.lang || "";
    if (/^fa/i.test(lang)) return true;
    if (lang && !/^fa/i.test(lang)) return false;
    const rtl = (document.documentElement.dir || document.body?.dir || "").toLowerCase() === "rtl";
    return rtl && /[\u067E\u0686\u0698\u06AF\u06CC]/.test((document.body?.innerText || "").slice(0, 4000));
  };

  // The value for one field, or undefined to leave it.
  function valueFor(el, kind, mode, ctx) {
    const L = ctx.L;
    const F = ctx.F;
    const type = (el.type || "text").toLowerCase();
    const max = el.maxLength > 0 ? el.maxLength : 0;
    const long = mode === "long";
    const fit = v => (max ? String(v).slice(0, max) : String(v));
    const longText = () => fit(L.long.repeat(6).trim());
    if (type === "date") return "1990-05-12";
    if (type === "datetime-local") return "2025-05-12T10:30";
    if (type === "time") return "10:30";
    if (type === "month") return "2025-05";
    if (type === "week") return "2025-W20";
    if (type === "color") return undefined;
    if (type === "range" || type === "number") {
      const lo = el.min !== "" ? Number(el.min) : null;
      const hi = el.max !== "" ? Number(el.max) : null;
      let v = kind === "amount" ? (long ? 999999999 : 150000) : kind === "age" ? 30 : long ? 99999999 : rnd(1, 99);
      if (type === "range") v = lo != null && hi != null ? (lo + hi) / 2 : 50;
      if (lo != null) v = Math.max(lo, v);
      if (hi != null) v = Math.min(hi, v);
      const step = Number(el.step) || 1;
      if (el.step !== "any") v = (lo || 0) + Math.round((v - (lo || 0)) / step) * step;
      return String(v);
    }
    if (type === "password") return ctx.password;
    if (type === "email" || kind === "email") return fit(long ? `${"very.long.test.address." + ctx.latin}${rnd(100, 999)}@example-company-with-a-long-name.com` : `test.${ctx.latin}${rnd(100, 999)}@example.com`);
    if (type === "tel" || kind === "mobile") {
      const m = F.mobile();
      if (max && m.length > max) return m.replace(/^\+\d|^0/, "").slice(-max);
      return m;
    }
    if (type === "url" || kind === "url") return "https://example.com";
    switch (kind) {
      case "otp":
        return digits(max && max <= 8 ? max : 6);
      case "iban": {
        const v = F.iban();
        return max && max < v.length ? v.slice(2, 2 + max) : v; // a field for the part after the country code
      }
      case "card": {
        const v = F.card();
        return max && max < v.length ? v.slice(0, max) : v;
      }
      case "nationalId":
        return fit(F.nationalId());
      case "companyId":
        return fit(F.companyId());
      case "postal":
        return fit(F.postal());
      case "username":
        return fit(long ? "a_very_long_username_for_testing_" + ctx.latin : `${ctx.latin}${rnd(10, 99)}`);
      case "company":
        return long ? longText() : fit(L.company);
      case "last":
        return fit(long ? L.longName[1] : ctx.last);
      case "full":
        return fit(long ? L.longName.join(" ") : `${ctx.first} ${ctx.last}`);
      case "first":
        return fit(long ? L.longName[0] : ctx.first);
      case "birth":
        return F.birth;
      case "amount":
        return fit(long ? "999999999" : "150000");
      case "age":
        return "30";
      case "province":
        return fit(pick(L.province));
      case "city":
        return fit(pick(L.city));
      case "address":
        return long ? longText() : fit(pick(L.street));
    }
    if (el instanceof HTMLTextAreaElement) return long ? longText() : fit(L.sentence);
    // A pattern like \d{10}: digits of the right length.
    const pat = el.getAttribute("pattern");
    if (pat && /^\\d|\[0-9\]/.test(pat)) {
      const n = Number((pat.match(/\{(\d+)/) || [])[1]) || max || 6;
      return digits(n);
    }
    if (el.inputMode === "numeric" || el.inputMode === "decimal") return digits(max && max < 10 ? max : 6);
    return long ? longText() : fit(L.text);
  }

  function setNative(el, value) {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function touch(el) {
    // Forms that validate on blur get to see the field once.
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    el.dispatchEvent(new FocusEvent("blur"));
  }

  const visible = el => {
    if (!el.isConnected || el.disabled || el.readOnly) return false;
    if (el.type === "hidden") return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) {
      // Custom checkboxes/radios hide the real input: fill it if its label shows.
      if ((el.type === "checkbox" || el.type === "radio") && el.labels && [...el.labels].some(l => l.getBoundingClientRect().width > 0)) return true;
      return false;
    }
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  };

  // The fields to fill: the form of the field used last, else the form with
  // the most visible fields, else every visible field on the page.
  function scopeFields(scope) {
    const sel = "input, textarea, select";
    const fieldsIn = root => [...root.querySelectorAll(sel)].filter(visible).filter(el => !/^(submit|button|reset|image|file|search)$/i.test(el.type || ""));
    if (scope && scope.isConnected) {
      const form = scope.closest("form, [role=form], dialog, [role=dialog]");
      if (form && fieldsIn(form).length) return fieldsIn(form);
    }
    let best = null;
    let most = 0;
    for (const f of document.querySelectorAll("form, [role=form], dialog[open], [role=dialog]")) {
      const n = fieldsIn(f).length;
      if (n > most) {
        best = f;
        most = n;
      }
    }
    return best ? fieldsIn(best) : fieldsIn(document);
  }

  window.__cbFill = (mode, scope) => {
    const fields = scopeFields(scope);
    const isFa = fa();
    const L = isFa ? FA : EN;
    const enFirst = pick(EN.first);
    const ctx = { L, F: isFa ? FORMATS.fa : FORMATS.en, first: pick(L.first), last: pick(L.last), latin: enFirst.toLowerCase().normalize("NFD").replace(/[^a-z]/g, ""), password: "Test@12345" };
    let n = 0;
    const radios = new Set();
    let boxes = 0;
    fields.forEach((el, i) => {
      const type = (el.type || "").toLowerCase();
      try {
        if (type === "checkbox") {
          const want = mode !== "clear"; // every box ticked: terms, opt-ins, all of it
          if (el.checked !== want) {
            el.click();
            n++;
          }
          return;
        }
        if (type === "radio") {
          if (mode === "clear") {
            if (el.checked) {
              el.checked = false;
              el.dispatchEvent(new Event("change", { bubbles: true }));
              n++;
            }
            return;
          }
          const group = el.name || el.closest("[role=radiogroup]") || el;
          if (radios.has(group)) return;
          radios.add(group);
          const all = el.name ? fields.filter(f => f.type === "radio" && f.name === el.name) : [el];
          if (!all.some(r => r.checked)) {
            all[0].click();
            n++;
          }
          return;
        }
        if (el instanceof HTMLSelectElement) {
          const opts = [...el.options].filter(o => !o.disabled && o.value !== "");
          const v = mode === "clear" ? (el.options[0] ? el.options[0].value : "") : opts.length ? pick(opts).value : undefined;
          if (v !== undefined && el.value !== v) {
            setNative(el, v);
            n++;
          }
          return;
        }
        // One-digit boxes in a row: a split code input.
        if (el.maxLength === 1 && mode !== "clear") {
          setNative(el, String((boxes++ % 9) + 1));
          touch(el);
          n++;
          return;
        }
        const kind = (KINDS.find(([, re]) => re.test(describe(el))) || [])[0] || "";
        const v = mode === "clear" ? "" : valueFor(el, kind, mode, ctx);
        if (v === undefined) return;
        setNative(el, v);
        if (mode !== "clear") touch(el);
        n++;
      } catch {}
    });
    return { filled: n, total: fields.length };
  };
})();
