/**
 * TCX (Training Center XML) export.
 *
 * The JSON backup only this app can read; TCX imports straight into Strava, Garmin
 * Connect, TrainingPeaks and Golden Cheetah, which is what makes a ride portable rather
 * than trapped on one phone.
 *
 * Deliberately hand-written rather than pulled from a library: the schema surface we need
 * is one Activity with one Lap per marked lap and a Trackpoint per second.
 */

const SCHEMA = 'http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2';

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Trackpoints for one time slice.
 *
 * Cadence is `<Cadence>` on the trackpoint itself, which is where cycling consumers look;
 * heart rate goes in the nested HeartRateBpm/Value pair the schema requires.
 */
function trackpoints(points, startMs) {
  return points.map(p => {
    const time = new Date(startMs + (p.timestamp || 0)).toISOString();
    const hr = p.bpm > 0
      ? `\n        <HeartRateBpm><Value>${Math.round(p.bpm)}</Value></HeartRateBpm>`
      : '';
    const cadence = p.rpm > 0 ? `\n        <Cadence>${Math.min(254, Math.round(p.rpm))}</Cadence>` : '';
    return `      <Trackpoint>
        <Time>${time}</Time>${hr}${cadence}
      </Trackpoint>`;
  }).join('\n');
}

function lapXml({ startMs, offsetMs, durationSeconds, calories, avgBPM, maxBPM, points }) {
  const avg = avgBPM > 0
    ? `\n      <AverageHeartRateBpm><Value>${Math.round(avgBPM)}</Value></AverageHeartRateBpm>`
    : '';
  const max = maxBPM > 0
    ? `\n      <MaximumHeartRateBpm><Value>${Math.round(maxBPM)}</Value></MaximumHeartRateBpm>`
    : '';

  return `    <Lap StartTime="${new Date(startMs + offsetMs).toISOString()}">
      <TotalTimeSeconds>${durationSeconds}</TotalTimeSeconds>
      <DistanceMeters>0</DistanceMeters>
      <Calories>${Math.round(calories || 0)}</Calories>${avg}${max}
      <Intensity>Active</Intensity>
      <TriggerMethod>Manual</TriggerMethod>
      <Track>
${trackpoints(points, startMs)}
      </Track>
    </Lap>`;
}

/**
 * @param {object} summary - a stored workout
 * @returns {string} TCX document
 */
export function buildTCX(summary) {
  const startMs = new Date(summary.date).getTime();
  const points = Array.isArray(summary.dataPoints) ? summary.dataPoints : [];

  // One TCX lap per marked lap; a ride with no laps becomes a single lap covering it all,
  // which is what every consumer expects.
  const marked = Array.isArray(summary.laps) ? summary.laps : [];
  const laps = marked.length > 0
    ? marked.map(lap => lapXml({
      startMs,
      offsetMs: lap.startMs,
      durationSeconds: lap.durationSeconds,
      calories: lap.calories,
      avgBPM: lap.avgBPM,
      maxBPM: lap.maxBPM,
      points: points.filter(p => p.timestamp >= lap.startMs && p.timestamp < lap.endMs),
    }))
    : [lapXml({
      startMs,
      offsetMs: 0,
      durationSeconds: summary.durationSeconds || 0,
      calories: summary.calories,
      avgBPM: summary.avgBPM,
      maxBPM: summary.maxBPM,
      points,
    })];

  const notes = summary.note || summary.planName
    ? `\n    <Notes>${xmlEscape([summary.planName, summary.note].filter(Boolean).join(' — '))}</Notes>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="${SCHEMA}">
  <Activities>
    <Activity Sport="Biking">
      <Id>${new Date(startMs).toISOString()}</Id>
${laps.join('\n')}${notes}
      <Creator xsi:type="Device_t" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <Name>SpinSync</Name>
        <UnitId>0</UnitId>
        <ProductID>0</ProductID>
      </Creator>
    </Activity>
  </Activities>
</TrainingCenterDatabase>
`;
}

/** Filename that sorts chronologically and survives every filesystem. */
export function tcxFilename(summary) {
  const d = new Date(summary.date);
  const pad = (n) => String(n).padStart(2, '0');
  return `spinsync-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.tcx`;
}
