/**
 * /api/analytics — consolidated analytics handler.
 * Routes: /api/analytics/traffic | data | export | zones
 * Routed via vercel.json rewrites: /api/analytics/:r → /api/analytics?_route=:r
 */

export default async function handler(req, res) {
  const route = req.query._route || "";

  switch (route) {
    case "traffic": return handleTraffic(req, res);
    case "data":    return handleData(req, res);
    case "export":  return handleExport(req, res);
    case "zones":   return handleZones(req, res);
    default:        return res.status(404).json({ error: `Unknown analytics route: ${route}` });
  }
}

// ── Shared helpers ─────────────────────────────────────────────────────────────

/** Prevent CSV formula injection by prefixing cells that start with formula chars. */
function _csvSanitize(value) {
  const s = String(value == null ? "" : value);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

function _parseDate(s, fallback) {
  if (!s) return fallback;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function getEnv(res) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    res.status(500).json({ error: "Server misconfiguration" });
    return null;
  }
  return { SUPABASE_URL, SERVICE_KEY };
}

function sbHeaders(SERVICE_KEY) {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json",
  };
}

// ── /api/analytics/traffic ────────────────────────────────────────────────────

async function handleTraffic(req, res) {
  if (req.method !== "GET")
    return res.status(405).json({ error: "Method not allowed" });

  const env = getEnv(res);
  if (!env) return;
  const { SUPABASE_URL, SERVICE_KEY } = env;
  const headers = sbHeaders(SERVICE_KEY);

  const { camera_id, hours = "24", from, to, granularity = "hour" } = req.query;

  let fromISO, toISO;
  if (from || to) {
    const fd = _parseDate(from, new Date(0));
    const td = _parseDate(to,   new Date());
    if (!fd || !td)
      return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD or ISO 8601." });
    fromISO = fd.toISOString();
    toISO   = td.toISOString();
  } else {
    const hoursInt = Math.min(Math.max(1, parseInt(hours, 10) || 24), 8760); // cap at 1 year
    toISO   = new Date().toISOString();
    fromISO = new Date(Date.now() - hoursInt * 3600 * 1000).toISOString();
  }

  try {
    let rows = [];

    if (granularity === "day" || granularity === "week") {
      const fromDate = fromISO.slice(0, 10);
      const toDate   = toISO.slice(0, 10);
      let url = `${SUPABASE_URL}/rest/v1/traffic_daily`
        + `?date=gte.${fromDate}&date=lte.${toDate}`
        + `&order=date.asc`;
      if (camera_id) url += `&camera_id=eq.${encodeURIComponent(camera_id)}`;

      const [r, outMap] = await Promise.all([
        fetch(url, { headers }),
        _outboundCounts(SUPABASE_URL, headers, camera_id, fromISO, toISO, granularity),
      ]);
      const dailyRows = r.ok ? (await r.json()) : [];

      if (granularity === "week") {
        const weeks = {};
        for (const d of dailyRows) {
          const monday = _getMondayISO(d.date);
          if (!weeks[monday]) weeks[monday] = { period: monday, total: 0, car: 0, truck: 0, bus: 0, motorcycle: 0, in: 0, out: 0, avg_queue: 0, avg_speed: 0, _q_sum: 0, _q_n: 0, _s_sum: 0, _s_n: 0 };
          const w = weeks[monday];
          w.total      += d.total_crossings  || 0;
          w.car        += d.car_count        || 0;
          w.truck      += d.truck_count      || 0;
          w.bus        += d.bus_count        || 0;
          w.motorcycle += d.motorcycle_count || 0;
          w.in         += d.count_in         || 0;
          w.out        += d.count_out        || 0;
          if (d.avg_queue_depth != null) { w._q_sum += parseFloat(d.avg_queue_depth); w._q_n += 1; }
          if (d.avg_speed_kmh   != null) { w._s_sum += parseFloat(d.avg_speed_kmh);   w._s_n += 1; }
        }
        rows = Object.values(weeks).map(w => ({
          period: w.period, total: w.total, car: w.car, truck: w.truck, bus: w.bus, motorcycle: w.motorcycle,
          in: w.in, out: outMap[w.period] ?? w.out,
          avg_queue: w._q_n > 0 ? +(w._q_sum / w._q_n).toFixed(2) : null,
          avg_speed: w._s_n > 0 ? +(w._s_sum / w._s_n).toFixed(1) : null,
        })).sort((a, b) => a.period.localeCompare(b.period));
      } else {
        rows = dailyRows.map(d => ({
          period: d.date, total: d.total_crossings, car: d.car_count, truck: d.truck_count,
          bus: d.bus_count, motorcycle: d.motorcycle_count, in: d.count_in, out: outMap[d.date] ?? d.count_out ?? 0,
          avg_queue: d.avg_queue_depth, avg_speed: d.avg_speed_kmh,
          peak_queue: d.peak_queue_depth, peak_hour: d.peak_hour,
        }));
      }

      if (rows.length === 0)
        rows = await _hourlyFallback(SUPABASE_URL, headers, camera_id, fromISO, toISO, "day");
    } else {
      rows = await _hourlyData(SUPABASE_URL, headers, camera_id, fromISO, toISO);
    }

    let periodTotal = 0, peakPeriod = null, peakVal = 0;
    const classTotals = { car: 0, truck: 0, bus: 0, motorcycle: 0 };
    const qDepths = [], speeds = [];
    for (const r of rows) {
      const t = r.total || 0;
      periodTotal += t;
      if (t > peakVal) { peakVal = t; peakPeriod = r.period || r.hour; }
      classTotals.car        += r.car        || 0;
      classTotals.truck      += r.truck      || 0;
      classTotals.bus        += r.bus        || 0;
      classTotals.motorcycle += r.motorcycle || 0;
      if (r.avg_queue != null) qDepths.push(parseFloat(r.avg_queue));
      if (r.avg_speed != null) speeds.push(parseFloat(r.avg_speed));
    }

    const grand    = Object.values(classTotals).reduce((a, b) => a + b, 0) || 1;
    const classPct = Object.fromEntries(
      Object.entries(classTotals).map(([k, v]) => [k, Math.round((v / grand) * 100)])
    );

    const [globalTotals, firstDate] = await Promise.all([
      _globalTotals(SUPABASE_URL, headers, camera_id),
      _firstDate(SUPABASE_URL, headers, camera_id),
    ]);

    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=30");
    return res.status(200).json({
      rows,
      summary: {
        period_total:    periodTotal,
        peak_period:     peakPeriod,
        peak_value:      peakVal,
        class_totals:    classTotals,
        class_pct:       classPct,
        avg_queue_depth: qDepths.length > 0 ? +(qDepths.reduce((a, b) => a + b, 0) / qDepths.length).toFixed(2) : null,
        peak_queue_depth: qDepths.length > 0 ? Math.max(...qDepths) : null,
        avg_speed_kmh:   speeds.length > 0   ? +(speeds.reduce((a, b) => a + b, 0) / speeds.length).toFixed(1) : null,
        global:          globalTotals,
        first_date:      firstDate,
        granularity,
        from: fromISO,
        to:   toISO,
      },
    });
  } catch (err) {
    console.error("[/api/analytics/traffic]", err);
    return res.status(502).json({ error: "Analytics query failed" });
  }
}

