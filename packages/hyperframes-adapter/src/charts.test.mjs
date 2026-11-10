import test from 'node:test';
import assert from 'node:assert/strict';
import { renderChartSvg } from './charts.mjs';

test('renders deterministic SVG bar charts with escaped labels', () => {
  const svg = renderChartSvg({
    chartType: 'bar',
    title: 'Quarterly growth',
    data: [{ label: '<Q1>', value: 12 }, { label: 'Q2', value: 18 }]
  }, { color: '#ff9900' });
  assert.match(svg, /<svg/);
  assert.match(svg, /Quarterly growth/);
  assert.match(svg, /&lt;Q1&gt;/);
  assert.match(svg, /<rect/);
  assert.match(svg, /#ff9900/);
});

test('renders line charts and escapes untrusted titles', () => {
  const svg = renderChartSvg({
    chartType: 'line',
    title: '<script>alert(1)</script>',
    data: [{ label: 'Jan', value: 3 }, { label: 'Feb', value: 8 }]
  });
  assert.match(svg, /<polyline/);
  assert.match(svg, /&lt;script&gt;/);
  assert.doesNotMatch(svg, /<script>/);
});

test('rejects unsupported chart types, empty data and non-numeric values', () => {
  assert.throws(() => renderChartSvg({ chartType: 'pie', data: [{ label: 'A', value: 1 }] }), /Unsupported chartType/);
  assert.throws(() => renderChartSvg({ data: [] }), /between 1 and 100/);
  assert.throws(() => renderChartSvg({ data: [{ label: 'A', value: 'many' }] }), /non-numeric/);
});

test('caps chart data size and sanitizes invalid color tokens', () => {
  assert.throws(() => renderChartSvg({ data: Array.from({ length: 101 }, (_, i) => ({ label: i, value: i })) }), /between 1 and 100/);
  const svg = renderChartSvg({ data: [{ label: 'A', value: 1 }] }, { color: 'red;fill:url(javascript:alert(1))' });
  assert.doesNotMatch(svg, /javascript:/);
  assert.match(svg, /#6ea8fe/);
});
