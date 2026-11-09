import type { CustomPage } from '@oryh/dsh-analytics/types'
import type { Words } from './words.js'

/**
 * What the page's own trusted script does inside the frame. It is the only script there: a template is
 * markup and CSS, and everything it needs a script for — filling in data, drawing a chart, sorting a
 * table, telling the host how tall it is — is asked for with `data-oryh-*` attributes and done here.
 *
 * - `data-oryh-field="name"` fills in a value, `data-oryh-format="number|money|percent|date"` formats it.
 * - `<template data-oryh-each="rows">` repeats for each item of an array; the element right after it
 *   holds the copies, or, with nothing after it, the copies follow the template in its place. Inside,
 *   fields name the item's keys, and templates may nest.
 * - `data-oryh-chart="bar|line|pie" data-oryh-data="rows" data-oryh-label="key" data-oryh-value="key"`
 *   draws the array as a chart: one mark per label, the values of rows sharing a label summed, and rows
 *   without a number left out, as a Harness page's chart block does.
 * - `<table data-oryh-sortable>` sorts by a column when its header is clicked.
 * - `data-oryh-fixed` holds the page's fixed text, which a refresh never changes.
 * - `<form data-oryh-form="name">` hands the values of the fields its definition declares to the host,
 *   which asks the person to confirm and then gives them to the Chat agent. A form in a repeated row is
 *   that row's. Its selects are filled from the definition — fixed options, or items of the result — and:
 *   - `<fieldset data-oryh-lines="items">` holds lines the person adds (`data-oryh-line-add`) and removes
 *     (`data-oryh-line-remove`): one line is the `template` inside it, copied into the element after it;
 *   - `<output name="amount">` shows a figure the definition declares, a line's or the form's;
 *   - `<input data-oryh-options-filter="product">` narrows the choices of that select as the person types.
 * - `<input data-oryh-filter="rows" data-oryh-filter-field="customer">` (or a select) narrows the rows of
 *   that array, and the charts drawn from it, as the person types; without a field it matches any value.
 *   Several arrays separated by spaces or commas (`data-oryh-filter="rows orders"`) are narrowed by the one input.
 *   A select written without options lists the values its field takes, as a Harness filter block does.
 *   The host is also told what each form holds as the person types, and may set its fields: that is how
 *   Chat reads a form and fills it (`oryh-forms`, `oryh-form-fill`; docs/56 §19). What Chat filled is
 *   marked with `data-ai-filled`, and a form Chat is still filling is held from submitting.
 * - `data-oryh-open="sales_order:id"` opens the row's record in ORYH: the object type, and the row field
 *   holding its id.
 * - `data-oryh-ask="问题"` asks Chat that question about the row it is in.
 *
 * Plain ES5 in a string, so no build step can add helpers the frame's CSP would refuse. What it says to the
 * person is not written here: the host hands it its words as `WORDS` ({@link FrameWords}).
 */