async function _hourlyData(SUPABASE_URL, headers, camera_id, fromISO, toISO) {
  const [rpcRes, outMap] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/rpc/analytics_traffic_hourly`, {
      method: "POST", headers,
      body: JSON.stringify({ p_camera_id: camera_id || null, p_since: fromISO }),
    }),
    _outboundCounts(SUPABASE_URL, headers, camera_id, fromISO, toISO, "hour"),
  ]);
  if (rpcRes.ok) {
    const rows = await rpcRes.json();
    if (rows && rows.length > 0)
      return rows.map(r => {
        const key = new Date(r.hour).toISOString().slice(0, 13) + ":00:00Z";
        return { ...r, period: r.hour, out: outMap[key] ?? 0 };
      });
  }
  // RPC only covers live vehicle_crossings (24h retention).
  // Try unpacking hour_buckets from traffic_daily for historical requests.
  const hist = await _hourlyFromDailyBuckets(SUPABASE_URL, headers, camera_id, fromISO, toISO);
  if (hist.length > 0) return hist;
  return _hourlyFallback(SUPABASE_URL, headers, camera_id, fromISO, toISO, "hour", outMap);
}

/**
 * Build hourly rows from traffic_daily.hour_buckets for date ranges beyond live retention.
 * Each bucket key is a string hour "0"-"23"; we reconstruct full ISO timestamps per date.
 */
async function _hourlyFromDailyBuckets(SUPABASE_URL, headers, camera_id, fromISO, toISO) {
  try {
    const fromDate = fromISO.slice(0, 10);
    const toDate   = toISO.slice(0, 10);
    let url = `${SUPABASE_URL}/rest/v1/traffic_daily`
      + `?select=date,hour_buckets`
      + `&date=gte.${fromDate}&date=lte.${toDate}`
      + `&hour_buckets=not.is.null`
      + `&order=date.asc`;
    if (camera_id) url += `&camera_id=eq.${encodeURIComponent(camera_id)}`;
    const r = await fetch(url, { headers });
    if (!r.ok) return [];
    const dailyRows = await r.json();
    if (!dailyRows || dailyRows.length === 0) return [];

    const result = [];
    for (const d of dailyRows) {
      if (!d.hour_buckets || typeof d.hour_buckets !== "object") continue;
      for (const [hStr, hv] of Object.entries(d.hour_buckets)) {
        const h = parseInt(hStr, 10);
        if (isNaN(h) || h < 0 || h > 23) continue;
        const period = `${d.date}T${String(h).padStart(2, "0")}:00:00Z`;
        result.push({
          period,
          total:      hv.total      || 0,
          in:         hv.in         || 0,
          out:        hv.out        || 0,
          car:        hv.car        || 0,
          truck:      hv.truck      || 0,
          bus:        hv.bus        || 0,
          motorcycle: hv.motorcycle || 0,
        });
      }
    }
    return result.sort((a, b) => a.period.localeCompare(b.period));
  } catch { return []; }
}

async function _hourlyFallback(SUPABASE_URL, headers, camera_id, fromISO, toISO, targetGranularity, outMap) {
  if (!outMap) outMap = await _outboundCounts(SUPABASE_URL, headers, camera_id, fromISO, toISO, targetGranularity);
  let url = `${SUPABASE_URL}/rest/v1/vehicle_crossings`
    + `?select=captured_at,vehicle_class,direction,zone_source,track_id`
    + `&captured_at=gte.${encodeURIComponent(fromISO)}`
    + `&captured_at=lte.${encodeURIComponent(toISO)}`
    + `&zone_source=eq.entry`;  // entry only — game zone double-counts the same vehicles
  if (camera_id) url += `&camera_id=eq.${encodeURIComponent(camera_id)}`;
  const r = await fetch(url, { headers });
  if (!r.ok) return [];
  const rows = await r.json();
  // Deduplicate: count each track_id only once per bucket (first occurrence)
  const seen = new Set();
  const buckets = {};
  for (const row of rows) {
    const dt  = new Date(row.captured_at);
    const key = targetGranularity === "hour"
      ? dt.toISOString().slice(0, 13) + ":00:00Z"
      : dt.toISOString().slice(0, 10);
    const dedupeKey = row.track_id != null ? `${key}:${row.track_id}` : null;
    if (dedupeKey && seen.has(dedupeKey)) continue;
    if (dedupeKey) seen.add(dedupeKey);
    if (!buckets[key]) buckets[key] = { period: key, total: 0, car: 0, truck: 0, bus: 0, motorcycle: 0, in: 0, out: 0 };
    buckets[key].total += 1;
    const cls = (row.vehicle_class || "car").toLowerCase();
    if (cls in buckets[key]) buckets[key][cls] += 1;
    if (row.direction === "in")  buckets[key].in  += 1;
    if (row.direction === "out") buckets[key].out += 1;
  }
  // Merge outbound counts from turning_movements
  for (const [key, val] of Object.entries(outMap)) {
    if (buckets[key]) buckets[key].out = val;
  }
  return Object.values(buckets).sort((a, b) => a.period.localeCompare(b.period));
}

// Returns a map of { period_key → outbound_count } by bucketing turning_movements via RPC
async function _outboundCounts(SUPABASE_URL, headers, camera_id, fromISO, toISO, targetGranularity) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/analytics_turnings_hourly`, {
      method: "POST", headers,
      body: JSON.stringify({ p_camera_id: camera_id || null, p_since: fromISO, p_until: toISO }),
    });
    if (!res.ok) return {};
    const rows = await res.json();
    const map = {};
    for (const r of rows) {
      const h = r.hour; // ISO string "2026-03-08T14:00:00+00:00"
      const key = targetGranularity === "hour"
        ? new Date(h).toISOString().slice(0, 13) + ":00:00Z"
        : targetGranularity === "day"
          ? new Date(h).toISOString().slice(0, 10)
          : _getMondayISO(new Date(h).toISOString().slice(0, 10));
      map[key] = (map[key] || 0) + Number(r.total || 0);
    }
    return map;
  } catch { return {}; }
}

