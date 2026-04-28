// Math-based temperature market analyzer — no external API required.
// Polymarket temperature markets are binary (Yes/No). The temperature condition
// is embedded in the question: "Will the highest temperature in London be 18°C on April 28?"
// We compare the OpenWeather forecast against that condition using a Gaussian model.
const { fetchWeatherForLocation } = require('./weather');
const logger = require('../utils/logger');

// ── Gaussian helpers ──────────────────────────────────────────────────────────

function erf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const result = 1 - poly * Math.exp(-x * x);
  return x >= 0 ? result : -result;
}

function normalCDF(x, mean, std) {
  return 0.5 * (1 + erf((x - mean) / (std * Math.SQRT2)));
}

// P(low ≤ X ≤ high) for X ~ N(mean, std)
function probabilityInRange(mean, std, low, high) {
  const pLow = isFinite(low) ? normalCDF(low, mean, std) : 0;
  const pHigh = isFinite(high) ? normalCDF(high, mean, std) : 1;
  return Math.max(0, Math.min(1, pHigh - pLow));
}

// ── Unit conversion ───────────────────────────────────────────────────────────

function celsiusToFahrenheit(c) { return c * 9 / 5 + 32; }

// ── Temperature condition parser ──────────────────────────────────────────────

// Parses the temperature condition from the market QUESTION (not outcome name).
// Returns { low, high, unit: 'C'|'F' } or null.
// Examples:
//   "...be 18°C on..."           → { low: 17.5, high: 18.5, unit: 'C' }
//   "...be between 38-39°F..."   → { low: 38,   high: 39,   unit: 'F' }
//   "...be 3°C or below..."      → { low: -Inf, high: 3,    unit: 'C' }
//   "...be 30°C or above..."     → { low: 30,   high: Inf,  unit: 'C' }
function parseTemperatureCondition(question) {
  const q = question;
  const unit = /°f/i.test(q) ? 'F' : /°c/i.test(q) ? 'C' : null;
  if (!unit) return null;

  const N = '-?\\d+(?:\\.\\d+)?';

  // "between X-Y°C" or "between X and Y°C"
  let m = q.match(new RegExp(`between\\s+(${N})\\s*(?:[-–]|and)\\s*(${N})\\s*°[CF]`, 'i'));
  if (m) return { low: parseFloat(m[1]), high: parseFloat(m[2]), unit };

  // "X-Y°C" range
  m = q.match(new RegExp(`(${N})\\s*[-–]\\s*(${N})\\s*°[CF]`));
  if (m) return { low: parseFloat(m[1]), high: parseFloat(m[2]), unit };

  // "X°C or below" / "X°C or lower"
  m = q.match(new RegExp(`(${N})\\s*°[CF]\\s+or\\s+(?:below|lower|less)`, 'i'));
  if (m) return { low: -Infinity, high: parseFloat(m[1]), unit };

  // "below X°C" / "less than X°C" / "under X°C"
  m = q.match(new RegExp(`(?:below|less than|under)\\s*(${N})\\s*°[CF]`, 'i'));
  if (m) return { low: -Infinity, high: parseFloat(m[1]), unit };

  // "X°C or above" / "X°C or higher"
  m = q.match(new RegExp(`(${N})\\s*°[CF]\\s+or\\s+(?:above|higher|more)`, 'i'));
  if (m) return { low: parseFloat(m[1]), high: Infinity, unit };

  // "above X°C" / "more than X°C" / "exceed X°C"
  m = q.match(new RegExp(`(?:above|more than|over|exceed)\\s*(${N})\\s*°[CF]`, 'i'));
  if (m) return { low: parseFloat(m[1]), high: Infinity, unit };

  // "be X°C" — single exact value, treat as ±0.5 bucket
  m = q.match(new RegExp(`be\\s+(${N})\\s*°[CF]`, 'i'));
  if (m) { const v = parseFloat(m[1]); return { low: v - 0.5, high: v + 0.5, unit }; }

  return null;
}

// ── Location extraction ───────────────────────────────────────────────────────

function extractLocation(question) {
  // Binary market: "Will the highest/lowest temperature in [City] be..."
  // Event title:   "Highest/Lowest temperature in [City] on..."
  const m = question.match(/(?:highest|lowest)\s+temp(?:erature)?\s+in\s+(.+?)\s+(?:be\s+|on\s+)/i);
  if (m) return m[1].trim();

  // Precipitation: "Precipitation in [City] in [Month]"
  const m2 = question.match(/precipitation\s+in\s+(.+?)\s+in\s+[A-Za-z]/i);
  if (m2) return m2[1].trim();

  return null;
}

