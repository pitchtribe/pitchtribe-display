// Parsers for the extra data sources. Fixtures follow each provider's documented
// response format (the build sandbox can't reach the live APIs) — check against the
// real feeds on a networked machine; any mismatch shows as "Unavailable" on screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFeed, parseIcs, sunTimes, moonPhase, describeMetSymbol, parseMetForecast, parseBankHolidays, parseFloods,
  parseCarbon, parseTfl, parseQuakes, parseRates, parseOpenTdb, parsePotd, parseBirths, parseHuxley, parseArrivals,
  parseRoads, parseAircraft, parseSiriVm, plainText, zonedToUtc,
} from '../src/sources.js';
import { createWidgets } from '../src/widgets.js';

// Widget fetches resolve the address first and refuse anything private, so the
// fixture hostnames here (`club.example`, `rail.example`) get a stub resolver
// that answers with a public address. Without it these tests would need DNS.
const lookup = async () => [{ address: '93.184.216.34', family: 4 }];

test('plainText decodes CDATA, tags and entities', () => {
  assert.equal(plainText('<![CDATA[<b>Fish &amp; chips</b> &#163;5]]>'), 'Fish & chips £5');
  assert.equal(plainText('Caf&eacute;?'), 'Caf&eacute;?', 'unknown named entities are left alone');
});

test('RSS and Atom feeds', () => {
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>Riverside FC News</title>
    <item><title><![CDATA[First team win 3–1]]></title><pubDate>Sat, 31 Oct 2026 17:05:00 GMT</pubDate></item>
    <item><title>AGM date set &amp; agenda</title></item></channel></rss>`;
  const f = parseFeed(rss);
  assert.equal(f.title, 'Riverside FC News');
  assert.deepEqual(f.items.map((i) => i.title), ['First team win 3–1', 'AGM date set & agenda']);
  assert.equal(f.items[0].date, '2026-10-31T17:05:00.000Z');
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><title type="text">League</title>
    <entry><title>Fixtures published</title><updated>2026-11-01T09:00:00Z</updated></entry></feed>`;
  assert.deepEqual(parseFeed(atom), { title: 'League', items: [{ title: 'Fixtures published', date: '2026-11-01T09:00:00.000Z' }] });
});

