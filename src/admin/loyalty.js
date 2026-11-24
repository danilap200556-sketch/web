'use strict';
// Админка: настройка накопительной скидки (уровни и правила). Доступна владельцу.
const { html } = require('../html');
const { rub } = require('../util');
const { validateLoyalty } = require('../loyalty');

const MAX_ROWS = 8;
const arr = (v) => (v === undefined ? [] : [].concat(v)).map((x) => String(x));

module.exports = function mount({ router, auth, render, settings }) {
  const form = (req, { rules, error = '' }) => html`
    <section class="card card--pad">
      <header class="card__h"><div><h2>Накопительная скидка</h2>
        <p class="muted">Уровень покупателя считается по сумме полученных заказов (без доставки, после скидок). Скидка применяется автоматически при оформлении, только когда покупатель вошёл в кабинет.</p></div></header>
      ${error ? html`<p class="flash flash--err" role="alert">${error}</p>` : ''}
      <form method="post" action="/admin/loyalty" class="mform__grid">${req.adminCsrf}
        <label class="check field--wide"><input type="checkbox" name="enabled" ${rules.enabled ? 'checked' : ''}><span>Программа лояльности включена</span></label>
        <label class="check field--wide"><input type="checkbox" name="applyToSale" ${rules.applyToSale ? 'checked' : ''}><span>Скидка действует и на товары с акционной ценой (по умолчанию нет)</span></label>
        <label class="check field--wide"><input type="checkbox" name="applyToElectronics" ${rules.applyToElectronics ? 'checked' : ''}><span>Скидка действует на электронику партнёра</span></label>
        <div class="field--wide tiers">
          <p class="tiers__h"><span>Название уровня</span><span>Накопить от, ₽</span><span>Скидка, %</span></p>
          ${rules.tiers.map((t) => html`<div class="tierrow">
            <input name="tierName" value="${t.name}" maxlength="30" aria-label="Название уровня">
            <input name="tierFrom" value="${t.from}" inputmode="numeric" aria-label="Накопить от, рублей">
            <input name="tierPercent" value="${t.percent}" inputmode="decimal" aria-label="Скидка, процентов"></div>`)}
        </div>
        <p class="muted field--wide">Первый уровень начинается с 0 ₽, пороги растут. Чтобы убрать уровень, очистите его строку; пустые строки внизу можно заполнить, чтобы добавить уровень (до ${MAX_ROWS}). Например: «Золото», ${rub(100000)}, 5%.</p>
        <div class="mform__foot"><button class="btn btn--primary" type="submit">Сохранить</button></div>
      </form>
    </section>`;

  // Пустые строки (все три поля пусты) пропускаем; сверх лимита пустых строк для добавления
  const padded = (rules) => ({ ...rules, tiers: [...rules.tiers, ...Array.from({ length: Math.max(0, Math.min(2, MAX_ROWS - rules.tiers.length)) }, () => ({ name: '', from: '', percent: '' }))] });

  router.get('/loyalty', auth.require('loyalty'), async (req, res, next) => {
    try {
      const rules = (await settings.get()).loyalty;
      await render(req, res, 'loyalty', { title: 'Лояльность', body: form(req, { rules: padded(rules) }) });
    } catch (e) { next(e); }
  });

  router.post('/loyalty', auth.require('loyalty'), async (req, res, next) => {
    try {
      const names = arr(req.body.tierName);
      const froms = arr(req.body.tierFrom);
      const percents = arr(req.body.tierPercent);
      const keep = names.map((_, i) => i).filter((i) => (names[i] || '').trim() || (froms[i] || '').trim() || (percents[i] || '').trim());
      const body = { ...req.body, tierName: keep.map((i) => names[i]), tierFrom: keep.map((i) => froms[i] ?? ''), tierPercent: keep.map((i) => percents[i] ?? '') };
      const v = validateLoyalty(body);
      if (v.error) {
        // Ошибка: показываем форму с тем, что ввели, ничего не сохраняем
        const posted = {
          enabled: body.enabled === 'on', applyToSale: body.applyToSale === 'on', applyToElectronics: body.applyToElectronics === 'on',
          tiers: keep.map((i) => ({ name: names[i], from: froms[i] ?? '', percent: percents[i] ?? '' })),
        };
        return render(req, res, 'loyalty', { title: 'Лояльность', body: form(req, { rules: padded(posted), error: v.error }) }, 422);
      }
      await settings.set({ loyalty: v.value });
      res.flash('ok', 'Настройки лояльности сохранены');
      res.redirect('/admin/loyalty');
    } catch (e) { next(e); }
  });
};