async function _firstDate(SUPABASE_URL, headers, camera_id) {
  try {
    // Try traffic_daily first (fast, aggregated)
    let url = `${SUPABASE_URL}/rest/v1/traffic_daily?select=date&order=date.asc&limit=1`;
    if (camera_id) url += `&camera_id=eq.${encodeURIComponent(camera_id)}`;
    const r = await fetch(url, { headers });
    if (r.ok) {
      const rows = await r.json();
      if (rows[0]?.date) return rows[0].date;
    }
    // Fallback: oldest vehicle_crossings row (table may be new, traffic_daily not yet populated)
    let vcUrl = `${SUPABASE_URL}/rest/v1/vehicle_crossings?select=captured_at&zone_source=in.(entry,game)&order=captured_at.asc&limit=1`;
    if (camera_id) vcUrl += `&camera_id=eq.${encodeURIComponent(camera_id)}`;
    const vcr = await fetch(vcUrl, { headers });
    if (!vcr.ok) return null;
    const vcRows = await vcr.json();
    return vcRows[0]?.captured_at?.slice(0, 10) || null;
  } catch { return null; }
}

async function _globalTotals(SUPABASE_URL, headers, camera_id) {
  try {
    // Sum all complete days from traffic_daily (permanent aggregated store)
    let dailyUrl = `${SUPABASE_URL}/rest/v1/traffic_daily?select=total_crossings`;
    if (camera_id) dailyUrl += `&camera_id=eq.${encodeURIComponent(camera_id)}`;
    const dr = await fetch(dailyUrl, { headers });
    let historicalTotal = 0;
    if (dr.ok) {
      const rows = await dr.json();
      historicalTotal = rows.reduce((sum, r) => sum + (r.total_crossings || 0), 0);
    }

    // Add today's live crossings (not yet in traffic_daily — aggregated at midnight)
    const todayMidnight = new Date().toISOString().slice(0, 10) + "T00:00:00Z";
    let liveUrl = `${SUPABASE_URL}/rest/v1/vehicle_crossings?select=id&zone_source=eq.entry&captured_at=gte.${encodeURIComponent(todayMidnight)}&limit=1`;
    if (camera_id) liveUrl += `&camera_id=eq.${encodeURIComponent(camera_id)}`;
    const lr = await fetch(liveUrl, { headers: { ...headers, Prefer: "count=exact" } });
    let liveCount = 0;
    if (lr.ok) {
      const range = lr.headers.get("Content-Range");
      liveCount = range ? (parseInt(range.split("/")[1]) || 0) : 0;
    }

    return { total: historicalTotal + liveCount };
  } catch { return null; }
}

