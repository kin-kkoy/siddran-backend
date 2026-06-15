// Build a parameterized multi-row VALUES list for a single bulk INSERT/UPDATE, so a batch of N
// rows is one round-trip instead of N. Each `row` is an array of values in column order.
//
//   const { text, values } = bulkValues([[a, b], [c, d]], 1, ['int', 'text'])
//   // text   -> "($1::int, $2::text), ($3, $4)"
//   // values -> [a, b, c, d]
//
// `start` is the first placeholder number (use existing params.length + 1 when some $-params
// already precede the VALUES list). `casts` applies a "::type" to the FIRST row only — enough for
// Postgres to resolve each column's type even when later rows are NULL; pass a falsy entry to skip
// a column (e.g. to let a Date param infer as timestamptz rather than forcing a cast).
function bulkValues(rows, start = 1, casts = []) {
    const values = []
    const tuples = rows.map((row, r) => {
        const cells = row.map((v, c) => {
            values.push(v)
            const n = start + values.length - 1
            return r === 0 && casts[c] ? `$${n}::${casts[c]}` : `$${n}`
        })
        return `(${cells.join(', ')})`
    })
    return { text: tuples.join(', '), values }
}

module.exports = { bulkValues }
