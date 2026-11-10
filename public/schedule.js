// Lógica de programación compartida entre el panel y el reproductor.
(function (root) {
  'use strict';
  const DAY = 86400000;

  // Estado de vigencia de un contenido: 'scheduled' (aún no empieza), 'expired' o 'active'.
  function contentStatus(item, now = new Date()) {
    if (item.startAt && new Date(item.startAt) > now) return 'scheduled';
    if (item.endAt && new Date(item.endAt) <= now) return 'expired';
    return 'active';
  }

  function nthWeekdayOfMonth(year, month, weekday, n) {
    if (n === 5) { // último
      const last = new Date(year, month + 1, 0);
      const diff = (last.getDay() - weekday + 7) % 7;
      return new Date(year, month, last.getDate() - diff);
    }
    const first = new Date(year, month, 1);
    const offset = (weekday - first.getDay() + 7) % 7;
    const day = 1 + offset + (n - 1) * 7;
    const d = new Date(year, month, day);
    return d.getMonth() === month ? d : null;
  }

  // Regla de visualización periódica de un elemento de la lista.
  // recur = { enabled, start, end, repeat: 'none'|'daily'|'weekly'|'monthly', every, monthlyMode: 'date'|'nth' }
  function recurActive(recur, now = new Date()) {
    if (!recur || !recur.enabled || !recur.start || !recur.end) return true;
    const start = new Date(recur.start), end = new Date(recur.end);
    const len = end - start;
    if (!(len > 0)) return true;
    const every = Math.max(1, parseInt(recur.every, 10) || 1);
    const inWindow = s => s && now >= s && now < new Date(s.getTime() + len);
    const repeat = recur.repeat || 'none';
    if (repeat === 'none') return now >= start && now < end;
    if (now < start) return false;
    if (repeat === 'daily' || repeat === 'weekly') {
      const step = (repeat === 'daily' ? 1 : 7) * every;
      const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate());
      const days = Math.floor((now - startDay) / DAY);
      // revisa las ocurrencias que pueden cubrir "ahora" (la ventana puede durar varios días)
      const maxBack = Math.ceil(len / DAY) + step;
      for (let k = Math.floor(days / step) * step; k >= 0 && days - k <= maxBack; k -= step) {
        const s = new Date(start.getFullYear(), start.getMonth(), start.getDate() + k, start.getHours(), start.getMinutes());
        if (inWindow(s)) return true;
      }
      return false;
    }
    if (repeat === 'monthly') {
      const months = (now.getFullYear() - start.getFullYear()) * 12 + now.getMonth() - start.getMonth();
      const n = Math.ceil(start.getDate() / 7);
      for (let m = months; m >= 0 && months - m <= 13; m--) {
        if (m % every) continue;
        const y = start.getFullYear(), mo = start.getMonth() + m;
        let d;
        if (recur.monthlyMode === 'nth') {
          d = nthWeekdayOfMonth(new Date(y, mo, 1).getFullYear(), new Date(y, mo, 1).getMonth(), start.getDay(), n > 4 ? 5 : n);
        } else {
          d = new Date(y, mo, start.getDate());
          if (d.getDate() !== start.getDate()) d = null; // el mes no tiene ese día
        }
        if (d) {
          d.setHours(start.getHours(), start.getMinutes(), 0, 0);
          if (inWindow(d)) return true;
        }
      }
      return false;
    }
    return true;
  }

  // ¿La pantalla está dentro de su horario de funcionamiento?
  function withinHours(hours, now = new Date()) {
    if (!hours || hours.mode !== 'custom') return true;
    const toMin = t => { const [h, m] = String(t || '0:0').split(':').map(Number); return h * 60 + (m || 0); };
    const mins = now.getHours() * 60 + now.getMinutes();
    const today = hours.days.find(d => d.day === now.getDay());
    const yesterday = hours.days.find(d => d.day === (now.getDay() + 6) % 7);
    if (today && today.on) {
      const o = toMin(today.open), c = toMin(today.close);
      if (o < c ? (mins >= o && mins < c) : mins >= o) return true;
    }
    // horario que cruza la medianoche desde el día anterior
    if (yesterday && yesterday.on) {
      const o = toMin(yesterday.open), c = toMin(yesterday.close);
      if (o >= c && mins < c) return true;
    }
    return false;
  }

  function describeRecur(r) {
    if (!r || !r.enabled) return '';
    const every = Math.max(1, parseInt(r.every, 10) || 1);
    const unit = { daily: ['día', 'días'], weekly: ['semana', 'semanas'], monthly: ['mes', 'meses'] }[r.repeat];
    if (!unit) return 'Una vez';
    return every === 1 ? `Cada ${unit[0]}` : `Cada ${every} ${unit[1]}`;
  }

  const api = { contentStatus, recurActive, withinHours, nthWeekdayOfMonth, describeRecur };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Schedule = api;
})(this);
