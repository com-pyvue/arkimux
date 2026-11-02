import { readableWeatherResultSchema } from "./contract.js";

export function WeatherAdvisorResult({ payload }: { payload: unknown }) {
  const result = readableWeatherResultSchema.parse(payload);
  const transportWarning = "transportWarning" in result.weather ? result.weather.transportWarning : undefined;
  return <article style={{ fontFamily: "system-ui", padding: 24, lineHeight: 1.5 }}>
    <h1>Weather Advisor — {result.city}</h1>
    {transportWarning && <div role="alert" style={{ border: "2px solid #b45309", borderLeftWidth: 6, borderRadius: 6, background: "#fffbeb", color: "#78350f", padding: 16, marginBottom: 20 }}>
      <strong>Warning: insecure weather connection</strong>
      <p style={{ margin: "8px 0 0" }}>{transportWarning} The response could have been intercepted or altered.</p>
    </div>}
    <h2>{result.weather.summary}</h2>
    <p>{result.weather.temperatureC} °C · Feels like {result.weather.feelsLikeC} °C · Wind {result.weather.windKph} km/h · Precipitation {result.weather.precipitationMm} mm</p>
    <h2>Clothing recommendation</h2><p>{result.recommendation.summary}</p>
    <ul>{result.recommendation.clothing.map((item, index) => <li key={index}><strong>{item.item}</strong> — {item.reason}</li>)}</ul>
    <h3>Cautions</h3><ul>{result.recommendation.cautions.map((caution, index) => <li key={index}>{caution}</li>)}</ul>
    <h2>Review: {result.critique.verdict}</h2>
    <ul>{result.critique.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>
    <p>{result.critique.adjustedAdvice}</p>
  </article>;
}
