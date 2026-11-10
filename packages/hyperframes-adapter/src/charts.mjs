const escapeXml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');

export function renderChartSvg(config, options = {}) {
  if (!config || typeof config !== 'object' || !Array.isArray(config.data) || config.data.length === 0 || config.data.length > 100) {
    throw new Error('Chart data must contain between 1 and 100 points.');
  }
  const chartType = config.chartType || 'bar';
  if (!['bar', 'line'].includes(chartType)) throw new Error('Unsupported chartType: ' + chartType + '. Supported: bar, line.');
  const xKey = config.xKey || 'label';
  const yKey = config.yKey || 'value';
  const points = config.data.map((item, index) => {
    const value = Number(item?.[yKey]);
    if (!Number.isFinite(value)) throw new Error('Chart point ' + index + ' has a non-numeric value.');
    return { label: String(item?.[xKey] ?? ''), value };
  });
  const width = 960, height = 540, left = 88, right = 28, top = 32, bottom = 82;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const max = Math.max(0, ...points.map(point => point.value));
  const min = Math.min(0, ...points.map(point => point.value));
  const range = max - min || 1;
  const fill = /^#[0-9a-f]{3,8}$/i.test(options.color || '') ? options.color : '#6ea8fe';
  const title = escapeXml(config.title || 'Data visualization');
  const grid = Array.from({ length: 5 }, (_, index) => {
    const value = max - range * index / 4;
    const y = top + plotHeight * index / 4;
    return '<line x1="' + left + '" y1="' + y + '" x2="' + (width - right) + '" y2="' + y + '" stroke="#64748b" stroke-opacity=".25"/>' +
      '<text x="' + (left - 12) + '" y="' + (y + 5) + '" fill="#94a3b8" font-size="16" text-anchor="end">' + value.toFixed(1) + '</text>';
  }).join('');
  const zeroY = top + plotHeight * max / range;
  let marks;
  if (chartType === 'line') {
    const coordinates = points.map((point, index) => ({
      x: left + (points.length === 1 ? plotWidth / 2 : plotWidth * index / (points.length - 1)),
      y: top + plotHeight * (max - point.value) / range
    }));
    marks = '<polyline fill="none" stroke="' + fill + '" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" points="' +
      coordinates.map(point => point.x + ',' + point.y).join(' ') + '"/>' +
      coordinates.map(point => '<circle cx="' + point.x + '" cy="' + point.y + '" r="7" fill="' + fill + '"/>').join('');
  } else {
    const slot = plotWidth / points.length;
    const barWidth = Math.min(88, slot * .62);
    marks = points.map((point, index) => {
      const x = left + slot * index + (slot - barWidth) / 2;
      const y = top + plotHeight * (max - Math.max(0, point.value)) / range;
      const barHeight = Math.abs(point.value) / range * plotHeight;
      return '<rect x="' + x + '" y="' + (point.value < 0 ? zeroY : y) + '" width="' + barWidth + '" height="' + barHeight + '" rx="8" fill="' + fill + '"/>';
    }).join('');
  }
  const labels = points.map((point, index) => {
    const x = left + plotWidth * (index + .5) / points.length;
    return '<text x="' + x + '" y="' + (height - 28) + '" fill="#cbd5e1" font-size="16" text-anchor="middle">' + escapeXml(point.label) + '</text>';
  }).join('');
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540" role="img" aria-label="' + title + '" width="100%" height="100%">' +
    '<title>' + title + '</title>' + grid + '<line x1="' + left + '" y1="' + zeroY + '" x2="' + (width - right) + '" y2="' + zeroY + '" stroke="#94a3b8" stroke-opacity=".5"/>' +
    marks + labels + '</svg>';
}
