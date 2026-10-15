// Общий код трёх приложений: сохранение данных в аккаунт пользователя.
(function () {
  function PrintApp(slug) {
    this.slug = slug;
    this.timer = null;
    this.statusEl = null;
  }

  // Загрузка сохранённых данных. null — если ещё ничего нет.
  PrintApp.prototype.load = async function () {
    try {
      var r = await fetch('/api/data/' + this.slug);
      if (r.status === 401) { location.href = '/login.html?next=' + encodeURIComponent('/app/' + this.slug); return null; }
      if (r.status === 402) { location.href = '/account.html?need=' + this.slug; return null; }
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

  window.PrintApp = PrintApp;
})();