function _getMondayISO(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return d.toISOString().slice(0, 10);
}

// ── /api/analytics/data ───────────────────────────────────────────────────────

async function handleData(req, res) {
  const env = getEnv(res);
  if (!env) return;
  const { SUPABASE_URL, SERVICE_KEY } = env;

  const { type } = req.query;
  if (type === "zones")    return _handleDataZones(req, res, SUPABASE_URL, SERVICE_KEY);
  if (type === "turnings") return _handleDataTurnings(req, res, SUPABASE_URL, SERVICE_KEY);
  return res.status(400).json({ error: "type must be 'zones' or 'turnings'" });
}

async function _handleDataZones(req, res, SUPABASE_URL, SERVICE_KEY) {
  const headers = { ...sbHeaders(SERVICE_KEY), Prefer: "return=representation" };

  if (req.method === "GET") {
    const { camera_id } = req.query;
    let url = `${SUPABASE_URL}/rest/v1/camera_zones?active=eq.true&select=id,name,zone_type,points,metadata,color,created_at`;
    if (camera_id) url += `&camera_id=eq.${encodeURIComponent(camera_id)}`;
    url += "&order=created_at.asc";
    try {
      const r = await fetch(url, { headers });
      if (!r.ok) {
        console.error("[zones GET] Supabase error:", await r.text());
        return res.status(502).json({ error: "Zone query failed" });
      }
      return res.status(200).json(await r.json());
    } catch (err) {
      console.error("[zones GET]", err);
      return res.status(502).json({ error: "Zone query failed" });
    }
  }

  if (req.method === "POST" || req.method === "DELETE") {
    // Zone writes require admin authentication.
    const authHeader = req.headers.authorization || "";
    const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
    if (!jwt) return res.status(401).json({ error: "Authentication required" });
    try {
      const verifyRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${jwt}` },
      });
      if (!verifyRes.ok) return res.status(401).json({ error: "Invalid or expired token" });
      const user = await verifyRes.json();
      if (user?.app_metadata?.role !== "admin")
        return res.status(403).json({ error: "Admin role required" });
    } catch {
      return res.status(401).json({ error: "Token verification failed" });
    }
  }

  if (req.method === "POST") {
    const { camera_id, zones } = req.body || {};
    if (!camera_id || !Array.isArray(zones) || !zones.length)
      return res.status(400).json({ error: "camera_id and zones[] required" });

    const VALID_ZONE_TYPES = new Set(["detection", "counting", "entry", "exit", "exclusion"]);
    let rows;
    try {
      rows = zones.slice(0, 50).map(z => {
        if (!VALID_ZONE_TYPES.has(z.zone_type)) throw new Error("Invalid zone_type");
        if (typeof z.name !== "string" || z.name.length > 100) throw new Error("Invalid name");
        if (!Array.isArray(z.points) || z.points.length > 200) throw new Error("Invalid points");
        const colorHex = /^#[0-9a-fA-F]{3,8}$/.test(z.color || "") ? z.color : null;
        return { camera_id, zone_type: z.zone_type, name: z.name.slice(0, 100),
                 points: z.points, metadata: null, color: colorHex, active: true };
      });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/camera_zones`, {
        method: "POST", headers, body: JSON.stringify(rows),
      });
      if (!r.ok) {
        console.error("[zones POST] Supabase error:", await r.text());
        return res.status(502).json({ error: "Zone write failed" });
      }
      return res.status(201).json(await r.json());
    } catch (err) {
      console.error("[zones POST]", err);
      return res.status(502).json({ error: "Zone write failed" });
    }
  }

  if (req.method === "DELETE") {
    const { zone_id } = req.query;
    if (!zone_id) return res.status(400).json({ error: "zone_id required" });
    try {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/camera_zones?id=eq.${encodeURIComponent(zone_id)}`,
        { method: "PATCH", headers, body: JSON.stringify({ active: false }) }
      );
      if (!r.ok) {
        console.error("[zones DELETE] Supabase error:", await r.text());
        return res.status(502).json({ error: "Zone update failed" });
      }
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error("[zones DELETE]", err);
      return res.status(502).json({ error: "Zone update failed" });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}

async function _handleDataTurnings(req, res, SUPABASE_URL, SERVICE_KEY) {
  if (req.method !== "GET")
    return res.status(405).json({ error: "Method not allowed" });

  const { camera_id, from, to, granularity = "hour" } = req.query;
  const toDate   = _parseDate(to,   new Date());
  const fromDate = _parseDate(from, new Date(toDate - 24 * 3600 * 1000));
  if (!fromDate || !toDate)
    return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD or ISO 8601." });
  const fromISO  = fromDate.toISOString();
  const toISO    = toDate.toISOString();

  function _bucketKey(isoStr) {
    const d = new Date(isoStr);
    if (granularity === "day")  return d.toISOString().slice(0, 10);
    if (granularity === "week") {
      const day  = d.getUTCDay();
      const mon  = new Date(d);
      mon.setUTCDate(d.getUTCDate() + (day === 0 ? -6 : 1 - day));
      return mon.toISOString().slice(0, 10);
    }
    return d.toISOString().slice(0, 13) + ":00:00Z";
  }

  const h = sbHeaders(SERVICE_KEY);

  try {
    const rpcBase = { method: "POST", headers: h };

    // Fetch hourly time series + entry→exit matrix via pre-aggregated RPCs (avoid 1000-row PostgREST cap)
    // Also get exact total count in parallel
    const tmCountBase = `${SUPABASE_URL}/rest/v1/turning_movements`
      + `?captured_at=gte.${encodeURIComponent(fromISO)}`
      + `&captured_at=lte.${encodeURIComponent(toISO)}`
      + (camera_id ? `&camera_id=eq.${encodeURIComponent(camera_id)}` : "");

    const [hourlyRes, matrixRes, tmCountRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/rpc/analytics_turnings_hourly`, {
        ...rpcBase,
        body: JSON.stringify({ p_camera_id: camera_id || null, p_since: fromISO, p_until: toISO }),
      }),
      fetch(`${SUPABASE_URL}/rest/v1/rpc/analytics_turnings_matrix`, {
        ...rpcBase,
        body: JSON.stringify({ p_camera_id: camera_id || null, p_since: fromISO, p_until: toISO }),
      }),
      fetch(tmCountBase + `&select=id&limit=1`, { headers: { ...h, Prefer: "count=exact" } }),
    ]);

    const hourlyRows = hourlyRes.ok ? await hourlyRes.json() : [];
    const matrixRows = matrixRes.ok ? await matrixRes.json() : [];
    const tmCountRange = tmCountRes.headers?.get("Content-Range") || "";
    const totalMovements = parseInt(tmCountRange.split("/")[1] || "") || 0;

    // Build matrix object from RPC results
    const matrix = {};
    const clsTotals = { car: 0, truck: 0, bus: 0, motorcycle: 0 };
    for (const r of matrixRows) {
      const key = `${r.entry_zone}→${r.exit_zone}`;
      matrix[key] = {
        from: r.entry_zone, to: r.exit_zone,
        total: Number(r.total), car: Number(r.car), truck: Number(r.truck),
        bus: Number(r.bus), motorcycle: Number(r.motorcycle),
        avg_dwell_ms: Number(r.avg_dwell_ms) || 0,
      };
      for (const cls of ["car","truck","bus","motorcycle"])
        clsTotals[cls] += Number(r[cls]) || 0;
    }

    // Build time buckets from hourly RPC, re-bucket to day/week if needed
    const timeBuckets = {};
    for (const r of hourlyRows) {
      const bucket = _bucketKey(r.hour);
      if (!timeBuckets[bucket]) timeBuckets[bucket] = { period: bucket, total: 0, car: 0, truck: 0, bus: 0, motorcycle: 0 };
      timeBuckets[bucket].total      += Number(r.total);
      timeBuckets[bucket].car        += Number(r.car);
      timeBuckets[bucket].truck      += Number(r.truck);
      timeBuckets[bucket].bus        += Number(r.bus);
      timeBuckets[bucket].motorcycle += Number(r.motorcycle);
    }

    const _qFetch = (from, to) => {
      let u = `${SUPABASE_URL}/rest/v1/traffic_snapshots`
        + `?select=captured_at,queue_depth,total_visible`
        + `&captured_at=gte.${encodeURIComponent(from)}`
        + `&captured_at=lte.${encodeURIComponent(to)}&order=captured_at.asc`;
      if (camera_id) u += `&camera_id=eq.${encodeURIComponent(camera_id)}`;
      return fetch(u, { headers: h }).then(r => r.ok ? r.json() : []);
    };
    let qRows = await _qFetch(fromISO, toISO);
    // If primary window returns nothing, fall back to last 7 days so the chart is never empty
    if (!qRows.length) {
      const fallbackFrom = new Date(toDate - 7 * 24 * 3600 * 1000).toISOString();
      qRows = await _qFetch(fallbackFrom, toISO);
    }
    const queueSeries  = qRows.map(r => ({ ts: r.captured_at, depth: r.queue_depth || 0, visible: r.total_visible || 0 }));
    const depths       = queueSeries.map(r => r.depth);
    // Average only periods where a queue actually formed (depth > 0); zeros mean backend idle / no queue
    const activeDepths = depths.filter(d => d > 0);
    const queueSummary = depths.length > 0
      ? { avg: activeDepths.length > 0 ? +(activeDepths.reduce((a, b) => a + b, 0) / activeDepths.length).toFixed(2) : 0,
          peak: Math.max(...depths), samples: depths.length, active_samples: activeDepths.length }
      : { avg: 0, peak: 0, samples: 0 };

    let speedUrl = `${SUPABASE_URL}/rest/v1/vehicle_crossings`
      + `?select=speed_kmh&speed_kmh=not.is.null`
      + `&captured_at=gte.${encodeURIComponent(fromISO)}`
      + `&captured_at=lte.${encodeURIComponent(toISO)}`;
    if (camera_id) speedUrl += `&camera_id=eq.${encodeURIComponent(camera_id)}`;

    const spRows   = await fetch(speedUrl, { headers: h }).then(r => r.ok ? r.json() : []);
    const speeds   = spRows.map(r => r.speed_kmh).filter(s => s > 0 && s < 300).sort((a, b) => a - b);
    const speedStats = speeds.length > 0
      ? { avg_kmh: +(speeds.reduce((a, b) => a + b, 0) / speeds.length).toFixed(1), p85_kmh: speeds[Math.floor(speeds.length * 0.85)] || null, min_kmh: speeds[0], max_kmh: speeds[speeds.length - 1], samples: speeds.length }
      : null;

    // Downsample queue_series to max 50 evenly-spaced points to keep response small
    const _downsample = (arr, maxPts) => {
      if (arr.length <= maxPts) return arr;
      const step = arr.length / maxPts;
      return Array.from({ length: maxPts }, (_, i) => arr[Math.round(i * step)]);
    };

    return res.status(200).json({
      matrix,
      top_movements: Object.values(matrix).sort((a, b) => b.total - a.total).slice(0, 10),
      queue_series: _downsample(queueSeries, 50), queue_summary: queueSummary,
      speed: speedStats, class_totals: clsTotals,
      time_series: Object.values(timeBuckets).sort((a, b) => a.period.localeCompare(b.period)),
      period: { from: fromISO, to: toISO, total_movements: totalMovements },
    });
  } catch (err) {
    console.error("[/api/analytics/data?type=turnings]", err);
    return res.status(502).json({ error: "Analytics query failed" });
  }
}

