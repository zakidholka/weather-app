import { useState, useEffect, useMemo, useRef, memo } from "react";
import {
  Search, LocateFixed, MapPin, Thermometer, Droplets, Wind, Sun, Moon, Leaf, Sunrise, RefreshCw, Star, X, ChevronLeft, ChevronRight, Umbrella,
  CloudSun, CloudMoon, Cloud, CloudFog, CloudDrizzle, CloudRain, CloudSnow, CloudLightning,
} from "lucide-react";
import "./App.css";

/* =====================================================================
   API  (Open-Meteo, no key needed)
   ===================================================================== */
const DEFAULT_PLACE = { name: "Faisalabad", country: "Pakistan", latitude: 31.4181, longitude: 73.0776 };
const rd = Math.round;

async function fetchWeather({ latitude, longitude }, unit, signal) {
  const params = new URLSearchParams({
    latitude, longitude, timezone: "auto", forecast_days: 7,
    temperature_unit: unit,
    wind_speed_unit: unit === "fahrenheit" ? "mph" : "kmh",
    current: "temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,wind_direction_10m,weather_code,is_day,surface_pressure",
    hourly: "temperature_2m,precipitation_probability,weather_code,is_day,wind_speed_10m,relative_humidity_2m",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset,uv_index_max",
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal });
  if (!res.ok) throw new ApiError("The weather service is having trouble. Try again in a moment.");
  return res.json();
}

