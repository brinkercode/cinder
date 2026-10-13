// Fake Analytics Engine dataset: writeDataPoint keeps each point; sql answers insights' SELECT as the SQL API's `data`,
// one row per point (blob1.., double1..), filtered on index1 when the query names one, ordered by double1.
export function fakeAnalytics() {
  const points = [];
  return {
    writeDataPoint: (p) => points.push(p),
    sql: async (query) => {
      const index = query.match(/index1 = '([^']*)'/)?.[1];
      return points.filter((p) => index === undefined || p.indexes[0] === index).toSorted((a, b) => a.doubles[0] - b.doubles[0]).map((p) => ({
        ...Object.fromEntries(p.blobs.map((v, i) => [`blob${i + 1}`, v])), ...Object.fromEntries(p.doubles.map((v, i) => [`double${i + 1}`, v])),
      }));
    },
  };
}