// ── /api/analytics/export ─────────────────────────────────────────────────────

async function handleExport(req, res) {
  if (req.method !== "GET")
    return res.status(405).json({ error: "Method not allowed" });

  const authHeader = req.headers.authorization || "";
  const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!jwt) return res.status(401).json({ error: "Authentication required" });

  const env = getEnv(res);
  if (!env) return;
  const { SUPABASE_URL, SERVICE_KEY } = env;

  try {
    const verifyRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${jwt}` },
    });
    if (!verifyRes.ok) return res.status(401).json({ error: "Invalid or expired token" });
    const user = await verifyRes.json();
    if (user?.app_metadata?.role !== "admin")
      return res.status(403).json({ error: "Admin role required for data export" });
  } catch {
    return res.status(401).json({ error: "Token verification failed" });
  }

  const { camera_id, from, to } = req.query;
  const _fd = _parseDate(from, new Date(Date.now() - 24 * 3600 * 1000));
  const _td = _parseDate(to,   new Date());
  if (!_fd || !_td)
    return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD or ISO 8601." });
  const fromDate = _fd.toISOString();
  const toDate   = _td.toISOString();
  const dateStr  = fromDate.slice(0, 10);
  const headers  = sbHeaders(SERVICE_KEY);

  // ── 90-day range guard ──────────────────────────────────────────────────────
  const diffDays = (_td - _fd) / 86400000;
  if (diffDays > 90)
    return res.status(400).json({ error: "Date range exceeds 90 days. Narrow your selection and try again." });

  try {
    // Select only vehicle classes; include track_id for deduplication
    let url = `${SUPABASE_URL}/rest/v1/vehicle_crossings`
      + `?select=captured_at,track_id,vehicle_class,direction,confidence,scene_lighting,scene_weather,dwell_frames,cameras(name)`
      + `&vehicle_class=in.(car,truck,bus,motorcycle)`
      + `&captured_at=gte.${encodeURIComponent(fromDate)}`
      + `&captured_at=lte.${encodeURIComponent(toDate)}`
      + `&order=captured_at.asc&limit=50000`;
    if (camera_id) url += `&camera_id=eq.${encodeURIComponent(camera_id)}`;

    const dataRes = await fetch(url, { headers });
    if (!dataRes.ok) return res.status(502).json({ error: "Data query failed" });
    const rows = await dataRes.json();

    // ── Deduplicate by track_id (first occurrence per unique vehicle) ─────────
    const seenTracks = new Set();
    const deduped = rows.filter(r => {
      if (!r.track_id) return true;            // rows without track_id always included
      if (seenTracks.has(r.track_id)) return false;
      seenTracks.add(r.track_id); return true;
    });

    if (deduped.length === 0) {
      // Fallback: generate daily summary CSV from traffic_daily (permanent aggregated store)
      // This covers dates older than 7 days where vehicle_crossings has been pruned.
      let dailyUrl = `${SUPABASE_URL}/rest/v1/traffic_daily`
        + `?select=date,total_crossings,count_in,count_out,cameras(name)`
        + `&date=gte.${encodeURIComponent(fromDate.slice(0, 10))}`
        + `&date=lte.${encodeURIComponent(toDate.slice(0, 10))}`
        + `&order=date.asc`;
      if (camera_id) dailyUrl += `&camera_id=eq.${encodeURIComponent(camera_id)}`;
      const dailyRes = await fetch(dailyUrl, { headers });
      const dailyRows = dailyRes.ok ? await dailyRes.json() : [];
      if (dailyRows.length === 0)
        return res.status(204).end();  // truly no data

      const csvLines = ["date,camera,total,inbound,outbound"];
      for (const r of dailyRows) {
        csvLines.push([
          _csvSanitize(r.date),
          _csvSanitize((r.cameras?.name || "").replace(/,/g, ";")),
          r.total_crossings ?? "",
          r.count_in  ?? "",
          r.count_out ?? "",
        ].join(","));
      }
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="traffic-${dateStr}.csv"`);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Total-Rows", String(dailyRows.length));
      return res.status(200).send(csvLines.join("\n"));
    }

    const csvLines = ["timestamp,camera,vehicle_class,direction,confidence,scene_lighting,scene_weather,dwell_frames,track_id"];
    for (const r of deduped) {
      csvLines.push([
        _csvSanitize(r.captured_at),
        _csvSanitize((r.cameras?.name || "").replace(/,/g, ";")),
        _csvSanitize(r.vehicle_class),
        _csvSanitize(r.direction),
        r.confidence != null ? r.confidence : "",
        _csvSanitize(r.scene_lighting),
        _csvSanitize(r.scene_weather),
        r.dwell_frames != null ? r.dwell_frames : "",
        _csvSanitize(r.track_id),
      ].join(","));
    }

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="traffic-${dateStr}.csv"`);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Total-Rows", String(deduped.length));
    return res.status(200).send(csvLines.join("\n"));
  } catch (err) {
    console.error("[/api/analytics/export]", err);
    return res.status(502).json({ error: "Export failed" });
  }
}

// ── /api/analytics/zones ──────────────────────────────────────────────────────

async function handleZones(req, res) {
  if (req.method !== "GET")
    return res.status(405).json({ error: "Method not allowed" });

  const env = getEnv(res);
  if (!env) return;
  const { SUPABASE_URL, SERVICE_KEY } = env;
  const headers = sbHeaders(SERVICE_KEY);

  const { camera_id, from, to } = req.query;

  const toISO   = to   ? new Date(to).toISOString()   : new Date().toISOString();
  const fromISO = from ? new Date(from).toISOString()
                       : new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  try {
    let url = `${SUPABASE_URL}/rest/v1/vehicle_crossings`
      + `?select=zone_name,vehicle_class&zone_source=in.(entry,game)`
      + `&captured_at=gte.${encodeURIComponent(fromISO)}`
      + `&captured_at=lte.${encodeURIComponent(toISO)}`;
    if (camera_id) url += `&camera_id=eq.${encodeURIComponent(camera_id)}`;

    const r = await fetch(url, { headers });
    if (!r.ok) return res.status(502).json({ error: "DB query failed" });
    const rows = await r.json();

    const zones = {};
    for (const row of rows) {
      const name = row.zone_name || "Unknown";
      if (!zones[name]) zones[name] = { zone_name: name, total: 0, car: 0, truck: 0, bus: 0, motorcycle: 0 };
      zones[name].total += 1;
      const cls = (row.vehicle_class || "car").toLowerCase();
      if (cls in zones[name]) zones[name][cls] += 1;
      else zones[name].car += 1;
    }

    const periodTotal = rows.length;
    const zoneList = Object.values(zones)
      .sort((a, b) => b.total - a.total)
      .map(z => ({ ...z, pct_of_total: periodTotal > 0 ? Math.round((z.total / periodTotal) * 100) : 0 }));

    return res.status(200).json({ zones: zoneList, period_total: periodTotal, from: fromISO, to: toISO });
  } catch (err) {
    console.error("[/api/analytics/zones]", err);
    return res.status(502).json({ error: "Zone analytics query failed" });
  }
}
