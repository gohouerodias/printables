// Общий код трёх приложений: сохранение данных, бесплатные лимиты, окно «нужна подписка».
(function () {
  function PrintApp(slug) {
    this.slug = slug;
    this.timer = null;
    this.statusEl = null;
    this.q = null; // состояние лимитов с сервера
    this.getCount = null; // для «Родословной»: сколько людей сейчас в древе
    // По умолчанию печать заблокирована (закрыто, пока сервер не подтвердит подписку или разрешённый лимит)
    if (document.body) document.body.classList.add('locked');
  }

  function loginUrl(slug) {
    return '/login.html?next=' + encodeURIComponent('/app/' + slug);
  }

  // ---------- сохранение данных ----------
  PrintApp.prototype.load = async function () {
    try {
      var r = await fetch('/api/data/' + this.slug);
      if (r.status === 401) { location.href = loginUrl(this.slug); return null; }
      return await r.json();
    } catch (e) {
      return null;
    }
  };

  // Сохранение с задержкой 800 мс после последнего изменения
  PrintApp.prototype.save = function (data) {
    var self = this;
    clearTimeout(this.timer);
    this.setStatus('Сохранение…');
    this.timer = setTimeout(async function () {
      try {
        var r = await fetch('/api/data/' + self.slug, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        if (r.status === 402) {
          var d = await r.json().catch(function () { return {}; });
          self.setStatus('Лимит бесплатной версии');
          self.showPaywall(d.error);
          return;
        }
        self.setStatus(r.ok ? 'Сохранено' : 'Не удалось сохранить');
      } catch (e) {
        self.setStatus('Нет связи — не сохранено');
      }
    }, 800);
  };

  PrintApp.prototype.setStatus = function (text) {
    if (!this.statusEl) this.statusEl = document.getElementById('saveStatus');
    if (this.statusEl) this.statusEl.textContent = text;
  };

  // ---------- бесплатные лимиты ----------
  PrintApp.prototype.quota = async function () {
    try {
      var r = await fetch('/api/quota/' + this.slug);
      if (r.status === 401) { location.href = loginUrl(this.slug); return null; }
      this.q = await r.json();
    } catch (e) {
      this.q = null;
    }
    this.render();
    this.updateLock();
    return this.q;
  };

  // Можно ли печатать «мимо кнопки» (Ctrl+P)? Только с подпиской или в рамках лимита по людям.
  PrintApp.prototype.updateLock = function () {
    var q = this.q;
    var locked = true;
    if (q && q.subscribed) locked = false;
    else if (q && q.kind === 'people' && this.getCount && this.getCount() <= q.limit) locked = false;
    document.body.classList.toggle('locked', locked);
    this.render();
  };

  PrintApp.prototype.render = function () {
    var q = this.q;
    var bar = document.getElementById('quotaBar');
    if (!q || q.subscribed) { if (bar) bar.remove(); return; }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'quotaBar';
      bar.className = 'quotabar';
      var top = document.querySelector('.bar');
      if (top && top.parentNode) top.parentNode.insertBefore(bar, top.nextSibling);
      else document.body.insertBefore(bar, document.body.firstChild);
    }
    var text;
    if (q.kind === 'people') {
      var n = this.getCount ? this.getCount() : q.used;
      text = 'Бесплатная версия: до ' + q.limit + ' человек в древе (сейчас ' + n + ').';
    } else {
      var unit = q.limit === 1 ? q.forms[1] : q.forms[2];
      text = 'Бесплатная версия: осталось ' + q.remaining + ' из ' + q.limit + ' ' + unit +
        ' для печати. Печатайте кнопкой «Печать / PDF».';
    }
    bar.innerHTML = '<span class="qtext"></span><a class="qbtn" href="#">Оформить подписку</a>';
    bar.querySelector('.qtext').textContent = text;
    bar.querySelector('.qbtn').href = '/account.html?upgrade=' + encodeURIComponent(this.slug);
  };

  PrintApp.prototype.overLimit = function (n) {
    var q = this.q;
    return !!(q && !q.subscribed && q.kind === 'people' && n > q.limit);
  };

  PrintApp.prototype.limitMessage = function () {
    return 'В бесплатной версии — до ' + (this.q ? this.q.limit : 5) + ' человек в древе.';
  };

  // ---------- окна ----------
  PrintApp.prototype.showDialog = function (title, msg, withBuy) {
    var old = document.getElementById('paywall');
    if (old) old.remove();
    var m = document.createElement('div');
    m.id = 'paywall';
    m.className = 'paywall';
    m.innerHTML = '<div class="pwin" role="dialog" aria-modal="true"><div class="ptitle"></div><div class="pbody">' +
      '<p class="pmsg"></p><p class="pprice"></p><div class="prow"><a class="pbuy" href="#">Оформить подписку</a>' +
      '<button type="button" class="pclose">Закрыть</button></div></div></div>';
    m.querySelector('.ptitle').textContent = title;
    m.querySelector('.pmsg').textContent = msg;
    var price = this.q && this.q.price;
    m.querySelector('.pprice').textContent = withBuy
      ? 'Подписка' + (price ? ' — ' + price + ' ₽ в месяц' : '') + ', без ограничений. Автопродление можно отключить в любой момент.'
      : '';
    var buy = m.querySelector('.pbuy');
    if (withBuy) buy.href = '/account.html?upgrade=' + encodeURIComponent(this.slug);
    else buy.remove();
    m.querySelector('.pclose').onclick = function () { m.remove(); };
    document.body.appendChild(m);
  };

  PrintApp.prototype.showPaywall = function (msg) {
    this.showDialog('Бесплатный лимит', msg || 'Бесплатный лимит исчерпан.', true);
  };

  // ---------- печать ----------
  // extra: { fp } или { people }. prep: действия перед печатью (например, новый номер документа).
  PrintApp.prototype.print = async function (extra, prep) {
    var d = null;
    var ok = false;
    try {
      var r = await fetch('/api/use/' + this.slug, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(extra || {}),
      });
      if (r.status === 401) { location.href = loginUrl(this.slug); return false; }
      d = await r.json();
      ok = r.ok;
    } catch (e) {
      this.showDialog('Нет связи', 'Не удалось проверить доступ. Проверьте интернет и попробуйте ещё раз.', false);
      return false;
    }
    if (d && d.status) { this.q = d.status; this.render(); }
    if (!ok) {
      this.updateLock();
      this.showPaywall(d && d.error);
      return false;
    }
    if (prep) prep();
    var self = this;
    document.body.classList.remove('locked');
    var restore = function () {
      window.removeEventListener('afterprint', restore);
      self.updateLock();
    };
    window.addEventListener('afterprint', restore);
    window.print();
    return true;
  };

  window.PrintApp = PrintApp;
})();