test('iCal: all-day, UTC, TZID, folded lines, escapes, cancelled', () => {
  // A fold is CRLF + one space (removed when unfolding), so the folded word gap needs a second space.
  const ics = [
    'BEGIN:VCALENDAR', 'X-WR-CALNAME:Riverside FC',
    'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20261107', 'SUMMARY:Club open day', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART:20261110T193000Z', 'SUMMARY:Training\\, pitch A', 'LOCATION:Astro', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART;TZID=America/New_York:20261112T100000', 'SUMMARY:Call with', '  US partners', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART:20261115T120000Z', 'SUMMARY:Cancelled thing', 'STATUS:CANCELLED', 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const cal = parseIcs(ics, { tz: 'Europe/London' });
  assert.equal(cal.title, 'Riverside FC');
  assert.equal(cal.events.length, 3);
  assert.equal(cal.events[0].allDay, true);
  assert.equal(cal.events[1].title, 'Training, pitch A');
  assert.equal(cal.events[1].start.toISOString(), '2026-11-10T19:30:00.000Z');
  assert.equal(cal.events[2].title, 'Call with US partners');
  assert.equal(cal.events[2].start.toISOString(), '2026-11-12T15:00:00.000Z', 'New York is UTC-5 in November');
  assert.equal(zonedToUtc(2026, 7, 1, 12, 0, 0, 'Europe/London').toISOString(), '2026-07-01T11:00:00.000Z', 'BST');
});

test('sun and moon calculations', () => {
  // London, 21 June 2026: sunrise ~03:43 UTC, sunset ~20:21 UTC.
  const { sunrise, sunset } = sunTimes(2026, 6, 21, 51.5072, -0.1276);
  const mins = (d) => d.getUTCHours() * 60 + d.getUTCMinutes();
  assert.ok(Math.abs(mins(sunrise) - (3 * 60 + 43)) <= 4, sunrise.toISOString());
  assert.ok(Math.abs(mins(sunset) - (20 * 60 + 21)) <= 4, sunset.toISOString());
  // Svalbard in December: polar night.
  assert.equal(sunTimes(2026, 12, 21, 78.2, 15.6).sunrise, null);
  // 2000-01-21 was a full moon (lunar eclipse).
  assert.equal(moonPhase(new Date(Date.UTC(2000, 0, 21, 4, 40))).name, 'Full moon');
  assert.equal(moonPhase(new Date(Date.UTC(2000, 0, 6, 18, 14))).name, 'New moon');
});

test('MET Norway forecast and symbols', () => {
  assert.deepEqual(describeMetSymbol('lightrainshowers_day'), { text: 'Light showers', icon: '🌦️', cond: 'showers' });
  assert.deepEqual(describeMetSymbol('clearsky_night'), { text: 'Clear sky', icon: '🌙', cond: 'clear' });
  assert.equal(describeMetSymbol('heavyrainandthunder').text, 'Thunderstorm');
  const ts = (time, t, wind, sym) => ({ time, data: { instant: { details: { air_temperature: t, wind_speed: wind } }, next_1_hours: { summary: { symbol_code: sym }, details: { precipitation_amount: 0.4 } }, next_6_hours: { summary: { symbol_code: sym } } } });
  const j = { properties: { timeseries: [ts('2026-11-03T09:00:00Z', 8.2, 4, 'cloudy'), ts('2026-11-03T12:00:00Z', 11.4, 5, 'partlycloudy_day'), ts('2026-11-04T12:00:00Z', 9.9, 6, 'rain')] } };
  const f = parseMetForecast(j, { tz: 'Europe/London', windUnit: 'mph' });
  assert.deepEqual(f.current, { temp: 8, wind: 9, text: 'Cloudy', icon: '☁️', cond: 'cloudy' });
  assert.equal(f.days.length, 2);
  assert.deepEqual([f.days[0].max, f.days[0].min, f.days[0].text], [11, 8, 'Partly cloudy']);
  assert.equal(f.days[0].rainMm, 0.8);
});

test('GOV.UK bank holidays, EA floods, carbon intensity', () => {
  const bh = { 'england-and-wales': { division: 'england-and-wales', events: [{ title: 'Boxing Day', date: '2026-12-28', notes: 'Substitute day', bunting: true }, { title: 'Christmas Day', date: '2026-12-25' }, { title: 'Summer bank holiday', date: '2026-08-31' }] } };
  assert.deepEqual(parseBankHolidays(bh, 'england-and-wales', '2026-11-03').map((e) => [e.title, e.daysAway]), [['Christmas Day', 52], ['Boxing Day', 55]]);

  const floods = { items: [
    { description: 'River Aire at Kirkstall', eaAreaName: 'Yorkshire', severity: 'Flood Alert', severityLevel: 3, timeRaised: '2026-11-03T08:00:00', floodArea: { county: 'West Yorkshire' } },
    { description: 'River Wharfe at Otley', severity: 'Flood Warning', severityLevel: 2, floodArea: { county: 'West Yorkshire' } },
    { description: 'Old', severity: 'Warning no Longer in Force', severityLevel: 4 },
  ] };
  assert.deepEqual(parseFloods(floods).map((f) => [f.level, f.area]), [[2, 'River Wharfe at Otley'], [3, 'River Aire at Kirkstall']]);

  const gb = parseCarbon({
    intensity: { data: [{ from: '2026-11-03T12:00Z', to: '2026-11-03T12:30Z', intensity: { forecast: 120, actual: 118, index: 'moderate' } }] },
    generation: { data: { generationmix: [{ fuel: 'gas', perc: 30.2 }, { fuel: 'wind', perc: 41.7 }, { fuel: 'coal', perc: 0 }] } },
  });
  assert.equal(gb.intensity.index, 'moderate');
  assert.deepEqual(gb.mix.map((m) => m.fuel), ['wind', 'gas']);
  const reg = parseCarbon({ regional: { data: [{ regionid: 4, dnoregion: 'Northern Powergrid Yorkshire', shortname: 'Yorkshire', data: [{ intensity: { forecast: 210, index: 'high' }, generationmix: [{ fuel: 'gas', perc: 55 }] }] }] } });
  assert.equal(reg.region, 'Yorkshire');
});

test('TfL lines, arrivals, roads', () => {
  const lines = parseTfl([
    { id: 'victoria', name: 'Victoria', modeName: 'tube', lineStatuses: [{ statusSeverity: 10, statusSeverityDescription: 'Good Service' }] },
    { id: 'central', name: 'Central', modeName: 'tube', lineStatuses: [{ statusSeverity: 9, statusSeverityDescription: 'Minor Delays', reason: 'Central Line: Minor delays due to an earlier signal failure.' }] },
  ]);
  assert.deepEqual(lines.map((l) => [l.name, l.status]), [['Central', 'Minor Delays'], ['Victoria', 'Good Service']]);
  const arr = parseArrivals([
    { lineName: '38', destinationName: 'Victoria', timeToStation: 420, stationName: 'Angel' },
    { lineName: '73', destinationName: 'Oxford Circus', timeToStation: 61, stationName: 'Angel' },
  ]);
  assert.equal(arr.stop, 'Angel');
  assert.deepEqual(arr.arrivals.map((a) => [a.line, a.minutes]), [['73', 1], ['38', 7]]);
  const roads = parseRoads([{ id: 'a2', displayName: 'A2', statusSeverity: 'Good', statusSeverityDescription: 'No Exceptional Delays' }, { id: 'a12', displayName: 'A12', statusSeverity: 'Serious', statusSeverityDescription: 'Serious Delays' }]);
  assert.equal(roads[0].name, 'A12');
});

test('National Rail via Huxley2, aircraft via adsb.lol', () => {
  const board = parseHuxley({
    locationName: 'Leeds', crs: 'LDS', nrccMessages: [{ value: '<p>Disruption between York and Leeds.</p>' }],
    trainServices: [
      { std: '14:05', etd: 'On time', platform: '12', operator: 'Northern', destination: [{ locationName: 'York', crs: 'YRK' }], isCancelled: false },
      { std: '14:12', etd: 'Cancelled', platform: null, operator: 'LNER', destination: [{ locationName: 'London Kings Cross' }], isCancelled: true },
    ],
  });
  assert.equal(board.station, 'Leeds');
  assert.equal(board.messages[0], 'Disruption between York and Leeds.');
  assert.deepEqual(board.services.map((s) => [s.time, s.destination, s.cancelled]), [['14:05', 'York', false], ['14:12', 'London Kings Cross', true]]);

  const planes = parseAircraft({ ac: [
    { hex: '4ca7b5', flight: 'RYR8AB  ', r: 'EI-DCL', t: 'B738', alt_baro: 24000, gs: 412, lat: 53.9, lon: -1.6 },
    { hex: '406b8c', flight: 'EXS42K', t: 'A321', alt_baro: 9025, lat: 53.81, lon: -1.56 },
    { hex: 'ground1', alt_baro: 'ground', lat: 53.8, lon: -1.55 },
  ] }, { lat: 53.8, lon: -1.55 });
  assert.deepEqual(planes.map((p) => p.callsign), ['EXS42K', 'RYR8AB']);
  assert.equal(planes[0].altitudeFt, 9000);
  assert.ok(planes[0].distanceKm < 2);
});

test('USGS, Frankfurter, Open Trivia DB, Wikimedia', () => {
  const q = parseQuakes({ features: [{ properties: { mag: 5.43, place: '80 km SW of Somewhere', time: 1793700000000, tsunami: 0 }, geometry: { coordinates: [1, 2, 10] } }] });
  assert.equal(q[0].mag, 5.4);
  assert.deepEqual(parseRates({ amount: 1, base: 'GBP', date: '2026-11-02', rates: { EUR: 1.18, USD: 1.31 } }).rates, [{ code: 'EUR', rate: 1.18 }, { code: 'USD', rate: 1.31 }]);

  const tdb = parseOpenTdb({ response_code: 0, results: [
    { type: 'multiple', difficulty: 'easy', category: 'Music', question: 'Which%20band%20sang%20%22Wonderwall%22%3F', correct_answer: 'Oasis', incorrect_answers: ['Blur', 'Pulp', 'Suede'] },
    { type: 'boolean', question: 'x', correct_answer: 'True', incorrect_answers: ['False'] },
  ] }, (o) => o.slice().reverse(), 'music');
  assert.equal(tdb.length, 1, 'true/false questions are skipped');
  assert.equal(tdb[0].q, 'Which band sang "Wonderwall"?');
  assert.equal(tdb[0].options[tdb[0].answer], 'Oasis');
  assert.throws(() => parseOpenTdb({ response_code: 5 }), /response code 5/);

  const potd = parsePotd({ image: {
    title: 'File:Sunset over the Pennines.jpg',
    thumbnail: { source: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Sunset.jpg/640px-Sunset.jpg', width: 640, height: 427 },
    image: { source: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Sunset.jpg', width: 6000, height: 4000 },
    artist: { text: 'Jane Photographer' }, license: { type: 'CC BY-SA 4.0' }, description: { text: 'Sunset over the <b>Pennines</b>' },
  } });
  assert.equal(potd.title, 'Sunset over the Pennines');
  assert.match(potd.src, /\/1920px-Sunset\.jpg$/);
  assert.equal(potd.description, 'Sunset over the Pennines');
  assert.deepEqual(parseBirths({ births: [{ text: 'Someone, actor', year: 1950 }, { text: 'Bad' }] }), [{ year: 1950, text: 'Someone, actor' }]);
});

test('widgets wire the sources together (fake network)', async () => {
  const responses = {
    'https://www.gov.uk/bank-holidays.json': { 'england-and-wales': { events: [{ title: 'Christmas Day', date: '2026-12-25' }] } },
    'https://api.carbonintensity.org.uk/intensity': { data: [{ intensity: { forecast: 90, index: 'low' } }] },
    'https://api.carbonintensity.org.uk/generation': { data: { generationmix: [{ fuel: 'wind', perc: 50 }] } },
  };
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.startsWith('https://api.met.no/')) return { ok: true, status: 200, json: async () => ({ properties: { timeseries: [{ time: '2026-11-03T12:00:00Z', data: { instant: { details: { air_temperature: 10, wind_speed: 3 } }, next_1_hours: { summary: { symbol_code: 'fair_day' } } } }] } }) };
    if (url.startsWith('https://api.tfl.gov.uk/Road')) return { ok: true, status: 200, json: async () => [{ id: 'a1', displayName: 'A1', statusSeverity: 'Good' }] };
    if (url.includes('/departures/LDS/')) return { ok: true, status: 200, json: async () => ({ locationName: 'Leeds', trainServices: [] }) };
    if (url.startsWith('https://club.example/feed')) return { ok: true, status: 200, text: async () => '<rss><channel><title>Club</title><item><title>Hello</title></item></channel></rss>' };
    if (responses[url]) return { ok: true, status: 200, json: async () => responses[url] };
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
  const w = createWidgets({
    config: { timezone: 'Europe/London', weather: { place: 'Leeds', latitude: 53.8, longitude: -1.55 }, widgets: { trains: { url: 'https://rail.example', token: 'secret' } } },
    fetchImpl, log: () => {}, lookup,
  });
  const now = new Date('2026-11-03T12:00:00Z');
  const weather = await w.get('weather', { days: 1 });
  assert.equal(weather.current.text, 'Fair');
  assert.match(weather.credit, /MET Norway/);
  assert.equal((await w.get('bankholiday', {}, now)).items[0].title, 'Christmas Day');
  assert.equal((await w.get('carbon', {})).intensity.index, 'low');
  assert.equal((await w.get('headlines', { url: 'https://club.example/feed' })).items[0].title, 'Hello');
  const hub = await w.get('transport', { sections: ['roads', 'trains', 'buses'], station: 'LDS' });
  assert.deepEqual(hub.sections.map((s) => s.key), ['trains', 'buses', 'roads']);
  assert.equal(hub.sections[0].title, 'Departures — Leeds');
  assert.match(hub.sections[1].error, /stop ID/);
  assert.ok(calls.some((u) => u === 'https://rail.example/departures/LDS/10?accessToken=secret'));
  assert.match((await w.get('quakes', {})).error, /Unavailable/);
  assert.equal(w.peek('sky', {}, now).sunrise, '07:09');
});

test('Bus Open Data Service SIRI-VM: routes near the ground', async () => {
  const va = (line, op, dest, lat, lon, vehicle, recorded = '2026-11-03T11:58:00+00:00') => `
    <VehicleActivity><RecordedAtTime>${recorded}</RecordedAtTime><MonitoredVehicleJourney>
      <LineRef>${line}</LineRef><OperatorRef>${op}</OperatorRef><DestinationName>${dest}</DestinationName>
      <VehicleLocation><Longitude>${lon}</Longitude><Latitude>${lat}</Latitude></VehicleLocation>
      <VehicleRef>${vehicle}</VehicleRef><PublishedLineName>${line}</PublishedLineName></MonitoredVehicleJourney></VehicleActivity>`;
  const xml = `<Siri xmlns="http://www.siri.org.uk/siri"><ServiceDelivery><VehicleMonitoringDelivery>
    ${va('73', 'GPLM', 'Bedford', 52.09, -0.27, '101')}
    ${va('74', 'GPLM', 'Biggleswade', 52.12, -0.40, '102')}
    ${va('74', 'GPLM', 'Biggleswade', 52.12, -0.40, '102')}
    ${va('9', 'XX', 'Elsewhere', 52.1, -0.3, '103')}
    ${va('73', 'GPLM', 'Old', 52.1, -0.3, '104', '2026-11-03T10:00:00+00:00')}
  </VehicleMonitoringDelivery></ServiceDelivery></Siri>`;
  const now = new Date('2026-11-03T12:00:00Z');
  const buses = parseSiriVm(xml, { lat: 52.087, lon: -0.264, lines: ['73', '74'], now });
  assert.deepEqual(buses.map((b) => [b.line, b.destination]), [['73', 'Bedford'], ['74', 'Biggleswade']], 'filtered, de-duplicated, stale dropped, nearest first');
  assert.equal(buses[0].minutesAgo, 2);
  assert.ok(buses[0].distanceKm < 1);
  assert.equal(buses[1].direction, 'W'); // ~9 km west, ~4 km north: bearing ≈ 292°

  const urls = [];
  const w = createWidgets({
    config: { timezone: 'Europe/London', weather: { place: 'Biggleswade', latitude: 52.087, longitude: -0.264 }, widgets: { bods: { apiKey: 'k3y' } } },
    fetchImpl: async (url) => { urls.push(url); return { ok: true, status: 200, text: async () => xml }; },
    log: () => {}, lookup,
  });
  const hub = await w.get('transport', { sections: ['tracker'], trackLines: ['73', '74'], trackRadius: 20 });
  assert.equal(hub.sections[0].key, 'tracker');
  assert.match(urls[0], /^https:\/\/data\.bus-data\.dft\.gov\.uk\/api\/v1\/datafeed\/\?boundingBox=-0\.55\d+,51\.90\d+,0\.0\d+,52\.26\d+&lineRef=73&api_key=k3y$/);
  const noKey = createWidgets({ config: { timezone: 'Europe/London', weather: { latitude: 52, longitude: 0 } }, fetchImpl: async () => ({}), log: () => {}, lookup });
  assert.match(noKey.peek('transport', { sections: ['tracker'], trackLines: ['73'] }).sections[0].error, /API key/);
});
