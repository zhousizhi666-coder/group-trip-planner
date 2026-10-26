// Shared server-side commit rules: validate before updating storage or versions.
function fail(message) {
  throw Object.assign(new Error(message), { status: 422 });
}
const key = value => String(value || '').trim().toLowerCase();
const nights = value => {
  const match = String(value || '').trim().match(/^(\d+)\s*(?:晚)?$/);
  return match ? Number(match[1]) : null;
};
function dateNights(value, fallbackYear) {
  const dates = [...String(value || '').matchAll(/(?:(\d{4})[-/年])?(\d{1,2})[-/月](\d{1,2})/g)];
  if (dates.length !== 2) return null;
  const stamp = (d, year) => Date.UTC(Number(d[1] || year), Number(d[2]) - 1, Number(d[3]));
  const start = stamp(dates[0], fallbackYear);
  let end = stamp(dates[1], fallbackYear);
  if (end < start && !dates[1][1]) end = stamp(dates[1], fallbackYear + 1);
  return (end - start) / 86400000;
}
export function constraintsFingerprint(c) {
  return JSON.stringify({
    arrival: String(c.arrival || '').trim(), departure: String(c.departure || '').trim(),
    destinations: (c.destinations || []).map(d => ({id: d.id, name: d.name, nights: d.nights || '待定'})),
    orderMode: c.orderMode === 'flexible' ? 'flexible' : 'fixed', order: c.order || [],
    lodging: String(c.lodging || '').trim(), accommodationBudget: String(c.accommodationBudget || '').trim(),
    fixedItems: (c.fixedItems || []).map(x => String(x || '').trim()).filter(Boolean)
  });
}
export function finalizeTripPlan(plan, request, state = {}) {
  const places = plan?.updatedPlaces;
  if (!Array.isArray(places) || !places.length || places.some(p => !p?.id || !p?.name)) {
    fail('模型没有返回完整的目的地模块，原行程未修改。');
  }
  if (new Set(places.map(p => key(p.id))).size !== places.length) fail('模型返回了重复的目的地 ID，原行程未修改。');
  const basics = {...state.basics, ...request.basics};
  const year = Number(String(basics.dates || '').match(/\d{4}/)?.[0]) || new Date().getUTCFullYear();
  const c = request.constraints || state.constraints || {};
  const expected = Array.isArray(c.destinations) ? c.destinations : [];
  const durations = places.map(p => {
    const explicit = nights(p.nights);
    const fromDates = dateNights(p.dates, year);
    if (explicit !== null && fromDates !== null && explicit !== fromDates) fail(`地点 ${p.name} 的晚数与日期不一致，原行程未修改。`);
    const count = explicit ?? fromDates;
    if (count === null || count < 0) fail(`地点 ${p.name} 缺少有效晚数或日期，原行程未修改。`);
    return count;
  });
  for (const d of expected) {
    const index = places.findIndex(p => key(p.name) === key(d.name) || key(p.id) === key(d.id));
    if (index < 0) fail(`Agent 没有遵守目的地硬约束：缺少 ${d.name}。原行程未修改。`);
    const wanted = nights(d.nights);
    if (wanted !== null && durations[index] !== wanted) fail(`Agent 没有遵守地点晚数硬约束：${d.name} 应为 ${wanted}晚。原行程未修改。`);
  }
  if (c.orderMode === 'fixed' && expected.length) {
    const order = c.order?.length ? c.order : expected.map(d => d.id);
    const actual = places.map(p => expected.find(d => key(d.name) === key(p.name) || key(d.id) === key(p.id))?.id);
    if (actual.length !== order.length || actual.some((id, i) => id !== order[i])) fail('Agent 没有遵守固定地点顺序，原行程未修改。');
  }
  const total = dateNights(basics.dates, year);
  if (total !== null && durations.reduce((a,b) => a+b, 0) !== total) fail(`行程总晚数必须为 ${total}晚，原行程未修改。`);
  const destinations = places.map((p,i) => {
    const previous = expected.find(d => key(d.name) === key(p.name) || key(d.id) === key(p.id));
    return {id: previous?.id || p.id, name: previous?.name || p.name, nights: `${durations[i]}晚`};
  });
  const constraints = {...c, destinations, order: destinations.map(d => d.id), orderMode: c.orderMode || 'flexible'};
  constraints.nights = destinations.map(d => `${d.name}（${d.nights}）`).join('；');
  const fingerprint = constraintsFingerprint(constraints);
  const generatedTrip = {...plan, constraintsFingerprint: fingerprint,
    updatedPlaces: places.map((p,i) => ({...p, ...destinations[i]}))};
  return {...state, basics, title: basics.tripName || state.title || basics.destination || '旅行计划',
    activeTripTemplate: request.templateId || state.activeTripTemplate || plan.templateId,
    activePlaceId: destinations[0].id, constraints, constraintsFingerprint: fingerprint, generatedTrip};
}