const BRIDGE = String.raw`
var channel = new MessageChannel();
var port = channel.port1;
var SVG = 'http://www.w3.org/2000/svg';
var COLORS = [ACCENT, '#6f8fb3', '#c99a5b', '#8e7cc3', '#5aa6a0', '#c7727a', '#8aa35c', '#b58a6a', '#6b7c93', '#a3a3a3'];
document.querySelectorAll('[data-oryh-fixed]').forEach(function (el) { el.textContent = FIXED; });
/* One of the host's words with its {name} places filled. */
function say(word, places) {
  return word.replace(/\{(\w+)\}/g, function (_, name) { return places[name]; });
}
function text(value, format) {
  if (value === null || value === undefined) return '';
  var number = Number(value);
  var numeric = typeof value === 'number' || (typeof value === 'string' && value.trim() !== '' && isFinite(number));
  if (numeric && format === 'number') return number.toLocaleString('zh-CN', { maximumFractionDigits: 6 });
  if (numeric && format === 'money') return number.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (numeric && format === 'percent') return (number * 100).toLocaleString('zh-CN', { maximumFractionDigits: 1 }) + '%';
  if (format === 'date' && typeof value === 'string') return day(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
/* The person's day for a zoned timestamp, not UTC's; the twin of a Harness page's day(). */
function day(value) {
  var match = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(value);
  if (!match) return value.slice(0, 10);
  var moment = new Date(value);
  if (!match[2] || isNaN(moment.getTime())) return match[1];
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  return moment.getFullYear() + '-' + pad(moment.getMonth() + 1) + '-' + pad(moment.getDate());
}
function bind(root, row) {
  row = row && typeof row === 'object' ? row : {};
  root.querySelectorAll('[data-oryh-field]').forEach(function (el) {
    el.textContent = text(row[el.getAttribute('data-oryh-field')], el.getAttribute('data-oryh-format'));
  });
}
var last = {};
/** Whether an item of a top-level array passes the filters the person has typed for that array. */
function passes(key, item) {
  var ok = true;
  document.querySelectorAll('[data-oryh-filter]').forEach(function (input) {
    if (String(input.getAttribute('data-oryh-filter')).split(/[\s,]+/).indexOf(key) < 0) return;
    var query = String(input.value || '').trim().toLowerCase();
    if (!query) return;
    var field = input.getAttribute('data-oryh-filter-field');
    var values = field ? [item && item[field]] : Object.keys(item || {}).map(function (name) { return item[name]; });
    if (!values.some(function (value) { return text(value).toLowerCase().indexOf(query) >= 0; })) ok = false;
  });
  return ok;
}
function render(root, row, path) {
  // Fields first, then the repeats: a repeated copy is filled from its own item, never from its parent.
  bind(root, row);
  root.querySelectorAll('template[data-oryh-each]').forEach(function (template) {
    var out = template.nextElementSibling;
    var key = template.getAttribute('data-oryh-each');
    var items = row && row[key];
    // With nothing after it to hold them, the copies follow the template itself, marked so that the
    // next draw takes them away again: a template alone in its container fills that container.
    var inPlace = !out || out.hasAttribute('data-oryh-copy');
    if (inPlace) {
      while (template.nextElementSibling && template.nextElementSibling.hasAttribute('data-oryh-copy'))
        template.nextElementSibling.remove();
    } else out.replaceChildren();
    if (!Array.isArray(items)) return;
    var before = template.nextSibling;
    items.forEach(function (item, index) {
      // A filtered-out row keeps its place in the data: the rows shown keep their own indexes.
      if (!path && !passes(key, item)) return;
      var copy = template.content.cloneNode(true);
      var itemPath = (path ? path + '.' : '') + key + '.' + index;
      render(copy, item, itemPath);
      // What acts on a row — a form, an open, a question — belongs to the innermost row around it; the
      // host reads that row from its own data.
      copy.querySelectorAll('form[data-oryh-form], [data-oryh-open], [data-oryh-ask]').forEach(function (el) {
        if (!el.hasAttribute('data-oryh-row')) el.setAttribute('data-oryh-row', itemPath);
      });
      if (!inPlace) {
        out.append(copy);
        return;
      }
      Array.prototype.slice.call(copy.childNodes).forEach(function (child) {
        if (child.nodeType === 1) child.setAttribute('data-oryh-copy', '');
        else child.remove();
      });
      template.parentNode.insertBefore(copy, before);
    });
  });
}
/**
 * A filter select the page wrote without options lists, after one for all, the values its field takes
 * in the arrays it narrows; a choice still among them survives new data.
 */
function filterChoices(data) {
  document.querySelectorAll('select[data-oryh-filter][data-oryh-filter-field]').forEach(function (select) {
    if (!select.hasAttribute('data-oryh-choices')) {
      if (select.options.length) return;
      select.setAttribute('data-oryh-choices', '');
    }
    var field = select.getAttribute('data-oryh-filter-field');
    var seen = Object.create(null);
    var values = [];
    String(select.getAttribute('data-oryh-filter')).split(/[\s,]+/).forEach(function (key) {
      (Array.isArray(data[key]) ? data[key] : []).forEach(function (item) {
        var value = text(item && item[field]);
        if (value !== '' && !seen[value]) {
          seen[value] = true;
          values.push(value);
        }
      });
    });
    values.sort(function (a, b) { return a.localeCompare(b, 'zh-CN'); });
    var chosen = select.value;
    select.replaceChildren();
    [''].concat(values.slice(0, 50)).forEach(function (value) {
      var option = document.createElement('option');
      option.value = value;
      option.textContent = value || WORDS.filterAll;
      select.append(option);
    });
    select.value = seen[chosen] ? chosen : '';
  });
}
/** The data as the charts should see it: each top-level array narrowed by its filters. */
function narrowed(data) {
  var view = {};
  Object.keys(data).forEach(function (key) {
    view[key] = Array.isArray(data[key]) ? data[key].filter(function (item) { return passes(key, item); }) : data[key];
  });
  return view;
}
function draw() {
  render(document, last, '');
  var view = narrowed(last);
  document.querySelectorAll('[data-oryh-chart]').forEach(function (el) { chart(el, view); });
  document.querySelectorAll('table[data-oryh-sortable]').forEach(sortable);
  document.querySelectorAll('form[data-oryh-form]').forEach(prepare);
  height();
  describe();
}
function node(name, attributes, content) {
  var el = document.createElementNS(SVG, name);
  Object.keys(attributes).forEach(function (key) { el.setAttribute(key, String(attributes[key])); });
  if (content !== undefined) el.textContent = content;
  return el;
}
/** A number from a value that may be written with thousands separators; NaN when it holds none. */
function chartValue(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || value.trim() === '') return NaN;
  return Number(value.replace(/,/g, ''));
}
function chart(el, data) {
  var rows = data[el.getAttribute('data-oryh-data')];
  var labelKey = el.getAttribute('data-oryh-label');
  var valueKey = el.getAttribute('data-oryh-value');
  var kind = el.getAttribute('data-oryh-chart');
  el.replaceChildren();
  // One bar, point or slice per label, as a Harness page draws it: a chart "by customer" over orders sums
  // each customer's orders, and a row with no number is left out rather than drawn as zero.
  var sums = Object.create(null), labels = [];
  (Array.isArray(rows) ? rows : []).forEach(function (row) {
    var value = chartValue(row && row[valueKey]);
    if (!isFinite(value)) return;
    var label = text(row && row[labelKey]);
    if (!(label in sums)) { sums[label] = 0; labels.push(label); }
    sums[label] += value;
  });
  var items = labels.map(function (label) { return { label: label, value: sums[label] }; });
  if (!items.length) { el.textContent = WORDS.chartEmpty; return; }
  var width = 640, svg;
  if (kind === 'pie') {
    var total = items.reduce(function (sum, item) { return sum + Math.max(item.value, 0); }, 0);
    svg = node('svg', { viewBox: '0 0 ' + width + ' ' + Math.max(220, items.length * 22 + 20), role: 'img' });
    var angle = -Math.PI / 2;
    items.forEach(function (item, index) {
      var share = total > 0 ? Math.max(item.value, 0) / total : 0;
      var next = angle + share * Math.PI * 2;
      var large = share > 0.5 ? 1 : 0;
      var path = share >= 0.9999
        ? 'M110,10 A100,100 0 1 1 109.99,10 Z'
        : 'M110,110 L' + (110 + 100 * Math.cos(angle)) + ',' + (110 + 100 * Math.sin(angle)) +
          ' A100,100 0 ' + large + ' 1 ' + (110 + 100 * Math.cos(next)) + ',' + (110 + 100 * Math.sin(next)) + ' Z';
      if (share > 0) svg.append(node('path', { d: path, fill: COLORS[index % COLORS.length] }));
      svg.append(node('rect', { x: 240, y: 14 + index * 22, width: 12, height: 12, fill: COLORS[index % COLORS.length] }));
      svg.append(node('text', { x: 260, y: 25 + index * 22, 'font-size': 13 },
        say(WORDS.pieLegend, { label: item.label, value: text(item.value, 'number'), share: (share * 100).toFixed(1) })));
      angle = next;
    });
  } else if (kind === 'line') {
    var height = 240, left = 56, bottom = 30;
    var max = Math.max.apply(null, items.map(function (item) { return item.value; }).concat([0]));
    var min = Math.min.apply(null, items.map(function (item) { return item.value; }).concat([0]));
    var span = max - min || 1;
    var step = items.length > 1 ? (width - left - 16) / (items.length - 1) : 0;
    svg = node('svg', { viewBox: '0 0 ' + width + ' ' + height, role: 'img' });
    var points = items.map(function (item, index) {
      return (left + index * step) + ',' + (10 + (height - bottom - 10) * (1 - (item.value - min) / span));
    });
    svg.append(node('line', { x1: left, y1: height - bottom, x2: width - 8, y2: height - bottom, class: 'oryh-axis' }));
    svg.append(node('text', { x: 4, y: 16, 'font-size': 12 }, text(max, 'number')));
    svg.append(node('text', { x: 4, y: height - bottom, 'font-size': 12 }, text(min, 'number')));
    svg.append(node('polyline', { points: points.join(' '), class: 'oryh-line' }));
    // Reserve the endpoint labels first; a fixed tick count can overlap long dates.
    var labelRight = -Infinity;
    var lastLabel = items[items.length - 1];
    var lastLeft = width - 16 - (lastLabel ? lastLabel.label.length * 7.2 : 0);
    items.forEach(function (item, index) {
      var xy = points[index].split(',');
      var dot = node('circle', { cx: xy[0], cy: xy[1], r: 3, class: 'oryh-dot' });
      dot.append(node('title', {}, item.label + ': ' + text(item.value, 'number')));
      svg.append(dot);
      var x = Number(xy[0]), labelWidth = item.label.length * 7.2;
      var first = index === 0, last = index === items.length - 1;
      if (first || last || (x - labelWidth / 2 >= labelRight + 16 && x + labelWidth / 2 <= lastLeft - 16)) {
        svg.append(node('text', { x: xy[0], y: height - 10, 'font-size': 12, 'text-anchor': index === 0 ? 'start' : index === items.length - 1 ? 'end' : 'middle' }, item.label));
        labelRight = first ? x + labelWidth : x + labelWidth / 2;
      }
    });
  } else {
    // Reserve space for real business names instead of clipping their leading words outside the SVG.
    var row = 28, label = Math.min(310, Math.max(160, Math.max.apply(null, items.map(function (item) { return item.label.length; })) * 7.2 + 16));
    var peak = Math.max.apply(null, items.map(function (item) { return Math.abs(item.value); })) || 1;
    svg = node('svg', { viewBox: '0 0 ' + width + ' ' + (items.length * row + 8), role: 'img' });
    items.forEach(function (item, index) {
      var y = 4 + index * row;
      var length = (width - label - 110) * Math.abs(item.value) / peak;
      var caption = node('text', { x: label - 8, y: y + 17, 'font-size': 13, 'text-anchor': 'end' }, item.label.length > 40 ? item.label.slice(0, 39) + '…' : item.label);
      caption.append(node('title', {}, item.label));
      svg.append(caption);
      svg.append(node('rect', { x: label, y: y + 4, width: Math.max(length, 1), height: row - 10, rx: 3, class: item.value < 0 ? 'oryh-bar oryh-negative' : 'oryh-bar' }));
      svg.append(node('text', { x: label + length + 6, y: y + 17, 'font-size': 13 }, text(item.value, 'number')));
    });
  }
  svg.setAttribute('width', '100%');
  el.append(svg);
}
function sortable(table) {
  if (table.getAttribute('data-oryh-sorting')) return;
  table.setAttribute('data-oryh-sorting', 'on');
  table.querySelectorAll('thead th').forEach(function (th, column) {
    th.style.cursor = 'pointer';
    th.addEventListener('click', function () {
      var body = table.tBodies[0];
      if (!body) return;
      var ascending = th.getAttribute('aria-sort') !== 'ascending';
      table.querySelectorAll('thead th').forEach(function (other) { other.removeAttribute('aria-sort'); });
      th.setAttribute('aria-sort', ascending ? 'ascending' : 'descending');
      var cell = function (tr) {
        var value = tr.cells[column] ? tr.cells[column].textContent.trim() : '';
        var number = Number(value.replace(/[,%\s]/g, ''));
        return value !== '' && isFinite(number) ? number : value;
      };
      Array.prototype.slice.call(body.rows)
        .sort(function (a, b) {
          var x = cell(a), y = cell(b);
          var order = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'zh-CN');
          return ascending ? order : -order;
        })
        .forEach(function (tr) { body.append(tr); });
    });
  });
}
function height() {
  port.postMessage({ type: 'oryh-height', height: Math.ceil(document.documentElement.scrollHeight) });
}
var sent = {};
var requests = 0;
var forms = {};
/** What the definition says of a form, a field of it, or a field of one of its lines. */
function specOf(form) { return forms[form.getAttribute('data-oryh-form')]; }
function fieldOf(fields, name) {
  for (var i = 0; i < (fields || []).length; i++) if (fields[i].name === name) return fields[i];
  return undefined;
}
function lineSpec(el) {
  var set = el.closest('fieldset[data-oryh-lines]');
  var spec = set && specOf(set.closest('form'));
  return set && spec ? fieldOf(spec.fields, set.getAttribute('data-oryh-lines')) : undefined;
}
/** The elements with this name; with outside set, only those in no line. */
function named(root, name, outside) {
  return Array.prototype.filter.call(root.querySelectorAll('[name="' + name + '"]'), function (el) {
    return !outside || !el.closest('[data-oryh-line]');
  });
}
function choices(field) {
  if (field.options) return field.options.map(function (value) { return { value: value, label: value }; });
  var items = field.source && Array.isArray(last[field.source.data]) ? last[field.source.data] : [];
  return items.map(function (item) {
    return { value: text(item && item[field.source.value]), label: text(item && item[field.source.label]), item: item };
  });
}
function fillSelects(root, fields, outside) {
  (fields || []).forEach(function (field) {
    if (field.type !== 'select') return;
    named(root, field.name, outside).forEach(function (select) {
      if (select.tagName !== 'SELECT') return;
      select.replaceChildren();
      var blank = document.createElement('option');
      blank.value = '';
      blank.textContent = WORDS.choose;
      select.append(blank);
      choices(field).forEach(function (choice) {
        var option = document.createElement('option');
        option.value = choice.value;
        option.textContent = choice.label;
        select.append(option);
      });
    });
  });
}
function lines(set) {
  var template = set.querySelector('template');
  var holder = template && template.nextElementSibling;
  return holder ? Array.prototype.filter.call(holder.children, function (el) { return el.hasAttribute('data-oryh-line'); }) : [];
}
function addLine(set) {
  var template = set.querySelector('template');
  var holder = template && template.nextElementSibling;
  var spec = lineSpec(set);
  if (!holder || !spec) return;
  var copy = template.content.cloneNode(true);
  var root = copy.firstElementChild;
  if (!root) return;
  root.setAttribute('data-oryh-line', '');
  // A line left empty is dropped by the host, so the browser must not hold the form back over it; the
  // host says which line lacks what.
  root.querySelectorAll('[required]').forEach(function (el) { el.removeAttribute('required'); });
  if (root.hasAttribute('required')) root.removeAttribute('required');
  fillSelects(root, spec.fields, false);
  holder.append(copy);
}
/** A form as the definition declares it: its selects filled, its lines at their least (one at least). */
function prepare(form) {
  if (form.hasAttribute('data-oryh-prepared')) return;
  form.setAttribute('data-oryh-prepared', '');
  var spec = specOf(form);
  if (!spec) return;
  fillSelects(form, spec.fields, true);
  form.querySelectorAll('fieldset[data-oryh-lines]').forEach(function (set) {
    var field = lineSpec(set);
    var start = Math.max((field && field.min) || 0, 1);
    for (var i = 0; i < start; i++) addLine(set);
  });
  compute(form);
  // What the form holds before anyone has typed: a form that still holds this has nothing to protect.
  form.__oryhBlank = JSON.stringify(collect(form, spec));
}
function numberOf(el) {
  if (!el) return NaN;
  var value = String(el.value || '').replace(/,/g, '').trim();
  return value === '' ? NaN : Number(value);
}
function show(root, name, value, outside) {
  named(root, name, outside).forEach(function (el) {
    el.textContent = isFinite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: 6 }) : '';
  });
}
/** The figures the definition declares, as the person types; the host works out its own exactly. */
function compute(form) {
  var spec = specOf(form);
  if (!spec) return;
  var sums = {};
  spec.fields.forEach(function (field) {
    if (field.type !== 'lines') return;
    var set = form.querySelector('fieldset[data-oryh-lines="' + field.name + '"]');
    (set ? lines(set) : []).forEach(function (root) {
      var figures = {};
      (field.computed || []).forEach(function (item) {
        var gift = item.zeroWhen && named(root, item.zeroWhen)[0];
        var value = gift && gift.checked ? 0 : numberOf(named(root, item.multiply[0])[0]) * numberOf(named(root, item.multiply[1])[0]);
        figures[item.name] = value;
        show(root, item.name, value);
      });
      (field.fields || []).concat(field.computed || []).forEach(function (column) {
        var value = column.name in figures ? figures[column.name] : numberOf(named(root, column.name)[0]);
        var key = field.name + '.' + column.name;
        if (isFinite(value)) sums[key] = (sums[key] || 0) + value;
      });
    });
  });
  (spec.computed || []).forEach(function (item) { show(form, item.name, sums[item.sum] || 0, true); });
}
/** A choice's own values filled into its line, where the definition says so; the person may change them. */
function applyDefaults(select) {
  var spec = lineSpec(select);
  var field = spec && fieldOf(spec.fields, select.name);
  var root = select.closest('[data-oryh-line]');
  if (!field || !field.defaults || !root) return;
  var chosen = choices(field).filter(function (choice) { return choice.value === select.value; })[0];
  if (!chosen || !chosen.item) return;
  Object.keys(field.defaults).forEach(function (target) {
    var value = chosen.item[field.defaults[target]];
    named(root, target).forEach(function (el) { if (value !== undefined && value !== null) el.value = text(value); });
  });
}
function read(root, field, outside) {
  var el = named(root, field.name, outside)[0];
  if (field.type === 'checkbox') return !!(el && el.checked);
  return el ? String(el.value) : '';
}
/** The declared fields only, by name; lines as a list of their declared fields. */
function collect(form, spec) {
  var values = {};
  spec.fields.forEach(function (field) {
    if (field.type !== 'lines') { values[field.name] = read(form, field, true); return; }
    var set = form.querySelector('fieldset[data-oryh-lines="' + field.name + '"]');
    values[field.name] = (set ? lines(set) : []).map(function (root) {
      var line = {};
      field.fields.forEach(function (sub) { line[sub.name] = read(root, sub, false); });
      return line;
    });
  });
  return values;
}
/* ── what Chat sees of the forms, and what it sets ── */
var FORM_LIMIT = 12;
function formId(form) {
  var row = form.getAttribute('data-oryh-row') || '';
  return form.getAttribute('data-oryh-form') + (row ? ':' + row : '');
}
function formById(id) {
  var found = null;
  document.querySelectorAll('form[data-oryh-form][data-oryh-prepared]').forEach(function (form) {
    if (!found && formId(form) === id) found = form;
  });
  return found;
}
function typedIn(form) {
  var spec = specOf(form);
  return !!spec && JSON.stringify(collect(form, spec)) !== form.__oryhBlank;
}
function anyTyped() {
  var any = false;
  document.querySelectorAll('form[data-oryh-form][data-oryh-prepared]').forEach(function (form) {
    if (typedIn(form)) any = true;
  });
  return any;
}
var described = '';
var describing = false;
/**
 * Tell the host which forms the page shows and what each holds, once things have settled. A page with a
 * form on every row may have hundreds: the forms of the page itself come first, then those someone has
 * typed in, then the rest in order, up to a dozen in all.
 */
function describe() {
  if (describing) return;
  describing = true;
  setTimeout(function () {
    describing = false;
    var own = [], typed = [], rest = [];
    document.querySelectorAll('form[data-oryh-form][data-oryh-prepared]').forEach(function (form) {
      var spec = specOf(form);
      if (!spec) return;
      var entry = {
        id: formId(form),
        name: form.getAttribute('data-oryh-form'),
        row: form.getAttribute('data-oryh-row') || '',
        values: collect(form, spec),
        busy: !!form.getAttribute('data-oryh-state'),
      };
      (entry.row === '' ? own : typedIn(form) ? typed : rest).push(entry);
    });
    var list = own.concat(typed, rest).slice(0, FORM_LIMIT);
    var next = JSON.stringify(list);
    if (next === described) return;
    described = next;
    port.postMessage({ type: 'oryh-forms', forms: list });
  }, 0);
}
function setField(root, field, value, outside) {
  named(root, field.name, outside).forEach(function (el) {
    if (field.type === 'checkbox') el.checked = value === true;
    else el.value = value === undefined || value === null ? '' : String(value);
  });
}
/** Put values into a form: a field as it is named, lines as the whole list, row by row. */
function fillForm(form, values) {
  var spec = specOf(form);
  if (!spec || !values || typeof values !== 'object') return;
  spec.fields.forEach(function (field) {
    if (!Object.prototype.hasOwnProperty.call(values, field.name)) return;
    var value = values[field.name];
    if (field.type !== 'lines') { setField(form, field, value, true); return; }
    var set = form.querySelector('fieldset[data-oryh-lines="' + field.name + '"]');
    if (!set || !Array.isArray(value)) return;
    lines(set).forEach(function (root) { root.remove(); });
    value.forEach(function (line) {
      addLine(set);
      var roots = lines(set);
      var root = roots[roots.length - 1];
      if (!root || !line || typeof line !== 'object') return;
      (field.fields || []).forEach(function (sub) {
        if (Object.prototype.hasOwnProperty.call(line, sub.name)) setField(root, sub, line[sub.name], false);
      });
    });
  });
  compute(form);
  tell(anyTyped());
  height();
  describe();
}
/** Mark the places Chat filled that still hold what it put there; the host says which. */
function markForm(form, marks) {
  form.querySelectorAll('[data-ai-filled]').forEach(function (el) { el.removeAttribute('data-ai-filled'); });
  var spec = specOf(form);
  if (!spec || !Array.isArray(marks)) return;
  function on(el) { el.setAttribute('data-ai-filled', ''); }
  marks.forEach(function (path) {
    var parts = String(path).split('.');
    var field = fieldOf(spec.fields, parts[0]);
    if (!field) return;
    if (field.type !== 'lines') { named(form, field.name, true).forEach(on); return; }
    var set = form.querySelector('fieldset[data-oryh-lines="' + field.name + '"]');
    if (!set) return;
    if (parts.length === 1) { on(set); return; }
    var root = lines(set)[Number(parts[1])];
    if (!root) return;
    if (parts.length === 2) on(root);
    else named(root, parts[2]).forEach(on);
  });
}
function status(form, message, kind) {
  var el = form.querySelector('.oryh-form-status');
  if (!el) {
    el = document.createElement('p');
    el.className = 'oryh-form-status';
    form.append(el);
  }
  el.textContent = message;
  el.setAttribute('data-kind', kind);
  height();
}
function busy(form, on) {
  form.querySelectorAll('button, input[type=submit]').forEach(function (button) { button.disabled = on; });
}
document.addEventListener('input', function (event) {
  var target = event.target;
  if (!target || !target.matches) return;
  if (target.matches('[data-oryh-filter]')) { draw(); return; }
  if (target.matches('[data-oryh-options-filter]')) {
    var query = String(target.value || '').trim().toLowerCase();
    var form = target.closest('form');
    (form ? named(form, target.getAttribute('data-oryh-options-filter')) : []).forEach(function (select) {
      Array.prototype.forEach.call(select.options || [], function (option) {
        option.hidden = !!query && option.value !== '' && !option.selected && option.textContent.toLowerCase().indexOf(query) < 0;
      });
    });
    return;
  }
  var owner = target.closest('form[data-oryh-form]');
  if (owner) { compute(owner); tell(true); describe(); }
}, true);
document.addEventListener('change', function (event) {
  var target = event.target;
  if (!target || !target.matches) return;
  if (target.matches('select[data-oryh-filter]')) { draw(); return; }
  if (target.tagName === 'SELECT') applyDefaults(target);
  var owner = target.closest('form[data-oryh-form]');
  if (owner) { compute(owner); tell(true); describe(); }
}, true);
// Opening a record and asking Chat are the host's to do; the frame only says which row.
document.addEventListener('click', function (event) {
  var line = event.target && event.target.closest ? event.target.closest('[data-oryh-line-add], [data-oryh-line-remove]') : null;
  if (line) {
    event.preventDefault();
    var set = line.closest('fieldset[data-oryh-lines]');
    var spec = set && lineSpec(set);
    if (!set || !spec) return;
    var count = lines(set).length;
    if (line.hasAttribute('data-oryh-line-add')) { if (count < (spec.max || 50)) addLine(set); }
    else if (count > (spec.min || 0)) { var root = line.closest('[data-oryh-line]'); if (root) root.remove(); }
    compute(set.closest('form'));
    height();
    describe();
    return;
  }
  var el = event.target && event.target.closest ? event.target.closest('[data-oryh-open], [data-oryh-ask]') : null;
  if (!el) return;
  event.preventDefault();
  var row = el.getAttribute('data-oryh-row') || '';
  if (el.hasAttribute('data-oryh-open'))
    port.postMessage({ type: 'oryh-open', target: el.getAttribute('data-oryh-open'), row: row });
  else port.postMessage({ type: 'oryh-ask', question: el.getAttribute('data-oryh-ask'), row: row });
}, true);
// A form never submits itself: its declared values go to the host, which asks the person and hands them to Chat.
/* The host is told while a form holds something the person typed: Chat then leaves the workbench on this page. */
var editing = false;
function tell(next) {
  if (next === editing) return;
  editing = next;
  port.postMessage({ type: 'oryh-editing', dirty: next });
}
document.addEventListener('submit', function (event) {
  event.preventDefault();
  var form = event.target;
  if (!form || !form.matches || !form.matches('form[data-oryh-form]') || form.getAttribute('data-oryh-state')) return;
  var spec = specOf(form);
  if (!spec) { status(form, WORDS.formUndeclared, 'error'); return; }
  // Chat is still filling it: more of the form may be on its way.
  if (form.hasAttribute('data-oryh-hold')) { status(form, WORDS.formHeld, 'muted'); return; }
  var request = ++requests;
  sent[request] = form;
  form.setAttribute('data-oryh-state', 'sending');
  busy(form, true);
  status(form, WORDS.formWaiting, 'pending');
  port.postMessage({
    type: 'oryh-form',
    request: request,
    form: form.getAttribute('data-oryh-form'),
    row: form.getAttribute('data-oryh-row') || '',
    values: collect(form, spec),
  });
  describe();
}, true);
port.onmessage = function (event) {
  if (event.data && event.data.type === 'oryh-form-result') {
    var form = sent[event.data.request];
    if (!form) return;
    delete sent[event.data.request];
    form.removeAttribute('data-oryh-state');
    busy(form, false);
    status(form, String(event.data.message || ''), event.data.ok ? 'ok' : event.data.cancelled ? 'muted' : 'error');
    if (event.data.ok) {
      form.reset();
      form.querySelectorAll('fieldset[data-oryh-lines]').forEach(function (set) {
        lines(set).forEach(function (root) { root.remove(); });
      });
      form.removeAttribute('data-oryh-prepared');
      prepare(form);
      tell(anyTyped());
    }
    describe();
    return;
  }
  if (event.data && (event.data.type === 'oryh-form-fill' || event.data.type === 'oryh-form-marks' || event.data.type === 'oryh-form-hold')) {
    var target = formById(String(event.data.form));
    if (!target) return;
    if (event.data.type === 'oryh-form-fill') fillForm(target, event.data.values);
    else if (event.data.type === 'oryh-form-marks') markForm(target, event.data.marks);
    else if (event.data.on) target.setAttribute('data-oryh-hold', '');
    else target.removeAttribute('data-oryh-hold');
    return;
  }
  if (event.data && event.data.type === 'oryh-theme') {
    var style = document.getElementById('oryh-theme');
    if (style && typeof event.data.css === 'string') style.textContent = event.data.css;
    return;
  }
  if (event.data && event.data.type === 'oryh-words' && event.data.words && typeof event.data.words === 'object') {
    WORDS = event.data.words;
    return;
  }
  if (!event.data || event.data.type !== 'oryh-data') return;
  last = event.data.data && typeof event.data.data === 'object' ? event.data.data : {};
  forms = event.data.forms && typeof event.data.forms === 'object' ? event.data.forms : {};
  filterChoices(last);
  draw();
};
if (window.ResizeObserver) new ResizeObserver(height).observe(document.body);
parent.postMessage({ type: 'oryh-ready', nonce: NONCE }, '*', [channel.port2]);
`

