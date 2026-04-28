const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const { config } = require('../config');
const logger = require('../utils/logger');
const cache = require('../utils/cache');

const owClient = axios.create({
  baseURL: 'https://api.openweathermap.org',
  timeout: 10000,
  params: { appid: config.OPENWEATHER_API_KEY, units: 'metric' },
});
axiosRetry(owClient, { retries: 3, retryDelay: axiosRetry.exponentialDelay });

// Known aliases where OpenWeather needs a different name than what Polymarket uses
const CITY_ALIASES = {
  'new york city': 'New York',
  'nyc': 'New York',
  'los angeles': 'Los Angeles',
  'la': 'Los Angeles',
  'sao paulo': 'São Paulo',
  'buenos aires': 'Buenos Aires',
};

// Build a list of candidate strings to try, from most to least specific
function buildLocationCandidates(location) {
  const candidates = [];
  const trimmed = location.trim();
  candidates.push(trimmed);

  // Strip trailing state/country code: "Miami, FL" → "Miami", "London, UK" → "London"
  const commaIdx = trimmed.lastIndexOf(',');
  if (commaIdx > 0) {
    candidates.push(trimmed.slice(0, commaIdx).trim());
  }

  // Apply known aliases against each candidate so far
  for (const candidate of [...candidates]) {
    const lower = candidate.toLowerCase();
    for (const [alias, canonical] of Object.entries(CITY_ALIASES)) {
      if (lower === alias || lower.startsWith(alias)) {
        candidates.push(canonical);
      }
    }
  }

  // Deduplicate while preserving order
  return [...new Set(candidates)];
}

// Geocode a single exact string, cached 24h
async function geocodeExact(location) {
  const cacheKey = `geo:${location.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const { data } = await owClient.get('/geo/1.0/direct', {
      params: { q: location, limit: 1 },
    });
    if (!data || data.length === 0) return null;
    const result = { lat: data[0].lat, lon: data[0].lon, name: data[0].name, country: data[0].country };
    cache.set(cacheKey, result, 24 * 60 * 60 * 1000);
    return result;
  } catch (err) {
    logger.warn('Geocoding failed', { location, error: err.message });
    return null;
  }
}

// Geocode a location string to lat/lon, trying simplified variants on failure
async function geocode(location) {
  const candidates = buildLocationCandidates(location);
  for (const candidate of candidates) {
    const result = await geocodeExact(candidate);
    if (result) return result;
  }
  logger.warn('Could not geocode location (all candidates failed)', { location, candidates });
  return null;
}

// Fetch current + forecast weather for a location string
async function fetchWeatherForLocation(location) {
  const cacheKey = `weather:${location.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const geo = await geocode(location);
  if (!geo) {
    logger.warn('Could not geocode location', { location });
    return null;
  }

  try {
    const [currentRes, forecastRes] = await Promise.all([
      owClient.get('/data/2.5/weather', { params: { lat: geo.lat, lon: geo.lon } }),
      owClient.get('/data/2.5/forecast', { params: { lat: geo.lat, lon: geo.lon, cnt: 16 } }),
    ]);

    const current = currentRes.data;
    const forecast = forecastRes.data;

    const result = {
      location: `${geo.name}, ${geo.country}`,
      lat: geo.lat,
      lon: geo.lon,
      current: {
        temp: current.main.temp,
        feels_like: current.main.feels_like,
        temp_min: current.main.temp_min,
        temp_max: current.main.temp_max,
        humidity: current.main.humidity,
        description: current.weather[0]?.description,
        wind_speed: current.wind?.speed,
        pressure: current.main.pressure,
        rain_1h: current.rain?.['1h'] || 0,
        snow_1h: current.snow?.['1h'] || 0,
      },
      forecast_48h: forecast.list.slice(0, 16).map(item => ({
        dt: item.dt,
        time: new Date(item.dt * 1000).toISOString(),
        temp: item.main.temp,
        temp_min: item.main.temp_min,
        temp_max: item.main.temp_max,
        pop: item.pop,        // probability of precipitation 0-1
        rain: item.rain?.['3h'] || 0,
        snow: item.snow?.['3h'] || 0,
        description: item.weather[0]?.description,
        wind_speed: item.wind?.speed,
      })),
      fetchedAt: new Date().toISOString(),
    };

    cache.set(cacheKey, result, config.MARKET_CACHE_TTL_MS);
    return result;
  } catch (err) {
    logger.error('Weather fetch failed', { location, error: err.message });
    return null;
  }
}

// Summarize weather data into human-readable strings for Claude
function summarizeWeather(weatherData) {
  if (!weatherData) return 'Weather data unavailable.';
  const { current, forecast_48h, location } = weatherData;

  const maxForecastTemp = Math.max(...forecast_48h.map(f => f.temp_max));
  const minForecastTemp = Math.min(...forecast_48h.map(f => f.temp_min));
  const maxPop = Math.max(...forecast_48h.map(f => f.pop));
  const totalRain = forecast_48h.reduce((s, f) => s + f.rain, 0).toFixed(2);
  const totalSnow = forecast_48h.reduce((s, f) => s + f.snow, 0).toFixed(2);

  return [
    `Location: ${location}`,
    `Current: ${current.temp.toFixed(1)}°C, ${current.description}, wind ${current.wind_speed} m/s`,
    `24h forecast range: ${minForecastTemp.toFixed(1)}°C - ${maxForecastTemp.toFixed(1)}°C`,
    `Max precipitation probability (48h): ${(maxPop * 100).toFixed(0)}%`,
    `Accumulated rain (48h): ${totalRain} mm, snow: ${totalSnow} mm`,
  ].join('\n');
}

module.exports = { fetchWeatherForLocation, summarizeWeather };
