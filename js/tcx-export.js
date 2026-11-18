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
    // Distância acumulada por ponto: sem ela o Strava desenha a atividade sem perfil de
    // distância, mesmo que o total da lap esteja preenchido.
    const distance = p.distanceM > 0
      ? `\n        <DistanceMeters>${Math.round(p.distanceM)}</DistanceMeters>`
      : '';
    return `      <Trackpoint>
        <Time>${time}</Time>${distance}${hr}${cadence}
      </Trackpoint>`;
  }).join('\n');
}

/** Distância percorrida num trecho: a acumulada é do treino inteiro, não da volta. */
function lapDistance(points) {
  if (!points.length) return 0;
  const first = points[0].distanceM || 0;
  const last = points[points.length - 1].distanceM || 0;
  return Math.max(0, last - first);
}

function lapPoints(points, lap) {
  return points.filter(p => p.timestamp >= lap.startMs && p.timestamp < lap.endMs);
}

function lapXml({ startMs, offsetMs, durationSeconds, calories, avgBPM, maxBPM, points, distanceM }) {
  const avg = avgBPM > 0
    ? `\n      <AverageHeartRateBpm><Value>${Math.round(avgBPM)}</Value></AverageHeartRateBpm>`
    : '';
  const max = maxBPM > 0
    ? `\n      <MaximumHeartRateBpm><Value>${Math.round(maxBPM)}</Value></MaximumHeartRateBpm>`
    : '';

  return `    <Lap StartTime="${new Date(startMs + offsetMs).toISOString()}">
      <TotalTimeSeconds>${durationSeconds}</TotalTimeSeconds>
      <DistanceMeters>${Math.round(distanceM || 0)}</DistanceMeters>
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
      points: lapPoints(points, lap),
      distanceM: lapDistance(lapPoints(points, lap)),
    }))
    : [lapXml({
      startMs,
      offsetMs: 0,
      durationSeconds: summary.durationSeconds || 0,
      calories: summary.calories,
      avgBPM: summary.avgBPM,
      maxBPM: summary.maxBPM,
      points,
      distanceM: summary.distanceM || lapDistance(points),
    })];

  // O RPE também vai aqui: é o único dado do treino que nenhum sensor mede, e sem isto
  // ele ficava preso no app — o TCX é justamente o formato que outros apps leem.
  const noteParts = [
    summary.planName,
    summary.rpe ? `Esforço percebido ${summary.rpe}/10` : null,
    summary.note,
  ].filter(Boolean);
  const notes = noteParts.length
    ? `\n    <Notes>${xmlEscape(noteParts.join(' — '))}</Notes>`
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