async function searchCities(name, signal) {
  const res = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=5`,
    { signal }
  );
  if (!res.ok) return [];
  return (await res.json()).results || [];
}

class ApiError extends Error { name = "ApiError"; }

/* =====================================================================
   Hooks
   ===================================================================== */
function usePersisted(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      const saved = localStorage.getItem(key);
      return saved ? JSON.parse(saved) : initial;
    } catch { return initial; }
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  }, [key, value]);
  return [value, setValue];
}

// Loads the forecast for the chosen place. Data is tagged with the place it belongs to,
// so one city's weather is never shown under another city's name.
function useWeather(place, unit) {
  const key = `${place.latitude},${place.longitude},${unit}`;
  const [state, setState] = useState({ data: null, key: "", status: "loading", error: "" });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
    setState((s) => ({ ...s, status: "loading", error: "" }));

    fetchWeather(place, unit, controller.signal)
      .then((data) => setState({ data, key, status: "ready", error: "" }))
      .catch((e) => {
        if (e.name === "AbortError" && !timedOut) return; // superseded by a newer request
        console.error("Weather request failed:", e);
        const message = timedOut
          ? "The weather service took too long to respond. Check your connection and try again."
          : e.name === "ApiError"
            ? e.message
            : "Couldn’t reach the weather service. Check your connection.";
        setState((s) => ({ ...s, status: "error", error: message }));
      })
      .finally(() => clearTimeout(timer));

    return () => { clearTimeout(timer); controller.abort(); };
  }, [place, unit, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  return { ...state, fresh: state.key === key, retry: () => setTick((t) => t + 1) };
}

// Air quality (US AQI + PM2.5). Fails quietly: the tile just shows "Unavailable".
function useAirQuality(place) {
  const key = `${place.latitude},${place.longitude}`;
  const [state, setState] = useState({ key: "", aqi: null, pm25: null, failed: false });

  useEffect(() => {
    const controller = new AbortController();
    fetch(
      `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${place.latitude}&longitude=${place.longitude}&current=us_aqi,pm2_5`,
      { signal: controller.signal }
    )
      .then((r) => { if (!r.ok) throw new Error("air quality"); return r.json(); })
      .then((j) => setState({ key, aqi: j.current?.us_aqi ?? null, pm25: j.current?.pm2_5 ?? null, failed: false }))
      .catch((e) => { if (e.name !== "AbortError") setState({ key, aqi: null, pm25: null, failed: true }); });
    return () => controller.abort();
  }, [place]); // eslint-disable-line react-hooks/exhaustive-deps

  return state.key === key ? { ...state, loading: false } : { aqi: null, pm25: null, failed: false, loading: true };
}

// One request fetches the current temperature for every saved city.
function useSavedTemps(saved, unit, refreshKey) {
  const [temps, setTemps] = useState({});
  const sig = saved.map(placeKey).join("|") + unit + refreshKey;

  useEffect(() => {
    if (!saved.length) { setTemps({}); return; }
    const controller = new AbortController();
    const params = new URLSearchParams({
      latitude: saved.map((p) => p.latitude).join(","),
      longitude: saved.map((p) => p.longitude).join(","),
      current: "temperature_2m,weather_code,is_day",
      temperature_unit: unit, timezone: "auto",
    });
    fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("saved cities"))))
      .then((j) => {
        const list = Array.isArray(j) ? j : [j];
        const next = {};
        saved.forEach((p, i) => { if (list[i]?.current) next[placeKey(p)] = list[i].current; });
        setTemps(next);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps

  return temps;
}

/* =====================================================================
   Helpers
   ===================================================================== */
// WMO weather code -> [label, icon]
function describe(code, isDay = true) {
  if (code === 0) return ["Clear sky", isDay ? Sun : Moon];
  if (code === 1) return ["Mostly clear", isDay ? CloudSun : CloudMoon];
  if (code === 2) return ["Partly cloudy", isDay ? CloudSun : CloudMoon];
  if (code === 3) return ["Overcast", Cloud];
  if (code === 45 || code === 48) return ["Fog", CloudFog];
  if (code >= 51 && code <= 57) return ["Drizzle", CloudDrizzle];
  if (code >= 61 && code <= 67) return ["Rain", CloudRain];
  if (code >= 80 && code <= 82) return ["Rain showers", CloudRain];
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return ["Snow", CloudSnow];
  if (code >= 95) return ["Thunderstorm", CloudLightning];
  return ["Unknown", Cloud];
}

function kindOf(code) {
  if (code >= 95) return "storm";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if (code === 45 || code === 48) return "fog";
  return code <= 1 ? "clear" : "cloud";
}

const uvLabel = (v) => (v < 3 ? "Low" : v < 6 ? "Moderate" : v < 8 ? "High" : v < 11 ? "Very high" : "Extreme");
const clock = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const placeKey = (p) => `${Number(p.latitude).toFixed(2)},${Number(p.longitude).toFixed(2)}`;

// US AQI scale
const aqiInfo = (v) =>
  v <= 50 ? { label: "Good", color: "#4ade80", tip: "Air is clean. Enjoy the outdoors." }
  : v <= 100 ? { label: "Moderate", color: "#facc15", tip: "Fine for most people. Very sensitive people may want to limit long outdoor effort." }
  : v <= 150 ? { label: "Unhealthy for some", color: "#fb923c", tip: "Children, older adults and people with asthma should reduce long outdoor activity." }
  : v <= 200 ? { label: "Unhealthy", color: "#f87171", tip: "Everyone should cut back on outdoor exertion. Consider a mask." }
  : v <= 300 ? { label: "Very unhealthy", color: "#c084fc", tip: "Avoid outdoor activity if you can." }
  : { label: "Hazardous", color: "#e11d48", tip: "Stay indoors and keep windows closed." };

/* =====================================================================
   Animated sky background
   ===================================================================== */
const rnd = (a, b) => a + Math.random() * (b - a);
const make = (n, f) => Array.from({ length: n }, f);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const minutesOf = (iso) => { const m = /T(\d\d):(\d\d)/.exec(iso || ""); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

// Turns real data into the numbers that drive the sky:
//  x, y   sun (day) or moon (night) position, following the real sunrise and sunset
//  tw     0..1 strength of the warm dawn/dusk glow (within an hour of sunrise or sunset)
//  speed  cloud speed from the wind;  lean/east  how far and which way wind pushes rain, snow and clouds
//  haze   0..1 dust haze from the air quality (US AQI 50 = none, 200 = full)
function skyState({ time, sunrise, sunset, isDay = true, windKmh = 0, windDir = null, aqi = null } = {}) {
  const now = minutesOf(time), rise = minutesOf(sunrise), set = minutesOf(sunset);
  let x = 82, y = 12, tw = 0;
  if (now !== null && rise !== null && set !== null && set > rise) {
    const dayLen = set - rise, nightLen = 1440 - dayLen;
    const pos = isDay
      ? clamp((now - rise) / dayLen, 0, 1)
      : clamp((now >= set ? now - set : now + 1440 - set) / nightLen, 0, 1);
    x = 6 + 88 * pos;
    y = 60 - 50 * Math.sin(Math.PI * pos);
    tw = clamp(1 - Math.min(Math.abs(now - rise), Math.abs(now - set)) / 60, 0, 1);
  }
  const w = Math.max(0, windKmh || 0);
  const east = windDir === null ? 1 : -Math.sin((windDir * Math.PI) / 180); // +1: wind blows toward the right of the screen
  return {
    x: +x.toFixed(1), y: +y.toFixed(1), tw: +tw.toFixed(2),
    speed: +clamp(0.5 + w / 10, 0.5, 5).toFixed(2),
    lean: w < 3 ? 0 : +(east * Math.min(1, w / 30)).toFixed(2),
    east: +east.toFixed(2),
    haze: +clamp(((aqi ?? 0) - 50) / 150, 0, 1).toFixed(2),
  };
}

const Scene = memo(function Scene({ kind, isDay, fade, x, y, tw, speed, lean, east, haze }) {
  const fx = useMemo(() => ({
    stars: make(90, () => ({ left: rnd(0, 100), top: rnd(0, 70), s: rnd(1, 3), t: rnd(2, 5), d: rnd(0, 5) })),
    clouds: make(6, () => ({ top: rnd(-5, 55), w: rnd(30, 55), h: rnd(14, 26), o: rnd(0.25, 0.5), t: rnd(80, 150), d: rnd(0, 150) })),
    drops: make(70, () => ({ left: rnd(-5, 105), h: rnd(40, 100), t: rnd(0.55, 1), d: rnd(0, 2) })),
    flakes: make(70, () => ({ left: rnd(0, 100), s: rnd(3, 8), t: rnd(7, 16), d: rnd(0, 16), dx: rnd(-8, 8) })),
  }), []);

  const clear = kind === "clear";
  const cloudCount = { clear: 2, cloud: 6, fog: 3 }[kind] ?? 4;
  const ang = lean * 28; // degrees the rain leans in the wind
  const vars = {
    "--tw": tw, "--haze": haze,
    "--rain-rot": `${(-ang).toFixed(1)}deg`,
    "--rain-dx": `${(Math.tan((ang * Math.PI) / 180) * 125).toFixed(1)}vh`,
  };

  return (
    <div className={`fx fx--${kind} ${isDay ? "" : "is-night"} ${haze > 0.25 ? "hazy" : ""} ${fade ? "fx-fade" : ""}`} style={vars} aria-hidden="true">
      <div className="sky-layer" />
      <div className="tint" />

      {!isDay && (clear || kind === "cloud") &&
        fx.stars.map((s, i) => (
          <i key={i} className="star" style={{ left: `${s.left}%`, top: `${s.top}%`, width: s.s, height: s.s, animationDuration: `${s.t}s`, animationDelay: `-${s.d}s` }} />
        ))}

      {isDay && (clear || kind === "cloud") && <div className={`sun ${clear ? "" : "dim"}`} style={{ "--x": x, "--y": y }} />}
      {!isDay && clear && <div className="moon" style={{ "--x": x, "--y": y }} />}

      {fx.clouds.slice(0, cloudCount).map((c, i) => (
        <div key={i} className="cloud" style={{
          top: `${c.top}%`, width: `${c.w}vw`, height: `${c.h}vh`, "--o": clear ? c.o * 0.5 : c.o,
          animationDuration: `${(c.t / speed).toFixed(1)}s`, animationDelay: `-${(c.d / speed).toFixed(1)}s`,
          animationDirection: east < -0.05 ? "reverse" : "normal",
        }} />
      ))}

      {haze > 0.02 && <div className="haze" />}

      {(kind === "rain" || kind === "storm") &&
        fx.drops.map((d, i) => (
          <i key={i} className="drop" style={{ left: `${d.left - lean * 30}%`, height: d.h, animationDuration: `${d.t}s`, animationDelay: `-${d.d}s` }} />
        ))}

      {kind === "snow" &&
        fx.flakes.map((f, i) => (
          <i key={i} className="flake" style={{ left: `${f.left}%`, width: f.s, height: f.s, "--dx": `${f.dx + lean * 20}vw`, animationDuration: `${f.t}s`, animationDelay: `-${f.d}s` }} />
        ))}

      {kind === "storm" && <div className="flash" />}
      {kind === "fog" && [20, 45, 70].map((top, i) => <div key={i} className="mist" style={{ top: `${top}%`, animationDelay: `-${i * 7}s` }} />)}

      <div className="vignette" />
    </div>
  );
});

// Crossfades between skies when the weather or time of day changes (e.g. when you switch city).
function Background({ kind = "clear", isDay = true, x = 82, y = 12, tw = 0, speed = 1, lean = 0, east = 1, haze = 0 }) {
  const id = `${kind}:${isDay}`;
  const [layers, setLayers] = useState([{ id, kind, isDay, fade: false, n: 0 }]);

  useEffect(() => {
    setLayers((prev) => {
      const top = prev[prev.length - 1];
      if (top.id === id) return prev;
      return [top, { id, kind, isDay, fade: true, n: top.n + 1 }];
    });
    const timer = setTimeout(() => setLayers((p) => p.slice(-1)), 1100);
    return () => clearTimeout(timer);
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  return layers.map((l) => (
    <Scene key={l.n} kind={l.kind} isDay={l.isDay} fade={l.fade} x={x} y={y} tw={tw} speed={speed} lean={lean} east={east} haze={haze} />
  ));
}

/* =====================================================================
   UI components
   ===================================================================== */
function TopBar({ onPick, onLocate, unit, setUnit }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => searchCities(q.trim(), controller.signal).then(setResults).catch(() => {}), 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [q]);

  const pick = (p) => {
    onPick({ name: p.name, country: p.country || "", latitude: p.latitude, longitude: p.longitude });
    setQ(""); setResults([]); setOpen(false);
  };

  return (
    <header className="topbar">
      <div className="search">
        <Search size={18} />
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && results[0]) pick(results[0]);
            if (e.key === "Escape") setOpen(false);
          }}
          placeholder="Search for a city"
          aria-label="Search for a city"
          role="combobox"
          aria-expanded={open && results.length > 0}
          aria-controls="city-results"
        />
        {open && results.length > 0 && (
          <ul id="city-results" role="listbox" className="suggest">
            {results.map((p) => (
              <li key={p.id} role="option" aria-selected="false" onMouseDown={(e) => { e.preventDefault(); pick(p); }}>
                <strong>{p.name}</strong>
                <span>{[p.admin1, p.country].filter(Boolean).join(", ")}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <button className="round" onClick={onLocate} aria-label="Use my location" title="Use my location"><LocateFixed size={18} /></button>
      <div className="seg" role="group" aria-label="Temperature unit">
        <button aria-pressed={unit === "celsius"} onClick={() => setUnit("celsius")}>°C</button>
        <button aria-pressed={unit === "fahrenheit"} onClick={() => setUnit("fahrenheit")}>°F</button>
      </div>
    </header>
  );
}

function Hero({ place, cur, today, symbol, isSaved, onToggleSave }) {
  const [label, Icon] = describe(cur.weather_code, cur.is_day === 1);
  return (
    <section className="hero">
      <p className="place">
        <MapPin size={18} />{place.name}{place.country && <span>{place.country}</span>}
        <button className="save" onClick={onToggleSave} aria-pressed={isSaved}
          aria-label={isSaved ? `Remove ${place.name} from saved cities` : `Save ${place.name}`}
          title={isSaved ? "Remove from saved cities" : "Save this city"}>
          <Star size={18} fill={isSaved ? "currentColor" : "none"} />
        </button>
      </p>
      <p className="when">
        {new Date(cur.time).toLocaleString(undefined, { weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" })}
      </p>
      <div className="temp">{rd(cur.temperature_2m)}<sup>{symbol}</sup></div>
      <p className="cond"><Icon size={30} strokeWidth={1.6} />{label}</p>
      <p className="range"><span>High {rd(today.max)}°</span><span>Low {rd(today.min)}°</span></p>
    </section>
  );
}

const num = (v, suffix = "") => (Number.isFinite(v) ? `${rd(v)}${suffix}` : "–");

// Per-hour weather. Columns share the panel width and scroll sideways (wheel, drag, swipe or the arrow buttons);
// rows share the panel height, and the panel drops detail on short screens instead of clipping it.
function HourlyTimeline({ title, hours, windUnit }) {
  const scroller = useRef(null);
  const drag = useRef(null);
  const [edge, setEdge] = useState({ start: true, end: false });
  const temps = hours.map((h) => h.temp);
  const lo = Math.min(...temps), hi = Math.max(...temps);
  const n = hours.length;
  const pts = temps.map((v) => 6 + (1 - (v - lo) / (hi - lo || 1)) * 88); // % of the plot area, top to bottom

  const updateEdge = () => {
    const el = scroller.current;
    if (!el) return;
    const start = el.scrollLeft <= 2;
    const end = el.scrollLeft >= el.scrollWidth - el.clientWidth - 2;
    setEdge((e) => (e.start === start && e.end === end ? e : { start, end })); // same values: no re-render
  };
  const scrollBy = (dir) => scroller.current?.scrollBy({ left: dir * 224, behavior: "smooth" });

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    updateEdge();
    // a normal mouse wheel scrolls the hours sideways while the strip can still move that way
    const onWheel = (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 0 || (e.deltaY < 0 && el.scrollLeft <= 0) || (e.deltaY > 0 && el.scrollLeft >= max)) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    const ro = new ResizeObserver(updateEdge);
    ro.observe(el);
    return () => { el.removeEventListener("wheel", onWheel); ro.disconnect(); };
  }, [n]); // eslint-disable-line react-hooks/exhaustive-deps

  // click-and-drag with a mouse (touch already scrolls natively)
  const onPointerDown = (e) => {
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    drag.current = { x: e.clientX, left: scroller.current.scrollLeft };
    scroller.current.setPointerCapture(e.pointerId);
    scroller.current.classList.add("dragging");
  };
  const onPointerMove = (e) => { if (drag.current) scroller.current.scrollLeft = drag.current.left - (e.clientX - drag.current.x); };
  const endDrag = () => { drag.current = null; scroller.current?.classList.remove("dragging"); };

  return (
    <>
      <div className="panel-head">
        <h2>{title}</h2>
        <div className="legend">
          <span><Umbrella size={12} />Rain</span>
          <span><Wind size={12} />Wind {windUnit}</span>
          <span><Droplets size={12} />Humidity</span>
        </div>
        <div className="nav-btns">
          <button className="nav-btn" onClick={() => scrollBy(-1)} disabled={edge.start} aria-label="Earlier hours"><ChevronLeft size={16} /></button>
          <button className="nav-btn" onClick={() => scrollBy(1)} disabled={edge.end} aria-label="Later hours"><ChevronRight size={16} /></button>
        </div>
      </div>

      <div
        className={`tl-scroll ${edge.end ? "" : "more"}`} ref={scroller} tabIndex={0} role="region" aria-label="Hourly forecast, scrollable"
        onScroll={updateEdge} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}
      >
        <ol className="tl">
          {hours.map((h, i) => {
            const [label, Icon] = describe(h.code, h.isDay);
            const before = i > 0 ? (pts[i - 1] + pts[i]) / 2 : pts[i];
            const after = i < n - 1 ? (pts[i] + pts[i + 1]) / 2 : pts[i];
            const line = `0,${before} 50,${pts[i]} 100,${after}`;
            return (
              <li key={h.time} className={`hr ${i === 0 ? "is-now" : ""}`}>
                <span className="hr-time">{i === 0 ? "Now" : new Date(h.time).toLocaleTimeString(undefined, { hour: "numeric" })}</span>
                <span className="hr-icon" title={label}><Icon size={22} strokeWidth={1.7} aria-label={label} /></span>
                <span className="hr-curve">
                  <span className="plot">
                    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                      <polygon points={`${line} 100,100 0,100`} className="c-area" />
                      <polyline points={line} className="c-line" />
                    </svg>
                    <i className="hr-dot" style={{ top: `${pts[i]}%` }} />
                    <b className="hr-temp" style={{ top: `${pts[i]}%` }}>{rd(h.temp)}°</b>
                  </span>
                </span>
                <span className={`hr-stat ${h.pop >= 20 ? "wet" : "dry"}`} title="Chance of rain"><Umbrella size={12} />{num(h.pop, "%")}</span>
                <span className="hr-stat hr-wind" title={`Wind (${windUnit})`}><Wind size={12} />{num(h.wind)}</span>
                <span className="hr-stat hr-hum" title="Humidity"><Droplets size={12} />{num(h.hum, "%")}</span>
              </li>
            );
          })}
        </ol>
      </div>
    </>
  );
}

function Week({ daily }) {
  const weekMin = Math.min(...daily.temperature_2m_min);
  const weekMax = Math.max(...daily.temperature_2m_max);
  const span = weekMax - weekMin || 1;
  return (
    <ul className="days">
      {daily.time.map((day, i) => {
        const [label, Icon] = describe(daily.weather_code[i]);
        const lo = daily.temperature_2m_min[i], hi = daily.temperature_2m_max[i];
        const pop = daily.precipitation_probability_max[i];
        return (
          <li key={day}>
            <span className="dow">{i === 0 ? "Today" : new Date(day + "T00:00").toLocaleDateString(undefined, { weekday: "short" })}</span>
            <Icon size={20} strokeWidth={1.7} aria-label={label} />
            <span className="pop">{pop >= 30 ? `${pop}%` : ""}</span>
            <span className="lo">{rd(lo)}°</span>
            <span className="track"><i style={{ left: `${((lo - weekMin) / span) * 100}%`, width: `${Math.max(((hi - lo) / span) * 100, 5)}%` }} /></span>
            <span className="hi">{rd(hi)}°</span>
          </li>
        );
      })}
    </ul>
  );
}

function SavedCities({ saved, current, temps, onSelect, onRemove }) {
  if (!saved.length) return null;
  return (
    <nav className="chips" aria-label="Saved cities">
      {saved.map((p) => {
        const k = placeKey(p);
        const c = temps[k];
        const Icon = c ? describe(c.weather_code, c.is_day === 1)[1] : null;
        const active = k === placeKey(current);
        return (
          <div key={k} className={`chip ${active ? "is-active" : ""}`}>
            <button className="chip-main" onClick={() => onSelect(p)} aria-current={active ? "true" : undefined} aria-label={`Show weather for ${p.name}`}>
              {Icon && <Icon size={16} />}<span>{p.name}</span>{c && <b>{rd(c.temperature_2m)}°</b>}
            </button>
            <button className="chip-x" onClick={() => onRemove(p)} aria-label={`Remove ${p.name}`}><X size={14} /></button>
          </div>
        );
      })}
    </nav>
  );
}

function AirTile({ air }) {
  const info = air.aqi == null ? null : aqiInfo(air.aqi);
  return (
    <div className="panel tile air" title={info ? `${info.tip} (PM2.5: ${rd(air.pm25)} µg/m³)` : undefined}>
      <span className="tile-label"><Leaf size={15} />Air quality</span>
      <strong>{info ? rd(air.aqi) : air.loading ? "…" : "—"}</strong>
      <small>{info ? info.label : air.loading ? "Checking air" : "Unavailable"}</small>
      {info && <span className="aq-bar"><i style={{ width: `${(Math.min(air.aqi, 300) / 300) * 100}%`, background: info.color }} /></span>}
    </div>
  );
}

const Tile = ({ icon: Icon, label, value, sub }) => (
  <div className="panel tile">
    <span className="tile-label"><Icon size={15} />{label}</span>
    <strong>{value}</strong>
    <small>{sub}</small>
  </div>
);

/* =====================================================================
   App
   ===================================================================== */
export default function App() {
  const [place, setPlace] = usePersisted("wx:place", DEFAULT_PLACE);
  const [unit, setUnit] = usePersisted("wx:unit", "celsius");
  const { data, fresh, status, error, retry } = useWeather(place, unit);
  const ready = Boolean(data) && fresh;
  const [saved, setSaved] = usePersisted("wx:saved", []);
  const air = useAirQuality(place);
  const temps = useSavedTemps(saved, unit, data?.current?.time ?? "");
  const isSaved = saved.some((p) => placeKey(p) === placeKey(place));
  const toggleSave = () =>
    setSaved((list) => (isSaved ? list.filter((p) => placeKey(p) !== placeKey(place)) : [...list, place].slice(-8)));
  const [notice, setNotice] = useState("");

  const locate = () => {
    if (!navigator.geolocation) return setNotice("Your browser doesn’t support location.");
    navigator.geolocation.getCurrentPosition(
      (p) => { setNotice(""); setPlace({ name: "Your location", country: "", latitude: p.coords.latitude, longitude: p.coords.longitude }); },
      () => setNotice("Location is blocked. Allow it in your browser settings or search for a city.")
    );
  };

  const cur = data?.current;
  const sky = cur
    ? skyState({
        time: cur.time, sunrise: data.daily.sunrise?.[0], sunset: data.daily.sunset?.[0], isDay: cur.is_day === 1,
        windKmh: unit === "fahrenheit" ? cur.wind_speed_10m * 1.609 : cur.wind_speed_10m,
        windDir: cur.wind_direction_10m ?? null, aqi: air.aqi,
      })
    : skyState();
  const symbol = unit === "celsius" ? "°C" : "°F";
  const windUnit = unit === "celsius" ? "km/h" : "mph";

  let body;
  if (ready) {
    const start = Math.max(0, data.hourly.time.findIndex((t) => t >= cur.time.slice(0, 13) + ":00"));
    const hr = data.hourly;
    const hourList = Array.from({ length: 24 }, (_, k) => {
      const i = start + k;
      return { time: hr.time[i], temp: hr.temperature_2m[i], code: hr.weather_code?.[i], isDay: hr.is_day?.[i] !== 0,
               pop: hr.precipitation_probability?.[i], wind: hr.wind_speed_10m?.[i], hum: hr.relative_humidity_2m?.[i] };
    }).filter((h) => h.time);
    const d = data.daily;
    const diff = rd(cur.apparent_temperature - cur.temperature_2m);
    body = (
      <main className={`grid ${status === "loading" ? "is-loading" : ""}`}>
        <Hero place={place} cur={cur} today={{ max: d.temperature_2m_max[0], min: d.temperature_2m_min[0] }} symbol={symbol} isSaved={isSaved} onToggleSave={toggleSave} />
        <section className="panel hourly">
          <HourlyTimeline title={`Next ${hourList.length > 20 ? 24 : hourList.length - 1} hours`} hours={hourList} windUnit={windUnit} />
        </section>
        <section className="stats">
          <Tile icon={Thermometer} label="Feels like" value={`${rd(cur.apparent_temperature)}°`} sub={diff === 0 ? "Same as actual" : diff > 0 ? "Warmer than actual" : "Cooler than actual"} />
          <Tile icon={Droplets} label="Humidity" value={`${cur.relative_humidity_2m}%`} sub={cur.relative_humidity_2m > 70 ? "Humid" : cur.relative_humidity_2m < 30 ? "Dry" : "Comfortable"} />
          <Tile icon={Wind} label="Wind" value={`${rd(cur.wind_speed_10m)} ${windUnit}`} sub="At 10 m" />
          <Tile icon={Sun} label="UV index" value={rd(d.uv_index_max[0])} sub={`${uvLabel(d.uv_index_max[0])} today`} />
          <AirTile air={air} />
          <Tile icon={Sunrise} label="Sunrise" value={clock(d.sunrise[0])} sub={`Sunset ${clock(d.sunset[0])}`} />
        </section>
        <section className="panel week"><h2>{d.time.length}-day forecast</h2><Week daily={d} /></section>
      </main>
    );
  } else if (status === "error") {
    body = (
      <div className="state" role="alert">
        <p>{error}</p>
        <button className="btn" onClick={retry}><RefreshCw size={16} /> Try again</button>
      </div>
    );
  } else {
    body = <div className="state"><p>Loading forecast for {place.name}…</p></div>;
  }

  return (
    <div className="screen">
      <Background kind={cur ? kindOf(cur.weather_code) : "clear"} isDay={cur ? cur.is_day === 1 : true} {...sky} />
      <div className="ui">
        <div className="bar">
          <TopBar onPick={setPlace} onLocate={locate} unit={unit} setUnit={setUnit} />
          <SavedCities saved={saved} current={place} temps={temps} onSelect={setPlace}
            onRemove={(p) => setSaved((list) => list.filter((x) => placeKey(x) !== placeKey(p)))} />
        </div>
        {(notice || (ready && status === "error")) && (
          <p className="banner" role="status">
            {notice || `${error} Showing the last forecast.`}
            {ready && status === "error" && <button onClick={retry}>Retry</button>}
          </p>
        )}
        {body}
        <footer className="foot">
          <span>Weather data by <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a></span>
        </footer>
      </div>
    </div>
  );
}