/** Produce an opaque-origin document with declarative data binding only. Model JavaScript is not executed. */
/** The workbench's look, handed to the frame so a page reads as part of it: its colors and its type. */
export interface FrameTheme {
  readonly scheme: 'light' | 'dark'
  /** The workbench's color tokens by name, without the leading dashes: bg, surface, text, muted, line, accent… */
  readonly tokens: Readonly<Record<string, string>>
  readonly font: string
}
const LIGHT: FrameTheme = {
  scheme: 'light',
  tokens: {
    bg: '#f6f7f9',
    surface: '#fff',
    text: '#26313c',
    muted: '#707b87',
    line: '#e5e9ed',
    accent: '#246b63',
    'accent-soft': '#e6f0ed',
    hover: '#f6f8f9',
  },
  font: 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
}
/** Only token names and color-ish values reach the stylesheet, so nothing from the host page can break out of it. */
const TOKEN = /^[a-z][a-z-]{0,30}$/
const VALUE = /^[#(),.%\s\w-]{1,60}$/
const FONT = /^[\w\s"',.-]{1,200}$/u

/**
 * The workbench's own styles, applied before the page's CSS: type sizes, tables, figures and charts look
 * as they do on every other page, in the light or dark theme the workbench is in. The page's CSS is for
 * its layout; it can override these, and is told not to.
 */
export function frameThemeCss(theme: FrameTheme): string {
  const tokens = Object.entries(theme.tokens)
    .filter(([name, value]) => TOKEN.test(name) && VALUE.test(value))
    .map(([name, value]) => `--${name}:${value}`)
    .join(';')
  const font = FONT.test(theme.font) ? theme.font : LIGHT.font
  return [
    `:root{color-scheme:${theme.scheme};${tokens}}`,
    `html,body{margin:0;background:transparent;color:var(--text);font-family:${font};font-size:14px;line-height:1.5}`,
    'body{padding:2px 1px 8px}',
    'h1,h2,h3,p{margin-top:0}',
    'h1{font-size:20px;line-height:1.4;font-weight:650;letter-spacing:-.3px;margin-bottom:6px}',
    'h2{font-size:16px;font-weight:600;margin:18px 0 8px}',
    'h3{font-size:14px;font-weight:600;margin:14px 0 6px}',
    'p{line-height:1.7;margin-bottom:10px}',
    'small,.muted{color:var(--muted)}',
    'section,article{margin-bottom:16px}',
    'table{width:100%;border-collapse:collapse;text-align:left;font-size:12px;margin:8px 0 16px;background:var(--surface);border:1px solid var(--line);border-radius:8px;overflow:hidden}',
    'th{padding:10px 14px;color:var(--muted);font-size:11px;font-weight:500;background:var(--hover);border-bottom:1px solid var(--line);white-space:nowrap}',
    'td{padding:12px 14px;border-bottom:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}',
    'tr:last-child td{border-bottom:none}',
    'tbody tr:hover{background:var(--hover)}',
    // Figures line up: formatted values align right, in digits of one width.
    '[data-oryh-format=number],[data-oryh-format=money],[data-oryh-format=percent]{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}',
    "th[aria-sort=ascending]::after{content:' ▲'}th[aria-sort=descending]::after{content:' ▼'}",
    '[data-oryh-chart]{margin:8px 0 16px;padding:12px 14px;background:var(--surface);border:1px solid var(--line);border-radius:8px}',
    'svg text{fill:var(--text)}',
    '.oryh-bar{fill:var(--accent)}.oryh-negative{fill:#c7727a}',
    '.oryh-line{fill:none;stroke:var(--accent);stroke-width:2}.oryh-dot{fill:var(--accent)}.oryh-axis{stroke:var(--line)}',
    '[data-oryh-fixed]{white-space:pre-wrap;color:var(--muted);font-size:13px;line-height:1.7}',
    'form[data-oryh-form]{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0}',
    'fieldset[data-oryh-lines]{flex-basis:100%;border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin:0}',
    'div[data-oryh-line]{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 6px}',
    'output{min-width:5em;text-align:right;font-variant-numeric:tabular-nums}',
    'input,textarea,select{font:inherit;font-size:12px;color:var(--text);background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:6px 8px}',
    'textarea{min-height:56px;flex:1 1 220px}',
    'button{font:inherit;font-size:12px;color:var(--bg);background:var(--accent);border:0;border-radius:6px;padding:6px 12px;cursor:pointer}',
    'button:disabled{opacity:.55;cursor:default}',
    '.oryh-form-status{flex-basis:100%;margin:2px 0 0;font-size:12px;color:var(--muted)}',
    '.oryh-form-status[data-kind=ok]{color:var(--accent)}.oryh-form-status[data-kind=error]{color:#c7727a}',
    '[data-oryh-open]{cursor:pointer;color:var(--accent);text-decoration:underline;text-underline-offset:3px}',
    '[data-oryh-filter]{margin:0 0 8px}',
    // What Chat filled, marked as it is on every other form of the workbench.
    '[data-ai-filled]{box-shadow:inset 3px 0 0 var(--accent)}',
  ].join('')
}

/** What the frame's own script says to the person: the frame cannot reach the locale service, so it is handed these. */
export interface FrameWords {
  readonly filterAll: string
  readonly chartEmpty: string
  /** One line of a pie's legend, with `{label}`, `{value}` and `{share}` places. */
  readonly pieLegend: string
  readonly choose: string
  readonly formUndeclared: string
  readonly formHeld: string
  readonly formWaiting: string
}

/**
 * The frame's words, in the person's language.
 * @param t - this plugin's words.
 */
export function frameWords(t: Words): FrameWords {
  return {
    filterAll: t('filterAll'),
    chartEmpty: t('frameChartEmpty'),
    // The places are filled inside the frame, row by row; here they are handed on as they are written.
    pieLegend: t('framePieLegend', { label: '{label}', value: '{value}', share: '{share}' }),
    choose: t('formChoose'),
    formUndeclared: t('frameFormUndeclared'),
    formHeld: t('frameFormHeld'),
    formWaiting: t('formWaiting'),
  }
}

/**
 * @param words - what the frame's script says, from {@link frameWords}.
 */
export function customSrcDoc(page: CustomPage, nonce: string, words: FrameWords, theme: FrameTheme = LIGHT): string {
  const jsLiteral = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c')
  const html = page.definition.html ?? ''
  const css = page.definition.css ?? ''
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  if (page.definition.fixedText && !parsed.body.querySelector('[data-oryh-fixed]')) {
    const fixed = parsed.createElement('section')
    fixed.setAttribute('data-oryh-fixed', '')
    parsed.body.append(fixed)
  }
  const sanitize = (root: ParentNode) => {
    for (const element of [...root.querySelectorAll('*')]) {
      // Case-blind: an element in the SVG or MathML namespace keeps its lower-case tag name, and a
      // <script> inside <svg> is one of those.
      if (
        /^(script|iframe|frame|frameset|object|embed|meta|base|link|svg|math|style|video|audio|noscript|noembed|noframes|xmp|plaintext|title)$/i.test(
          element.localName,
        ) ||
        // A form is kept only as a declared form; it never submits anywhere itself.
        (/^form$/i.test(element.localName) && !element.hasAttribute('data-oryh-form'))
      ) {
        element.remove()
        continue
      }
      for (const attribute of [...element.attributes]) {
        const name = attribute.name.toLowerCase()
        if (
          name.startsWith('on') ||
          name === 'href' ||
          name === 'srcset' ||
          /^(form)?(action|method|target|enctype)$/.test(name) ||
          name === 'style' ||
          (name === 'src' &&
            !(
              element.localName === 'img' &&
              /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(attribute.value)
            ))
        )
          element.removeAttribute(attribute.name)
      }
      if (element instanceof HTMLTemplateElement) sanitize(element.content)
    }
  }
  sanitize(parsed.body)
  // A private MessagePort is transferred by this trusted bridge. The data is never posted to an
  // iframe window after a navigation, and no model-authored JavaScript is executed.
  const accent = VALUE.test(theme.tokens.accent ?? '') ? theme.tokens.accent! : LIGHT.tokens.accent!
  const bridge = `(function(){var FIXED=${jsLiteral(page.definition.fixedText)};var NONCE=${jsLiteral(nonce)};var ACCENT=${jsLiteral(accent)};var WORDS=${jsLiteral(words)};${BRIDGE}})();`
  // Colors, backgrounds and fonts are the workbench's: a page that sets its own — as pages written before
  // the theme did — would stand out from every other page. A theme variable is kept; layout is untouched.
  const themed = css.replace(
    /(^|[;{])\s*(color|background|background-color|font-family)\s*:(?!\s*var\(--)[^;}]*/gi,
    '$1',
  )
  const safeCss = themed.replace(/<\/style/gi, '<\\/style')
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'"><style id="oryh-theme">${frameThemeCss(theme)}</style><style>${safeCss}</style></head><body>${parsed.body.innerHTML}<script nonce="${nonce}">${bridge}</script></body></html>`
}