// ── Forecast helpers ──────────────────────────────────────────────────────────

// Forecast 1σ uncertainty grows with horizon (~1.5°C same-day, ~3°C at 2 days)
function forecastSigma(targetDate) {
  const daysOut = Math.max(0, (targetDate - Date.now()) / 86_400_000);
  return 1.5 + daysOut * 0.75;
}

// Get the forecast high or low for a specific calendar date from the 48h array
function getForecastForDate(weatherData, targetDate, wantHigh) {
  const targetDay = targetDate.toDateString();
  const slots = weatherData.forecast_48h.filter(f => new Date(f.time).toDateString() === targetDay);
  const pool = slots.length > 0 ? slots : weatherData.forecast_48h;
  return wantHigh
    ? Math.max(...pool.map(f => f.temp_max))
    : Math.min(...pool.map(f => f.temp_min));
}

function extractTargetDate(question) {
  const m = question.match(/\bon\s+([A-Za-z]+\s+\d{1,2}(?:,?\s*\d{4})?)/i);
  if (!m) return null;
  const str = /\d{4}/.test(m[1]) ? m[1] : `${m[1]} ${new Date().getFullYear()}`;
  const d = new Date(str);
  return isNaN(d) ? null : d;
}

function formatRange(range) {
  if (!isFinite(range.low)) return `≤${range.high}°${range.unit}`;
  if (!isFinite(range.high)) return `≥${range.low}°${range.unit}`;
  return `${range.low}–${range.high}°${range.unit}`;
}

// ── Main analysis entry point ─────────────────────────────────────────────────

async function analyzeMarket({ market, location }) {
  const q = market.question;
  const isHigh = /highest\s+temp/i.test(q);
  const isLow = /lowest\s+temp/i.test(q);
  if (!isHigh && !isLow) return null;

  const loc = location || extractLocation(q);
  if (!loc) return null;

  const targetDate = extractTargetDate(q);
  if (!targetDate) return null;

  // Parse temperature condition from the question text
  const range = parseTemperatureCondition(q);
  if (!range) return null;

  const weatherData = await fetchWeatherForLocation(loc);
  if (!weatherData) return null;

  // Forecast in °C (weather.js uses metric); convert to outcome unit if needed
  const forecastC = getForecastForDate(weatherData, targetDate, isHigh);
  const sigma = forecastSigma(targetDate);
  const forecastInUnit = range.unit === 'F' ? celsiusToFahrenheit(forecastC) : forecastC;
  const sigmaInUnit = range.unit === 'F' ? sigma * 1.8 : sigma;

  // P(Yes) = probability forecast falls within the market's temperature condition
  const pYes = probabilityInRange(forecastInUnit, sigmaInUnit, range.low, range.high);
  const pNo = 1 - pYes;

  // Find the Yes/No binary outcomes
  const yesOutcome = market.outcomes.find(o => /^yes$/i.test(o.name.trim()));
  const noOutcome = market.outcomes.find(o => /^no$/i.test(o.name.trim()));
  if (!yesOutcome || !noOutcome) return null;

  // Recommend whichever has higher probability
  const [recommendedOutcome, confidence] = pYes >= pNo
    ? ['Yes', Math.round(pYes * 100)]
    : ['No', Math.round(pNo * 100)];

  // Require at least 55% model confidence to return any result
  if (confidence < 55) return null;

  const forecastF = celsiusToFahrenheit(forecastC);
  const rangeStr = formatRange(range);

  return {
    confidence,
    recommended_outcome: recommendedOutcome,
    rationale: `Forecast ${isHigh ? 'high' : 'low'} for ${targetDate.toDateString()}: ${forecastC.toFixed(1)}°C / ${forecastF.toFixed(1)}°F. P(Yes)=${(pYes * 100).toFixed(0)}% for condition ${rangeStr}.`,
    risk: `Forecast uncertainty ±${sigma.toFixed(1)}°C — actual temp may land in a different bracket.`,
    weather_analysis: `${isHigh ? 'High' : 'Low'}: ${forecastC.toFixed(1)}°C / ${forecastF.toFixed(1)}°F vs. market condition ${rangeStr}`,
    news_analysis: null,
    trader_alignment: 'neutral',
    data_quality: 'high',
  };
}

module.exports = { analyzeMarket, extractLocation };
